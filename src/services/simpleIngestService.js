import { createHash } from 'node:crypto';
import {
  buildArticleContentHash,
  canonicalizeArticleUrl,
  getSourceDomain
} from './articleUtils.js';
import {
  buildSourceFingerprint,
  isLikelySameIncident,
  scoreIncidentMatch,
  buildDedupeKey
} from './dedupe.js';

const COMMUNITY_SOURCE_NAME = 'Anonymous community report';
const SUBMISSION_QUEUE_BATCH_SIZE = 12;
const SUBMISSION_RATE_LIMIT_WINDOW_HOURS = 6;
const SUBMISSION_RATE_LIMIT_MAX = 3;
const SUBMISSION_CATEGORY_SET = new Set([
  'murder',
  'rape',
  'assault',
  'robbery/theft',
  'kidnapping',
  'fraud/scam',
  'drug offense',
  'other'
]);

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function hashContent(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function buildSubmissionFingerprint({ category, locality, occurredAt, description, sourceUrl }) {
  const occurredDate = toIsoOrNull(occurredAt)?.slice(0, 10) || 'unknown-date';
  return hashContent([
    category,
    normalizeText(locality).toLowerCase(),
    occurredDate,
    normalizeText(description).toLowerCase(),
    canonicalizeArticleUrl(sourceUrl || '')
  ].join('|'));
}

function buildSubmissionSourceUrl(queueId) {
  return `https://user-report.local/submissions/${queueId}`;
}

function buildSubmissionTitle({ category, locality, description }) {
  const compactDescription = normalizeText(description);
  const summary = compactDescription.slice(0, 90).replace(/[.!?]\s.*$/, '');
  const where = normalizeText(locality) || 'Chennai';
  return summary || `${category} report near ${where}`;
}

function summarizeSubmissionIncident({ category, locality, occurredAt }) {
  const dateLabel = occurredAt ? occurredAt.slice(0, 10) : 'unknown date';
  const where = locality ? `near ${locality}` : 'in Chennai';
  return `Anonymous community report for ${category} incident ${where} on ${dateLabel}. Verify independently.`;
}

function withPromiseTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms.`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function summarizeSimpleIncident({ category, locality, occurredAt }) {
  const dateLabel = occurredAt ? occurredAt.slice(0, 10) : 'unknown date';
  const where = locality ? `near ${locality}` : 'in Chennai';
  return `AI-extracted ${category} incident ${where} on ${dateLabel}. Verify details in the source article.`;
}

export class SimpleIngestService {
  constructor({
    db,
    crawl4aiDiscovery,
    crawl4aiFetcher,
    extractionService,
    geoService,
    publishThreshold = 0.65,
    maxArticlesPerSource = 10,
    articleTimeoutMs = 30000,
    sourceTimeBudgetMs = 120000,
    runTimeBudgetMs = 600000
  }) {
    this.db = db;
    this.crawl4aiDiscovery = crawl4aiDiscovery;
    this.crawl4aiFetcher = crawl4aiFetcher;
    this.extractionService = extractionService;
    this.geoService = geoService;
    this.publishThreshold = publishThreshold;
    this.maxArticlesPerSource = maxArticlesPerSource;
    this.articleTimeoutMs = articleTimeoutMs;
    this.sourceTimeBudgetMs = sourceTimeBudgetMs;
    this.runTimeBudgetMs = runTimeBudgetMs;

    // Prepared statements
    this.insertRun = db.prepare(`
      INSERT INTO ingestion_runs (started_at, status, details_json)
      VALUES (?, ?, ?)
    `);

    this.finishRun = db.prepare(`
      UPDATE ingestion_runs SET
        finished_at = ?,
        status = ?,
        processed_count = ?,
        published_count = ?,
        error_count = ?,
        error_summary = ?,
        details_json = ?
      WHERE id = ?
    `);

    this.updateRunProgress = db.prepare(`
      UPDATE ingestion_runs SET
        processed_count = ?,
        published_count = ?,
        error_count = ?,
        details_json = ?
      WHERE id = ?
    `);

    this.selectEnabledSources = db.prepare(`
      SELECT id, name, homepage_url, include_patterns, exclude_patterns, max_articles
      FROM sources WHERE enabled = 1 ORDER BY name ASC
    `);

    this.insertRawArticle = db.prepare(`
      INSERT INTO articles_raw (
        source_id, source_name, source_url, canonical_url, content_hash,
        title, published_at, content, normalized_text, fetch_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.selectIncidentByDedupe = db.prepare(`
      SELECT id FROM incidents WHERE dedupe_key = ? LIMIT 1
    `);

    this.selectIncidentMergeCandidates = db.prepare(`
      SELECT id, dedupe_key, category, subcategory, occurred_at, locality,
             lat, lng, confidence, source_name, source_url, source_domain, title, summary
      FROM incidents
      WHERE category = ?
        AND datetime(COALESCE(occurred_at, created_at)) BETWEEN datetime(?) AND datetime(?)
        AND lat BETWEEN ? AND ?
        AND lng BETWEEN ? AND ?
      ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
      LIMIT 25
    `);

    this.upsertIncident = db.prepare(`
      INSERT INTO incidents (
        dedupe_key, category, subcategory, occurred_at, locality, lat, lng,
        confidence, source_name, source_url, source_domain, title, summary,
        published_at, updated_at
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

    this.selectIncidentById = db.prepare(`
      SELECT id, dedupe_key, category, subcategory, occurred_at, locality,
             lat, lng, confidence, source_name, source_url, source_domain, title, summary, published_at
      FROM incidents WHERE id = ?
    `);

    this.selectIncidentSourceByFingerprint = db.prepare(`
      SELECT id, incident_id FROM incident_sources WHERE source_fingerprint = ? LIMIT 1
    `);

    this.insertIncidentSource = db.prepare(`
      INSERT INTO incident_sources (
        incident_id, source_fingerprint, source_name, source_url, source_domain,
        title, published_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(source_fingerprint) DO UPDATE SET
        incident_id = excluded.incident_id,
        source_name = excluded.source_name,
        source_url = excluded.source_url,
        source_domain = excluded.source_domain,
        title = excluded.title,
        published_at = excluded.published_at,
        updated_at = datetime('now')
    `);

    // Submission queue statements
    this.selectSubmissionByFingerprint = db.prepare(`
      SELECT id, status FROM submission_queue WHERE submission_fingerprint = ? LIMIT 1
    `);

    this.countRecentReporterSubmissions = db.prepare(`
      SELECT COUNT(*) AS count FROM submission_queue
      WHERE reporter_hash = ? AND datetime(created_at) >= datetime(?)
    `);

    this.insertSubmissionQueue = db.prepare(`
      INSERT INTO submission_queue (
        reporter_hash, submission_fingerprint, category, locality, occurred_at,
        description, source_url, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', datetime('now'))
    `);

    this.selectQueuedSubmissions = db.prepare(`
      SELECT id, reporter_hash, submission_fingerprint, category, locality,
             occurred_at, description, source_url, status, created_at
      FROM submission_queue WHERE status = 'queued'
      ORDER BY datetime(created_at) ASC, id ASC LIMIT ?
    `);

    this.updateSubmissionQueueState = db.prepare(`
      UPDATE submission_queue SET
        status = ?, processed_incident_id = ?, last_error = ?, run_id = ?,
        processed_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    this.markSourceSuccess = db.prepare(`
      UPDATE sources SET last_success_at = ?, last_error = NULL, updated_at = datetime('now')
      WHERE id = ?
    `);

    this.markSourceError = db.prepare(`
      UPDATE sources SET last_error = ?, updated_at = datetime('now')
      WHERE id = ?
    `);
  }

  isConfigured() {
    return Boolean(
      this.crawl4aiDiscovery?.isConfigured?.() &&
      this.extractionService?.isConfigured?.()
    );
  }

  async processArticle(url, source, runId) {
    const startTime = Date.now();
    
    try {
      // Fetch article via Crawl4AI
      const fetchResult = await withPromiseTimeout(
        this.crawl4aiFetcher.fetchArticleContent(url, { timeoutMs: this.articleTimeoutMs }),
        this.articleTimeoutMs + 2000,
        `Article fetch for ${url}`
      );

      const article = {
        sourceUrl: url,
        title: fetchResult.title || '',
        content: fetchResult.content || '',
        publishedAt: fetchResult.publishedAt || new Date().toISOString()
      };

      // Store raw article
      const canonicalUrl = canonicalizeArticleUrl(url);
      const contentHash = buildArticleContentHash(article);
      
      this.insertRawArticle.run(
        source.id,
        source.name,
        url,
        canonicalUrl,
        contentHash,
        article.title,
        toIsoOrNull(article.publishedAt),
        article.content,
        normalizeText(article.content),
        runId
      );

      // Skip if content too short
      if (article.content.length < 200) {
        return {
          published: false,
          reason: 'content_too_short',
          article,
          processingTimeMs: Date.now() - startTime
        };
      }

      // Extract incident using LLM
      const extractionResult = await withPromiseTimeout(
        this.extractionService.extractIncident(article),
        30000,
        `Extraction for ${url}`
      );

      if (!extractionResult.success) {
        return {
          published: false,
          reason: 'extraction_failed',
          error: extractionResult.error,
          article,
          processingTimeMs: Date.now() - startTime
        };
      }

      const extraction = extractionResult.extraction;

      // Check if it's a crime event with sufficient confidence
      if (!extraction.isCrimeEvent || extraction.category === 'not-a-crime-event') {
        return {
          published: false,
          reason: 'not_a_crime_event',
          extraction,
          article,
          processingTimeMs: Date.now() - startTime
        };
      }

      if (extraction.confidence < this.publishThreshold) {
        return {
          published: false,
          reason: 'low_confidence',
          extraction,
          article,
          processingTimeMs: Date.now() - startTime
        };
      }

      // Geocode location
      if (!extraction.locationText) {
        return {
          published: false,
          reason: 'no_location',
          extraction,
          article,
          processingTimeMs: Date.now() - startTime
        };
      }

      const geocodeResult = await this.geoService.geocodeLocality(extraction.locationText);
      if (!geocodeResult) {
        return {
          published: false,
          reason: 'geocode_failed',
          extraction,
          article,
          processingTimeMs: Date.now() - startTime
        };
      }

      // Build incident candidate
      const occurredAt = extraction.occurredAt || toIsoOrNull(article.publishedAt) || new Date().toISOString();
      const candidate = {
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
        sourceUrl: url,
        sourceDomain: getSourceDomain(url),
        title: article.title,
        summary: extraction.summary || summarizeSimpleIncident({
          category: extraction.category,
          locality: geocodeResult.locality,
          occurredAt
        }),
        publishedAt: new Date().toISOString()
      };

      // Publish incident
      const published = this.publishIncident(candidate);

      return {
        published,
        candidate,
        extraction,
        article,
        processingTimeMs: Date.now() - startTime
      };
    } catch (error) {
      return {
        published: false,
        reason: 'error',
        error: error.message,
        url,
        processingTimeMs: Date.now() - startTime
      };
    }
  }

  publishIncident(candidate) {
    if (!candidate?.dedupe?.key) return false;

    const canonicalSourceUrl = canonicalizeArticleUrl(candidate.sourceUrl);
    const sourceFingerprint = buildSourceFingerprint({
      sourceUrl: canonicalSourceUrl,
      title: candidate.title
    });

    // Check if we've already seen this source
    const existingSource = this.selectIncidentSourceByFingerprint.get(sourceFingerprint);
    if (existingSource) return false;

    // Find merge candidates
    const mergeMatch = this.findMergeTarget(candidate);
    if (mergeMatch) {
      const merged = this.mergeIntoIncident(mergeMatch.id, candidate);
      this.attachIncidentSource(merged.id, candidate, canonicalSourceUrl, sourceFingerprint);
      return false;
    }

    // Check for existing incident by dedupe key
    const existed = this.selectIncidentByDedupe.get(candidate.dedupe.key);
    const result = this.upsertIncident.run(
      candidate.dedupe.key,
      candidate.category,
      candidate.subcategory,
      candidate.occurredAt,
      candidate.locality,
      candidate.lat,
      candidate.lng,
      candidate.confidence,
      candidate.sourceName,
      canonicalSourceUrl,
      candidate.sourceDomain,
      candidate.title,
      candidate.summary,
      candidate.publishedAt
    );

    const incidentId = existed?.id || Number(result.lastInsertRowid) || this.selectIncidentByDedupe.get(candidate.dedupe.key)?.id;
    if (incidentId) {
      this.attachIncidentSource(incidentId, candidate, canonicalSourceUrl, sourceFingerprint);
    }

    return !existed;
  }

  findMergeTarget(candidate) {
    const occurredAt = new Date(candidate.occurredAt || Date.now());
    const from = new Date(occurredAt.getTime() - 24 * 60 * 60 * 1000);
    const to = new Date(occurredAt.getTime() + 24 * 60 * 60 * 1000);

    const lat = Number(candidate.lat);
    const lng = Number(candidate.lng);
    const rows = this.selectIncidentMergeCandidates.all(
      candidate.category,
      from.toISOString(),
      to.toISOString(),
      lat - 0.02,
      lat + 0.02,
      lng - 0.02,
      lng + 0.02
    );

    let bestMatch = null;
    let bestScore = -1;

    for (const row of rows) {
      const existing = {
        category: row.category,
        subcategory: row.subcategory,
        occurredAt: row.occurred_at,
        locality: row.locality,
        lat: row.lat,
        lng: row.lng,
        title: row.title
      };
      const score = scoreIncidentMatch(existing, candidate);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = row;
      }
    }

    return bestMatch && isLikelySameIncident({
      category: bestMatch.category,
      subcategory: bestMatch.subcategory,
      occurredAt: bestMatch.occurred_at,
      locality: bestMatch.locality,
      lat: bestMatch.lat,
      lng: bestMatch.lng,
      title: bestMatch.title
    }, candidate) ? bestMatch : null;
  }

  mergeIntoIncident(incidentId, candidate) {
    const existing = this.selectIncidentById.get(incidentId);
    if (!existing) {
      throw new Error(`Missing incident ${incidentId} during merge.`);
    }

    const shouldPromoteSource = Number(candidate.confidence || 0) > Number(existing.confidence || 0);
    const merged = {
      dedupeKey: existing.dedupe_key,
      category: existing.category || candidate.category,
      subcategory: existing.subcategory || candidate.subcategory,
      occurredAt: existing.occurred_at || candidate.occurredAt,
      locality: existing.locality || candidate.locality,
      lat: existing.lat ?? candidate.lat,
      lng: existing.lng ?? candidate.lng,
      confidence: Math.max(Number(existing.confidence || 0), Number(candidate.confidence || 0)),
      sourceName: shouldPromoteSource ? candidate.sourceName : existing.source_name,
      sourceUrl: shouldPromoteSource ? canonicalizeArticleUrl(candidate.sourceUrl) : existing.source_url,
      sourceDomain: shouldPromoteSource ? candidate.sourceDomain : existing.source_domain,
      title: shouldPromoteSource ? candidate.title : existing.title,
      summary: existing.summary || candidate.summary,
      publishedAt: existing.published_at || candidate.publishedAt
    };

    this.db.prepare(`
      UPDATE incidents SET
        dedupe_key = ?, category = ?, subcategory = ?, occurred_at = ?, locality = ?,
        lat = ?, lng = ?, confidence = ?, source_name = ?, source_url = ?,
        source_domain = ?, title = ?, summary = ?, published_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      merged.dedupeKey, merged.category, merged.subcategory, merged.occurredAt,
      merged.locality, merged.lat, merged.lng, merged.confidence, merged.sourceName,
      merged.sourceUrl, merged.sourceDomain, merged.title, merged.summary,
      merged.publishedAt, incidentId
    );

    return { id: incidentId, ...merged };
  }

  attachIncidentSource(incidentId, candidate, canonicalSourceUrl, sourceFingerprint) {
    this.insertIncidentSource.run(
      incidentId,
      sourceFingerprint,
      candidate.sourceName,
      canonicalSourceUrl,
      candidate.sourceDomain || getSourceDomain(canonicalSourceUrl),
      candidate.title,
      candidate.publishedAt
    );
  }

  // Submission queue methods (unchanged from original)
  queueIncidentSubmission({ reporterHash, category, locality, occurredAt = null, description, sourceUrl = '' }) {
    const normalizedReporterHash = normalizeText(reporterHash);
    const normalizedCategory = SUBMISSION_CATEGORY_SET.has(category) ? category : 'other';
    const normalizedLocality = normalizeText(locality).slice(0, 160);
    const normalizedDescription = normalizeText(description).slice(0, 2000);
    const normalizedSourceUrl = canonicalizeArticleUrl(sourceUrl || '');
    const occurredAtIso = toIsoOrNull(occurredAt);

    if (!normalizedReporterHash) {
      throw new Error('Missing anonymous reporter token.');
    }
    if (!normalizedLocality || normalizedLocality.length < 3) {
      throw new Error('Locality must be at least 3 characters.');
    }
    if (!normalizedDescription || normalizedDescription.length < 24) {
      throw new Error('Description must be at least 24 characters.');
    }

    const submissionFingerprint = buildSubmissionFingerprint({
      category: normalizedCategory,
      locality: normalizedLocality,
      occurredAt: occurredAtIso,
      description: normalizedDescription,
      sourceUrl: normalizedSourceUrl
    });

    const existing = this.selectSubmissionByFingerprint.get(submissionFingerprint);
    if (existing) {
      return { queued: false, status: 'duplicate', queueId: existing.id };
    }

    const windowStart = new Date(Date.now() - SUBMISSION_RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const recentCount = Number(this.countRecentReporterSubmissions.get(normalizedReporterHash, windowStart)?.count || 0);

    if (recentCount >= SUBMISSION_RATE_LIMIT_MAX) {
      return { queued: false, status: 'rate_limited', retryAfterHours: SUBMISSION_RATE_LIMIT_WINDOW_HOURS };
    }

    const result = this.insertSubmissionQueue.run(
      normalizedReporterHash,
      submissionFingerprint,
      normalizedCategory,
      normalizedLocality,
      occurredAtIso,
      normalizedDescription,
      normalizedSourceUrl || null
    );

    return { queued: true, status: 'queued', queueId: Number(result.lastInsertRowid) };
  }

  async processQueuedSubmissions(runId) {
    const queueDetail = {
      sourceId: 'submission-queue',
      name: 'Anonymous submission queue',
      discoveredCount: 0,
      fetchedCount: 0,
      processedCount: 0,
      publishedCount: 0,
      rejectedCount: 0,
      skippedCount: 0,
      errors: []
    };

    const queuedSubmissions = this.selectQueuedSubmissions.all(SUBMISSION_QUEUE_BATCH_SIZE);
    queueDetail.discoveredCount = queuedSubmissions.length;
    queueDetail.fetchedCount = queuedSubmissions.length;

    if (!queuedSubmissions.length) return queueDetail;

    if (!this.geoService) {
      queueDetail.errors.push({ stage: 'queue', message: 'Geo service not configured' });
      for (const submission of queuedSubmissions) {
        this.updateSubmissionQueueState.run('error', null, 'Geo service unavailable.', runId, new Date().toISOString(), submission.id);
      }
      return queueDetail;
    }

    for (const submission of queuedSubmissions) {
      try {
        queueDetail.processedCount += 1;
        const geocoded = await this.geoService.geocodeLocality(submission.locality);

        if (!geocoded) {
          queueDetail.rejectedCount += 1;
          this.updateSubmissionQueueState.run('rejected', null, 'Unable to geocode locality', runId, new Date().toISOString(), submission.id);
          continue;
        }

        const sourceUrl = submission.source_url || buildSubmissionSourceUrl(submission.id);
        const occurredAt = submission.occurred_at || submission.created_at || new Date().toISOString();
        const title = buildSubmissionTitle({
          category: submission.category,
          locality: submission.locality,
          description: submission.description
        });

        const candidate = {
          dedupe: buildDedupeKey({
            category: submission.category,
            subcategory: 'community report',
            title,
            occurredAt,
            locality: geocoded.locality,
            lat: geocoded.lat,
            lng: geocoded.lng
          }),
          category: submission.category,
          subcategory: 'community report',
          occurredAt,
          locality: geocoded.locality,
          lat: geocoded.lat,
          lng: geocoded.lng,
          confidence: 0.35,
          sourceName: COMMUNITY_SOURCE_NAME,
          sourceUrl,
          sourceDomain: getSourceDomain(sourceUrl),
          title,
          summary: summarizeSubmissionIncident({ category: submission.category, locality: geocoded.locality, occurredAt }),
          publishedAt: new Date().toISOString()
        };

        const published = this.publishIncident(candidate);
        queueDetail.publishedCount += published ? 1 : 0;

        this.updateSubmissionQueueState.run('accepted', null, null, runId, new Date().toISOString(), submission.id);
      } catch (error) {
        queueDetail.errors.push({ stage: 'queue-item', submissionId: submission.id, message: error.message });
        this.updateSubmissionQueueState.run('error', null, error.message.slice(0, 1000), runId, new Date().toISOString(), submission.id);
      }
    }

    return queueDetail;
  }

  async debugArticleByUrl(url) {
    if (!url) throw new Error('Missing url parameter');
    if (!this.extractionService?.isConfigured?.()) {
      return { url, configured: false, error: 'Extraction service not configured' };
    }

    try {
      // Fetch article
      const fetchResult = await this.crawl4aiFetcher.fetchArticleContent(url, { timeoutMs: 30000 });
      const article = {
        sourceUrl: url,
        title: fetchResult.title || '',
        content: fetchResult.content || '',
        publishedAt: fetchResult.publishedAt || new Date().toISOString()
      };

      // Log article info
      console.log(`[debug] Article fetched: title="${article.title?.slice(0, 50)}...", contentLength=${article.content?.length}`);

      // Extract
      const extractionResult = await this.extractionService.extractIncident(article);

      // Geocode if location found
      let geocodeResult = null;
      if (extractionResult.success && extractionResult.extraction.locationText) {
        geocodeResult = await this.geoService.geocodeLocality(extractionResult.extraction.locationText);
      }

      return {
        url,
        configured: true,
        article: {
          title: article.title,
          contentLength: article.content.length,
          publishedAt: article.publishedAt
        },
        extraction: extractionResult.extraction,
        extractionSuccess: extractionResult.success,
        extractionError: extractionResult.error || null,
        geocodeResult,
        rawText: extractionResult.rawText
      };
    } catch (error) {
      console.error(`[debug] Error: ${error.message}`, error.stack);
      return { url, configured: true, error: error.message, stack: error.stack };
    }
  }

  async runIngestion({ trigger = 'manual' } = {}) {
    const startedAt = new Date();
    const runDetails = {
      trigger,
      pipelineMode: 'simple',
      configured: this.isConfigured(),
      publishThreshold: this.publishThreshold,
      limits: {
        maxArticlesPerSource: this.maxArticlesPerSource,
        articleTimeoutMs: this.articleTimeoutMs,
        sourceTimeBudgetMs: this.sourceTimeBudgetMs,
        runTimeBudgetMs: this.runTimeBudgetMs
      },
      sources: []
    };

    const runResult = this.insertRun.run(startedAt.toISOString(), 'running', JSON.stringify(runDetails));
    const runId = Number(runResult.lastInsertRowid);

    let processedCount = 0;
    let publishedCount = 0;
    let errorCount = 0;

    const persistProgress = () => {
      this.updateRunProgress.run(processedCount, publishedCount, errorCount, JSON.stringify(runDetails), runId);
    };

    // Process submission queue first
    try {
      const queueDetail = await this.processQueuedSubmissions(runId);
      runDetails.submissionQueue = queueDetail;
      processedCount += queueDetail.processedCount;
      publishedCount += queueDetail.publishedCount;
      errorCount += queueDetail.errors.length;
      persistProgress();
    } catch (error) {
      errorCount += 1;
      runDetails.submissionQueue = { error: error.message };
      persistProgress();
    }

    // Load sources
    const sources = this.selectEnabledSources.all();

    for (const source of sources) {
      // Check run budget
      if (Date.now() - startedAt.getTime() >= this.runTimeBudgetMs) {
        errorCount += 1;
        runDetails.runBudgetExceeded = true;
        runDetails.sources.push({
          sourceId: source.id,
          name: source.name,
          error: `Run exceeded ${this.runTimeBudgetMs}ms budget`
        });
        persistProgress();
        break;
      }

      const sourceStartedAt = Date.now();
      const sourceDetail = {
        sourceId: source.id,
        name: source.name,
        discoveredCount: 0,
        fetchedCount: 0,
        processedCount: 0,
        publishedCount: 0,
        rejectedCount: 0,
        errorCount: 0,
        errors: []
      };

      try {
        // Discover articles
        const includePatterns = source.include_patterns ? JSON.parse(source.include_patterns) : [];
        const excludePatterns = source.exclude_patterns ? JSON.parse(source.exclude_patterns) : [];
        const maxArticles = source.max_articles || this.maxArticlesPerSource;

        const discovered = await this.crawl4aiDiscovery.discoverArticles(
          source.homepage_url,
          includePatterns,
          excludePatterns
        );

        sourceDetail.discoveredCount = discovered.length;
        const articlesToProcess = discovered.slice(0, maxArticles);
        sourceDetail.fetchedCount = articlesToProcess.length;

        // Process each article
        for (const article of articlesToProcess) {
          if (Date.now() - sourceStartedAt >= this.sourceTimeBudgetMs) {
            sourceDetail.errors.push({ stage: 'budget', message: 'Source time budget exceeded' });
            break;
          }

          processedCount += 1;

          try {
            const result = await this.processArticle(article.url, source, runId);
            sourceDetail.processedCount += 1;

            if (result.published) {
              publishedCount += 1;
              sourceDetail.publishedCount += 1;
            } else if (result.reason === 'not_a_crime_event' || result.reason === 'low_confidence') {
              sourceDetail.rejectedCount += 1;
            }
          } catch (error) {
            errorCount += 1;
            sourceDetail.errorCount += 1;
            sourceDetail.errors.push({ url: article.url, message: error.message });
          }

          persistProgress();
        }

        this.markSourceSuccess.run(new Date().toISOString(), source.id);
      } catch (error) {
        errorCount += 1;
        sourceDetail.errorCount += 1;
        sourceDetail.errors.push({ stage: 'discovery', message: error.message });
        this.markSourceError.run(error.message.slice(0, 1000), source.id);
      }

      runDetails.sources.push(sourceDetail);
      persistProgress();
    }

    // Finalize run
    const status = errorCount === 0 ? 'success' : (processedCount > 0 || publishedCount > 0 ? 'partial' : 'error');
    const errorSummary = runDetails.sources
      .flatMap(s => s.errors || [])
      .slice(0, 5)
      .map(e => e.message)
      .join(' | ')
      .slice(0, 1000);

    this.finishRun.run(
      new Date().toISOString(),
      status,
      processedCount,
      publishedCount,
      errorCount,
      errorSummary || null,
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
      details: runDetails
    };
  }
}
