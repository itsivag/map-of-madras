# Chennai Crime Map

Node + Express + SQLite + Leaflet app that ingests Chennai crime reports every hour and plots semantically extracted incidents on an OpenStreetMap-based map.

## Features

- Open/free map tiles from OpenStreetMap
- Chennai + suburbs map restriction via polygon geofence
- Hourly ingestion scheduler (`node-cron`) and startup ingestion run
- Firecrawl-powered article scraping
- Semantic retrieval pipeline using Bedrock Titan embeddings, Qdrant, and MiniMax M2.1
- Official-source integration for Tamil Nadu Police metro station masters
- Crime categorization (`murder`, `rape`, `assault`, `robbery/theft`, `kidnapping`, `fraud/scam`, `drug offense`, `other`)
- Location extraction + geocoding with Photon and Nominatim
- Semantic confidence threshold publishing (`>= 0.80`)
- Diversified Chennai-focused source mix across English and Tamil publishers
- Developer debug endpoint for inspecting extraction evidence and rejection reasons
- Full-screen Chennai-only map with emoji markers

## Setup

```bash
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000)

## Frontend Deploy (GitHub Pages)

The frontend is now deployable as a static site on GitHub Pages.

1. In the GitHub repo, set Pages source to `GitHub Actions`.
2. Add a repository variable named `PAGES_API_BASE_URL`.
   Example: `https://your-backend.up.railway.app`
3. Push to `main`.

The workflow at [deploy-pages.yml](/Users/itsivag/AntigravityProjects/chennai-gbu-map/.github/workflows/deploy-pages.yml) will:

- build a static Pages artifact from `public/`
- inject the backend base URL into `runtime-config.js`
- publish the artifact to GitHub Pages

Local Pages build:

```bash
PAGES_API_BASE_URL=https://your-backend.example.com npm run build:pages
```

Generated static output goes to `dist-pages/`.

## Backend Deploy

For the current backend architecture, the practical free deployment path is:

1. Deploy the Node API on Railway
2. Point `QDRANT_URL` at Qdrant Cloud free tier
3. Store SQLite on a mounted Railway volume by setting `DB_PATH`

The repo includes a [Dockerfile](/Users/itsivag/AntigravityProjects/chennai-gbu-map/Dockerfile) for hosts that prefer container deploys.

Recommended backend env:

```bash
PORT=3000
DB_PATH=/data/crime_map.sqlite
QDRANT_URL=https://your-qdrant-cluster-url
CORS_ALLOWED_ORIGINS=https://itsivag.github.io
ADMIN_TOKEN=your-random-admin-token
```

If `ADMIN_TOKEN` is set, these endpoints require `Authorization: Bearer <token>`:

- `POST /api/ingest/run`
- `POST /api/official/sync`
- `GET /api/debug/article`

The public map endpoints stay open:

- `GET /api/incidents`
- `GET /api/meta`
- `GET /api/boundary`

## Deployment Notes

- GitHub Pages serves only the static frontend. The API must run elsewhere.
- The frontend reads the backend URL from [runtime-config.js](/Users/itsivag/AntigravityProjects/chennai-gbu-map/public/runtime-config.js).
- Static asset paths are relative, so the frontend works on project Pages paths like `/chennai/`.
- `CORS_ALLOWED_ORIGINS` should be narrowed to your actual Pages origin in production.

## Environment variables

- `PORT` (default `3000`)
- `DB_PATH` (default `data/crime_map.sqlite`)
- `INGEST_CRON` (default `0 * * * *`)
- `PIPELINE_MODE` (default `semantic`, `shadow` stores semantic results without publishing)
- `SEMANTIC_PUBLISH_THRESHOLD` (default `0.8`)
- `CORS_ALLOWED_ORIGINS` (default `*`)
- `ADMIN_TOKEN` (optional bearer token for admin/debug routes)
- `RSS_MAX_ITEMS_PER_FEED` (default `8`)
- `INGEST_MAX_ITEMS_PER_SOURCE` (default `3`)
- `INGEST_SOURCE_TIME_BUDGET_MS` (default `30000`)
- `INGEST_ITEM_TIMEOUT_MS` (default `12000`)
- `INGEST_RUN_TIME_BUDGET_MS` (default `120000`)
- `FIRECRAWL_API_KEY` (required for article scraping)
- `INGEST_USER_AGENT` (default set in `src/config.js`)
- `AWS_REGION`
- `BEDROCK_TITAN_EMBED_MODEL_ID` (default `amazon.titan-embed-text-v2:0`)
- `BEDROCK_MINIMAX_MODEL_ID` (default `minimax.minimax-m2.1`)
- `QDRANT_URL`
- `QDRANT_API_KEY` (optional)
- `QDRANT_ARTICLE_COLLECTION` (default `article_chunks_v1`)
- `QDRANT_TAXONOMY_COLLECTION` (default `crime_taxonomy_v1`)
- `SEMANTIC_PROMPT_VERSION` (default `semantic-v1`)
- `TN_POLICE_BASE_URL` (default `https://www.police.tn.gov.in/digigov`)
- `TN_POLICE_METRO_UNITS` (default `CHENNAI CITY,TAMBARAM CITY,AVADI CITY`)

## APIs

- `GET /api/incidents?from=ISO&to=ISO&category=...&bbox=minLng,minLat,maxLng,maxLat&limit=...`
- `GET /api/meta`
- `GET /api/official/meta`
- `GET /api/official/police-stations?metroUnit=CHENNAI%20CITY`
- `POST /api/official/sync` (`ADMIN_TOKEN` optional protection)
- `GET /api/debug/article?url=...` (`ADMIN_TOKEN` optional protection)
- `GET /api/boundary`
- `POST /api/ingest/run` (`ADMIN_TOKEN` optional protection)

## Testing

```bash
npm test
```

Test coverage includes:

- Semantic schema validation
- Stable chunk generation
- Qdrant indexing and filtered search glue
- Bedrock response parsing
- Boundary checks and geocoding behavior
- Dedupe key generation
- RSS parsing and article enrichment
- Ingestion pipeline DB writes
- API filters, meta, and debug endpoint behavior
- Frontend smoke checks for map capabilities

## Notes

- Markers are based on publicly reported news and are not official police records.
- Official-source integration currently ingests the TN Police metro station master; FIR view, arrested-person search, missing-person search, and court cause lists are tracked as blocked because the live official endpoints require token or captcha flows.
- Popups are anonymized and avoid personal-identifying details.
- Source feeds are configurable in `config/sources.json`.
- `html-links` sources can define `htmlLinkIncludePatterns` and `htmlLinkExcludePatterns` in `config/sources.json`.
- SQLite is the operational store; Qdrant stores retrieval vectors and evidence chunks.
