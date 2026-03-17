# Deploy on Railway with Crawl4AI

## Overview

Since Railway doesn't support Docker Compose, we deploy Crawl4AI and the Node.js app as separate services that communicate over Railway's internal network.

## Architecture

```
┌─────────────────────┐         ┌─────────────────────┐
│   Node.js App       │◄───────►│   Crawl4AI Service  │
│   (Railway Service) │  HTTP   │   (Railway Service) │
└─────────────────────┘         └─────────────────────┘
          │
          ▼
┌─────────────────────┐
│   SQLite (Volume)   │
└─────────────────────┘
```

## Step 1: Deploy Crawl4AI Service

### Create a New Railway Project for Crawl4AI

1. Go to Railway Dashboard → New Project → Empty Project
2. Click "New" → "Docker Image"
3. Image name: `unclecode/crawl4ai:latest`
4. Add Environment Variables:
   ```
   CRAWL4AI_API_TOKEN=your-secure-token-here
   MAX_CONCURRENT_CRAWLS=5
   DEFAULT_TIMEOUT=30000
   ```
5. Add a TCP port: `11235`
6. Deploy

### Get the Internal URL

After deployment, Railway provides an internal URL:
```
http://crawl4ai.railway.internal:11235
```

Or use the public domain if needed (add auth token for security).

## Step 2: Deploy Node.js App Service

### Configure Environment Variables

In your main app's Railway service, set:

```bash
# Crawl4AI connection
CRAWL4AI_URL=http://crawl4ai.railway.internal:11235
CRAWL4AI_TOKEN=your-secure-token-here

# Disable Browserless (we're using Crawl4AI)
BROWSERLESS_API_KEY=

# Other settings
NODE_ENV=production
PORT=3000
PIPELINE_MODE=semantic
SEMANTIC_PUBLISH_THRESHOLD=0.65
# ... other env vars
```

### Deploy

Railway auto-detects the Dockerfile:

```bash
# Using Railway CLI
railway login
railway link
railway up
```

## Step 3: Verify Connection

Test the Crawl4AI connection from your Node.js app:

```bash
railway logs

# Look for:
# "Crawl4AI configured: http://crawl4ai.railway.internal:11235"
```

## Private Network Communication

Railway services in the same project can communicate via internal DNS:

| Service Name | Internal URL |
|--------------|--------------|
| crawl4ai | `http://crawl4ai.railway.internal:11235` |
| app | `http://app.railway.internal:3000` |

## Cost Comparison

| Component | Browserless (SaaS) | Railway + Crawl4AI |
|-----------|-------------------|-------------------|
| Browserless API | ~$50-100/mo | $0 |
| Crawl4AI Service | - | ~$5-10/mo (512MB-1GB) |
| Node.js App | ~$5-20/mo | ~$5-20/mo |
| **Total** | **$55-120/mo** | **$10-30/mo** |

## Troubleshooting

### Service can't reach Crawl4AI

1. Check both services are in the same Railway project
2. Verify the internal URL format: `http://<service-name>.railway.internal:<port>`
3. Check logs: `railway logs -s crawl4ai`

### Crawl4AI OOM (Out of Memory)

Crawl4AI uses Chrome internally and needs at least 512MB-1GB RAM:

```
Railway Dashboard → Crawl4AI Service → Settings → Resources
→ Increase RAM to 1024MB or 2048MB
```

### Slow crawls

Railway's hobby plan has limited CPU. For better performance:
- Upgrade to Pro plan
- Or deploy on a VPS (see deploy-vps-podman.md)

## Alternative: Single Service with Embedded Crawl4AI

If you prefer one service (not recommended due to resource contention):

Create a `Dockerfile.combined`:

```dockerfile
# Multi-stage build with both services
FROM unclecode/crawl4ai:latest as crawl4ai

FROM node:22-bookworm-slim

# Install dependencies for Chrome
RUN apt-get update && apt-get install -y \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Copy Crawl4AI from first stage
COPY --from=crawl4ai /app /crawl4ai

# Setup Node.js app
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

# Start script that runs both services
COPY start-combined.sh /start.sh
RUN chmod +x /start.sh

ENV CRAWL4AI_URL=http://localhost:11235
EXPOSE 3000 11235

CMD ["/start.sh"]
```

This is complex and resource-heavy. The separate services approach (Option A) is recommended.
