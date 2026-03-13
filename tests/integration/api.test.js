import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../../src/db/init.js';
import { createApp } from '../../src/app.js';
import { ROOT_DIR, loadBoundaryGeoJson } from '../../src/config.js';

describe('API endpoints', () => {
  let db;
  let app;
  let officialSourceService;

  beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-api-'));
    const dbPath = path.join(tempDir, 'api.sqlite');

    db = initDatabase(dbPath, [
      {
        id: 'source-a',
        name: 'Source A',
        feedUrl: 'https://example.org/feed.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        parserMode: 'rss'
      }
    ]);

    const nowIso = new Date().toISOString();

    db.prepare(
      `INSERT INTO incidents
      (dedupe_key, category, subcategory, occurred_at, locality, lat, lng, confidence, source_name, source_url, source_domain, title, summary, published_at)
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'key-published',
      'murder',
      'murder',
      nowIso,
      'Adyar',
      13.007,
      80.257,
      0.9,
      'Source A',
      'https://example.org/story-1',
      'example.org',
      'Murder case',
      'Reported murder incident near Adyar.',
      nowIso
    );
    db.prepare(
      `INSERT INTO incident_sources
      (incident_id, source_fingerprint, source_name, source_url, source_domain, title, published_at)
      VALUES
      (?, ?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      'fingerprint-source-a',
      'Source A',
      'https://example.org/story-1',
      'example.org',
      'Murder case',
      nowIso,
      1,
      'fingerprint-source-b',
      'Source B',
      'https://example.net/story-99',
      'example.net',
      'Alternate murder case headline',
      nowIso
    );

    db.prepare(
      `INSERT INTO incidents
      (dedupe_key, category, subcategory, occurred_at, locality, lat, lng, confidence, source_name, source_url, source_domain, title, summary, published_at)
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'key-hidden',
      'rape',
      'rape',
      nowIso,
      'Tambaram',
      12.925,
      80.123,
      0.51,
      'Source A',
      'https://example.org/story-2',
      'example.org',
      'Rape case',
      'Reported rape incident near Tambaram.',
      null
    );

    const geoService = {
      bounds: {
        minLng: 79.85,
        minLat: 12.86,
        maxLng: 80.41,
        maxLat: 13.42,
        leafletMaxBounds: [
          [12.86, 79.85],
          [13.42, 80.41]
        ]
      },
      boundaryGeoJson: loadBoundaryGeoJson()
    };

    const ingestService = {
      pipelineMode: 'semantic',
      isSemanticConfigured() {
        return true;
      },
      async runIngestion() {
        return { status: 'success', processedCount: 0, publishedCount: 0 };
      },
      async debugArticleByUrl(url) {
        return {
          url,
          stage: 'ready_to_publish',
          decision: 'publish',
          extraction: {
            category: 'murder'
          }
        };
      }
    };

    officialSourceService = {
      getMeta() {
        return {
          sources: [
            {
              id: 'tn-police-metro-stations',
              integration_state: 'active',
              record_count: 2
            },
            {
              id: 'tn-police-view-fir',
              integration_state: 'blocked',
              record_count: 0
            }
          ],
          metroStationCounts: [{ metro_unit_name: 'CHENNAI CITY', count: 2 }]
        };
      },
      getPoliceStations() {
        return [
          {
            stationOrgId: '70002266',
            stationName: 'ADYAR',
            metroUnitOrgId: '70002111',
            metroUnitName: 'CHENNAI CITY',
            sourceName: 'Tamil Nadu Police Metro Station Master',
            sourceUrl: 'https://www.police.tn.gov.in/citizenportal/contactus',
            syncedAt: nowIso
          }
        ];
      },
      async syncAll() {
        return {
          status: 'ok',
          sources: [{ sourceId: 'tn-police-metro-stations', recordCount: 2 }]
        };
      }
    };

    app = createApp({
      db,
      ingestService,
      geoService,
      officialSourceService,
      rootDir: ROOT_DIR
    });
  });

  it('returns only published incidents and applies category filter', async () => {
    const response = await request(app).get('/api/incidents?category=murder&limit=100');

    expect(response.status).toBe(200);
    expect(response.body.incidents).toHaveLength(1);
    expect(response.body.incidents[0].category).toBe('murder');
    expect(response.body.incidents[0].sourceName).toBe('Source A');
    expect(response.body.incidents[0].sourceCount).toBe(2);
    expect(response.body.incidents[0].sources).toHaveLength(2);
  });

  it('applies bbox filtering', async () => {
    const response = await request(app)
      .get('/api/incidents?bbox=80.2,12.95,80.3,13.05&limit=100');

    expect(response.status).toBe(200);
    expect(response.body.incidents).toHaveLength(1);
    expect(response.body.incidents[0].locality).toBe('Adyar');
  });

  it('returns meta payload with source health and boundary', async () => {
    const response = await request(app).get('/api/meta');

    expect(response.status).toBe(200);
    expect(response.body.sourceHealth).toHaveLength(1);
    expect(response.body.boundary.maxBounds).toHaveLength(2);
    expect(response.body.pipeline.mode).toBe('semantic');
    expect(response.body.pipeline.semanticConfigured).toBe(true);
    expect(response.body.officialSources.sources).toHaveLength(2);
  });

  it('returns semantic debug output for a provided article URL', async () => {
    const response = await request(app).get(
      '/api/debug/article?url=https://example.org/chennai-article'
    );

    expect(response.status).toBe(200);
    expect(response.body.url).toBe('https://example.org/chennai-article');
    expect(response.body.decision).toBe('publish');
    expect(response.body.extraction.category).toBe('murder');
  });

  it('returns structured debug error state instead of 500 when analysis fails', async () => {
    const errorApp = createApp({
      db,
      ingestService: {
        pipelineMode: 'semantic',
        isSemanticConfigured() {
          return true;
        },
        async runIngestion() {
          return { status: 'success', processedCount: 0, publishedCount: 0 };
        },
        async debugArticleByUrl(url) {
          return {
            url,
            pipelineMode: 'semantic',
            configured: true,
            stage: 'error',
            decision: 'error',
            error: 'MiniMax response did not include JSON output.'
          };
        }
      },
      geoService: {
        bounds: {
          minLng: 79.85,
          minLat: 12.86,
          maxLng: 80.41,
          maxLat: 13.42,
          leafletMaxBounds: [
            [12.86, 79.85],
            [13.42, 80.41]
          ]
        },
        boundaryGeoJson: loadBoundaryGeoJson()
      },
      officialSourceService,
      rootDir: ROOT_DIR
    });

    const response = await request(errorApp).get(
      '/api/debug/article?url=https://example.org/chennai-article'
    );

    expect(response.status).toBe(200);
    expect(response.body.stage).toBe('error');
    expect(response.body.decision).toBe('error');
    expect(response.body.error).toContain('MiniMax response');
  });

  it('returns official source metadata and metro police stations', async () => {
    const [metaResponse, stationsResponse] = await Promise.all([
      request(app).get('/api/official/meta'),
      request(app).get('/api/official/police-stations?metroUnit=chennai city')
    ]);

    expect(metaResponse.status).toBe(200);
    expect(metaResponse.body.sources).toHaveLength(2);
    expect(metaResponse.body.metroStationCounts[0].metro_unit_name).toBe('CHENNAI CITY');

    expect(stationsResponse.status).toBe(200);
    expect(stationsResponse.body.policeStations).toHaveLength(1);
    expect(stationsResponse.body.policeStations[0].stationName).toBe('ADYAR');
  });
});
