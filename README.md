# Map of Madras

Map of Madras is a Chennai-focused incident map that continuously ingests crime-related news coverage, extracts structured incident data, and plots recent incidents on a restricted Chennai map.

The app is designed to answer a narrow question:

"What recent crime incidents reported in Chennai and its suburbs can be mapped to a usable location?"

It is not a general city map, and it is not an official police record system.

## What The App Does

- Scrapes Chennai-focused news sources on a schedule
- Extracts likely crime incidents from articles using a semantic pipeline
- Resolves incident locations to Chennai-area coordinates
- Filters incidents to Chennai and its suburbs only
- Publishes only high-confidence incidents to the map
- Merges duplicate coverage from multiple outlets into a single marker
- Shows recent incidents on a constrained web map with a simple time slider

## How It Works

### 1. Source ingestion

The backend pulls articles from a mixed source list that includes:

- Chennai-focused English publishers
- Chennai-focused Tamil publishers
- Google News crime search feeds
- Official-source metadata such as Tamil Nadu Police metro station masters

### 2. Article extraction

Article pages are fetched through Firecrawl so the app can work across different publisher layouts without brittle per-site scraping rules.

### 3. Semantic incident extraction

Each article is processed through a semantic pipeline built around:

- Amazon Titan embeddings for vectorization
- Qdrant for retrieval
- MiniMax on Bedrock for structured incident extraction

The pipeline extracts:

- whether the article is describing a real crime event
- crime category and subcategory
- time of incident
- location text
- evidence chunks supporting the extraction
- confidence score

### 4. Chennai-only location filtering

Resolved locations are geocoded and validated against the Chennai boundary polygon. Incidents outside Chennai and its suburbs are rejected.

### 5. Publishing and deduplication

Only incidents above the publish threshold are shown on the map. If multiple outlets describe the same incident, the app merges them into one marker and stores multiple source links under that marker.

## Main Features

### Map

- Full-screen web map
- Chennai + suburbs only
- Open/free map tiles
- Minimal top-left time slider
- Emoji crime markers
- Hover popup with click-to-pin behavior

### Incident data

- Categories:
  - `murder`
  - `rape`
  - `assault`
  - `robbery/theft`
  - `kidnapping`
  - `fraud/scam`
  - `drug offense`
  - `other`
- Duplicate incident merging across outlets
- Multiple source links per marker
- Recent incident filtering by time range

### Ingestion pipeline

- Hourly scheduler
- Startup ingestion run
- Firecrawl-based article scraping
- Semantic retrieval and extraction
- Qdrant-backed evidence search
- Bedrock-based structured classification
- Per-source caps and runtime budgets to stop long ingestion runs from hanging

### Data quality and controls

- Confidence threshold before publishing
- Debug endpoint for single-article inspection
- Official-source metadata integration
- Protected admin endpoints via bearer token
- CORS support for separate frontend/backend deployment

## Current UI

The frontend is intentionally minimal:

- the map fills the screen
- only a time/day slider is shown
- markers open on hover
- clicking a marker keeps the popup open until the user clicks outside

## API Summary

Public endpoints:

- `GET /api/incidents`
- `GET /api/incidents/:id`
- `GET /api/meta`
- `GET /api/boundary`
- `GET /api/official/meta`
- `GET /api/official/police-stations?metroUnit=...`

Protected endpoints when `ADMIN_TOKEN` is configured:

- `POST /api/ingest/run`
- `POST /api/official/sync`
- `GET /api/debug/article?url=...`

## Important Limitations

- This app maps incidents from reported news coverage, not from authoritative crime records.
- Official police incident endpoints are not fully integrated because many live official flows require captcha or authenticated session tokens.
- Geocoding can still be approximate when articles only mention broad locations.
- Source quality and publisher behavior can affect extraction quality.

## Deployment Model

The app is split cleanly for deployment:

- frontend: static site, suitable for GitHub Pages
- backend: Node + Express API, suitable for Railway or another Node host
- vector store: Qdrant
- operational store: SQLite

The repo includes:

- GitHub Pages workflow for the frontend
- Dockerfile for backend/container deployment
- runtime frontend API configuration

## Tech Stack

- Node.js
- Express
- SQLite
- Leaflet
- Firecrawl
- Amazon Bedrock
- MiniMax
- Titan Embeddings
- Qdrant
- Vitest

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create environment file

Create `.env` with the required runtime values.

Minimum practical config:

```env
PORT=3000
PIPELINE_MODE=semantic
FIRECRAWL_API_KEY=your_firecrawl_key
AWS_BEARER_TOKEN_BEDROCK=your_bedrock_key
AWS_REGION=us-east-1
QDRANT_URL=http://localhost:6333
```

Optional but recommended:

```env
DB_PATH=data/crime_map.sqlite
CORS_ALLOWED_ORIGINS=*
ADMIN_TOKEN=your_admin_token
RSS_MAX_ITEMS_PER_FEED=8
INGEST_MAX_ITEMS_PER_SOURCE=3
INGEST_SOURCE_TIME_BUDGET_MS=30000
INGEST_ITEM_TIMEOUT_MS=12000
INGEST_RUN_TIME_BUDGET_MS=120000
```

### 3. Start Qdrant

If you are running locally with Docker:

```bash
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
```

### 4. Start the app

```bash
npm start
```

### 5. Open the map

Open:

```text
http://localhost:3000
```

### 6. Trigger ingestion manually if needed

```bash
curl -H 'Authorization: Bearer YOUR_ADMIN_TOKEN' \
  -X POST 'http://localhost:3000/api/ingest/run'
```

If `ADMIN_TOKEN` is not set, the header is not required.

### 7. Run tests

```bash
npm test
```
