import cron from 'node-cron';
import { createApp } from './app.js';
import {
  ROOT_DIR,
  DB_PATH,
  PORT,
  INGEST_CRON,
  RSS_MAX_ITEMS_PER_FEED,
  INGEST_MAX_ITEMS_PER_SOURCE,
  INGEST_SOURCE_TIME_BUDGET_MS,
  INGEST_ITEM_TIMEOUT_MS,
  INGEST_RUN_TIME_BUDGET_MS,
  PIPELINE_MODE,
  SEMANTIC_PUBLISH_THRESHOLD,
  CORS_ALLOWED_ORIGINS,
  ADMIN_TOKEN,
  BROWSERLESS_API_KEY,
  BROWSERLESS_BASE_URL,
  USER_AGENT,
  AWS_REGION,
  BEDROCK_TITAN_EMBED_MODEL_ID,
  BEDROCK_MINIMAX_MODEL_ID,
  QDRANT_URL,
  QDRANT_API_KEY,
  QDRANT_ARTICLE_COLLECTION,
  QDRANT_TAXONOMY_COLLECTION,
  SEMANTIC_PROMPT_VERSION,
  loadBoundaryGeoJson,
  loadLocalities,
  loadSourcesConfig
} from './config.js';
import { initDatabase } from './db/init.js';
import { createGeoService } from './services/geo.js';
import { createRssService } from './services/rss.js';
import { BedrockSemanticService } from './services/bedrockService.js';
import { IngestService } from './services/ingestService.js';
import { QdrantService } from './services/qdrantService.js';
import { SemanticChunker } from './services/semanticChunker.js';
import { SemanticPipeline } from './services/semanticPipeline.js';

async function bootstrap() {
  const sourceConfigs = loadSourcesConfig();
  const localities = loadLocalities();
  const boundaryGeoJson = loadBoundaryGeoJson();

  const db = initDatabase(DB_PATH, sourceConfigs);
  const geoService = createGeoService({
    boundaryGeoJson,
    localities,
    userAgent: USER_AGENT
  });
  const rssService = createRssService({
    userAgent: USER_AGENT,
    browserlessApiKey: BROWSERLESS_API_KEY,
    browserlessBaseUrl: BROWSERLESS_BASE_URL,
    maxItemsPerFeed: RSS_MAX_ITEMS_PER_FEED
  });
  const bedrockService = new BedrockSemanticService({
    region: AWS_REGION,
    embedModelId: BEDROCK_TITAN_EMBED_MODEL_ID,
    extractionModelId: BEDROCK_MINIMAX_MODEL_ID,
    promptVersion: SEMANTIC_PROMPT_VERSION
  });
  const qdrantService = new QdrantService({
    url: QDRANT_URL,
    apiKey: QDRANT_API_KEY,
    articleCollectionName: QDRANT_ARTICLE_COLLECTION,
    taxonomyCollectionName: QDRANT_TAXONOMY_COLLECTION
  });
  const semanticPipeline = new SemanticPipeline({
    db,
    bedrockService,
    qdrantService,
    chunker: new SemanticChunker(),
    geoService,
    publishThreshold: SEMANTIC_PUBLISH_THRESHOLD,
    pipelineMode: PIPELINE_MODE
  });

  const ingestService = new IngestService({
    db,
    rssService,
    geoService,
    semanticPipeline,
    publishThreshold: SEMANTIC_PUBLISH_THRESHOLD,
    pipelineMode: PIPELINE_MODE,
    maxItemsPerSource: INGEST_MAX_ITEMS_PER_SOURCE,
    sourceTimeBudgetMs: INGEST_SOURCE_TIME_BUDGET_MS,
    itemTimeoutMs: INGEST_ITEM_TIMEOUT_MS,
    runTimeBudgetMs: INGEST_RUN_TIME_BUDGET_MS
  });

  const app = createApp({
    db,
    ingestService,
    geoService,
    rootDir: ROOT_DIR,
    corsAllowedOrigins: CORS_ALLOWED_ORIGINS,
    adminToken: ADMIN_TOKEN
  });

  const server = app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
    console.log(
      `Semantic pipeline: mode=${PIPELINE_MODE} configured=${semanticPipeline.isConfigured()}`
    );
  });

  cron.schedule(INGEST_CRON, async () => {
    try {
      const result = await ingestService.runIngestion({ trigger: 'scheduler' });
      console.log(
        `[ingest:scheduler] status=${result.status} processed=${result.processedCount || 0} published=${result.publishedCount || 0}`
      );
    } catch (error) {
      console.error('[ingest:scheduler] failed', error.message);
    }
  });

  ingestService
    .runIngestion({ trigger: 'startup' })
    .then((result) => {
      console.log(
        `[ingest:startup] status=${result.status} processed=${result.processedCount || 0} published=${result.publishedCount || 0}`
      );
    })
    .catch((error) => {
      console.error('[ingest:startup] failed', error.message);
    });

  const shutdown = () => {
    console.log('Shutting down...');
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  console.error('Bootstrap failed', error);
  process.exit(1);
});
