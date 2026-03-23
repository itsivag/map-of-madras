# Map of Madras

Map of Madras is a Chennai-focused incident map that continuously ingests crime-related news coverage, extracts structured incident data using AI, and plots recent incidents on a restricted Chennai map.

Live deployment:

- frontend: [https://mapofmadras.web.app](https://mapofmadras.web.app)
- backend API: [https://backend-production-a0f6.up.railway.app](https://backend-production-a0f6.up.railway.app)

The repo has a split deployment model:

- frontend: static Next.js app exported to `out/` and deployed with Firebase Hosting
- backend: Node + Express API deployed on Railway for ingestion, metadata, and incident feeds
- database: SQLite for incidents and article storage

## What the app does

- Discovers articles from Chennai news sources using Crawl4AI
- Extracts likely crime incidents from articles using LLM (AWS Bedrock)
- Resolves incident locations to Chennai-area coordinates using geocoding
- Filters incidents to Chennai and its suburbs only
- Publishes only high-confidence incidents to the map
- Merges duplicate coverage from multiple outlets into a single marker
- Shows recent incidents on a constrained web map with a simple time slider

## Ingestion Pipeline

The app supports two pipeline modes:

### 1. Simplified Pipeline (Default)
```
News Sources → Crawl4AI → Direct LLM Extraction → Geocode → Deduplicate → Publish
```

- **Discovery**: Crawl4AI scrapes news homepages for article links
- **Extraction**: Direct LLM call (MiniMax via AWS Bedrock) extracts structured data
- **Benefits**: Simpler, no vector database needed, faster for short articles
- **Trade-off**: Higher token usage (full article vs chunks)

### 2. Semantic Pipeline (Legacy)
```
News Sources → RSS/HTML → Vector Embeddings → Qdrant → Evidence Retrieval → LLM → Publish
```

- **Discovery**: RSS feeds or HTML link scraping
- **Extraction**: Vector search + targeted evidence retrieval + LLM
- **Benefits**: Lower token costs, better for very long articles
- **Trade-off**: Requires Qdrant vector database, more complex

## Frontend architecture

- Next.js App Router frontend in `app/` and `components/`
- Leaflet map rendered client-side
- Static export enabled through `next.config.mjs`
- Firebase Hosting serves the exported `out/` directory
- Runtime API base URL injected into `public/runtime-config.js`

The frontend expects the backend API to be reachable through `window.CCM_CONFIG.apiBaseUrl`. During local Next.js development this defaults to `http://localhost:3000`. The current production build points to `https://backend-production-a0f6.up.railway.app`.

## API summary

Public endpoints:

- `GET /api/incidents` - List incidents with filters (category, bbox, date range)
- `GET /api/incidents/:id` - Get incident details with related articles
- `GET /api/meta` - Service status, source health, pipeline info
- `GET /api/boundary` - Chennai boundary GeoJSON

Protected endpoints when `ADMIN_TOKEN` is configured:

- `POST /api/ingest/run` - Trigger manual ingestion
- `GET /api/debug/article?url=...` - Debug extraction for a specific URL

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

**For Simplified Pipeline (Recommended):**

```env
PORT=3000
USE_SIMPLE_PIPELINE=true
CRAWL4AI_URL=http://localhost:11235
EXTRACTION_CONFIDENCE_THRESHOLD=0.65
CRAWL4AI_MAX_ARTICLES=8
AWS_BEARER_TOKEN_BEDROCK=your_bedrock_key
AWS_REGION=us-east-1
BEDROCK_MINIMAX_MODEL_ID=minimax.minimax-m2.1
```

**For Semantic Pipeline (Legacy):**

```env
PORT=3000
USE_SIMPLE_PIPELINE=false
PIPELINE_MODE=semantic
QDRANT_URL=http://localhost:6333
AWS_BEARER_TOKEN_BEDROCK=your_bedrock_key
AWS_REGION=us-east-1
BEDROCK_TITAN_EMBED_MODEL_ID=amazon.titan-embed-text-v2:0
BEDROCK_MINIMAX_MODEL_ID=minimax.minimax-m2.1
```

Optional but recommended:

```env
DB_PATH=data/crime_map.sqlite
CORS_ALLOWED_ORIGINS=http://localhost:3001
ADMIN_TOKEN=your_admin_token
INGEST_ITEM_TIMEOUT_MS=30000
INGEST_RUN_TIME_BUDGET_MS=480000
```

### 3. Start Crawl4AI (for simplified pipeline)

```bash
docker run -d --name crawl4ai -p 11235:11235 unclecode/crawl4ai:latest
```

Or use the docker-compose file:
```bash
docker-compose -f docker-compose.crawl4ai.yml up -d
```

### 4. Run the backend API

```bash
npm run dev:api
```

The API will be available at `http://localhost:3000`.

### 5. Run the Next.js frontend

```bash
npm run dev:web
```

The frontend will be available at `http://localhost:3001`.

### 6. Build the Firebase Hosting bundle

```bash
FRONTEND_API_BASE_URL=https://backend-production-a0f6.up.railway.app npm run build:hosting
```

This writes the static export to `out/`.

### 7. Deploy to Firebase Hosting

```bash
firebase login
FRONTEND_API_BASE_URL=https://backend-production-a0f6.up.railway.app npm run deploy:hosting
```

`firebase.json` and `.firebaserc` are configured to deploy `out/` to the `mapofmadras` Firebase Hosting site.

## GitHub Actions deployment

The repo includes:

- frontend: `.github/workflows/deploy-firebase-hosting.yml`
- backend CI: `.github/workflows/deploy-backend-railway.yml`

Configure these repository settings before using them:

- Repository secret: `SECRETS_ENV`
  Paste the full backend/frontend `.env` file content here as a multiline secret.

`SECRETS_ENV` should include the frontend/runtime config needed by the workflows, including:

```env
FRONTEND_API_BASE_URL=https://backend-production-a0f6.up.railway.app
FIREBASE_PROJECT_ID=chennai-gbu-map
FIREBASE_TOKEN=your-firebase-cli-token
USE_SIMPLE_PIPELINE=true
CRAWL4AI_URL=https://your-crawl4ai-service.up.railway.app
AWS_BEARER_TOKEN_BEDROCK=your-bedrock-token
AWS_REGION=us-east-1
EXTRACTION_CONFIDENCE_THRESHOLD=0.65
```

Generate `FIREBASE_TOKEN` locally with:

```bash
firebase login:ci
```

Backend deployment happens through Railway's native GitHub repo integration. The existing backend GitHub workflow is CI-only (`npm test`) so pushes still get backend validation in GitHub, while Railway handles the actual backend deploy.

## News Sources

News sources are configured in `config/sources.json`. Each source needs:

```json
{
  "id": "the-hindu-chennai",
  "name": "The Hindu Chennai",
  "homepageUrl": "https://www.thehindu.com/news/cities/chennai/",
  "enabled": true,
  "includePatterns": ["/news/cities/chennai/"],
  "excludePatterns": ["/video/", "/photo/"],
  "maxArticles": 8
}
```

Current sources:
- The Hindu Chennai
- Times of India Chennai
- Indian Express Chennai
- New Indian Express Chennai
- DT Next Chennai
- Dinamani Chennai (Tamil)

## Important limitations

- This app maps incidents from reported news coverage, not authoritative crime records.
- News sources may have paywalls or anti-scraping measures.
- Geocoding can be approximate when articles only mention broad locations.
- Source quality and publisher behavior can affect extraction quality.
- LLM extraction may miss incidents or misclassify them.

## Tech stack

- Next.js
- React
- Leaflet
- Node.js
- Express
- SQLite
- Crawl4AI (web crawling)
- Amazon Bedrock (LLM)
- MiniMax (extraction model)
- Firebase Hosting
- Vitest

### Optional (for semantic pipeline only)
- Titan Embeddings
- Qdrant (vector database)

## Tests

```bash
npm test
```

## Architecture Comparison

| Aspect | Simplified Pipeline | Semantic Pipeline |
|--------|---------------------|-------------------|
| Dependencies | Crawl4AI + Bedrock | Crawl4AI + Bedrock + Qdrant |
| Vector DB | Not needed | Required |
| Embeddings | Not needed | Titan + storage cost |
| Token Cost | Higher (full article) | Lower (chunks only) |
| Speed | Faster setup | Slower setup |
| Accuracy | Good | Slightly better |
| Best For | Most use cases | Very high volume |

## Recent Updates

- **2026-03-23**: Added simplified pipeline with direct LLM extraction (no vectors)
- **2026-03-23**: Migrated from RSS-based to Crawl4AI-based discovery
- **2026-03-23**: Made `feed_url` nullable to support web-first sources

---

*Last updated: 2026-03-23*
