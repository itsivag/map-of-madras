import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');

loadDotEnv(path.join(ROOT_DIR, '.env'));

export const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'crime_map.sqlite');
export const PORT = Number(process.env.PORT || 3000);
export const INGEST_CRON = process.env.INGEST_CRON || '0 * * * *';
export const RSS_MAX_ITEMS_PER_FEED = Number(process.env.RSS_MAX_ITEMS_PER_FEED || 8);
export const INGEST_MAX_ITEMS_PER_SOURCE = Number(process.env.INGEST_MAX_ITEMS_PER_SOURCE || 4);
export const MANUAL_INGEST_LOOKBACK_HOURS = Number(
  process.env.MANUAL_INGEST_LOOKBACK_HOURS || 4
);
export const INGEST_WINDOW_OVERLAP_MINUTES = Number(
  process.env.INGEST_WINDOW_OVERLAP_MINUTES || 30
);
export const INGEST_SOURCE_TIME_BUDGET_MS = Number(
  process.env.INGEST_SOURCE_TIME_BUDGET_MS || 30000
);
export const INGEST_ITEM_TIMEOUT_MS = Number(process.env.INGEST_ITEM_TIMEOUT_MS || 12000);
export const INGEST_RUN_TIME_BUDGET_MS = Number(process.env.INGEST_RUN_TIME_BUDGET_MS || 120000);
export const PIPELINE_MODE = process.env.PIPELINE_MODE || 'semantic';
export const SEMANTIC_PUBLISH_THRESHOLD = Number(process.env.SEMANTIC_PUBLISH_THRESHOLD || 0.8);
export const CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || '*';
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
export const BROWSERLESS_API_KEY = process.env.BROWSERLESS_API_KEY || '';
export const BROWSERLESS_BASE_URL =
  process.env.BROWSERLESS_BASE_URL || 'https://production-sfo.browserless.io';
export const USER_AGENT =
  process.env.INGEST_USER_AGENT ||
  'map-of-madras/1.0 (localhost development; contact: local-admin@example.com)';
export const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
export const BEDROCK_TITAN_EMBED_MODEL_ID =
  process.env.BEDROCK_TITAN_EMBED_MODEL_ID || 'amazon.titan-embed-text-v2:0';
export const BEDROCK_MINIMAX_MODEL_ID =
  process.env.BEDROCK_MINIMAX_MODEL_ID || 'minimax.minimax-m2.1';
export const QDRANT_URL = process.env.QDRANT_URL || '';
export const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
export const QDRANT_ARTICLE_COLLECTION =
  process.env.QDRANT_ARTICLE_COLLECTION || 'article_chunks_v1';
export const QDRANT_TAXONOMY_COLLECTION =
  process.env.QDRANT_TAXONOMY_COLLECTION || 'crime_taxonomy_v1';
export const SEMANTIC_PROMPT_VERSION = process.env.SEMANTIC_PROMPT_VERSION || 'semantic-v1';

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function readJson(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(content);
}

export function loadSourcesConfig() {
  return readJson(path.join(ROOT_DIR, 'config', 'sources.json'));
}

export function loadLocalities() {
  const localities = readJson(path.join(ROOT_DIR, 'config', 'chennai_localities.json'));
  const regionalLocalities = loadGreaterChennaiLocalities();
  return [...new Set([...localities, ...regionalLocalities])];
}

export function loadGreaterChennaiLocalities() {
  return readJson(path.join(ROOT_DIR, 'config', 'greater_chennai_localities.json'));
}

export function loadBoundaryGeoJson() {
  return readJson(path.join(ROOT_DIR, 'geo', 'chennai_suburbs.geojson'));
}
