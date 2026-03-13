import { QdrantClient } from '@qdrant/js-client-rest';
import { createHash } from 'node:crypto';

function normalizeSearchResults(results = []) {
  return results.map((result) => ({
    id: String(result.id),
    score: result.score,
    payload: result.payload || {}
  }));
}

function toQdrantPointId(seed) {
  const hex = createHash('sha256').update(String(seed)).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class QdrantService {
  constructor({
    client = null,
    url = '',
    apiKey = '',
    articleCollectionName = 'article_chunks_v1',
    taxonomyCollectionName = 'crime_taxonomy_v1'
  } = {}) {
    this.client =
      client ||
      (url
        ? new QdrantClient({
            url,
            apiKey: apiKey || undefined,
            checkCompatibility: false
          })
        : null);
    this.articleCollectionName = articleCollectionName;
    this.taxonomyCollectionName = taxonomyCollectionName;
    this.collectionCache = new Set();
  }

  isConfigured() {
    return Boolean(this.client);
  }

  async ensureCollection(collectionName, vectorSize) {
    if (!this.client) {
      return false;
    }

    const cacheKey = `${collectionName}:${vectorSize}`;
    if (this.collectionCache.has(cacheKey)) {
      return true;
    }

    const existing = await this.client.getCollections();
    const exists = Array.isArray(existing?.collections)
      ? existing.collections.some((collection) => collection.name === collectionName)
      : false;

    if (!exists) {
      await this.client.createCollection(collectionName, {
        vectors: {
          size: vectorSize,
          distance: 'Cosine'
        }
      });
    }

    this.collectionCache.add(cacheKey);
    return true;
  }

  async upsertTaxonomy(entries, vectors) {
    if (!this.client || entries.length === 0 || vectors.length === 0) {
      return [];
    }

    await this.ensureCollection(this.taxonomyCollectionName, vectors[0].length);

    await this.client.upsert(this.taxonomyCollectionName, {
      wait: true,
      points: entries.map((entry, index) => ({
        id: toQdrantPointId(`taxonomy:${entry.id}`),
        vector: vectors[index],
        payload: {
          taxonomy_id: entry.id,
          category: entry.category,
          title: entry.title,
          document: entry.document
        }
      }))
    });

    return entries;
  }

  async upsertArticleChunks(articleId, chunks, vectors) {
    if (!this.client || chunks.length === 0 || vectors.length === 0) {
      return [];
    }

    await this.ensureCollection(this.articleCollectionName, vectors[0].length);

    await this.client.upsert(this.articleCollectionName, {
      wait: true,
      points: chunks.map((chunk, index) => ({
        id: toQdrantPointId(`article:${articleId}:${chunk.chunkId}`),
        vector: vectors[index],
        payload: {
          article_id: articleId,
          chunk_id: chunk.chunkId,
          chunk_index: chunk.chunkIndex,
          chunk_text: chunk.chunkText,
          canonical_url: chunk.canonicalUrl,
          content_hash: chunk.contentHash,
          source_id: chunk.sourceId,
          published_at: chunk.publishedAt,
          city: 'Chennai'
        }
      }))
    });

    return chunks.map((chunk) => toQdrantPointId(`article:${articleId}:${chunk.chunkId}`));
  }

  async searchTaxonomy(vector, limit = 5) {
    if (!this.client) {
      return [];
    }

    const results = await this.client.search(this.taxonomyCollectionName, {
      vector,
      limit,
      with_payload: true
    });

    return normalizeSearchResults(results);
  }

  async searchArticleChunks(vector, { articleId, limit = 6 } = {}) {
    if (!this.client) {
      return [];
    }

    const filter = articleId
      ? {
          must: [
            {
              key: 'article_id',
              match: {
                value: articleId
              }
            }
          ]
        }
      : undefined;

    const results = await this.client.search(this.articleCollectionName, {
      vector,
      limit,
      filter,
      with_payload: true
    });

    return normalizeSearchResults(results);
  }
}
