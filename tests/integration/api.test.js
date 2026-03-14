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

    const articleInsert = db.prepare(
      `INSERT INTO articles_raw
      (source_id, source_name, source_url, canonical_url, content_hash, title, published_at, content, normalized_text, semantic_status, semantic_model, last_indexed_at, fetch_run_id)
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const primaryArticle = articleInsert.run(
      'source-a',
      'Source A',
      'https://example.org/story-1',
      'https://example.org/story-1',
      'hash-story-1',
      'Murder case',
      nowIso,
      'A murder case was reported in Adyar near the riverside road.',
      'a murder case was reported in adyar near the riverside road',
      'indexed',
      'semantic-model',
      nowIso,
      null
    );

    db.prepare(
      `INSERT INTO article_chunks
      (article_id, chunk_index, chunk_id, chunk_text, chunk_hash, qdrant_point_id)
      VALUES
      (?, ?, ?, ?, ?, ?),
      (?, ?, ?, ?, ?, ?)`
    ).run(
      primaryArticle.lastInsertRowid,
      0,
      'chunk-1',
      'Police said the murder happened in Adyar late on Thursday night.',
      'chunk-hash-1',
      'point-1',
      primaryArticle.lastInsertRowid,
      1,
      'chunk-2',
      'Witnesses identified the location near the Adyar bridge approach road.',
      'chunk-hash-2',
      'point-2'
    );

    db.prepare(
      `INSERT INTO semantic_extractions
      (article_id, model_id, prompt_version, pipeline_mode, evidence_chunk_ids, raw_json, decision, confidence, rejection_reason, extraction_json)
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      primaryArticle.lastInsertRowid,
      'semantic-model',
      'semantic-v1',
      'semantic',
      JSON.stringify(['chunk-1', 'chunk-2']),
      '{"ok":true}',
      'publish',
      0.94,
      null,
      JSON.stringify({
        isCrimeEvent: true,
        category: 'murder',
        subcategory: 'murder',
        occurredAt: nowIso,
        locationText: 'Adyar',
        locationPrecision: 'locality',
        evidence: [
          { chunkId: 'chunk-1', supports: 'offense' },
          { chunkId: 'chunk-2', supports: 'location' },
          { chunkId: 'chunk-1', supports: 'time' }
        ],
        confidence: 0.94,
        rejectionReason: null
      })
    );

    db.prepare(
      `INSERT INTO incidents
      (dedupe_key, category, subcategory, occurred_at, locality, lat, lng, confidence, source_name, source_url, source_domain, title, summary, published_at)
      VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'key-related',
      'murder',
      'murder',
      nowIso,
      'Adyar',
      13.011,
      80.261,
      0.86,
      'Source B',
      'https://example.org/story-3',
      'example.org',
      'Second murder report',
      'Follow-up coverage near Adyar.',
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

    app = createApp({
      db,
      ingestService,
      geoService,
      rootDir: ROOT_DIR
    });
  });

  it('returns only published incidents and applies category filter', async () => {
    const response = await request(app).get('/api/incidents?category=murder&limit=100');

    expect(response.status).toBe(200);
    expect(response.body.incidents).toHaveLength(2);
    expect(response.body.incidents.every((incident) => incident.category === 'murder')).toBe(true);
    const primaryIncident = response.body.incidents.find((incident) => incident.sourceName === 'Source A');
    expect(primaryIncident).toBeTruthy();
    expect(primaryIncident.sourceCount).toBe(2);
    expect(primaryIncident.sources).toHaveLength(2);
  });

  it('applies bbox filtering', async () => {
    const response = await request(app)
      .get('/api/incidents?bbox=80.2,12.95,80.3,13.05&limit=100');

    expect(response.status).toBe(200);
    expect(response.body.incidents).toHaveLength(2);
    expect(response.body.incidents.every((incident) => incident.locality === 'Adyar')).toBe(true);
  });

  it('returns incident detail with supporting articles and extracted evidence', async () => {
    const response = await request(app).get('/api/incidents/1');

    expect(response.status).toBe(200);
    expect(response.body.incident.id).toBe(1);
    expect(response.body.primaryArticle.title).toBe('Murder case');
    expect(response.body.extraction.locationText).toBe('Adyar');
    expect(response.body.evidence).toHaveLength(2);
    expect(response.body.evidence[0].supports).toContain('offense');
    expect(response.body.supportingArticles).toHaveLength(2);
    expect(response.body.supportingArticles[0].isPrimary).toBe(true);
    expect(response.body.supportingArticles[1].title).toBe('Second murder report');
  });

  it('returns meta payload with source health and boundary', async () => {
    const response = await request(app).get('/api/meta');

    expect(response.status).toBe(200);
    expect(response.body.sourceHealth).toHaveLength(1);
    expect(response.body.boundary.maxBounds).toHaveLength(2);
    expect(response.body.pipeline.mode).toBe('semantic');
    expect(response.body.pipeline.semanticConfigured).toBe(true);
    expect(response.body.officialSources).toBeUndefined();
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

  it('applies CORS headers and protects admin routes when a token is configured', async () => {
    const protectedApp = createApp({
      db,
      ingestService: {
        pipelineMode: 'semantic',
        isSemanticConfigured() {
          return true;
        },
        async runIngestion() {
          return { status: 'success', processedCount: 1, publishedCount: 0 };
        },
        async debugArticleByUrl(url) {
          return { url, decision: 'publish' };
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
      rootDir: ROOT_DIR,
      corsAllowedOrigins: 'https://itsivag.github.io',
      adminToken: 'secret-token'
    });

    const metaResponse = await request(protectedApp)
      .get('/api/meta')
      .set('Origin', 'https://itsivag.github.io');
    expect(metaResponse.status).toBe(200);
    expect(metaResponse.headers['access-control-allow-origin']).toBe('https://itsivag.github.io');

    const unauthorized = await request(protectedApp).post('/api/ingest/run');
    expect(unauthorized.status).toBe(401);

    const authorized = await request(protectedApp)
      .post('/api/ingest/run')
      .set('Authorization', 'Bearer secret-token');
    expect(authorized.status).toBe(200);
  });
});
