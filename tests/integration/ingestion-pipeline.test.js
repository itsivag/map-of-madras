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

    db.close();
  });
});
