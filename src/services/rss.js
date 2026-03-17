import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { createCrawl4AIService } from './crawl4ai.js';

function stripHtml(html = '') {
  if (!html) {
    return '';
  }

  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, ' ').trim();
}

export function compactText(value = '') {
  return value.replace(/\s+/g, ' ').trim();
}

function parseJsonArray(value) {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string' && item.trim());
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item) => typeof item === 'string' && item.trim())
      : [];
  } catch {
    return [];
  }
}

function normalizeForMatch(value = '') {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildKeywords(...values) {
  const stopWords = new Set([
    'the',
    'and',
    'for',
    'with',
    'from',
    'that',
    'this',
    'after',
    'into',
    'when',
    'over',
    'have',
    'has',
    'had',
    'was',
    'were',
    'will',
    'would',
    'their',
    'they',
    'them',
    'said',
    'says',
    'news',
    'times',
    'india'
  ]);

  const words = values
    .flatMap((value) => normalizeForMatch(value).split(' '))
    .filter((word) => word.length >= 4 && !stopWords.has(word));

  return [...new Set(words)].slice(0, 18);
}

function scoreArticleTextCandidate(text, { title = '', description = '' } = {}) {
  const normalized = normalizeForMatch(text);
  if (!normalized) {
    return Number.NEGATIVE_INFINITY;
  }

  const keywords = buildKeywords(title, description);
  const keywordHits = keywords.filter((word) => normalized.includes(word)).length;
  const sentenceCount = (text.match(/[.!?]/g) || []).length;
  const linkPenalty = (text.match(/https?:\/\//g) || []).length * 2;
  const boilerplatePenalty =
    [
      'sign in',
      'edition',
      'trending',
      'follow us',
      'about the author',
      'author biography',
      'veteran journalist',
      'years of experience',
      'read more',
      'advertisement',
      'subscribe',
      'newsletter'
    ].filter((token) => normalized.includes(token)).length * 6;
  const descriptionBoost =
    description && normalized.includes(normalizeForMatch(description).slice(0, 40)) ? 12 : 0;
  const lengthScore = Math.min(text.length / 600, 8);

  return keywordHits * 3 + sentenceCount + descriptionBoost + lengthScore - linkPenalty - boilerplatePenalty;
}

function hasSubstantialArticleContent(content = '') {
  return compactText(content).length >= 280;
}

function buildBrowserlessContentUrl(baseUrl, apiKey) {
  const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const contentUrl = normalizedBaseUrl.endsWith('/content')
    ? new URL(normalizedBaseUrl)
    : new URL(`${normalizedBaseUrl}/content`);

  if (apiKey) {
    contentUrl.searchParams.set('token', apiKey);
  }

  return contentUrl.toString();
}

function createBrowserlessClient({
  fetchImpl,
  baseUrl,
  apiKey,
  userAgent
}) {
  const contentUrl = buildBrowserlessContentUrl(baseUrl, apiKey);

  return {
    async getContent(url, { timeoutMs }) {
      const response = await fetchImpl(contentUrl, {
        method: 'POST',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
          'User-Agent': userAgent
        },
        body: JSON.stringify({
          url,
          bestAttempt: true,
          gotoOptions: {
            timeout: timeoutMs,
            waitUntil: 'domcontentloaded'
          }
        })
      });

      if (!response.ok) {
        const errorBody = compactText(await response.text());
        throw new Error(
          `Browserless content request failed: ${response.status}${errorBody ? ` ${errorBody.slice(0, 240)}` : ''}`
        );
      }

      return response.text();
    }
  };
}

function parseJsonLdBlocks($) {
  return $('script[type="application/ld+json"]')
    .map((_, el) => $(el).contents().text())
    .get()
    .flatMap((scriptBody) => {
      if (!scriptBody) {
        return [];
      }

      try {
        return [JSON.parse(scriptBody)];
      } catch {
        return [];
      }
    });
}

function walkJson(value, visitor) {
  const queue = Array.isArray(value) ? [...value] : [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') {
      continue;
    }

    const result = visitor(current);
    if (result) {
      return result;
    }

    for (const nested of Object.values(current)) {
      if (nested && typeof nested === 'object') {
        queue.push(nested);
      }
    }
  }

  return null;
}

function withTimeout(ms = 12000) {
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

export function createRssService({
  fetchImpl = fetch,
  userAgent,
  maxItemsPerFeed = 25,
  articleFetchTimeoutMs = 15000,
  browserlessApiKey = '',
  browserlessBaseUrl = 'https://production-sfo.browserless.io',
  browserlessClient = null,
  crawl4aiUrl = '',
  crawl4aiToken = ''
}) {
  const parser = new Parser({
    timeout: 15000,
    customFields: {
      item: ['content:encoded']
    }
  });
  const browserless =
    browserlessClient ||
    (browserlessApiKey
      ? createBrowserlessClient({
          fetchImpl,
          baseUrl: browserlessBaseUrl,
          apiKey: browserlessApiKey,
          userAgent
        })
      : null);

  // Crawl4AI service (preferred over Browserless if configured)
  const crawl4aiService =
    crawl4aiUrl
      ? createCrawl4AIService({
          fetchImpl,
          baseUrl: crawl4aiUrl,
          apiToken: crawl4aiToken
        })
      : null;

  function normalizeFeedItems(rawItems) {
    const items = Array.isArray(rawItems) ? rawItems : [];

    return items.slice(0, maxItemsPerFeed).map((item) => {
      const htmlContent = item['content:encoded'] || item.content || '';
      const plainContent = stripHtml(htmlContent);

      return {
        title: compactText(item.title || ''),
        link: item.link || '',
        publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
        feedSummary: compactText(stripHtml(item.contentSnippet || item.content || '')),
        feedContent: compactText(plainContent)
      };
    });
  }

  function toAbsoluteUrl(value, baseUrl) {
    if (!value) {
      return '';
    }

    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return '';
    }
  }

  function parseJsonLdPublishedAt($) {
    for (const parsed of parseJsonLdBlocks($)) {
      const publishedAt = walkJson(parsed, (current) =>
        typeof current.datePublished === 'string' ? current.datePublished : null
      );

      if (publishedAt) {
        return publishedAt;
      }
    }

    return null;
  }

  function parseJsonLdArticleBody($) {
    for (const parsed of parseJsonLdBlocks($)) {
      const articleBody = walkJson(parsed, (current) =>
        typeof current.articleBody === 'string' ? current.articleBody : null
      );

      if (articleBody) {
        return compactText(articleBody);
      }
    }

    return '';
  }

  function extractPublishedAt($) {
    const selectors = [
      'meta[property="article:published_time"]',
      'meta[name="publish-date"]',
      'meta[name="Date"]',
      'meta[itemprop="datePublished"]',
      'meta[property="og:updated_time"]'
    ];

    for (const selector of selectors) {
      const content = $(selector).attr('content');
      if (content) {
        return content;
      }
    }

    return parseJsonLdPublishedAt($);
  }

  async function fetchHtmlIndexItems(source) {
    const pageUrl = source.feed_url || source.feedUrl || source.website_url || source.websiteUrl;
    if (!pageUrl) {
      return [];
    }

    const includePatterns = parseJsonArray(
      source.html_link_include_patterns || source.htmlLinkIncludePatterns
    );
    const excludePatterns = parseJsonArray(
      source.html_link_exclude_patterns || source.htmlLinkExcludePatterns
    );
    const timeout = withTimeout(15000);

    try {
      const response = await fetchImpl(pageUrl, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml'
        },
        signal: timeout.signal
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch index page: ${response.status}`);
      }

      const html = await response.text();
      const $ = cheerio.load(html);
      const seen = new Set();
      const items = [];

      $('a[href]').each((_, el) => {
        if (items.length >= maxItemsPerFeed) {
          return false;
        }

        const href = $(el).attr('href');
        const link = toAbsoluteUrl(href, pageUrl);
        if (!link || seen.has(link)) {
          return;
        }

        const includeMatch =
          includePatterns.length === 0 || includePatterns.every((pattern) => link.includes(pattern));
        const excludeMatch = excludePatterns.some((pattern) => link.includes(pattern));

        if (!includeMatch || excludeMatch) {
          return;
        }

        const title = compactText($(el).attr('title') || $(el).text() || '');
        if (title.length < 20) {
          return;
        }

        seen.add(link);
        items.push({
          title,
          link,
          publishedAt: null,
          feedSummary: '',
          feedContent: ''
        });
      });

      return items;
    } finally {
      timeout.clear();
    }
  }

  async function fetchFeedItems(source) {
    const parserMode = source.parser_mode || source.parserMode || 'rss';
    if (parserMode === 'html-links') {
      return fetchHtmlIndexItems(source);
    }

    const feedUrl = source.feed_url || source.feedUrl;
    const feed = await parser.parseURL(feedUrl);
    return normalizeFeedItems(feed.items);
  }

  async function parseFeedFromString(xmlString) {
    const feed = await parser.parseString(xmlString);
    return normalizeFeedItems(feed.items);
  }

  function parseArticlePageDataFromHtml(html = '') {
    if (!html) {
      return {
        content: '',
        publishedAt: null,
        title: null
      };
    }

    const $ = cheerio.load(html);
    const jsonLdArticleBody = parseJsonLdArticleBody($);
    const publishedAt = extractPublishedAt($);
    const title = compactText(
      $('meta[property="og:title"]').attr('content') || $('title').text() || $('h1').first().text() || ''
    );
    $(
      [
        'script',
        'style',
        'noscript',
        'iframe',
        'header',
        'footer',
        'nav',
        'aside',
        'form',
        '#author_desc',
        '#related_stories',
        '.author',
        '.authorBio',
        '.author-bio',
        '.newsletter',
        '.advertisement',
        '.ad',
        '.breadcrumbs'
      ].join(', ')
    ).remove();

    let text = jsonLdArticleBody;

    if (!text) {
      const articleParagraphs = $('article p')
        .map((_, el) => $(el).text())
        .get();

      if (articleParagraphs.length > 0) {
        text = articleParagraphs.join(' ');
      } else {
        const bodyParagraphs = $('main p, [role="main"] p, .article p, .story p, .content p, body p')
          .slice(0, 40)
          .map((_, el) => $(el).text())
          .get();
        text = bodyParagraphs.join(' ');
      }
    }

    return {
      content: compactText(text),
      publishedAt,
      title
    };
  }

  async function fetchArticleHtmlDirect(url) {
    const timeout = withTimeout(articleFetchTimeoutMs);

    try {
      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml'
        },
        signal: timeout.signal
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch article page: ${response.status}`);
      }

      return response.text();
    } finally {
      timeout.clear();
    }
  }

  async function fetchArticlePageData(url) {
    if (!url) {
      return {
        content: '',
        publishedAt: null,
        title: null
      };
    }

    // Priority 1: Crawl4AI (if configured) - provides markdown + metadata
    if (crawl4aiService) {
      try {
        const crawlResult = await crawl4aiService.fetchArticleContent(url, {
          timeoutMs: articleFetchTimeoutMs
        });
        if (hasSubstantialArticleContent(crawlResult.content)) {
          return crawlResult;
        }
      } catch (error) {
        console.warn(`Crawl4AI failed for ${url}:`, error.message);
        // Fall through to next method
      }
    }

    // Priority 2: Browserless client (if explicitly provided)
    if (browserlessClient) {
      const html = await withPromiseTimeout(
        browserless.getContent(url, { timeoutMs: articleFetchTimeoutMs }),
        articleFetchTimeoutMs + 1000,
        `Browserless content for ${url}`
      );
      return parseArticlePageDataFromHtml(html);
    }

    // Priority 3: Direct fetch (fastest, but may be blocked by paywalls)
    let directPageData = {
      content: '',
      publishedAt: null,
      title: null
    };
    let directFetchError = null;

    try {
      const html = await withPromiseTimeout(
        fetchArticleHtmlDirect(url),
        articleFetchTimeoutMs + 1000,
        `Direct article fetch for ${url}`
      );
      directPageData = parseArticlePageDataFromHtml(html);
    } catch (error) {
      directFetchError = error;
    }

    if (hasSubstantialArticleContent(directPageData.content)) {
      return directPageData;
    }

    // Priority 4: Browserless fallback (if configured via API key)
    if (browserless) {
      const browserlessHtml = await withPromiseTimeout(
        browserless.getContent(url, { timeoutMs: articleFetchTimeoutMs }),
        articleFetchTimeoutMs + 1000,
        `Browserless content for ${url}`
      );
      const browserlessPageData = parseArticlePageDataFromHtml(browserlessHtml);

      const metadata = {
        title: browserlessPageData.title || directPageData.title || '',
        description: ''
      };
      const contentCandidates = [directPageData.content, browserlessPageData.content]
        .filter(Boolean)
        .sort(
          (left, right) =>
            scoreArticleTextCandidate(right, metadata) - scoreArticleTextCandidate(left, metadata)
        );

      return {
        content: contentCandidates[0] || '',
        publishedAt: browserlessPageData.publishedAt || directPageData.publishedAt,
        title: browserlessPageData.title || directPageData.title
      };
    }

    // No fallback available
    if (!directPageData.content && directFetchError) {
      throw directFetchError;
    }

    return directPageData;
  }

  async function enrichItem(source, item) {
    let pageData = {
      content: '',
      publishedAt: null,
      title: null
    };
    let pageFetchError = null;

    try {
      pageData = await fetchArticlePageData(item.link);
    } catch (error) {
      pageFetchError = error;
    }

    const fallbackContent = compactText([item.feedSummary, item.feedContent].filter(Boolean).join(' '));
    if (!pageData.content && pageFetchError && !fallbackContent) {
      throw pageFetchError;
    }

    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: item.link,
      title: compactText(item.title || pageData.title || ''),
      publishedAt: item.publishedAt || pageData.publishedAt || null,
      content: compactText([fallbackContent, pageData.content].filter(Boolean).join(' '))
    };
  }

  async function fetchStandaloneArticle(url) {
    const pageData = await fetchArticlePageData(url);

    return {
      sourceUrl: url,
      title: compactText(pageData.title || ''),
      publishedAt: pageData.publishedAt || null,
      content: compactText(pageData.content || '')
    };
  }

  return {
    fetchFeedItems,
    enrichItem,
    parseFeedFromString,
    fetchStandaloneArticle
  };
}
