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

export function createApp({ db, ingestService, geoService, officialSourceService = null, rootDir }) {
  const app = express();
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
  app.use('/geo', express.static(path.join(rootDir, 'geo')));
  app.use(express.static(path.join(rootDir, 'public')));

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
        sourceCount: sources.length || (row.source_url ? 1 : 0),
        sources: sources.length
          ? sources
          : row.source_url
            ? [
                {
                  sourceName: row.source_name,
                  sourceUrl: row.source_url,
                  sourceDomain: null,
                  title: null,
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
      },
      officialSources: officialSourceService ? officialSourceService.getMeta() : null
    });
  });

  app.get('/api/official/meta', (req, res) => {
    if (!officialSourceService) {
      res.status(503).json({ error: 'Official source integration is not initialized.' });
      return;
    }

    res.json(officialSourceService.getMeta());
  });

  app.get('/api/official/police-stations', (req, res) => {
    if (!officialSourceService) {
      res.status(503).json({ error: 'Official source integration is not initialized.' });
      return;
    }

    const metroUnit = String(req.query.metroUnit || '').trim() || null;
    res.json({
      policeStations: officialSourceService.getPoliceStations({ metroUnit })
    });
  });

  app.post('/api/official/sync', async (req, res, next) => {
    if (!officialSourceService) {
      res.status(503).json({ error: 'Official source integration is not initialized.' });
      return;
    }

    try {
      const result = await officialSourceService.syncAll();
      res.json(result);
    } catch (error) {
      next(error);
    }
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
