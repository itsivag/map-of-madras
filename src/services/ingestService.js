import {
  buildArticleContentHash,
  canonicalizeArticleUrl,
  getSourceDomain
} from './articleUtils.js';

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

function normalizeArticleContent(content = '') {
  return content.replace(/\s+/g, ' ').trim();
}

function buildErrorSummary(sourceErrors) {
  const messages = sourceErrors
    .flatMap((entry) => entry.errors || [])
    .map((entry) => entry.message)
    .filter(Boolean);

  if (messages.length === 0) {
    return null;
  }

  return messages.slice(0, 5).join(' | ').slice(0, 1000);
}

function buildDebugSource(url) {
  const domain = getSourceDomain(url);
  return {
    id: 'debug-source',
    name: domain ? domain.replace(/\./g, ' ') : 'Debug source'
  };
}

export class IngestService {
  constructor({
    db,
    rssService,
    geoService = null,
    semanticPipeline = null,
    pipelineMode = 'semantic',
    publishThreshold = 0.8
  }) {
    this.db = db;
    this.rssService = rssService;
    this.geoService = geoService;
    this.semanticPipeline = semanticPipeline;
    this.pipelineMode = pipelineMode === 'shadow' ? 'shadow' : 'semantic';
    this.publishThreshold = publishThreshold;

    this.insertRun = db.prepare(`
      INSERT INTO ingestion_runs (
        started_at,
        status,
        details_json
      ) VALUES (?, ?, ?)
    `);

    this.finishRun = db.prepare(`
      UPDATE ingestion_runs
      SET
        finished_at = ?,
        status = ?,
        processed_count = ?,
        published_count = ?,
        error_count = ?,
        error_summary = ?,
        details_json = ?
      WHERE id = ?
    `);

    this.selectEnabledSources = db.prepare(`
      SELECT
        id,
        name,
        feed_url,
        website_url,
        enabled,
        parser_mode,
        html_link_include_patterns,
        html_link_exclude_patterns,
        last_success_at,
        last_error
      FROM sources
      WHERE enabled = 1
      ORDER BY name ASC
    `);

    this.selectAllSources = db.prepare(`
      SELECT
        id,
        name,
        feed_url,
        website_url,
        enabled,
        parser_mode,
        html_link_include_patterns,
        html_link_exclude_patterns
      FROM sources
      ORDER BY name ASC
    `);

    this.selectRawArticleByCanonicalHash = db.prepare(`
      SELECT *
      FROM articles_raw
      WHERE canonical_url = ? AND content_hash = ?
      ORDER BY id DESC
      LIMIT 1
    `);

    this.selectRawArticleById = db.prepare(`
      SELECT *
      FROM articles_raw
      WHERE id = ?
    `);

    this.insertRawArticle = db.prepare(`
      INSERT INTO articles_raw (
        source_id,
        source_name,
        source_url,
        canonical_url,
        content_hash,
        title,
        published_at,
        content,
        normalized_text,
        semantic_status,
        semantic_model,
        last_indexed_at,
        fetch_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.touchRawArticle = db.prepare(`
      UPDATE articles_raw
      SET
        source_id = ?,
        source_name = ?,
        source_url = ?,
        title = ?,
        published_at = ?,
        content = ?,
        normalized_text = ?,
        fetch_run_id = ?
      WHERE id = ?
    `);

    this.selectIncidentByDedupe = db.prepare(`
      SELECT id
      FROM incidents
      WHERE dedupe_key = ?
      LIMIT 1
    `);

    this.upsertIncident = db.prepare(`
      INSERT INTO incidents (
        dedupe_key,
        category,
        subcategory,
        occurred_at,
        locality,
        lat,
        lng,
        confidence,
        source_name,
        source_url,
        source_domain,
        title,
        summary,
        published_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(dedupe_key) DO UPDATE SET
        category = excluded.category,
        subcategory = excluded.subcategory,
        occurred_at = excluded.occurred_at,
        locality = excluded.locality,
        lat = excluded.lat,
        lng = excluded.lng,
        confidence = excluded.confidence,
        source_name = excluded.source_name,
        source_url = excluded.source_url,
        source_domain = excluded.source_domain,
        title = excluded.title,
        summary = excluded.summary,
        published_at = excluded.published_at,
        updated_at = datetime('now')
    `);

    this.markSourceSuccess = db.prepare(`
      UPDATE sources
      SET
        last_success_at = ?,
        last_error = NULL,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    this.markSourceError = db.prepare(`
      UPDATE sources
      SET
        last_error = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);
  }

  isSemanticConfigured() {
    return Boolean(this.semanticPipeline?.isConfigured?.());
  }

  shouldPublishSemanticResults() {
    return this.pipelineMode === 'semantic';
  }

  matchSourceForUrl(url) {
    const targetDomain = getSourceDomain(url);
    if (!targetDomain) {
      return null;
    }

    return (
      this.selectAllSources
        .all()
        .find((source) =>
          [source.feed_url, source.website_url]
            .filter(Boolean)
            .map((value) => getSourceDomain(value))
            .some((domain) => domain === targetDomain)
        ) || null
    );
  }

  upsertRawArticle({ source, article, runId }) {
    const canonicalUrl = canonicalizeArticleUrl(article.sourceUrl);
    const contentHash = buildArticleContentHash(article);
    const normalizedText = normalizeArticleContent(article.content);
    const existing = this.selectRawArticleByCanonicalHash.get(canonicalUrl, contentHash);

    if (existing) {
      this.touchRawArticle.run(
        source.id,
        source.name,
        article.sourceUrl,
        article.title,
        toIsoOrNull(article.publishedAt),
        article.content,
        normalizedText,
        runId,
        existing.id
      );

      return this.selectRawArticleById.get(existing.id);
    }

    const result = this.insertRawArticle.run(
      source.id,
      source.name,
      article.sourceUrl,
      canonicalUrl,
      contentHash,
      article.title,
      toIsoOrNull(article.publishedAt),
      article.content,
      normalizedText,
      null,
      null,
      null,
      runId
    );

    return this.selectRawArticleById.get(result.lastInsertRowid);
  }

  publishIncident(candidate) {
    if (!candidate?.dedupe?.key) {
      return false;
    }

    const existed = this.selectIncidentByDedupe.get(candidate.dedupe.key);

    this.upsertIncident.run(
      candidate.dedupe.key,
      candidate.category,
      candidate.subcategory,
      candidate.occurredAt,
      candidate.locality,
      candidate.lat,
      candidate.lng,
      candidate.confidence,
      candidate.sourceName,
      candidate.sourceUrl,
      candidate.sourceDomain,
      candidate.title,
      candidate.summary,
      candidate.publishedAt
    );

    return !existed;
  }

  async processItem({ source, item, runId }) {
    const article = await this.rssService.enrichItem(source, item);
    const articleRow = this.upsertRawArticle({ source, article, runId });

    if (!this.semanticPipeline) {
      return {
        published: false,
        article,
        articleRow,
        semanticResult: {
          stage: 'disabled',
          decision: 'disabled',
          rejectionReason: 'Semantic pipeline is not initialized.',
          incidentCandidate: null
        }
      };
    }

    const semanticResult = await this.semanticPipeline.analyzeArticle({
      source,
      article,
      articleRow,
      persist: true
    });

    const published =
      this.shouldPublishSemanticResults() && semanticResult.incidentCandidate
        ? this.publishIncident(semanticResult.incidentCandidate)
        : false;

    return {
      published,
      article,
      articleRow,
      semanticResult
    };
  }

  async debugArticleByUrl(url) {
    if (!url) {
      throw new Error('Missing url query parameter.');
    }

    if (!this.semanticPipeline) {
      return {
        url,
        pipelineMode: this.pipelineMode,
        configured: false,
        stage: 'disabled',
        decision: 'disabled',
        rejectionReason: 'Semantic pipeline is not initialized.'
      };
    }

    const article = await this.rssService.fetchStandaloneArticle(url);
    if (!article?.title && !article?.content) {
      throw new Error('Unable to fetch article content for debug analysis.');
    }

    const source = this.matchSourceForUrl(url) || buildDebugSource(url);
    let semanticResult;

    try {
      semanticResult = await this.semanticPipeline.analyzeArticle({
        source,
        article,
        persist: false
      });
    } catch (error) {
      return {
        url,
        pipelineMode: this.pipelineMode,
        configured: this.isSemanticConfigured(),
        stage: 'error',
        decision: 'error',
        error: error.message
      };
    }

    return {
      url,
      pipelineMode: this.pipelineMode,
      configured: this.isSemanticConfigured(),
      stage: semanticResult.stage,
      decision: semanticResult.decision,
      extraction: semanticResult.extraction,
      taxonomyCandidates: semanticResult.taxonomyCandidates,
      evidenceChunks: semanticResult.evidenceChunks,
      geocodeResult: semanticResult.geocodeResult,
      rejectionReason: semanticResult.rejectionReason,
      incidentCandidate: semanticResult.incidentCandidate,
      rawText: semanticResult.rawText
    };
  }

  async runIngestion({ trigger = 'manual' } = {}) {
    const startedAt = new Date().toISOString();
    const runDetails = {
      trigger,
      pipelineMode: this.pipelineMode,
      semanticConfigured: this.isSemanticConfigured(),
      publishThreshold: this.publishThreshold,
      sources: []
    };

    const runResult = this.insertRun.run(startedAt, 'running', JSON.stringify(runDetails));
    const runId = Number(runResult.lastInsertRowid);
    let processedCount = 0;
    let publishedCount = 0;
    let errorCount = 0;

    const sources = this.selectEnabledSources.all();

    for (const source of sources) {
      const sourceDetail = {
        sourceId: source.id,
        name: source.name,
        fetchedCount: 0,
        processedCount: 0,
        publishedCount: 0,
        rejectedCount: 0,
        errors: []
      };

      try {
        const items = await this.rssService.fetchFeedItems(source);
        sourceDetail.fetchedCount = items.length;

        for (const item of items) {
          processedCount += 1;

          try {
            const result = await this.processItem({ source, item, runId });
            sourceDetail.processedCount += 1;

            if (result.published) {
              publishedCount += 1;
              sourceDetail.publishedCount += 1;
            } else if (result.semanticResult?.decision !== 'publish') {
              sourceDetail.rejectedCount += 1;
            }
          } catch (error) {
            errorCount += 1;
            sourceDetail.errors.push({
              url: item.link || null,
              message: error.message
            });
          }
        }

        this.markSourceSuccess.run(new Date().toISOString(), source.id);
      } catch (error) {
        errorCount += 1;
        sourceDetail.errors.push({
          stage: 'fetch',
          message: error.message
        });
        this.markSourceError.run(error.message.slice(0, 1000), source.id);
      }

      runDetails.sources.push(sourceDetail);
    }

    const status =
      errorCount === 0 ? 'success' : processedCount > 0 || publishedCount > 0 ? 'partial' : 'error';
    const finishedAt = new Date().toISOString();
    const errorSummary = buildErrorSummary(runDetails.sources);

    this.finishRun.run(
      finishedAt,
      status,
      processedCount,
      publishedCount,
      errorCount,
      errorSummary,
      JSON.stringify(runDetails),
      runId
    );

    return {
      id: runId,
      status,
      trigger,
      processedCount,
      publishedCount,
      errorCount,
      semanticConfigured: runDetails.semanticConfigured,
      pipelineMode: this.pipelineMode,
      details: runDetails
    };
  }
}
