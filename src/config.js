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
export const PIPELINE_MODE = process.env.PIPELINE_MODE || 'semantic';
export const SEMANTIC_PUBLISH_THRESHOLD = Number(process.env.SEMANTIC_PUBLISH_THRESHOLD || 0.8);
export const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY || '';
export const USER_AGENT =
  process.env.INGEST_USER_AGENT ||
  'chennai-crime-map/1.0 (localhost development; contact: local-admin@example.com)';
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
  return readJson(path.join(ROOT_DIR, 'config', 'chennai_localities.json'));
}

export function loadBoundaryGeoJson() {
  return readJson(path.join(ROOT_DIR, 'geo', 'chennai_suburbs.geojson'));
}
