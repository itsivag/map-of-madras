import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  website_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  parser_mode TEXT NOT NULL DEFAULT 'rss',
  html_link_include_patterns TEXT,
  html_link_exclude_patterns TEXT,
  last_success_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  processed_count INTEGER NOT NULL DEFAULT 0,
  published_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS articles_raw (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  source_name TEXT,
  source_url TEXT,
  canonical_url TEXT,
  content_hash TEXT,
  title TEXT,
  published_at TEXT,
  content TEXT,
  normalized_text TEXT,
  semantic_status TEXT,
  semantic_model TEXT,
  last_indexed_at TEXT,
  fetch_run_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(fetch_run_id) REFERENCES ingestion_runs(id)
);

CREATE TABLE IF NOT EXISTS article_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_id TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  chunk_hash TEXT NOT NULL,
  qdrant_point_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(article_id) REFERENCES articles_raw(id)
);

CREATE TABLE IF NOT EXISTS semantic_extractions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  pipeline_mode TEXT NOT NULL,
  evidence_chunk_ids TEXT,
  raw_json TEXT,
  decision TEXT NOT NULL,
  confidence REAL,
  rejection_reason TEXT,
  extraction_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(article_id) REFERENCES articles_raw(id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  subcategory TEXT,
  occurred_at TEXT,
  locality TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  confidence REAL NOT NULL,
  source_name TEXT,
  source_url TEXT,
  source_domain TEXT,
  title TEXT,
  summary TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incident_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL UNIQUE,
  source_name TEXT,
  source_url TEXT NOT NULL,
  source_domain TEXT,
  title TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(incident_id) REFERENCES incidents(id)
);

CREATE TABLE IF NOT EXISTS official_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  integration_state TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  source_url TEXT,
  notes TEXT,
  last_success_at TEXT,
  last_error TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS official_police_stations (
  station_org_id TEXT PRIMARY KEY,
  station_name TEXT NOT NULL,
  metro_unit_org_id TEXT NOT NULL,
  metro_unit_name TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_incidents_published_at ON incidents(published_at);
CREATE INDEX IF NOT EXISTS idx_incidents_occurred_at ON incidents(occurred_at);
CREATE INDEX IF NOT EXISTS idx_incidents_category ON incidents(category);
CREATE INDEX IF NOT EXISTS idx_incidents_merge_lookup ON incidents(category, occurred_at, lat, lng);
CREATE INDEX IF NOT EXISTS idx_articles_raw_run_id ON articles_raw(fetch_run_id);
CREATE INDEX IF NOT EXISTS idx_articles_raw_canonical_hash ON articles_raw(canonical_url, content_hash);
CREATE INDEX IF NOT EXISTS idx_article_chunks_article_id ON article_chunks(article_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_article_chunks_article_chunk ON article_chunks(article_id, chunk_index);
CREATE INDEX IF NOT EXISTS idx_semantic_extractions_article_id ON semantic_extractions(article_id);
CREATE INDEX IF NOT EXISTS idx_official_sources_state ON official_sources(integration_state);
CREATE INDEX IF NOT EXISTS idx_official_police_stations_unit ON official_police_stations(metro_unit_org_id);
CREATE INDEX IF NOT EXISTS idx_incident_sources_incident_id ON incident_sources(incident_id);
`;

const ARTICLE_RAW_COLUMNS = [
  ['canonical_url', 'TEXT'],
  ['content_hash', 'TEXT'],
  ['semantic_status', 'TEXT'],
  ['semantic_model', 'TEXT'],
  ['last_indexed_at', 'TEXT']
];

const SOURCE_COLUMNS = [
  ['html_link_include_patterns', 'TEXT'],
  ['html_link_exclude_patterns', 'TEXT']
];

export function initDatabase(dbPath, sourceConfigs = []) {
  const dbDir = path.dirname(dbPath);
  fs.mkdirSync(dbDir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  ensureSourceColumns(db);
  ensureArticlesRawColumns(db);
  db.exec(INDEX_SQL);
  ensureLegacyIncidentSourceBackfill(db);

  seedSources(db, sourceConfigs);
  return db;
}

function seedSources(db, sourceConfigs) {
  const statement = db.prepare(`
    INSERT INTO sources (
      id,
      name,
      feed_url,
      website_url,
      enabled,
      parser_mode,
      html_link_include_patterns,
      html_link_exclude_patterns,
      updated_at
    )
    VALUES (
      @id,
      @name,
      @feedUrl,
      @websiteUrl,
      @enabled,
      @parserMode,
      @htmlLinkIncludePatterns,
      @htmlLinkExcludePatterns,
      datetime('now')
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      feed_url = excluded.feed_url,
      website_url = excluded.website_url,
      enabled = excluded.enabled,
      parser_mode = excluded.parser_mode,
      html_link_include_patterns = excluded.html_link_include_patterns,
      html_link_exclude_patterns = excluded.html_link_exclude_patterns,
      updated_at = datetime('now')
  `);

  const tx = db.transaction((sources) => {
    for (const source of sources) {
      statement.run({
        id: source.id,
        name: source.name,
        feedUrl: source.feedUrl,
        websiteUrl: source.websiteUrl || null,
        enabled: source.enabled ? 1 : 0,
        parserMode: source.parserMode || 'rss',
        htmlLinkIncludePatterns: Array.isArray(source.htmlLinkIncludePatterns)
          ? JSON.stringify(source.htmlLinkIncludePatterns)
          : null,
        htmlLinkExcludePatterns: Array.isArray(source.htmlLinkExcludePatterns)
          ? JSON.stringify(source.htmlLinkExcludePatterns)
          : null
      });
    }
  });

  tx(sourceConfigs);
}

function ensureSourceColumns(db) {
  const columns = db.prepare(`PRAGMA table_info('sources')`).all();
  const existing = new Set(columns.map((column) => column.name));

  for (const [name, type] of SOURCE_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE sources ADD COLUMN ${name} ${type}`);
    }
  }
}

function ensureArticlesRawColumns(db) {
  const columns = db.prepare(`PRAGMA table_info('articles_raw')`).all();
  const existing = new Set(columns.map((column) => column.name));

  for (const [name, type] of ARTICLE_RAW_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE articles_raw ADD COLUMN ${name} ${type}`);
    }
  }
}

function ensureLegacyIncidentSourceBackfill(db) {
  db.exec(`
    INSERT INTO incident_sources (
      incident_id,
      source_fingerprint,
      source_name,
      source_url,
      source_domain,
      title,
      published_at,
      updated_at
    )
    SELECT
      incidents.id,
      lower(hex(randomblob(16))) || ':' || incidents.id,
      incidents.source_name,
      incidents.source_url,
      incidents.source_domain,
      incidents.title,
      incidents.published_at,
      datetime('now')
    FROM incidents
    WHERE incidents.source_url IS NOT NULL
      AND incidents.source_url != ''
      AND NOT EXISTS (
        SELECT 1
        FROM incident_sources
        WHERE incident_sources.incident_id = incidents.id
      )
  `);
}
