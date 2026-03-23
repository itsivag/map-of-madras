import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const EVIDENCE_SUPPORT_ORDER = ['offense', 'location', 'time', 'context'];
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

function parseLimit(rawLimit) {
  const parsed = Number(rawLimit || 500);
  if (!Number.isFinite(parsed)) {
    return 500;
  }
  return Math.max(1, Math.min(parsed, 2000));
}

function parseBBox(rawBBox) {
  if (!rawBBox) {
    return null;
  }

  const parts = rawBBox.split(',').map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((num) => !Number.isFinite(num))) {
    return null;
  }

  const [minLng, minLat, maxLng, maxLat] = parts;
  return { minLng, minLat, maxLng, maxLat };
}

function defaultFromIso() {
  const date = new Date();
  date.setDate(date.getDate() - 30);
  return date.toISOString();
}

function parseJson(value, fallback) {
  if (typeof value !== 'string' || !value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toIsoWindow(centerIso, dayOffset) {
  const date = new Date(centerIso || new Date().toISOString());
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }

  date.setDate(date.getDate() + dayOffset);
  return date.toISOString();
}

function normalizeAllowedOrigins(value) {
  if (!value || value === '*') {
    return '*';
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeSubmissionField(value, maxLength = 2000) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function createAnonymousReporterHash(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  const remoteAddress = normalizeSubmissionField(
    forwardedFor || req.socket?.remoteAddress || req.ip || '',
    200
  );
  const userAgent = normalizeSubmissionField(req.headers['user-agent'] || '', 300);
  const dayBucket = new Date().toISOString().slice(0, 10);

  return createHash('sha256')
    .update(`${dayBucket}|${remoteAddress}|${userAgent}|anonymous-submission-v1`)
    .digest('hex');
}

function validateSubmissionPayload(body) {
  const category = SUBMISSION_CATEGORY_SET.has(body?.category) ? body.category : 'other';
  const locality = normalizeSubmissionField(body?.locality, 160);
  const description = normalizeSubmissionField(body?.description, 2000);
  const sourceUrl = normalizeSubmissionField(body?.sourceUrl, 400);
  const honeypot = normalizeSubmissionField(body?.website, 120);
  const occurredAt = body?.occurredAt ? new Date(body.occurredAt) : null;

  if (!locality || locality.length < 3) {
    return { error: 'Locality must be at least 3 characters.' };
  }

  if (!description || description.length < 24) {
    return { error: 'Description must be at least 24 characters.' };
  }

  if (occurredAt && Number.isNaN(occurredAt.getTime())) {
    return { error: 'Occurred-at timestamp is invalid.' };
  }

  return {
    category,
    locality,
    description,
    sourceUrl,
    honeypot,
    occurredAt: occurredAt ? occurredAt.toISOString() : null
  };
}

function mapIncidentRow(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    category: row.category,
    subcategory: row.subcategory,
    occurredAt: row.occurred_at,
    locality: row.locality,
    lat: row.lat,
    lng: row.lng,
    confidence: row.confidence,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    publishedAt: row.published_at,
    summary: row.summary,
    title: row.title || null
  };
}

function groupEvidenceEntries(extraction, chunkRows) {
  const grouped = new Map();

  for (const chunkRow of chunkRows) {
    grouped.set(chunkRow.chunk_id, {
      chunkId: chunkRow.chunk_id,
      text: chunkRow.chunk_text,
      supports: []
    });
  }

  for (const entry of Array.isArray(extraction?.evidence) ? extraction.evidence : []) {
    if (!grouped.has(entry.chunkId)) {
      grouped.set(entry.chunkId, {
        chunkId: entry.chunkId,
        text: null,
        supports: []
      });
    }

    const current = grouped.get(entry.chunkId);
    if (!current.supports.includes(entry.supports)) {
      current.supports.push(entry.supports);
    }
  }

  return [...grouped.values()]
    .map((entry) => ({
      ...entry,
      supports: entry.supports.sort(
        (left, right) => EVIDENCE_SUPPORT_ORDER.indexOf(left) - EVIDENCE_SUPPORT_ORDER.indexOf(right)
      )
    }))
    .filter((entry) => entry.text || entry.supports.length > 0);
}

function getIncidentDetail(db, incidentId) {
  const incidentRow = db
    .prepare(
      `SELECT
         id,
         category,
         subcategory,
         occurred_at,
         locality,
         lat,
         lng,
         confidence,
         source_name,
         source_url,
         title,
         summary,
         published_at
       FROM incidents
       WHERE id = ? AND published_at IS NOT NULL
       LIMIT 1`
    )
    .get(incidentId);

  if (!incidentRow) {
    return null;
  }

  const incident = mapIncidentRow(incidentRow);
  const primaryArticleRow =
    db
      .prepare(
        `SELECT
           a.id AS article_id,
           a.source_name,
           a.source_url,
           a.title,
           a.published_at,
           a.created_at,
           s.id AS extraction_id,
           s.decision,
           s.confidence,
           s.rejection_reason,
           s.extraction_json
         FROM articles_raw a
         LEFT JOIN semantic_extractions s
           ON s.id = (
             SELECT se.id
             FROM semantic_extractions se
             WHERE se.article_id = a.id
             ORDER BY se.id DESC
             LIMIT 1
           )
         WHERE a.source_url = ?
         ORDER BY a.id DESC
         LIMIT 1`
      )
      .get(incident.sourceUrl) ||
    db
      .prepare(
        `SELECT
           a.id AS article_id,
           a.source_name,
           a.source_url,
           a.title,
           a.published_at,
           a.created_at,
           s.id AS extraction_id,
           s.decision,
           s.confidence,
           s.rejection_reason,
           s.extraction_json
         FROM articles_raw a
         LEFT JOIN semantic_extractions s
           ON s.id = (
             SELECT se.id
             FROM semantic_extractions se
             WHERE se.article_id = a.id
             ORDER BY se.id DESC
             LIMIT 1
           )
         WHERE a.title = ?
         ORDER BY a.id DESC
         LIMIT 1`
      )
      .get(incident.title);

  const extraction = parseJson(primaryArticleRow?.extraction_json, null);
  const chunkRows = primaryArticleRow?.article_id
    ? db
        .prepare(
          `SELECT chunk_id, chunk_text
           FROM article_chunks
           WHERE article_id = ?
           ORDER BY chunk_index ASC`
        )
        .all(primaryArticleRow.article_id)
    : [];

  const relatedRows = db
    .prepare(
      `SELECT
         id,
         category,
         subcategory,
         occurred_at,
         locality,
         lat,
         lng,
         confidence,
         source_name,
         source_url,
         title,
         summary,
         published_at
       FROM incidents
       WHERE published_at IS NOT NULL
         AND id != ?
         AND category = ?
         AND datetime(COALESCE(occurred_at, created_at)) BETWEEN datetime(?) AND datetime(?)
         AND lat BETWEEN ? AND ?
         AND lng BETWEEN ? AND ?
       ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
       LIMIT 8`
    )
    .all(
      incident.id,
      incident.category,
      toIsoWindow(incident.occurredAt, -3),
      toIsoWindow(incident.occurredAt, 3),
      incident.lat - 0.03,
      incident.lat + 0.03,
      incident.lng - 0.03,
      incident.lng + 0.03
    );

  const supportingArticles = [
    {
      incidentId: incident.id,
      title: incident.title,
      sourceName: incident.sourceName,
      sourceUrl: incident.sourceUrl,
      publishedAt: incident.publishedAt,
      occurredAt: incident.occurredAt,
      locality: incident.locality,
      category: incident.category,
      summary: incident.summary,
      confidence: incident.confidence,
      isPrimary: true
    },
    ...relatedRows.map((row) => {
      const relatedIncident = mapIncidentRow(row);
      return {
        incidentId: relatedIncident.id,
        title: relatedIncident.title,
        sourceName: relatedIncident.sourceName,
        sourceUrl: relatedIncident.sourceUrl,
        publishedAt: relatedIncident.publishedAt,
        occurredAt: relatedIncident.occurredAt,
        locality: relatedIncident.locality,
        category: relatedIncident.category,
        summary: relatedIncident.summary,
        confidence: relatedIncident.confidence,
        isPrimary: false
      };
    })
  ];

  return {
    incident,
    primaryArticle: primaryArticleRow
      ? {
          articleId: primaryArticleRow.article_id,
          sourceName: primaryArticleRow.source_name,
          sourceUrl: primaryArticleRow.source_url,
          title: primaryArticleRow.title,
          publishedAt: primaryArticleRow.published_at,
          indexedAt: primaryArticleRow.created_at,
          decision: primaryArticleRow.decision || null,
          confidence:
            typeof primaryArticleRow.confidence === 'number'
              ? primaryArticleRow.confidence
              : extraction?.confidence || null,
          rejectionReason: primaryArticleRow.rejection_reason || null
        }
      : null,
    extraction: extraction
      ? {
          category: extraction.category,
          subcategory: extraction.subcategory,
          occurredAt: extraction.occurredAt,
          locationText: extraction.locationText,
          locationPrecision: extraction.locationPrecision,
          confidence: extraction.confidence
        }
      : null,
    evidence: groupEvidenceEntries(extraction, chunkRows),
    supportingArticles
  };
}

function buildIncidentsQuery(query) {
  const conditions = ['published_at IS NOT NULL'];
  const params = [];

  const from = query.from || defaultFromIso();
  const to = query.to || new Date().toISOString();

  conditions.push("datetime(COALESCE(occurred_at, created_at)) >= datetime(?)");
  params.push(from);
  conditions.push("datetime(COALESCE(occurred_at, created_at)) <= datetime(?)");
  params.push(to);

  if (query.category && query.category !== 'all') {
    const categories = query.category
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (categories.length > 0) {
      conditions.push(`category IN (${categories.map(() => '?').join(', ')})`);
      params.push(...categories);
    }
  }

  const bbox = parseBBox(query.bbox);
  if (bbox) {
    conditions.push('lng BETWEEN ? AND ?');
    conditions.push('lat BETWEEN ? AND ?');
    params.push(bbox.minLng, bbox.maxLng, bbox.minLat, bbox.maxLat);
  }

  const limit = parseLimit(query.limit);

  const sql = `
    SELECT
      id,
      category,
      subcategory,
      occurred_at,
      locality,
      lat,
      lng,
      confidence,
      source_name,
      source_url,
      title,
      published_at,
      summary
    FROM incidents
    WHERE ${conditions.join(' AND ')}
    ORDER BY datetime(COALESCE(occurred_at, created_at)) DESC
    LIMIT ?
  `;

  params.push(limit);

  return { sql, params, from, to, limit, bbox };
}

export function createApp({
  db,
  ingestService,
  geoService,
  rootDir,
  corsAllowedOrigins = '*',
  adminToken = '',
  pipelineMode = 'semantic'
}) {
  const app = express();
  const frontendDir = path.join(rootDir, 'out');
  const frontendIndexPath = path.join(frontendDir, 'index.html');
  const hasBuiltFrontend = fs.existsSync(frontendIndexPath);
  const allowedOrigins = normalizeAllowedOrigins(corsAllowedOrigins);
  const selectIncidentSources = db.prepare(`
    SELECT
      incident_id,
      source_name,
      source_url,
      source_domain,
      title,
      published_at
    FROM incident_sources
    WHERE incident_id IN (${Array(2000).fill('?').join(', ')})
    ORDER BY datetime(COALESCE(published_at, created_at)) DESC, id DESC
  `);

  app.use(express.json());
  app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (allowedOrigins === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  });
  app.use('/geo', express.static(path.join(rootDir, 'geo')));

  function requireAdmin(req, res, next) {
    if (!adminToken) {
      next();
      return;
    }

    const authorization = String(req.headers.authorization || '');
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

    if (token !== adminToken) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  }

  app.get('/api/incidents', (req, res) => {
    const { sql, params, from, to, limit } = buildIncidentsQuery(req.query);
    const rows = db.prepare(sql).all(...params);
    const incidentIds = rows.map((row) => row.id);
    const sourceRows =
      incidentIds.length > 0
        ? selectIncidentSources.all(...incidentIds, ...Array(2000 - incidentIds.length).fill(-1))
        : [];
    const sourcesByIncident = new Map();

    for (const row of sourceRows) {
      const existing = sourcesByIncident.get(row.incident_id) || [];
      existing.push({
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        sourceDomain: row.source_domain,
        title: row.title,
        publishedAt: row.published_at
      });
      sourcesByIncident.set(row.incident_id, existing);
    }

    const incidents = rows.map((row) => {
      const sources = sourcesByIncident.get(row.id) || [];
      const sourceTitle = sources.find((source) => source.title)?.title || null;

      return {
        id: row.id,
        category: row.category,
        subcategory: row.subcategory,
        occurredAt: row.occurred_at,
        locality: row.locality,
        lat: row.lat,
        lng: row.lng,
        confidence: row.confidence,
        sourceName: row.source_name,
        sourceUrl: row.source_url,
        title: row.title || sourceTitle,
        publishedAt: row.published_at,
        summary: row.summary,
        sourceCount: sources.length || (row.source_url ? 1 : 0),
        sources: sources.length
          ? sources
          : row.source_url
            ? [
                {
                  sourceName: row.source_name,
                  sourceUrl: row.source_url,
                  sourceDomain: null,
                  title: row.title || null,
                  publishedAt: row.published_at
                }
              ]
            : []
      };
    });

    res.json({
      filters: {
        from,
        to,
        limit
      },
      incidents
    });
  });

  app.get('/api/incidents/:id', (req, res) => {
    const incidentId = Number(req.params.id);
    if (!Number.isInteger(incidentId) || incidentId <= 0) {
      res.status(400).json({ error: 'Invalid incident id.' });
      return;
    }

    const detail = getIncidentDetail(db, incidentId);
    if (!detail) {
      res.status(404).json({ error: 'Incident not found.' });
      return;
    }

    res.json(detail);
  });

  app.get('/api/meta', (req, res) => {
    const lastRun = db
      .prepare(
        `SELECT id, started_at, finished_at, status, processed_count, published_count, error_count, error_summary
         FROM ingestion_runs
         ORDER BY id DESC
         LIMIT 1`
      )
      .get();

    const categoryCounts = db
      .prepare(
        `SELECT category, COUNT(*) as count
         FROM incidents
         WHERE published_at IS NOT NULL
         GROUP BY category
         ORDER BY count DESC`
      )
      .all();

    const sourceHealth = db
      .prepare(
        `SELECT id, name, enabled, homepage_url, feed_url, last_success_at, last_error
         FROM sources
         ORDER BY name ASC`
      )
      .all();

    const isConfigured = typeof ingestService.isConfigured === 'function' 
      ? ingestService.isConfigured() 
      : (typeof ingestService.isSemanticConfigured === 'function' ? ingestService.isSemanticConfigured() : false);

    res.json({
      disclaimer:
        'Markers are derived from AI-processed news reports and may contain errors. This is not an official police record.',
      lastRun,
      categoryCounts,
      sourceHealth,
      pipeline: {
        mode: pipelineMode,
        configured: isConfigured,
        semanticConfigured: isConfigured  // Backward compatibility
      },
      boundary: {
        maxBounds: geoService.bounds.leafletMaxBounds,
        bbox: {
          minLng: geoService.bounds.minLng,
          minLat: geoService.bounds.minLat,
          maxLng: geoService.bounds.maxLng,
          maxLat: geoService.bounds.maxLat
        }
      }
    });
  });

  app.post('/api/reports', (req, res) => {
    if (typeof ingestService?.queueIncidentSubmission !== 'function') {
      res.status(503).json({ error: 'Anonymous report queue is unavailable.' });
      return;
    }

    const payload = validateSubmissionPayload(req.body);
    if (payload.error) {
      res.status(400).json({ error: payload.error });
      return;
    }

    if (payload.honeypot) {
      res.status(202).json({
        status: 'queued',
        message: 'Report queued for the next ingestion run.'
      });
      return;
    }

    const result = ingestService.queueIncidentSubmission({
      reporterHash: createAnonymousReporterHash(req),
      category: payload.category,
      locality: payload.locality,
      occurredAt: payload.occurredAt,
      description: payload.description,
      sourceUrl: payload.sourceUrl
    });

    if (result.status === 'rate_limited') {
      res.status(429).json({
        status: 'rate_limited',
        message: 'Too many anonymous reports from this device recently. Try again later.',
        retryAfterHours: result.retryAfterHours
      });
      return;
    }

    if (result.status === 'duplicate') {
      res.status(200).json({
        status: 'duplicate',
        message: 'A similar report is already queued.'
      });
      return;
    }

    res.status(202).json({
      status: 'queued',
      queueId: result.queueId,
      message: 'Report queued for the next ingestion run.'
    });
  });

  app.get('/api/debug/article', requireAdmin, async (req, res, next) => {
    try {
      const url = String(req.query.url || '').trim();
      if (!url) {
        res.status(400).json({ error: 'Missing url query parameter.' });
        return;
      }

      const result = await ingestService.debugArticleByUrl(url);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/boundary', (req, res) => {
    res.json(geoService.boundaryGeoJson);
  });

  app.post('/api/ingest/run', requireAdmin, async (req, res, next) => {
    try {
      const result = await ingestService.runIngestion({ trigger: 'manual' });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get('/health', (req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  if (hasBuiltFrontend) {
    app.use(express.static(frontendDir));

    app.get('/', (req, res) => {
      res.sendFile(frontendIndexPath);
    });
  } else {
    app.get('/', (req, res) => {
      res.json({
        name: 'Map of Madras API',
        ok: true,
        frontend:
          'Deploy the Next.js frontend from this repository to Firebase Hosting or run `npm run dev:web` locally.',
        endpoints: ['/api/incidents', '/api/incidents/:id', '/api/meta', '/api/boundary', '/health']
      });
    });
  }

  app.use((error, req, res, next) => {
    const message = error?.message || 'Unknown server error';
    res.status(500).json({ error: message });
  });

  return app;
}
