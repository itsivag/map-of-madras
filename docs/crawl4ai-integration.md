# Crawl4AI Integration Guide

## Overview
Replace Browserless with Crawl4AI for article content extraction.

## Docker Setup

Add to `docker-compose.yml`:

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - CRAWL4AI_URL=http://crawl4ai:11235
      # Remove: BROWSERLESS_API_KEY, BROWSERLESS_BASE_URL
    depends_on:
      - crawl4ai

  crawl4ai:
    image: unclecode/crawl4ai:latest
    ports:
      - "11235:11235"
    environment:
      - CRAWL4AI_API_TOKEN=your-secret-token  # Optional auth
    volumes:
      - crawl4ai-cache:/app/.crawl4ai
    restart: unless-stopped

volumes:
  crawl4ai-cache:
```

## Code Changes

### 1. New Service: `src/services/crawl4ai.js`

```javascript
const CRAWL4AI_DEFAULT_URL = 'http://localhost:11235';

export function createCrawl4AIClient({ 
  fetchImpl = fetch, 
  baseUrl = CRAWL4AI_DEFAULT_URL,
  apiToken = '' 
}) {
  return {
    async getContent(url, { timeoutMs = 15000 }) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      
      try {
        const response = await fetchImpl(`${baseUrl}/crawl`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiToken && { 'Authorization': `Bearer ${apiToken}` })
          },
          body: JSON.stringify({
            url,
            priority: 10,
            // Crawl4AI-specific options
            result: {
              cleaned_html: true,     // Clean HTML for parsing
              markdown: true,          // Markdown for LLM
              extracted_content: true, // Auto-extracted article
              metadata: true           // publishedAt, title, etc.
            }
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          const error = await response.text();
          throw new Error(`Crawl4AI request failed: ${response.status} ${error}`);
        }

        const result = await response.json();
        
        // Return in compatible format
        return {
          html: result.cleaned_html || '',
          markdown: result.markdown || '',
          extractedContent: result.extracted_content || '',
          metadata: result.metadata || {}
        };
      } finally {
        clearTimeout(timeout);
      }
    }
  };
}
```

### 2. Update `src/services/rss.js`

Replace the Browserless client creation:

```javascript
// OLD
import { createBrowserlessClient } from './browserless.js';

// NEW  
import { createCrawl4AIClient } from './crawl4ai.js';

export function createRssService({
  // ... other params
  // Remove: browserlessApiKey, browserlessBaseUrl
  crawl4aiUrl = 'http://localhost:11235',
  crawl4aiToken = ''
}) {
  const crawl4ai = createCrawl4AIClient({
    fetchImpl,
    baseUrl: crawl4aiUrl,
    apiToken: crawl4aiToken
  });
  
  // Use crawl4ai instead of browserless
}
```

### 3. Enhanced Article Extraction

Crawl4AI's markdown output can simplify `parseArticlePageDataFromHtml`:

```javascript
async function fetchArticlePageData(url) {
  // Try direct fetch first (fast path)
  const directResult = await tryDirectFetch(url);
  if (hasSubstantialContent(directResult)) {
    return directResult;
  }
  
  // Fallback to Crawl4AI with markdown extraction
  const crawlResult = await crawl4ai.getContent(url);
  
  return {
    content: crawlResult.extractedContent || crawlResult.markdown,
    title: crawlResult.metadata?.title || extractTitle(crawlResult.html),
    publishedAt: crawlResult.metadata?.publishedAt || extractDate(crawlResult.html)
  };
}
```

### 4. Update Configuration

In `src/config.js`:

```javascript
// Remove Browserless config
// export const BROWSERLESS_API_KEY = ...
// export const BROWSERLESS_BASE_URL = ...

// Add Crawl4AI config
export const CRAWL4AI_URL = process.env.CRAWL4AI_URL || 'http://localhost:11235';
export const CRAWL4AI_TOKEN = process.env.CRAWL4AI_TOKEN || '';
```

## Benefits for Crime Map Pipeline

### 1. Better Content Quality
- **Markdown output**: Cleaner text for semantic analysis
- **Auto-extraction**: Removes ads, navigation, comments
- **Structured metadata**: JSON-LD extraction built-in

### 2. Cost Savings
- No per-request API costs
- Single Docker container handles all requests
- Caching built-in

### 3. Improved Extraction
```javascript
// Example: Crawl4AI returns this structure
{
  "markdown": "# Man killed in Chennai\n\nA 35-year-old man was...",
  "metadata": {
    "title": "Man killed in Chennai robbery",
    "publishedAt": "2026-03-14T10:30:00Z",
    "author": "Staff Reporter",
    "site_name": "The Hindu"
  },
  "extracted_content": "A 35-year-old man was killed..." // Article body only
}
```

## Testing

```javascript
// tests/unit/crawl4ai.test.js
import { describe, it, expect } from 'vitest';
import { createCrawl4AIClient } from '../src/services/crawl4ai.js';

describe('Crawl4AI Client', () => {
  it('should fetch and parse article content', async () => {
    const client = createCrawl4AIClient({
      baseUrl: 'http://localhost:11235'
    });
    
    const result = await client.getContent('https://example.com/news/article');
    
    expect(result.markdown).toBeDefined();
    expect(result.metadata).toBeDefined();
  });
});
```

## Migration Steps

1. **Add Crawl4AI service** to Docker Compose
2. **Create `crawl4ai.js` service** wrapper
3. **Update `rss.js`** to use Crawl4AI client
4. **Update `config.js`** - swap Browserless env vars
5. **Update `server.js`** - pass Crawl4AI config
6. **Remove Browserless** env vars from `.env`
7. **Test** article extraction quality

## Rollback Plan

Keep Browserless code as fallback:

```javascript
const fetchArticlePageData = async (url) => {
  // Try Crawl4AI first
  try {
    return await fetchWithCrawl4AI(url);
  } catch (error) {
    console.warn('Crawl4AI failed, falling back to Browserless:', error.message);
    return await fetchWithBrowserless(url); // Keep old method
  }
};
```
