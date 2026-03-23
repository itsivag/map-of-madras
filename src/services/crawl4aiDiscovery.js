import * as cheerio from 'cheerio';
import { createCrawl4AIClient } from './crawl4ai.js';

function compactText(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function toAbsoluteUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return '';
  }
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string' && item.trim());
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item.trim()) : [];
  } catch {
    return [];
  }
}

export class Crawl4aiDiscoveryService {
  constructor({ 
    crawl4aiClient = null, 
    fetchImpl = fetch,
    baseUrl = '',
    apiToken = '',
    maxArticlesPerSource = 10,
    discoveryTimeoutMs = 20000
  } = {}) {
    this.client = crawl4aiClient || (baseUrl ? createCrawl4AIClient({ fetchImpl, baseUrl, apiToken }) : null);
    this.maxArticlesPerSource = maxArticlesPerSource;
    this.discoveryTimeoutMs = discoveryTimeoutMs;
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.client);
  }

  /**
   * Discover article URLs from a news source homepage
   * @param {string} sourceUrl - The homepage URL to scrape
   * @param {string[]} includePatterns - URL must include ALL these patterns
   * @param {string[]} excludePatterns - URL must NOT include ANY of these patterns
   * @returns {Promise<Array<{url: string, title: string, publishedAt: string|null}>>}
   */
  async discoverArticles(sourceUrl, includePatterns = [], excludePatterns = []) {
    if (!this.client) {
      throw new Error('Crawl4AI client is not configured');
    }

    if (!sourceUrl) {
      return [];
    }

    // Normalize patterns
    const includes = parseJsonArray(includePatterns);
    const excludes = parseJsonArray(excludePatterns);

    try {
      // Use Crawl4AI to fetch the homepage
      const result = await this.client.getContent(sourceUrl, { 
        timeoutMs: this.discoveryTimeoutMs 
      });

      const html = result.html || '';
      if (!html) {
        return [];
      }

      const $ = cheerio.load(html);
      const seen = new Set();
      const articles = [];

      // Extract all article links
      $('a[href]').each((_, el) => {
        if (articles.length >= this.maxArticlesPerSource) {
          return false; // Stop iteration
        }

        const href = $(el).attr('href');
        const url = toAbsoluteUrl(href, sourceUrl);
        
        if (!url || seen.has(url)) {
          return;
        }

        // Check include patterns (must match ALL if specified)
        const includeMatch = includes.length === 0 || includes.every(pattern => url.includes(pattern));
        if (!includeMatch) {
          return;
        }

        // Check exclude patterns (must NOT match ANY)
        const excludeMatch = excludes.some(pattern => url.includes(pattern));
        if (excludeMatch) {
          return;
        }

        // Extract title from link text or nearby heading
        let title = $(el).attr('title') || $(el).text() || '';
        title = compactText(title);

        // If title is too short, look for nearby heading
        if (title.length < 15) {
          const parentHeading = $(el).closest('article, .article, .story, .news-item, [class*="card"]').find('h1, h2, h3, h4').first().text();
          title = compactText(parentHeading) || title;
        }

        // Skip if still no meaningful title
        if (title.length < 10) {
          return;
        }

        // Try to extract published date from nearby elements
        let publishedAt = null;
        const parent = $(el).closest('article, .article, .story, .news-item, [class*="card"], li');
        const timeEl = parent.find('time').first();
        if (timeEl.length) {
          publishedAt = timeEl.attr('datetime') || timeEl.text() || null;
        }
        // Try meta tags
        if (!publishedAt) {
          const dateMatch = parent.text().match(/(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}[\/-]\d{1,2}[\/-]\d{1,2})/);
          if (dateMatch) {
            const parsed = new Date(dateMatch[0]);
            if (!isNaN(parsed.getTime())) {
              publishedAt = parsed.toISOString();
            }
          }
        }

        seen.add(url);
        articles.push({
          url,
          title,
          publishedAt
        });
      });

      return articles;
    } catch (error) {
      console.error(`[Crawl4aiDiscovery] Failed to discover from ${sourceUrl}:`, error.message);
      return [];
    }
  }

  /**
   * Batch discover articles from multiple sources
   * @param {Array<{id: string, name: string, homepageUrl: string, includePatterns?: string[], excludePatterns?: string[]}>} sources
   * @returns {Promise<Map<string, Array>>} - Map of sourceId to discovered articles
   */
  async discoverFromSources(sources) {
    const results = new Map();

    for (const source of sources) {
      if (!source.homepageUrl) {
        results.set(source.id, []);
        continue;
      }

      const articles = await this.discoverArticles(
        source.homepageUrl,
        source.includePatterns,
        source.excludePatterns
      );

      results.set(source.id, articles.map(article => ({
        ...article,
        sourceId: source.id,
        sourceName: source.name
      })));
    }

    return results;
  }
}
