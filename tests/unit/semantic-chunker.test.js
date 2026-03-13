import { describe, expect, it } from 'vitest';
import { SemanticChunker } from '../../src/services/semanticChunker.js';

describe('semantic chunker', () => {
  it('produces stable chunk ids for the same article input', async () => {
    const chunker = new SemanticChunker({ chunkSize: 80, chunkOverlap: 10 });
    const article = {
      title: 'Mob beats man to death near Chennai Airport',
      content:
        'Police said the man was attacked near Chennai Airport after a quarrel. Witnesses told officers that the assault happened on Friday night in Meenambakkam. Another paragraph adds more detail for splitting.',
      canonicalUrl: 'https://example.org/chennai-airport-murder',
      contentHash: 'content-hash-1',
      sourceId: 'source-a',
      publishedAt: '2026-03-13T05:53:54.000Z'
    };

    const first = await chunker.chunkArticle(article);
    const second = await chunker.chunkArticle(article);

    expect(first.length).toBeGreaterThan(1);
    expect(first.map((chunk) => chunk.chunkId)).toEqual(second.map((chunk) => chunk.chunkId));
    expect(first[0].canonicalUrl).toBe(article.canonicalUrl);
    expect(first[0].sourceId).toBe(article.sourceId);
  });
});
