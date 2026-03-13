import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
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
});
