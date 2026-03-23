function compactText(value = '') {
  if (typeof value !== 'string') {
    return '';
  }
  return value.replace(/\s+/g, ' ').trim();
}

const CRAWL4AI_DEFAULT_URL = 'http://localhost:11235';

function withTimeout(ms = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

function withPromiseTimeout(promise, ms, label) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }

  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms.`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
}

export function createCrawl4AIClient({
  fetchImpl = fetch,
  baseUrl = CRAWL4AI_DEFAULT_URL,
  apiToken = ''
}) {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  return {
    async getContent(url, { timeoutMs = 60000 } = {}) {
      const crawlUrl = `${normalizedBaseUrl}/crawl`;
      console.log(`[Crawl4AI] Fetching: ${url} (timeout: ${timeoutMs}ms)`);
      const timeout = withTimeout(timeoutMs);

      try {
        const response = await fetchImpl(crawlUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(apiToken && { Authorization: `Bearer ${apiToken}` })
          },
          body: JSON.stringify({
            urls: [url],
            priority: 10,
            result: {
              cleaned_html: true,
              markdown: true,
              extracted_content: true,
              metadata: true
            }
          }),
          signal: timeout.signal
        });

        if (!response.ok) {
          const errorBody = compactText(await response.text());
          throw new Error(
            `Crawl4AI request failed: ${response.status}${errorBody ? ` ${errorBody.slice(0, 240)}` : ''}`
          );
        }

        const responseData = await response.json();
        // Crawl4AI returns {success: true, results: [...]}
        const results = responseData.results || responseData;
        const result = Array.isArray(results) ? results[0] : results;

        if (!result) {
          throw new Error('Crawl4AI returned empty result');
        }

        // Normalize response format
        return {
          html: result.cleaned_html || result.html || '',
          markdown: result.markdown || '',
          extractedContent: result.extracted_content || '',
          metadata: {
            title: result.metadata?.title || result.title || '',
            publishedAt: result.metadata?.publishedAt || result.metadata?.date || null,
            author: result.metadata?.author || '',
            siteName: result.metadata?.site_name || ''
          }
        };
      } catch (error) {
        console.error(`[Crawl4AI] Error fetching ${url}: ${error.message}`);
        if (error.name === 'AbortError') {
          console.error(`[Crawl4AI] Request was aborted (timeout: ${timeoutMs}ms)`);
        }
        throw error;
      } finally {
        timeout.clear();
      }
    }
  };
}

export function createCrawl4AIService({
  fetchImpl = fetch,
  baseUrl = CRAWL4AI_DEFAULT_URL,
  apiToken = ''
}) {
  const client = createCrawl4AIClient({ fetchImpl, baseUrl, apiToken });

  return {
    client,
    async fetchArticleContent(url, { timeoutMs = 15000 } = {}) {
      const result = await withPromiseTimeout(
        client.getContent(url, { timeoutMs }),
        timeoutMs + 1000,
        `Crawl4AI content for ${url}`
      );

      // Return format compatible with existing rss.js expectations
      return {
        content: compactText(result.extractedContent || result.markdown || result.html || ''),
        title: String(result.metadata?.title || ''),
        publishedAt: result.metadata?.publishedAt || null
      };
    }
  };
}
