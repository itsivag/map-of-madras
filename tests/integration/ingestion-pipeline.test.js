import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, vi } from 'vitest';
import { initDatabase } from '../../src/db/init.js';
import { IngestService } from '../../src/services/ingestService.js';
import { buildDedupeKey } from '../../src/services/dedupe.js';

describe('ingestion pipeline', () => {
  it('writes ingestion run, raw articles, and published incidents', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-test-'));
    const dbPath = path.join(tempDir, 'test.sqlite');

    const db = initDatabase(dbPath, [
      {
        id: 'fixture-source',
        name: 'Fixture Source',
        feedUrl: 'https://example.org/feed.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        parserMode: 'rss'
      }
    ]);

    const rssService = {
      async fetchFeedItems() {
        return [
          {
            title: 'Robbery and theft case reported in Adyar',
            link: 'https://example.org/crime-story',
            publishedAt: '2026-03-07T09:00:00.000Z',
            feedSummary: 'Police filed FIR for robbery and theft.',
            feedContent: 'Robbery and theft happened near Adyar bus stand.'
          },
          {
            title: 'City marathon route announced',
            link: 'https://example.org/non-crime-story',
            publishedAt: '2026-03-07T10:00:00.000Z',
            feedSummary: 'Traffic advisory issued.',
            feedContent: 'No criminal event in this report.'
          }
        ];
      },
      async enrichItem(source, item) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: item.link,
          title: item.title,
          publishedAt: item.publishedAt,
          content: `${item.feedSummary} ${item.feedContent}`
        };
      }
    };

    const semanticPipeline = {
      isConfigured() {
        return true;
      },
      async analyzeArticle({ article }) {
        if (article.title.includes('Robbery')) {
          return {
            stage: 'ready_to_publish',
            decision: 'publish',
            extraction: {
              category: 'robbery/theft'
            },
            incidentCandidate: {
              dedupe: buildDedupeKey({
                sourceUrl: article.sourceUrl,
                title: article.title,
                occurredAt: article.publishedAt,
                lat: 13.007,
                lng: 80.257
              }),
              category: 'robbery/theft',
              subcategory: 'robbery',
              occurredAt: article.publishedAt,
              locality: 'Adyar',
              lat: 13.007,
              lng: 80.257,
              confidence: 0.92,
              sourceName: 'Fixture Source',
              sourceUrl: article.sourceUrl,
              sourceDomain: 'example.org',
              title: article.title,
              summary: 'Semantically extracted robbery/theft incident near Adyar.',
              publishedAt: new Date().toISOString()
            }
          };
        }

        return {
          stage: 'rejected',
          decision: 'reject',
          extraction: {
            category: 'not-a-crime-event'
          },
          incidentCandidate: null
        };
      }
    };

    const ingestService = new IngestService({
      db,
      rssService,
      semanticPipeline,
      pipelineMode: 'semantic',
      publishThreshold: 0.8
    });

    const result = await ingestService.runIngestion({ trigger: 'test' });

    const run = db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1').get();
    const rawCount = db.prepare('SELECT COUNT(*) as count FROM articles_raw').get().count;
    const incidentRows = db.prepare('SELECT * FROM incidents').all();

    expect(result.status).toBe('success');
    expect(result.pipelineMode).toBe('semantic');
    expect(result.semanticConfigured).toBe(true);
    expect(run.processed_count).toBe(2);
    expect(rawCount).toBe(2);
    expect(incidentRows).toHaveLength(1);
    expect(incidentRows[0].published_at).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS count FROM incident_sources').get().count).toBe(1);

    db.close();
  });

  it('filters scheduler runs to the current cron window with overlap before processing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T09:30:00.000Z'));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-window-test-'));
    const dbPath = path.join(tempDir, 'window.sqlite');

    const db = initDatabase(dbPath, [
      {
        id: 'fixture-source',
        name: 'Fixture Source',
        feedUrl: 'https://example.org/feed.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        parserMode: 'rss'
      }
    ]);

    const rssService = {
      async fetchFeedItems() {
        return [
          {
            title: 'Old incident',
            link: 'https://example.org/old-story',
            publishedAt: '2026-03-13T08:25:00.000Z',
            feedSummary: '',
            feedContent: ''
          },
          {
            title: 'Overlap incident',
            link: 'https://example.org/overlap-story',
            publishedAt: '2026-03-13T08:35:00.000Z',
            feedSummary: '',
            feedContent: ''
          },
          {
            title: 'Current incident',
            link: 'https://example.org/current-story',
            publishedAt: '2026-03-13T09:05:00.000Z',
            feedSummary: '',
            feedContent: ''
          }
        ];
      },
      async enrichItem(source, item) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: item.link,
          title: item.title,
          publishedAt: item.publishedAt,
          content: item.title
        };
      }
    };

    const semanticPipeline = {
      isConfigured() {
        return true;
      },
      async analyzeArticle({ article }) {
        const index = article.title.includes('Overlap') ? 1 : 2;
        return {
          stage: 'ready_to_publish',
          decision: 'publish',
          extraction: {
            category: 'fraud/scam'
          },
          incidentCandidate: {
            dedupe: buildDedupeKey({
              title: article.title,
              category: 'fraud/scam',
              subcategory: 'window-test',
              occurredAt: article.publishedAt,
              locality: `Chennai ${index}`,
              lat: 13.08 + index * 0.05,
              lng: 80.27 + index * 0.05
            }),
            category: 'fraud/scam',
            subcategory: 'window-test',
            occurredAt: article.publishedAt,
            locality: `Chennai ${index}`,
            lat: 13.08 + index * 0.05,
            lng: 80.27 + index * 0.05,
            confidence: 0.95,
            sourceName: 'Fixture Source',
            sourceUrl: article.sourceUrl,
            sourceDomain: 'example.org',
            title: article.title,
            summary: 'Window filtered test incident.',
            publishedAt: new Date().toISOString()
          }
        };
      }
    };

    try {
      const ingestService = new IngestService({
        db,
        rssService,
        semanticPipeline,
        pipelineMode: 'semantic',
        publishThreshold: 0.8,
        ingestCron: '0 * * * *',
        ingestionWindowOverlapMinutes: 30,
        maxItemsPerSource: 5
      });

      const result = await ingestService.runIngestion({ trigger: 'scheduler' });
      const run = db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1').get();
      const details = JSON.parse(run.details_json);
      const rawCount = db.prepare('SELECT COUNT(*) AS count FROM articles_raw').get().count;

      expect(result.processedCount).toBe(2);
      expect(result.publishedCount).toBe(2);
      expect(details.ingestionWindow.from).toBe('2026-03-13T08:30:00.000Z');
      expect(details.ingestionWindow.mode).toBe('scheduled_cron');
      expect(details.ingestionWindow.overlapMinutes).toBe(30);
      expect(details.sources[0].windowSkippedCount).toBe(1);
      expect(rawCount).toBe(2);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it('gives manual runs a wider recent lookback window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T09:30:00.000Z'));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-manual-window-test-'));
    const dbPath = path.join(tempDir, 'manual-window.sqlite');

    const db = initDatabase(dbPath, [
      {
        id: 'fixture-source',
        name: 'Fixture Source',
        feedUrl: 'https://example.org/feed.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        parserMode: 'rss'
      }
    ]);

    const rssService = {
      async fetchFeedItems() {
        return [
          {
            title: 'Too old incident',
            link: 'https://example.org/too-old-story',
            publishedAt: '2026-03-13T04:55:00.000Z',
            feedSummary: '',
            feedContent: ''
          },
          {
            title: 'Manual lookback incident',
            link: 'https://example.org/manual-lookback-story',
            publishedAt: '2026-03-13T05:10:00.000Z',
            feedSummary: '',
            feedContent: ''
          },
          {
            title: 'Manual current incident',
            link: 'https://example.org/manual-current-story',
            publishedAt: '2026-03-13T09:15:00.000Z',
            feedSummary: '',
            feedContent: ''
          }
        ];
      },
      async enrichItem(source, item) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: item.link,
          title: item.title,
          publishedAt: item.publishedAt,
          content: item.title
        };
      }
    };

    const semanticPipeline = {
      isConfigured() {
        return true;
      },
      async analyzeArticle({ article }) {
        const index = article.title.includes('lookback') ? 1 : 2;
        return {
          stage: 'ready_to_publish',
          decision: 'publish',
          extraction: {
            category: 'fraud/scam'
          },
          incidentCandidate: {
            dedupe: buildDedupeKey({
              title: article.title,
              category: 'fraud/scam',
              subcategory: 'manual-window-test',
              occurredAt: article.publishedAt,
              locality: `Chennai ${index}`,
              lat: 13.18 + index * 0.05,
              lng: 80.17 + index * 0.05
            }),
            category: 'fraud/scam',
            subcategory: 'manual-window-test',
            occurredAt: article.publishedAt,
            locality: `Chennai ${index}`,
            lat: 13.18 + index * 0.05,
            lng: 80.17 + index * 0.05,
            confidence: 0.95,
            sourceName: 'Fixture Source',
            sourceUrl: article.sourceUrl,
            sourceDomain: 'example.org',
            title: article.title,
            summary: 'Manual window test incident.',
            publishedAt: new Date().toISOString()
          }
        };
      }
    };

    try {
      const ingestService = new IngestService({
        db,
        rssService,
        semanticPipeline,
        pipelineMode: 'semantic',
        publishThreshold: 0.8,
        ingestCron: '0 * * * *',
        manualLookbackHours: 4,
        ingestionWindowOverlapMinutes: 30,
        maxItemsPerSource: 5
      });

      const result = await ingestService.runIngestion({ trigger: 'manual' });
      const run = db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1').get();
      const details = JSON.parse(run.details_json);

      expect(result.processedCount).toBe(2);
      expect(result.publishedCount).toBe(2);
      expect(details.ingestionWindow.from).toBe('2026-03-13T05:00:00.000Z');
      expect(details.ingestionWindow.mode).toBe('manual_recent');
      expect(details.ingestionWindow.lookbackHours).toBe(4);
      expect(details.ingestionWindow.overlapMinutes).toBe(30);
      expect(details.sources[0].windowSkippedCount).toBe(1);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it('skips non-crime feed items before enrichment', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-keyword-filter-test-'));
    const dbPath = path.join(tempDir, 'keyword-filter.sqlite');

    const db = initDatabase(dbPath, [
      {
        id: 'fixture-source',
        name: 'Fixture Source',
        feedUrl: 'https://example.org/feed.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        crimeKeywordFilter: true,
        parserMode: 'rss'
      }
    ]);

    const rssService = {
      async fetchFeedItems() {
        return [
          {
            title: 'City launches new health walk in Adyar',
            link: 'https://example.org/non-crime',
            publishedAt: '2026-03-13T09:05:00.000Z',
            feedSummary: '',
            feedContent: ''
          },
          {
            title: 'Three arrested for robbery in Chennai',
            link: 'https://example.org/crime',
            publishedAt: '2026-03-13T09:10:00.000Z',
            feedSummary: '',
            feedContent: ''
          }
        ];
      },
      async enrichItem(source, item) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: item.link,
          title: item.title,
          publishedAt: item.publishedAt,
          content: item.title
        };
      }
    };

    const semanticPipeline = {
      isConfigured() {
        return true;
      },
      async analyzeArticle({ article }) {
        return {
          stage: 'ready_to_publish',
          decision: 'publish',
          extraction: {
            category: 'robbery/theft'
          },
          incidentCandidate: {
            dedupe: buildDedupeKey({
              title: article.title,
              category: 'robbery/theft',
              subcategory: 'keyword-filter-test',
              occurredAt: article.publishedAt,
              locality: 'Chennai',
              lat: 13.09,
              lng: 80.29
            }),
            category: 'robbery/theft',
            subcategory: 'keyword-filter-test',
            occurredAt: article.publishedAt,
            locality: 'Chennai',
            lat: 13.09,
            lng: 80.29,
            confidence: 0.95,
            sourceName: 'Fixture Source',
            sourceUrl: article.sourceUrl,
            sourceDomain: 'example.org',
            title: article.title,
            summary: 'Keyword filter test incident.',
            publishedAt: new Date().toISOString()
          }
        };
      }
    };

    try {
      const ingestService = new IngestService({
        db,
        rssService,
        semanticPipeline,
        pipelineMode: 'semantic',
        publishThreshold: 0.8,
        maxItemsPerSource: 5
      });

      const result = await ingestService.runIngestion({ trigger: 'test' });
      const details = JSON.parse(
        db.prepare('SELECT details_json FROM ingestion_runs ORDER BY id DESC LIMIT 1').get().details_json
      );

      expect(result.processedCount).toBe(1);
      expect(result.publishedCount).toBe(1);
      expect(details.sources[0].keywordSkippedCount).toBe(1);
    } finally {
      db.close();
    }
  });

  it('skips enriched articles that resolve outside the current cron window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T09:30:00.000Z'));

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-window-enrich-test-'));
    const dbPath = path.join(tempDir, 'window-enrich.sqlite');

    const db = initDatabase(dbPath, [
      {
        id: 'fixture-source',
        name: 'Fixture Source',
        feedUrl: 'https://example.org/feed.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        parserMode: 'rss'
      }
    ]);

    const rssService = {
      async fetchFeedItems() {
        return [
          {
          title: 'Resolved old article',
          link: 'https://example.org/old-story',
          publishedAt: null,
            feedSummary: '',
            feedContent: ''
          },
          {
            title: 'Resolved current article',
            link: 'https://example.org/current-story',
            publishedAt: null,
            feedSummary: '',
            feedContent: ''
          }
        ];
      },
      async enrichItem(source, item) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: item.link,
          title: item.title,
          publishedAt: item.link.includes('old')
            ? '2026-03-13T08:10:00.000Z'
            : '2026-03-13T09:10:00.000Z',
          content: item.title
        };
      }
    };

    const semanticPipeline = {
      isConfigured() {
        return true;
      },
      async analyzeArticle({ article }) {
        return {
          stage: 'ready_to_publish',
          decision: 'publish',
          extraction: {
            category: 'murder'
          },
          incidentCandidate: {
            dedupe: buildDedupeKey({
              title: article.title,
              category: 'murder',
              subcategory: 'window-test',
              occurredAt: article.publishedAt,
              locality: 'Chennai',
              lat: 13.09,
              lng: 80.28
            }),
            category: 'murder',
            subcategory: 'window-test',
            occurredAt: article.publishedAt,
            locality: 'Chennai',
            lat: 13.09,
            lng: 80.28,
            confidence: 0.95,
            sourceName: 'Fixture Source',
            sourceUrl: article.sourceUrl,
            sourceDomain: 'example.org',
            title: article.title,
            summary: 'Window filtered enrich incident.',
            publishedAt: new Date().toISOString()
          }
        };
      }
    };

    try {
      const ingestService = new IngestService({
        db,
        rssService,
        semanticPipeline,
        pipelineMode: 'semantic',
        publishThreshold: 0.8,
        ingestCron: '0 * * * *',
        ingestionWindowOverlapMinutes: 30,
        maxItemsPerSource: 5
      });

      const result = await ingestService.runIngestion({ trigger: 'scheduler' });
      const rawCount = db.prepare('SELECT COUNT(*) AS count FROM articles_raw').get().count;
      const details = JSON.parse(
        db.prepare('SELECT details_json FROM ingestion_runs ORDER BY id DESC LIMIT 1').get().details_json
      );

      expect(result.processedCount).toBe(2);
      expect(result.publishedCount).toBe(1);
      expect(details.sources[0].windowSkippedCount).toBe(1);
      expect(rawCount).toBe(1);
    } finally {
      db.close();
      vi.useRealTimers();
    }
  });

  it('merges duplicate incidents across outlets into one marker with multiple source rows', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-merge-test-'));
    const dbPath = path.join(tempDir, 'merge.sqlite');

    const db = initDatabase(dbPath, [
      {
        id: 'source-a',
        name: 'Source A',
        feedUrl: 'https://example.org/feed.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        parserMode: 'rss'
      },
      {
        id: 'source-b',
        name: 'Source B',
        feedUrl: 'https://example.net/feed.xml',
        websiteUrl: 'https://example.net',
        enabled: true,
        parserMode: 'rss'
      }
    ]);

    const rssService = {
      async fetchFeedItems(source) {
        if (source.id === 'source-a') {
          return [
            {
              title: 'Mob kills van driver after his urine spills on woman in Chennai',
              link: 'https://example.org/story-a',
              publishedAt: '2026-03-13T09:00:00.000Z',
              feedSummary: '',
              feedContent: ''
            }
          ];
        }

        return [
          {
            title: 'Man urinates on woman from auto, mob beats him to death',
            link: 'https://example.net/story-b',
            publishedAt: '2026-03-13T09:20:00.000Z',
            feedSummary: '',
            feedContent: ''
          }
        ];
      },
      async enrichItem(source, item) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: item.link,
          title: item.title,
          publishedAt: item.publishedAt,
          content: item.title
        };
      }
    };

    const semanticPipeline = {
      isConfigured() {
        return true;
      },
      async analyzeArticle({ source, article }) {
        return {
          stage: 'ready_to_publish',
          decision: 'publish',
          extraction: {
            category: 'murder'
          },
          incidentCandidate: {
            dedupe: buildDedupeKey({
              title: article.title,
              category: 'murder',
              subcategory: 'mob beating',
              occurredAt: article.publishedAt,
              locality: 'Prakasam Salai, Broadway, Chennai',
              lat: 13.0430,
              lng: 80.2738
            }),
            category: 'murder',
            subcategory: 'mob beating',
            occurredAt: article.publishedAt,
            locality: 'Prakasam Salai, Broadway, Chennai',
            lat: 13.0430,
            lng: 80.2738,
            confidence: 0.95,
            sourceName: source.name,
            sourceUrl: article.sourceUrl,
            sourceDomain: source.id === 'source-a' ? 'example.org' : 'example.net',
            title: article.title,
            summary: 'Semantically extracted murder incident near Broadway.',
            publishedAt: new Date().toISOString()
          }
        };
      }
    };

    const ingestService = new IngestService({
      db,
      rssService,
      semanticPipeline,
      pipelineMode: 'semantic',
      publishThreshold: 0.8
    });

    const result = await ingestService.runIngestion({ trigger: 'test-merge' });
    const incidentCount = db.prepare('SELECT COUNT(*) AS count FROM incidents').get().count;
    const sourceCount = db.prepare('SELECT COUNT(*) AS count FROM incident_sources').get().count;
    const incident = db
      .prepare('SELECT id, title, source_name, source_url FROM incidents LIMIT 1')
      .get();

    expect(result.status).toBe('success');
    expect(result.publishedCount).toBe(1);
    expect(incidentCount).toBe(1);
    expect(sourceCount).toBe(2);
    expect(incident.source_url).toBe('https://example.org/story-a');

    db.close();
  });

  it('caps per-source processing and records progress details during a run', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-limit-test-'));
    const dbPath = path.join(tempDir, 'limit.sqlite');

    const db = initDatabase(dbPath, [
      {
        id: 'source-a',
        name: 'Source A',
        feedUrl: 'https://example.org/feed.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        parserMode: 'rss'
      }
    ]);

    const rssService = {
      async fetchFeedItems() {
        return [
          {
            title: 'Incident 1',
            link: 'https://example.org/story-1',
            publishedAt: '2026-03-13T09:00:00.000Z',
            feedSummary: '',
            feedContent: ''
          },
          {
            title: 'Incident 2',
            link: 'https://example.org/story-2',
            publishedAt: '2026-03-13T09:05:00.000Z',
            feedSummary: '',
            feedContent: ''
          },
          {
            title: 'Incident 3',
            link: 'https://example.org/story-3',
            publishedAt: '2026-03-13T09:10:00.000Z',
            feedSummary: '',
            feedContent: ''
          }
        ];
      },
      async enrichItem(source, item) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: item.link,
          title: item.title,
          publishedAt: item.publishedAt,
          content: item.title
        };
      }
    };

    const semanticPipeline = {
      isConfigured() {
        return true;
      },
      async analyzeArticle({ article }) {
        const index = Number(article.title.split(' ').pop());
        const lat = 13.0836939 + index * 0.01;
        const lng = 80.270186 + index * 0.01;
        return {
          stage: 'ready_to_publish',
          decision: 'publish',
          extraction: {
            category: 'fraud/scam'
          },
          incidentCandidate: {
            dedupe: buildDedupeKey({
              title: article.title,
              category: 'fraud/scam',
              subcategory: 'test',
              occurredAt: article.publishedAt,
              locality: `Chennai Sector ${index}`,
              lat,
              lng
            }),
            category: 'fraud/scam',
            subcategory: 'test',
            occurredAt: article.publishedAt,
            locality: `Chennai Sector ${index}`,
            lat,
            lng,
            confidence: 0.95,
            sourceName: 'Source A',
            sourceUrl: article.sourceUrl,
            sourceDomain: 'example.org',
            title: article.title,
            summary: 'Test incident.',
            publishedAt: new Date().toISOString()
          }
        };
      }
    };

    const ingestService = new IngestService({
      db,
      rssService,
      semanticPipeline,
      pipelineMode: 'semantic',
      publishThreshold: 0.8,
      maxItemsPerSource: 2,
      sourceTimeBudgetMs: 10000,
      itemTimeoutMs: 1000
    });

    const result = await ingestService.runIngestion({ trigger: 'test-limit' });
    const run = db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1').get();
    const details = JSON.parse(run.details_json);

    expect(result.status).toBe('success');
    expect(result.processedCount).toBe(2);
    expect(result.publishedCount).toBe(1);
    expect(details.limits.maxItemsPerSource).toBe(2);
    expect(details.sources[0].discoveredCount).toBe(3);
    expect(details.sources[0].fetchedCount).toBe(2);
    expect(details.sources[0].skippedCount).toBe(1);
    expect(details.sources[0].errors.some((entry) => entry.stage === 'limit')).toBe(true);

    db.close();
  });

  it('stops the run early when the overall run budget is exceeded', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-run-budget-test-'));
    const dbPath = path.join(tempDir, 'run-budget.sqlite');

    const db = initDatabase(dbPath, [
      {
        id: 'source-a',
        name: 'Source A',
        feedUrl: 'https://example.org/feed-a.xml',
        websiteUrl: 'https://example.org',
        enabled: true,
        parserMode: 'rss'
      },
      {
        id: 'source-b',
        name: 'Source B',
        feedUrl: 'https://example.net/feed-b.xml',
        websiteUrl: 'https://example.net',
        enabled: true,
        parserMode: 'rss'
      }
    ]);

    const rssService = {
      async fetchFeedItems(source) {
        return [
          {
            title: `Incident for ${source.id}`,
            link: `https://${source.id}.example/story-1`,
            publishedAt: '2026-03-13T09:00:00.000Z',
            feedSummary: '',
            feedContent: ''
          }
        ];
      },
      async enrichItem(source, item) {
        return {
          sourceId: source.id,
          sourceName: source.name,
          sourceUrl: item.link,
          title: item.title,
          publishedAt: item.publishedAt,
          content: item.title
        };
      }
    };

    const semanticPipeline = {
      isConfigured() {
        return true;
      },
      async analyzeArticle({ source, article }) {
        await sleep(30);

        return {
          stage: 'ready_to_publish',
          decision: 'publish',
          extraction: {
            category: 'fraud/scam'
          },
          incidentCandidate: {
            dedupe: buildDedupeKey({
              title: article.title,
              category: 'fraud/scam',
              subcategory: source.id,
              occurredAt: article.publishedAt,
              locality: `${source.name} locality`,
              lat: source.id === 'source-a' ? 13.08 : 13.18,
              lng: source.id === 'source-a' ? 80.27 : 80.18
            }),
            category: 'fraud/scam',
            subcategory: source.id,
            occurredAt: article.publishedAt,
            locality: `${source.name} locality`,
            lat: source.id === 'source-a' ? 13.08 : 13.18,
            lng: source.id === 'source-a' ? 80.27 : 80.18,
            confidence: 0.95,
            sourceName: source.name,
            sourceUrl: article.sourceUrl,
            sourceDomain: 'example.org',
            title: article.title,
            summary: 'Test incident.',
            publishedAt: new Date().toISOString()
          }
        };
      }
    };

    const ingestService = new IngestService({
      db,
      rssService,
      semanticPipeline,
      pipelineMode: 'semantic',
      publishThreshold: 0.8,
      maxItemsPerSource: 1,
      sourceTimeBudgetMs: 1000,
      itemTimeoutMs: 1000,
      runTimeBudgetMs: 10
    });

    const result = await ingestService.runIngestion({ trigger: 'test-run-budget' });
    const run = db.prepare('SELECT * FROM ingestion_runs ORDER BY id DESC LIMIT 1').get();
    const details = JSON.parse(run.details_json);

    expect(result.status).toBe('partial');
    expect(details.runBudgetExceeded).toBe(true);
    expect(details.sources.some((entry) =>
      entry.errors.some((error) => error.stage === 'run-budget')
    )).toBe(true);

    db.close();
  });
});
