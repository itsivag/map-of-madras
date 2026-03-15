import {
  buildArticleContentHash,
  canonicalizeArticleUrl,
  getSourceDomain,
  hashContent
} from './articleUtils.js';
import {
  buildSourceFingerprint,
  isLikelySameIncident,
  scoreIncidentMatch
} from './dedupe.js';

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

function withPromiseTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }

  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms.`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeCronValue(rawValue, fallback) {
  const value = Number(rawValue);
  return Number.isInteger(value) ? value : fallback;
}

function matchesCronSegment(segment, value, { min, max, sundayAliases = false }) {
  const [base, stepRaw] = segment.split('/');
  const step = stepRaw ? Number(stepRaw) : 1;
  if (!Number.isInteger(step) || step <= 0) {
    return false;
  }

  const normalize = (input) => {
    if (sundayAliases && input === 7) {
      return 0;
    }

    return input;
  };

  let rangeStart = min;
  let rangeEnd = max;

  if (base && base !== '*') {
    if (base.includes('-')) {
      const [rawStart, rawEnd] = base.split('-').map((entry) => normalizeCronValue(entry, NaN));
      rangeStart = normalize(rawStart);
      rangeEnd = normalize(rawEnd);
    } else {
      const exactValue = normalize(normalizeCronValue(base, NaN));
      return exactValue === normalize(value);
    }
  }

  if (!Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd)) {
    return false;
  }

  if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
    return false;
  }

  const normalizedValue = normalize(value);
  if (normalizedValue < rangeStart || normalizedValue > rangeEnd) {
    return false;
  }

  return (normalizedValue - rangeStart) % step === 0;
}

function matchesCronField(field, value, options) {
  return field
    .split(',')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .some((segment) => matchesCronSegment(segment, value, options));
}

function matchesCronExpression(expression, date) {
  const parts = String(expression || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    matchesCronField(minute, date.getUTCMinutes(), { min: 0, max: 59 }) &&
    matchesCronField(hour, date.getUTCHours(), { min: 0, max: 23 }) &&
    matchesCronField(dayOfMonth, date.getUTCDate(), { min: 1, max: 31 }) &&
    matchesCronField(month, date.getUTCMonth() + 1, { min: 1, max: 12 }) &&
    matchesCronField(dayOfWeek, date.getUTCDay(), { min: 0, max: 7, sundayAliases: true })
  );
}

function getPreviousCronBoundary(cronExpression, referenceDate) {
  const probe = new Date(referenceDate.getTime());
  probe.setUTCSeconds(0, 0);
  probe.setUTCMinutes(probe.getUTCMinutes() - 1);

  for (let steps = 0; steps < 60 * 24 * 14; steps += 1) {
    if (matchesCronExpression(cronExpression, probe)) {
      return probe;
    }

    probe.setUTCMinutes(probe.getUTCMinutes() - 1);
  }

  const fallback = new Date(referenceDate.getTime());
  fallback.setUTCHours(fallback.getUTCHours() - 1, 0, 0, 0);
  return fallback;
}

function buildIngestionWindow({
  trigger,
  cronExpression,
  referenceDate,
  manualLookbackHours,
  overlapMinutes
}) {
  const overlapMs = Math.max(0, Number(overlapMinutes) || 0) * 60 * 1000;
  const to = new Date(referenceDate.getTime());

  if (trigger === 'manual') {
    const lookbackHours = Math.max(1, Number(manualLookbackHours) || 4);
    return {
      from: new Date(referenceDate.getTime() - lookbackHours * 60 * 60 * 1000 - overlapMs),
      to,
      mode: 'manual_recent',
      lookbackHours,
      overlapMinutes: Math.max(0, Number(overlapMinutes) || 0)
    };
  }

  if (trigger === 'scheduler' || trigger === 'startup') {
    const previousBoundary = getPreviousCronBoundary(cronExpression, referenceDate);
    return {
      from: new Date(previousBoundary.getTime() - overlapMs),
      to,
      mode: 'scheduled_cron',
      lookbackHours: null,
      overlapMinutes: Math.max(0, Number(overlapMinutes) || 0)
    };
  }

  return null;
}

function isWithinIngestionWindow(value, window) {
  const timestamp = parseTimestamp(value);
  if (!timestamp || !window?.from || !window?.to) {
    return false;
  }

  return timestamp.getTime() >= window.from.getTime() && timestamp.getTime() <= window.to.getTime();
}

const CRIME_HINT_PATTERNS = [
  /\bmurder\b/i,
  /\bkilled\b/i,
  /\bdeath\b/i,
  /\bdead\b/i,
  /\brape\b/i,
  /\bsexual(?:ly)? assault/i,
  /\bassault\b/i,
  /\brobber(?:y|ies)?\b/i,
  /\btheft\b/i,
  /\bburglary\b/i,
  /\bchain snatch/i,
  /\bkidnap(?:ped|ping)?\b/i,
  /\babduction\b/i,
  /\bscam\b/i,
  /\bfraud\b/i,
  /\bcheat(?:ing|ed)?\b/i,
  /\bcyber ?crime\b/i,
  /\bganja\b/i,
  /\bnarcotic/i,
  /\bdrug\b/i,
  /\barrest(?:ed)?\b/i,
  /\bheld\b/i,
  /\bdetained\b/i,
  /\bbooked\b/i,
  /\bhacked to death\b/i,
  /\bbeat(?:en)? to death\b/i,
  /\battack(?:ed)?\b/i,
  /\bstabbed\b/i
];

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

function normalizeSubmissionText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function buildSubmissionFingerprint({ category, locality, occurredAt, description, sourceUrl }) {
  const occurredDate = toIsoOrNull(occurredAt)?.slice(0, 10) || 'unknown-date';
  return hashContent(
    [
      category,
      normalizeSubmissionText(locality).toLowerCase(),
      occurredDate,
      normalizeSubmissionText(description).toLowerCase(),
      canonicalizeArticleUrl(sourceUrl || '')
    ].join('|')
  );
}

function buildSubmissionSourceUrl(queueId) {
  return `https://user-report.local/submissions/${queueId}`;
}

function buildSubmissionTitle({ category, locality, description }) {
  const compactDescription = normalizeSubmissionText(description);
  const summary = compactDescription.slice(0, 90).replace(/[.!?]\s.*$/, '');
  const where = normalizeSubmissionText(locality) || 'Chennai';
  return summary || `${category} report near ${where}`;
}

function summarizeSubmissionIncident({ category, locality, occurredAt }) {
  const dateLabel = occurredAt ? occurredAt.slice(0, 10) : 'unknown date';
  const where = locality ? `near ${locality}` : 'in Chennai';
  return `Anonymous community report for ${category} incident ${where} on ${dateLabel}. Verify independently.`;
}

function isLikelyCrimeFeedItem(item) {
  const haystack = [item?.title, item?.feedSummary, item?.feedContent]
    .filter(Boolean)
    .join(' ')
    .trim();

  if (!haystack) {
    return true;
  }

  return CRIME_HINT_PATTERNS.some((pattern) => pattern.test(haystack));
}

function shouldApplyCrimeKeywordFilter(source) {
  return Boolean(source?.crime_keyword_filter ?? source?.crimeKeywordFilter);
}

export class IngestService {
  constructor({
    db,
    rssService,
    geoService = null,
    semanticPipeline = null,
    pipelineMode = 'semantic',
    publishThreshold = 0.8,
    ingestCron = '0 * * * *',
    manualLookbackHours = 4,
    ingestionWindowOverlapMinutes = 30,
    maxItemsPerSource = 6,
    sourceTimeBudgetMs = 90000,
    itemTimeoutMs = 20000,
    runTimeBudgetMs = 120000
  }) {
    this.db = db;
    this.rssService = rssService;
    this.geoService = geoService;
    this.semanticPipeline = semanticPipeline;
    this.pipelineMode = pipelineMode === 'shadow' ? 'shadow' : 'semantic';
    this.publishThreshold = publishThreshold;
    this.ingestCron = ingestCron;
    this.manualLookbackHours = Number.isFinite(manualLookbackHours) ? manualLookbackHours : 4;
    this.ingestionWindowOverlapMinutes = Number.isFinite(ingestionWindowOverlapMinutes)
      ? ingestionWindowOverlapMinutes
      : 30;
    this.maxItemsPerSource = Number.isFinite(maxItemsPerSource) ? maxItemsPerSource : 6;
    this.sourceTimeBudgetMs = Number.isFinite(sourceTimeBudgetMs) ? sourceTimeBudgetMs : 90000;
    this.itemTimeoutMs = Number.isFinite(itemTimeoutMs) ? itemTimeoutMs : 20000;
    this.runTimeBudgetMs = Number.isFinite(runTimeBudgetMs) ? runTimeBudgetMs : 120000;

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

    this.updateRunProgress = db.prepare(`
      UPDATE ingestion_runs
      SET
        processed_count = ?,
        published_count = ?,
        error_count = ?,
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
      crime_keyword_filter,
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
      crime_keyword_filter,
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

    this.selectIncidentMergeCandidates = db.prepare(`
      SELECT
        id,
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
        published_at
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

    this.updateIncidentCanonical = db.prepare(`
      UPDATE incidents
      SET
        dedupe_key = ?,
        category = ?,
        subcategory = ?,
        occurred_at = ?,
        locality = ?,
        lat = ?,
        lng = ?,
        confidence = ?,
        source_name = ?,
        source_url = ?,
        source_domain = ?,
        title = ?,
        summary = ?,
        published_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `);

    this.selectIncidentById = db.prepare(`
      SELECT
        id,
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
        published_at
      FROM incidents
      WHERE id = ?
    `);

    this.selectIncidentSourceByFingerprint = db.prepare(`
      SELECT id, incident_id
      FROM incident_sources
      WHERE source_fingerprint = ?
      LIMIT 1
    `);

    this.insertIncidentSource = db.prepare(`
      INSERT INTO incident_sources (
        incident_id,
        source_fingerprint,
        source_name,
        source_url,
        source_domain,
        title,
        published_at,
        updated_at
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

    this.selectSubmissionByFingerprint = db.prepare(`
      SELECT id, status
      FROM submission_queue
      WHERE submission_fingerprint = ?
      LIMIT 1
    `);

    this.countRecentReporterSubmissions = db.prepare(`
      SELECT COUNT(*) AS count
      FROM submission_queue
      WHERE reporter_hash = ?
        AND datetime(created_at) >= datetime(?)
    `);

    this.insertSubmissionQueue = db.prepare(`
      INSERT INTO submission_queue (
        reporter_hash,
        submission_fingerprint,
        category,
        locality,
        occurred_at,
        description,
        source_url,
        status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', datetime('now'))
    `);

    this.selectQueuedSubmissions = db.prepare(`
      SELECT
        id,
        reporter_hash,
        submission_fingerprint,
        category,
        locality,
        occurred_at,
        description,
        source_url,
        status,
        created_at
      FROM submission_queue
      WHERE status = 'queued'
      ORDER BY datetime(created_at) ASC, id ASC
      LIMIT ?
    `);

    this.updateSubmissionQueueState = db.prepare(`
      UPDATE submission_queue
      SET
        status = ?,
        processed_incident_id = ?,
        last_error = ?,
        run_id = ?,
        processed_at = ?,
        updated_at = datetime('now')
      WHERE id = ?
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

    const canonicalSourceUrl = canonicalizeArticleUrl(candidate.sourceUrl);
    const sourceFingerprint = buildSourceFingerprint({
      sourceUrl: canonicalSourceUrl,
      title: candidate.title
    });
    const existingSource = this.selectIncidentSourceByFingerprint.get(sourceFingerprint);

    if (existingSource) {
      return false;
    }

    const mergeMatch = this.findMergeTarget(candidate);

    if (mergeMatch) {
      const merged = this.mergeIntoIncident(mergeMatch.id, candidate);
      this.attachIncidentSource(merged.id, candidate, canonicalSourceUrl, sourceFingerprint);
      return false;
    }

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
    const from = new Date(occurredAt);
    const to = new Date(occurredAt);
    from.setHours(from.getHours() - 24);
    to.setHours(to.getHours() + 24);

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
    }, candidate)
      ? bestMatch
      : null;
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
      sourceUrl: shouldPromoteSource
        ? canonicalizeArticleUrl(candidate.sourceUrl)
        : existing.source_url,
      sourceDomain: shouldPromoteSource ? candidate.sourceDomain : existing.source_domain,
      title: shouldPromoteSource ? candidate.title : existing.title,
      summary: existing.summary || candidate.summary,
      publishedAt: existing.published_at || candidate.publishedAt
    };

    this.updateIncidentCanonical.run(
      merged.dedupeKey,
      merged.category,
      merged.subcategory,
      merged.occurredAt,
      merged.locality,
      merged.lat,
      merged.lng,
      merged.confidence,
      merged.sourceName,
      merged.sourceUrl,
      merged.sourceDomain,
      merged.title,
      merged.summary,
      merged.publishedAt,
      incidentId
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

  queueIncidentSubmission({
    reporterHash,
    category,
    locality,
    occurredAt = null,
    description,
    sourceUrl = ''
  }) {
    const normalizedReporterHash = normalizeSubmissionText(reporterHash);
    const normalizedCategory = SUBMISSION_CATEGORY_SET.has(category) ? category : 'other';
    const normalizedLocality = normalizeSubmissionText(locality).slice(0, 160);
    const normalizedDescription = normalizeSubmissionText(description).slice(0, 2000);
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
      return {
        queued: false,
        status: 'duplicate',
        queueId: existing.id
      };
    }

    const windowStart = new Date(
      Date.now() - SUBMISSION_RATE_LIMIT_WINDOW_HOURS * 60 * 60 * 1000
    ).toISOString();
    const recentCount = Number(
      this.countRecentReporterSubmissions.get(normalizedReporterHash, windowStart)?.count || 0
    );

    if (recentCount >= SUBMISSION_RATE_LIMIT_MAX) {
      return {
        queued: false,
        status: 'rate_limited',
        retryAfterHours: SUBMISSION_RATE_LIMIT_WINDOW_HOURS
      };
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

    return {
      queued: true,
      status: 'queued',
      queueId: Number(result.lastInsertRowid)
    };
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

    if (!queuedSubmissions.length) {
      return queueDetail;
    }

    if (!this.geoService) {
      queueDetail.errors.push({
        stage: 'queue',
        message: 'Geo service is not configured for queued submissions.'
      });

      for (const submission of queuedSubmissions) {
        this.updateSubmissionQueueState.run(
          'error',
          null,
          'Geo service unavailable.',
          runId,
          new Date().toISOString(),
          submission.id
        );
      }

      return queueDetail;
    }

    for (const submission of queuedSubmissions) {
      try {
        queueDetail.processedCount += 1;
        const geocoded = await this.geoService.geocodeLocality(submission.locality);

        if (!geocoded) {
          queueDetail.rejectedCount += 1;
          this.updateSubmissionQueueState.run(
            'rejected',
            null,
            'Unable to geocode the submitted locality inside Chennai.',
            runId,
            new Date().toISOString(),
            submission.id
          );
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
          summary: summarizeSubmissionIncident({
            category: submission.category,
            locality: geocoded.locality,
            occurredAt
          }),
          publishedAt: new Date().toISOString()
        };
        const canonicalSourceUrl = canonicalizeArticleUrl(candidate.sourceUrl);
        const sourceFingerprint = buildSourceFingerprint({
          sourceUrl: canonicalSourceUrl,
          title: candidate.title
        });
        const mergeTarget = this.findMergeTarget(candidate);
        const directTarget = this.selectIncidentByDedupe.get(candidate.dedupe.key);
        const published = this.publishIncident(candidate);
        const linkedIncident = this.selectIncidentSourceByFingerprint.get(sourceFingerprint);

        queueDetail.publishedCount += published ? 1 : 0;

        this.updateSubmissionQueueState.run(
          mergeTarget || directTarget || linkedIncident ? 'accepted' : 'accepted',
          linkedIncident?.incident_id || mergeTarget?.id || directTarget?.id || null,
          null,
          runId,
          new Date().toISOString(),
          submission.id
        );
      } catch (error) {
        queueDetail.errors.push({
          stage: 'queue-item',
          submissionId: submission.id,
          message: error.message
        });
        this.updateSubmissionQueueState.run(
          'error',
          null,
          error.message.slice(0, 1000),
          runId,
          new Date().toISOString(),
          submission.id
        );
      }
    }

    return queueDetail;
  }

  async processItem({ source, item, runId, ingestionWindow = null }) {
    const article = await this.rssService.enrichItem(source, item);

    if (ingestionWindow && !isWithinIngestionWindow(article.publishedAt, ingestionWindow)) {
      return {
        published: false,
        article,
        articleRow: null,
        semanticResult: {
          stage: 'window_filtered',
          decision: 'skip',
          rejectionReason: 'Article published outside the active ingestion window.',
          incidentCandidate: null
        },
        windowFiltered: true
      };
    }

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
    const startedAtDate = new Date();
    const startedAt = startedAtDate.toISOString();
    const ingestionWindow = buildIngestionWindow({
      trigger,
      cronExpression: this.ingestCron,
      referenceDate: startedAtDate,
      manualLookbackHours: this.manualLookbackHours,
      overlapMinutes: this.ingestionWindowOverlapMinutes
    });
    const runDetails = {
      trigger,
      pipelineMode: this.pipelineMode,
      semanticConfigured: this.isSemanticConfigured(),
      publishThreshold: this.publishThreshold,
      ingestionWindow: ingestionWindow
        ? {
            from: ingestionWindow.from.toISOString(),
            to: ingestionWindow.to.toISOString(),
            mode: ingestionWindow.mode,
            lookbackHours: ingestionWindow.lookbackHours,
            overlapMinutes: ingestionWindow.overlapMinutes
          }
        : null,
      limits: {
        ingestCron: this.ingestCron,
        manualLookbackHours: this.manualLookbackHours,
        ingestionWindowOverlapMinutes: this.ingestionWindowOverlapMinutes,
        maxItemsPerSource: this.maxItemsPerSource,
        sourceTimeBudgetMs: this.sourceTimeBudgetMs,
        itemTimeoutMs: this.itemTimeoutMs,
        runTimeBudgetMs: this.runTimeBudgetMs
      },
      sources: []
    };

    const runResult = this.insertRun.run(startedAt, 'running', JSON.stringify(runDetails));
    const runId = Number(runResult.lastInsertRowid);
    let processedCount = 0;
    let publishedCount = 0;
    let errorCount = 0;
    let stoppedEarly = false;

    const sources = this.selectEnabledSources.all();
    const persistProgress = () => {
      this.updateRunProgress.run(
        processedCount,
        publishedCount,
        errorCount,
        JSON.stringify(runDetails),
        runId
      );
    };

    try {
      const queueDetail = await this.processQueuedSubmissions(runId);
      runDetails.submissionQueue = queueDetail;
      processedCount += queueDetail.processedCount;
      publishedCount += queueDetail.publishedCount;
      errorCount += queueDetail.errors.length;
      persistProgress();
    } catch (error) {
      errorCount += 1;
      runDetails.submissionQueue = {
        sourceId: 'submission-queue',
        name: 'Anonymous submission queue',
        discoveredCount: 0,
        fetchedCount: 0,
        processedCount: 0,
        publishedCount: 0,
        rejectedCount: 0,
        skippedCount: 0,
        errors: [
          {
            stage: 'queue',
            message: error.message
          }
        ]
      };
      persistProgress();
    }

    for (const source of sources) {
      if (Date.now() - Date.parse(startedAt) >= this.runTimeBudgetMs) {
        errorCount += 1;
        stoppedEarly = true;
        runDetails.runBudgetExceeded = true;
        runDetails.sources.push({
          sourceId: source.id,
          name: source.name,
          discoveredCount: 0,
          fetchedCount: 0,
          processedCount: 0,
          publishedCount: 0,
          rejectedCount: 0,
          skippedCount: 0,
          errors: [
            {
              stage: 'run-budget',
              message: `Run exceeded ${this.runTimeBudgetMs}ms total budget and stopped before processing this source.`
            }
          ]
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
        skippedCount: 0,
        windowSkippedCount: 0,
        keywordSkippedCount: 0,
        errors: []
      };

      try {
        const discoveredItems = await this.rssService.fetchFeedItems(source);
        sourceDetail.discoveredCount = discoveredItems.length;
        const windowEligibleItems = discoveredItems.filter((item) => {
          if (!ingestionWindow) {
            return true;
          }

          if (!item?.publishedAt) {
            return true;
          }

          return isWithinIngestionWindow(item.publishedAt, ingestionWindow);
        });
        sourceDetail.windowSkippedCount = Math.max(0, discoveredItems.length - windowEligibleItems.length);
        const keywordEligibleItems = shouldApplyCrimeKeywordFilter(source)
          ? windowEligibleItems.filter((item) => isLikelyCrimeFeedItem(item))
          : windowEligibleItems;
        sourceDetail.keywordSkippedCount = shouldApplyCrimeKeywordFilter(source)
          ? Math.max(0, windowEligibleItems.length - keywordEligibleItems.length)
          : 0;
        const items = keywordEligibleItems.slice(0, this.maxItemsPerSource);
        sourceDetail.fetchedCount = items.length;
        sourceDetail.skippedCount =
          sourceDetail.windowSkippedCount +
          sourceDetail.keywordSkippedCount +
          Math.max(0, keywordEligibleItems.length - items.length);

        if (sourceDetail.windowSkippedCount > 0) {
          sourceDetail.errors.push({
            stage: 'window',
            message: `${sourceDetail.windowSkippedCount} items were outside the ingestion window.`
          });
        }

        if (sourceDetail.keywordSkippedCount > 0) {
          sourceDetail.errors.push({
            stage: 'keyword',
            message: `${sourceDetail.keywordSkippedCount} items were skipped because they did not look crime-related.`
          });
        }

        if (keywordEligibleItems.length > items.length) {
          sourceDetail.errors.push({
            stage: 'limit',
            message: `Source capped at ${this.maxItemsPerSource} items for this run.`
          });
        }

        for (const item of items) {
          if (Date.now() - sourceStartedAt >= this.sourceTimeBudgetMs) {
            errorCount += 1;
            sourceDetail.errors.push({
              stage: 'budget',
              message: `Source exceeded ${this.sourceTimeBudgetMs}ms time budget and was stopped early.`
            });
            break;
          }

          processedCount += 1;

          try {
            const result = await withPromiseTimeout(
              this.processItem({ source, item, runId, ingestionWindow }),
              this.itemTimeoutMs,
              `Item processing for ${item.link || source.name}`
            );

            if (result.windowFiltered) {
              sourceDetail.windowSkippedCount += 1;
              sourceDetail.skippedCount += 1;
            } else {
              sourceDetail.processedCount += 1;
            }

            if (result.published) {
              publishedCount += 1;
              sourceDetail.publishedCount += 1;
            } else if (!result.windowFiltered && result.semanticResult?.decision !== 'publish') {
              sourceDetail.rejectedCount += 1;
            }
          } catch (error) {
            errorCount += 1;
            sourceDetail.errors.push({
              url: item.link || null,
              message: error.message
            });
          }

          persistProgress();
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
      persistProgress();
    }

    const status = stoppedEarly
      ? processedCount > 0 || publishedCount > 0
        ? 'partial'
        : 'error'
      : errorCount === 0
        ? 'success'
        : processedCount > 0 || publishedCount > 0
          ? 'partial'
          : 'error';
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
