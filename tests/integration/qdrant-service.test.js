import { describe, expect, it, vi } from 'vitest';
import { QdrantService } from '../../src/services/qdrantService.js';

describe('qdrant service', () => {
  it('creates collections, upserts points, and searches with payload filters', async () => {
    const createCollection = vi.fn(async () => undefined);
    const upsert = vi.fn(async () => undefined);
    const search = vi.fn(async (collectionName, payload) => {
      if (collectionName === 'crime_taxonomy_v1') {
        return [
          {
            id: 'murder',
            score: 0.99,
            payload: {
              taxonomy_id: 'murder',
              category: 'murder'
            }
          }
        ];
      }

      return [
        {
          id: 'chunk-1',
          score: 0.88,
          payload: {
            article_id: 42,
            chunk_text: 'Mob killed driver in Meenambakkam.',
            chunk_index: 0
          }
        }
      ];
    });

    const service = new QdrantService({
      client: {
        getCollections: vi.fn(async () => ({ collections: [] })),
        createCollection,
        upsert,
        search
      }
    });

    await service.upsertTaxonomy(
      [
        {
          id: 'murder',
          category: 'murder',
          title: 'Murder',
          document: 'Intentional killing.'
        }
      ],
      [[0.1, 0.2, 0.3]]
    );

    await service.upsertArticleChunks(
      42,
      [
        {
          chunkId: 'chunk-1',
          chunkIndex: 0,
          chunkText: 'Mob killed driver in Meenambakkam.',
          canonicalUrl: 'https://example.org/story',
          contentHash: 'hash-1',
          sourceId: 'source-a',
          publishedAt: '2026-03-13T05:53:54.000Z'
        }
      ],
      [[0.5, 0.6, 0.7]]
    );

    const taxonomyResults = await service.searchTaxonomy([0.1, 0.2, 0.3], 3);
    const chunkResults = await service.searchArticleChunks([0.5, 0.6, 0.7], {
      articleId: 42,
      limit: 4
    });

    expect(createCollection).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenLastCalledWith(
      'article_chunks_v1',
      expect.objectContaining({
        limit: 4,
        filter: {
          must: [
            {
              key: 'article_id',
              match: {
                value: 42
              }
            }
          ]
        }
      })
    );
    expect(taxonomyResults[0].payload.category).toBe('murder');
    expect(chunkResults[0].payload.article_id).toBe(42);
  });
});
