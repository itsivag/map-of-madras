# Map of Madras

Map of Madras is a Chennai-focused incident map that continuously ingests crime-related news coverage, extracts structured incident data, and plots recent incidents on a restricted Chennai map.

Live deployment:

- frontend: [https://chennai-gbu-map.web.app](https://chennai-gbu-map.web.app)
- backend API: [https://backend-production-a0f6.up.railway.app](https://backend-production-a0f6.up.railway.app)

The repo now has a split deployment model:

- frontend: static Next.js app exported to `out/` and deployed with Firebase Hosting
- backend: Node + Express API deployed on Railway for ingestion, metadata, and incident feeds
- data services: SQLite for operations and Qdrant for vector retrieval

## What the app does

- Scrapes Chennai-focused news sources on a schedule
- Extracts likely crime incidents from articles using a semantic pipeline
- Resolves incident locations to Chennai-area coordinates
- Filters incidents to Chennai and its suburbs only
- Publishes only high-confidence incidents to the map
- Merges duplicate coverage from multiple outlets into a single marker
- Shows recent incidents on a constrained web map with a simple time slider

## Frontend architecture

- Next.js App Router frontend in `app/` and `components/`
- Leaflet map rendered client-side
- Static export enabled through `next.config.mjs`
- Firebase Hosting serves the exported `out/` directory
- Runtime API base URL injected into `public/runtime-config.js`

The frontend expects the backend API to be reachable through `window.CCM_CONFIG.apiBaseUrl`. During local Next.js development this defaults to `http://localhost:3000`. The current production build points to `https://backend-production-a0f6.up.railway.app`.

## API summary

Public endpoints:

- `GET /api/incidents`
- `GET /api/incidents/:id`
- `GET /api/meta`
- `GET /api/boundary`

Protected endpoints when `ADMIN_TOKEN` is configured:

- `POST /api/ingest/run`
- `GET /api/debug/article?url=...`

## Local setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

Minimum practical backend config:

```env
PORT=3000
PIPELINE_MODE=semantic
BROWSERLESS_API_KEY=your_browserless_token
BROWSERLESS_BASE_URL=https://production-sfo.browserless.io
AWS_BEARER_TOKEN_BEDROCK=your_bedrock_key
AWS_REGION=us-east-1
QDRANT_URL=http://localhost:6333
```

Optional but recommended:

```env
DB_PATH=data/crime_map.sqlite
CORS_ALLOWED_ORIGINS=http://localhost:3001
ADMIN_TOKEN=your_admin_token
RSS_MAX_ITEMS_PER_FEED=8
INGEST_MAX_ITEMS_PER_SOURCE=3
INGEST_SOURCE_TIME_BUDGET_MS=30000
INGEST_ITEM_TIMEOUT_MS=12000
INGEST_RUN_TIME_BUDGET_MS=120000
```

### 3. Start Qdrant

```bash
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
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
firebase use --add
FRONTEND_API_BASE_URL=https://backend-production-a0f6.up.railway.app npm run deploy:hosting
```

`firebase.json` is already configured to serve `out/`.

## GitHub Actions deployment

The repo includes both deployment workflows:

- frontend: [`.github/workflows/deploy-firebase-hosting.yml`](/Users/itsivag/AntigravityProjects/chennai-gbu-map/.github/workflows/deploy-firebase-hosting.yml)
- backend: [`.github/workflows/deploy-backend-railway.yml`](/Users/itsivag/AntigravityProjects/chennai-gbu-map/.github/workflows/deploy-backend-railway.yml)

Configure these repository settings before using them:

- Repository secret: `SECRETS_ENV`
  Paste the full backend/frontend `.env` file content here as a multiline secret.

`SECRETS_ENV` should include everything needed by the workflows, including:

```env
FRONTEND_API_BASE_URL=https://backend-production-a0f6.up.railway.app
FIREBASE_PROJECT_ID=chennai-gbu-map
FIREBASE_TOKEN=your-firebase-cli-token
RAILWAY_PROJECT_ID=your-railway-project-id
RAILWAY_ENVIRONMENT=production
RAILWAY_SERVICE=backend
RAILWAY_TOKEN=your-railway-token
BROWSERLESS_API_KEY=your-browserless-token
BROWSERLESS_BASE_URL=https://production-sfo.browserless.io
AWS_BEARER_TOKEN_BEDROCK=your-bedrock-token
AWS_REGION=us-east-1
QDRANT_URL=http://localhost:6333
```

Generate `FIREBASE_TOKEN` locally with:

```bash
firebase login:ci
```

## Important limitations

- This app maps incidents from reported news coverage, not authoritative crime records.
- Browserless usage is only needed when direct HTML fetches do not expose enough article content.
- Browserless free-tier quotas can still be exhausted on heavier ingestion runs.
- Geocoding can still be approximate when articles only mention broad locations.
- Source quality and publisher behavior can affect extraction quality.

## Tech stack

- Next.js
- React
- Leaflet
- Node.js
- Express
- SQLite
- Browserless
- Amazon Bedrock
- MiniMax
- Titan Embeddings
- Qdrant
- Firebase Hosting
- Vitest

## Tests

```bash
npm test
```
