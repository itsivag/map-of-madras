import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import FirecrawlApp from '@mendable/firecrawl-js';

function stripHtml(html = '') {
  if (!html) {
    return '';
  }

  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, ' ').trim();
}

function compactText(value = '') {
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

function markdownToText(value = '') {
  return compactText(
    value
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1 ')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ')
      .replace(/[#>*_`~|-]+/g, ' ')
  );
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

function distillArticleTextFromMarkdown(markdown = '', metadata = {}) {
  const blocks = markdown
    .split(/\n{2,}/)
    .map((block) => markdownToText(block))
    .filter((block) => block.length >= 60);

  if (blocks.length === 0) {
    return '';
  }

  const blockScores = blocks.map((block) => scoreArticleTextCandidate(block, metadata));
  let bestIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < blockScores.length; index += 1) {
    if (blockScores[index] > bestScore) {
      bestScore = blockScores[index];
      bestIndex = index;
    }
  }

  const selected = [];
  let totalLength = 0;

  for (let index = bestIndex; index < blocks.length; index += 1) {
    const block = blocks[index];
    const score = blockScores[index];

    if (index > bestIndex && score <= 0) {
      break;
    }

    selected.push(block);
    totalLength += block.length;

    if (totalLength >= 5000 || selected.length >= 6) {
      break;
    }
  }

  return compactText(selected.join(' '));
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
  firecrawlApiKey = '',
  firecrawlClient = null
}) {
  const parser = new Parser({
    timeout: 15000,
    customFields: {
      item: ['content:encoded']
    }
  });
  const firecrawl = firecrawlClient || (firecrawlApiKey ? new FirecrawlApp({ apiKey: firecrawlApiKey }) : null);

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
    $('script, style, noscript, iframe, header, footer').remove();

    let text = jsonLdArticleBody;

    if (!text) {
      const articleParagraphs = $('article p')
        .map((_, el) => $(el).text())
        .get();

      if (articleParagraphs.length > 0) {
        text = articleParagraphs.join(' ');
      } else {
        const bodyParagraphs = $('body p')
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

  async function fetchArticlePageData(url) {
    if (!url) {
      return {
        content: '',
        publishedAt: null,
        title: null
      };
    }

    if (!firecrawl) {
      throw new Error('Firecrawl is not configured. Set FIRECRAWL_API_KEY.');
    }

    const document = await withPromiseTimeout(
      firecrawl.scrape(url, {
        formats: ['markdown', 'html'],
        onlyMainContent: true,
        timeout: articleFetchTimeoutMs
      }),
      articleFetchTimeoutMs + 1000,
      `Firecrawl scrape for ${url}`
    );

    const parsedHtml = parseArticlePageDataFromHtml(document?.html || '');
    const metadata = {
      title: document?.metadata?.title || document?.metadata?.ogTitle || parsedHtml.title || '',
      description: document?.metadata?.description || document?.metadata?.ogDescription || ''
    };
    const distilledMarkdown = distillArticleTextFromMarkdown(document?.markdown || '', metadata);
    const contentCandidates = [parsedHtml.content, distilledMarkdown, markdownToText(document?.markdown || '')]
      .filter(Boolean)
      .sort(
        (left, right) =>
          scoreArticleTextCandidate(right, metadata) - scoreArticleTextCandidate(left, metadata)
      );
    const content = contentCandidates[0] || '';

    return {
      content,
      publishedAt:
        document?.metadata?.publishedTime ||
        document?.metadata?.modifiedTime ||
        parsedHtml.publishedAt,
      title:
        compactText(document?.metadata?.title || document?.metadata?.ogTitle || '') ||
        parsedHtml.title
    };
  }

  async function enrichItem(source, item) {
    const pageData = await fetchArticlePageData(item.link);

    return {
      sourceId: source.id,
      sourceName: source.name,
      sourceUrl: item.link,
      title: compactText(item.title || pageData.title || ''),
      publishedAt: item.publishedAt || pageData.publishedAt || new Date().toISOString(),
      content: compactText([item.feedSummary, item.feedContent, pageData.content].filter(Boolean).join(' '))
    };
  }

  async function fetchStandaloneArticle(url) {
    const pageData = await fetchArticlePageData(url);

    return {
      sourceUrl: url,
      title: compactText(pageData.title || ''),
      publishedAt: pageData.publishedAt || new Date().toISOString(),
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
