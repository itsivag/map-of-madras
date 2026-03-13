import express from 'express';
import path from 'node:path';

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

export function createApp({ db, ingestService, geoService, rootDir }) {
  const app = express();

  app.use(express.json());
  app.use('/geo', express.static(path.join(rootDir, 'geo')));
  app.use(express.static(path.join(rootDir, 'public')));

  app.get('/api/incidents', (req, res) => {
    const { sql, params, from, to, limit } = buildIncidentsQuery(req.query);
    const rows = db.prepare(sql).all(...params);

    const incidents = rows.map((row) => ({
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
      summary: row.summary
    }));

    res.json({
      filters: {
        from,
        to,
        limit
      },
      incidents
    });
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
        `SELECT id, name, enabled, feed_url, last_success_at, last_error
         FROM sources
         ORDER BY name ASC`
      )
      .all();

    res.json({
      disclaimer:
        'Markers are derived from news reports and may contain errors. This is not an official police record.',
      lastRun,
      categoryCounts,
      sourceHealth,
      pipeline: {
        mode: ingestService.pipelineMode || 'semantic',
        semanticConfigured:
          typeof ingestService.isSemanticConfigured === 'function'
            ? ingestService.isSemanticConfigured()
            : false
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

  app.get('/api/debug/article', async (req, res, next) => {
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

  app.post('/api/ingest/run', async (req, res, next) => {
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

  app.get(/.*/, (req, res) => {
    res.sendFile(path.join(rootDir, 'public', 'index.html'));
  });

  app.use((error, req, res, next) => {
    const message = error?.message || 'Unknown server error';
    res.status(500).json({ error: message });
  });

  return app;
}
