import { buildDedupeKey } from './dedupe.js';
import {
  buildArticleContentHash,
  canonicalizeArticleUrl,
  getSourceDomain
} from './articleUtils.js';
import { hasSemanticEvidence } from './semanticSchema.js';
import { CRIME_TAXONOMY, buildTaxonomyDocument } from './semanticTaxonomy.js';
import { rankBySimilarity } from './vectorMath.js';

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function summarizeSemanticIncident({ category, locality, occurredAt }) {
  const dateLabel = occurredAt ? occurredAt.slice(0, 10) : 'unknown date';
  const where = locality ? `near ${locality}` : 'in Chennai';
  return `Semantically extracted ${category} incident ${where} on ${dateLabel}. Verify details in the source article.`;
}

function buildEvidenceQueries(article, taxonomyCandidates) {
  const candidateList = taxonomyCandidates.map((candidate) => candidate.category).join(', ') || 'other';

  return [
    {
      supports: 'offense',
      text: `Crime type evidence for article: ${article.title}. Possible categories: ${candidateList}.`
    },
    {
      supports: 'location',
      text: `Location evidence for Chennai article: ${article.title}. Find the best locality, neighborhood, airport, road or suburb mentioned.`
    },
    {
      supports: 'time',
      text: `Time evidence for article: ${article.title}. Find when the incident happened.`
    }
  ];
}

function mergeEvidenceResults(searchBuckets) {
  const merged = new Map();

  for (const bucket of searchBuckets) {
    for (const result of bucket.results) {
      const existing = merged.get(result.chunkId);

      if (!existing) {
        merged.set(result.chunkId, {
          ...result,
          supports: [bucket.supports]
        });
        continue;
      }

      if (!existing.supports.includes(bucket.supports)) {
        existing.supports.push(bucket.supports);
      }

      if (result.score > existing.score) {
        existing.score = result.score;
      }
    }
  }

  return [...merged.values()].sort((left, right) => right.score - left.score).slice(0, 8);
}

function deriveRejectionReason({ extraction, geocoded }) {
  if (!extraction.isCrimeEvent) {
    return extraction.rejectionReason || 'Model rejected the article as not a crime event.';
  }

  if (!geocoded) {
    return 'Semantic location could not be geocoded inside Chennai.';
  }

  if (!hasSemanticEvidence(extraction, 'offense')) {
    return 'Model did not provide offense evidence chunk ids.';
  }

  if (!hasSemanticEvidence(extraction, 'location')) {
    return 'Model did not provide location evidence chunk ids.';
  }

  if (extraction.confidence < 0.65) {
    return 'Semantic confidence below publish threshold.';
  }

  return extraction.rejectionReason || 'Semantic pipeline rejected the article.';
}

function augmentExtractionEvidence(extraction, evidenceChunks) {
  if (!Array.isArray(extraction?.evidence) || extraction.evidence.length === 0) {
    return extraction;
  }

  const supportHints = new Map(
    evidenceChunks.map((chunk) => [chunk.chunkId, Array.isArray(chunk.supports) ? chunk.supports : []])
  );
  const mergedEvidence = [];
  const seen = new Set();

  for (const entry of extraction.evidence) {
    const supports = new Set([entry.supports, ...(supportHints.get(entry.chunkId) || [])]);

    for (const support of supports) {
      const key = `${entry.chunkId}:${support}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      mergedEvidence.push({
        chunkId: entry.chunkId,
        supports: support
      });
    }
  }

  return {
    ...extraction,
    evidence: mergedEvidence
  };
}

export class SemanticPipeline {
  constructor({
    db = null,
    bedrockService,
    qdrantService,
    chunker,
    geoService,
    publishThreshold = 0.65,
    pipelineMode = 'semantic'
  }) {
    this.db = db;
    this.bedrockService = bedrockService;
    this.qdrantService = qdrantService;
    this.chunker = chunker;
    this.geoService = geoService;
    this.publishThreshold = publishThreshold;
    this.pipelineMode = pipelineMode;
    this.taxonomyEntries = CRIME_TAXONOMY.map((entry) => ({
      ...entry,
      document: buildTaxonomyDocument(entry)
    }));
    this.taxonomyReady = false;

    if (db) {
      this.updateArticleSemanticState = db.prepare(`
        UPDATE articles_raw
        SET
          canonical_url = @canonicalUrl,
          content_hash = @contentHash,
          semantic_status = @semanticStatus,
          semantic_model = @semanticModel,
          last_indexed_at = @lastIndexedAt
        WHERE id = @articleId
      `);

      this.deleteArticleChunks = db.prepare('DELETE FROM article_chunks WHERE article_id = ?');
      this.insertArticleChunk = db.prepare(`
        INSERT INTO article_chunks (
          article_id,
          chunk_index,
          chunk_id,
          chunk_text,
          chunk_hash,
          qdrant_point_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      this.insertSemanticExtraction = db.prepare(`
        INSERT INTO semantic_extractions (
          article_id,
          model_id,
          prompt_version,
          pipeline_mode,
          evidence_chunk_ids,
          raw_json,
          decision,
          confidence,
          rejection_reason,
          extraction_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.selectLatestSemanticExtraction = db.prepare(`
        SELECT *
        FROM semantic_extractions
        WHERE article_id = ?
        ORDER BY id DESC
        LIMIT 1
      `);
    }
  }

  isConfigured() {
    return Boolean(this.bedrockService?.isConfigured() && this.qdrantService?.isConfigured());
  }

  async ensureTaxonomyReady() {
    if (this.taxonomyReady) {
      return;
    }

    const embeddings = await this.bedrockService.embedTexts(
      this.taxonomyEntries.map((entry) => entry.document)
    );

    this.taxonomyEntries = this.taxonomyEntries.map((entry, index) => ({
      ...entry,
      vector: embeddings[index]
    }));

    await this.qdrantService.upsertTaxonomy(this.taxonomyEntries, embeddings);
    this.taxonomyReady = true;
  }

  async hydrateCachedResult({ articleRow, article, source }) {
    if (!this.db || !articleRow?.id) {
      return null;
    }

    const cached = this.selectLatestSemanticExtraction.get(articleRow.id);
    if (!cached || !cached.extraction_json) {
      return null;
    }

    const extraction = JSON.parse(cached.extraction_json);
    const locationText =
      extraction.locationText || (extraction.locationPrecision === 'city' ? 'Chennai' : null);
    const geocodeResult = locationText ? await this.geoService.geocodeLocality(locationText) : null;

    return this.buildSemanticResult({
      article,
      source,
      extraction,
      geocodeResult,
      evidenceChunks: [],
      taxonomyCandidates: [],
      decision: cached.decision,
      rawText: cached.raw_json || '',
      cached: true
    });
  }

  async shortlistTaxonomy(article) {
    const summaryText = [article.title, article.content.slice(0, 4000)].filter(Boolean).join('\n\n');
    const queryVector = await this.bedrockService.embedText(summaryText);
    const remoteResults = await this.qdrantService.searchTaxonomy(queryVector, 5);

    if (remoteResults.length > 0) {
      return remoteResults.map((result) => ({
        id: result.payload.taxonomy_id,
        category: result.payload.category,
        title: result.payload.title,
        document: result.payload.document,
        score: result.score
      }));
    }

    return rankBySimilarity(this.taxonomyEntries, queryVector, (entry) => entry.vector)
      .slice(0, 5)
      .map(({ item, score }) => ({
        id: item.id,
        category: item.category,
        title: item.title,
        document: item.document,
        score
      }));
  }

  async retrieveEvidence({ articleRow, article, chunks, chunkVectors, taxonomyCandidates, persist }) {
    const queries = buildEvidenceQueries(article, taxonomyCandidates);
    const queryVectors = await this.bedrockService.embedTexts(queries.map((query) => query.text));
    const searchBuckets = [];

    for (let index = 0; index < queries.length; index += 1) {
      const supports = queries[index].supports;
      const vector = queryVectors[index];
      let results = [];

      if (persist && articleRow?.id) {
        const remoteResults = await this.qdrantService.searchArticleChunks(vector, {
          articleId: articleRow.id,
          limit: 4
        });

        results = remoteResults.map((result) => ({
          chunkId: result.payload.chunk_id || String(result.id),
          chunkText: result.payload.chunk_text,
          chunkIndex: result.payload.chunk_index,
          score: result.score
        }));
      }

      if (results.length === 0) {
        results = rankBySimilarity(
          chunks.map((chunk, chunkIndex) => ({
            chunkId: chunk.chunkId,
            chunkText: chunk.chunkText,
            chunkIndex: chunk.chunkIndex,
            vector: chunkVectors[chunkIndex]
          })),
          vector,
          (item) => item.vector
        )
          .slice(0, 4)
          .map(({ item, score }) => ({
            chunkId: item.chunkId,
            chunkText: item.chunkText,
            chunkIndex: item.chunkIndex,
            score
          }));
      }

      searchBuckets.push({
        supports,
        results
      });
    }

    return mergeEvidenceResults(searchBuckets);
  }

  persistArticleChunks(articleId, chunks) {
    if (!this.db || !articleId) {
      return;
    }

    const tx = this.db.transaction((chunkRows) => {
      this.deleteArticleChunks.run(articleId);

      for (const chunk of chunkRows) {
        this.insertArticleChunk.run(
          articleId,
          chunk.chunkIndex,
          chunk.chunkId,
          chunk.chunkText,
          chunk.chunkHash,
          chunk.chunkId
        );
      }
    });

    tx(chunks);
  }

  persistSemanticExtraction(articleId, result) {
    if (!this.db || !articleId) {
      return;
    }

    this.insertSemanticExtraction.run(
      articleId,
      result.modelId,
      result.promptVersion,
      this.pipelineMode,
      JSON.stringify(result.extraction.evidence.map((entry) => entry.chunkId)),
      result.rawText,
      result.decision,
      result.extraction.confidence,
      result.rejectionReason,
      JSON.stringify(result.extraction)
    );

    this.updateArticleSemanticState.run({
      articleId,
      canonicalUrl: result.canonicalUrl,
      contentHash: result.contentHash,
      semanticStatus: result.decision === 'publish' ? 'indexed' : 'rejected',
      semanticModel: result.modelId,
      lastIndexedAt: new Date().toISOString()
    });
  }

  buildSemanticResult({
    article,
    source,
    extraction,
    geocodeResult,
    evidenceChunks,
    taxonomyCandidates,
    decision,
    rawText,
    cached = false
  }) {
    const locationText =
      extraction.locationText || (extraction.locationPrecision === 'city' ? 'Chennai' : null);
    const occurredAt = toIsoOrNull(extraction.occurredAt) || toIsoOrNull(article.publishedAt) || new Date().toISOString();
    const publishable =
      decision === 'publish' &&
      extraction.isCrimeEvent &&
      extraction.category !== 'not-a-crime-event' &&
      extraction.confidence >= this.publishThreshold &&
      geocodeResult &&
      hasSemanticEvidence(extraction, 'offense') &&
      hasSemanticEvidence(extraction, 'location');

    const incidentCandidate = publishable
      ? {
          dedupe: buildDedupeKey({
            category: extraction.category,
            subcategory: extraction.subcategory,
            title: article.title,
            occurredAt,
            locality: geocodeResult.locality,
            lat: geocodeResult.lat,
            lng: geocodeResult.lng
          }),
          category: extraction.category,
          subcategory: extraction.subcategory,
          occurredAt,
          locality: geocodeResult.locality,
          lat: geocodeResult.lat,
          lng: geocodeResult.lng,
          confidence: extraction.confidence,
          sourceName: source.name,
          sourceUrl: article.sourceUrl,
          sourceDomain: getSourceDomain(article.sourceUrl),
          title: article.title,
          summary: summarizeSemanticIncident({
            category: extraction.category,
            locality: geocodeResult.locality,
            occurredAt
          }),
          publishedAt: new Date().toISOString()
        }
      : null;

    return {
      stage: publishable ? 'ready_to_publish' : cached ? 'cached' : 'rejected',
      cached,
      extraction,
      taxonomyCandidates,
      evidenceChunks,
      geocodeResult:
        geocodeResult ||
        (locationText
          ? {
              locality: locationText,
              lat: null,
              lng: null
            }
          : null),
      decision,
      rejectionReason: publishable ? null : deriveRejectionReason({ extraction, geocoded: geocodeResult }),
      incidentCandidate,
      rawText
    };
  }

  async analyzeArticle({ source, article, articleRow = null, persist = true }) {
    if (!this.isConfigured()) {
      return {
        stage: 'disabled',
        decision: 'disabled',
        rejectionReason: 'Semantic pipeline requires both Bedrock and Qdrant configuration.',
        extraction: null,
        evidenceChunks: [],
        taxonomyCandidates: [],
        geocodeResult: null,
        incidentCandidate: null
      };
    }

    const canonicalUrl = canonicalizeArticleUrl(article.sourceUrl);
    const contentHash = buildArticleContentHash(article);

    if (persist && articleRow?.id && articleRow.content_hash === contentHash && articleRow.semantic_status === 'indexed') {
      const cached = await this.hydrateCachedResult({ articleRow, article, source });
      if (cached) {
        return cached;
      }
    }

    await this.ensureTaxonomyReady();

    const chunks = await this.chunker.chunkArticle({
      title: article.title,
      content: article.content,
      canonicalUrl,
      contentHash,
      sourceId: source.id,
      publishedAt: toIsoOrNull(article.publishedAt)
    });

    const chunkVectors = await this.bedrockService.embedTexts(chunks.map((chunk) => chunk.chunkText));
    const taxonomyCandidates = await this.shortlistTaxonomy(article);

    if (persist && articleRow?.id) {
      await this.qdrantService.upsertArticleChunks(articleRow.id, chunks, chunkVectors);
      this.persistArticleChunks(articleRow.id, chunks);
    }

    const evidenceChunks = await this.retrieveEvidence({
      articleRow,
      article,
      chunks,
      chunkVectors,
      taxonomyCandidates,
      persist
    });

    const extractionResponse = await this.bedrockService.extractIncident({
      article,
      taxonomyCandidates,
      evidenceChunks
    });

    const extraction = augmentExtractionEvidence(extractionResponse.parsed, evidenceChunks);
    const locationText =
      extraction.locationText || (extraction.locationPrecision === 'city' ? 'Chennai' : null);
    const geocodeResult = locationText ? await this.geoService.geocodeLocality(locationText) : null;

    const decision =
      extraction.isCrimeEvent &&
      extraction.category !== 'not-a-crime-event' &&
      extraction.confidence >= this.publishThreshold &&
      geocodeResult &&
      hasSemanticEvidence(extraction, 'offense') &&
      hasSemanticEvidence(extraction, 'location')
        ? 'publish'
        : 'reject';

    const result = this.buildSemanticResult({
      article,
      source,
      extraction,
      geocodeResult,
      evidenceChunks,
      taxonomyCandidates,
      decision,
      rawText: extractionResponse.rawText
    });

    result.modelId = extractionResponse.modelId;
    result.promptVersion = extractionResponse.promptVersion;
    result.canonicalUrl = canonicalUrl;
    result.contentHash = contentHash;

    if (persist && articleRow?.id) {
      this.persistSemanticExtraction(articleRow.id, result);
    }

    return result;
  }
}
