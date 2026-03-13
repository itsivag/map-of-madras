import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { createRssService } from '../../src/services/rss.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('rss service', () => {
  it('parses RSS fixture and enriches article body', async () => {
    const xml = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sampleFeed.xml'), 'utf8');
    const firecrawlClient = {
      scrape: vi.fn(async () => ({
        markdown: 'Detailed robbery report from local police.',
        html: '<html><body><article><p>Detailed robbery report from local police.</p></article></body></html>',
        metadata: {
          title: 'Robbery article',
          publishedTime: '2026-03-07T09:00:00.000Z'
        }
      }))
    };

    const rss = createRssService({
      userAgent: 'test-agent',
      maxItemsPerFeed: 10,
      firecrawlClient
    });

    const items = await rss.parseFeedFromString(xml);
    expect(items).toHaveLength(2);
    expect(items[0].title).toContain('robbery');

    const enriched = await rss.enrichItem({ id: 'source-1', name: 'Fixture Feed' }, items[0]);
    expect(enriched.content).toContain('Detailed robbery report');
    expect(firecrawlClient.scrape).toHaveBeenCalledTimes(1);
  });

  it('scrapes TOI Chennai index pages for article links', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        `
          <html>
            <body>
              <a href="/city/chennai/mob-kills-van-driver-after-his-urine-spills-on-woman-in-chennai/articleshow/129513132.cms">
                Mob kills van driver after his urine spills on woman in Chennai
              </a>
              <a href="/city/chennai/1cr-digital-arrest-scamster-with-40-mule-accounts-held-in-chennai/articleshow/129477318.cms">
                1cr digital arrest: Scamster with 40 mule accounts held in Chennai
              </a>
              <a href="/city/bengaluru/not-a-chennai-story/articleshow/999999.cms">
                Bengaluru article
              </a>
            </body>
          </html>
        `,
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      );
    });

    const rss = createRssService({
      fetchImpl: fetchMock,
      userAgent: 'test-agent',
      maxItemsPerFeed: 10
    });

    const items = await rss.fetchFeedItems({
      id: 'toi-chennai',
      name: 'Times of India Chennai',
      feed_url: 'https://timesofindia.indiatimes.com/city/chennai',
      parser_mode: 'html-links'
    });

    expect(items).toHaveLength(2);
    expect(items[0].link).toContain('/city/chennai/');
    expect(items[1].title).toContain('Scamster');
  });

  it('prefers JSON-LD articleBody over fallback body paragraphs', async () => {
    const firecrawlClient = {
      scrape: vi.fn(async () => ({
        markdown: '',
        html: `
          <html>
            <head>
              <meta property="og:title" content="Mob kills van driver in Chennai" />
              <script type="application/ld+json">
                {
                  "@context": "https://schema.org",
                  "articleBody": "CHENNAI: A mob beat a van driver to death on Prakasam Salai in Broadway."
                }
              </script>
            </head>
            <body>
              <div id="author_desc">
                <p>Author biography that should not be used as article content.</p>
              </div>
            </body>
          </html>
        `,
        metadata: {
          title: 'Mob kills van driver in Chennai'
        }
      }))
    };

    const rss = createRssService({
      userAgent: 'test-agent',
      maxItemsPerFeed: 10,
      firecrawlClient
    });

    const article = await rss.fetchStandaloneArticle('https://example.org/toi-like-story');

    expect(article.title).toContain('Mob kills van driver');
    expect(article.content).toContain('Prakasam Salai');
    expect(article.content).not.toContain('Author biography');
  });

  it('distills article text from Firecrawl markdown generically when html content is noisy', async () => {
    const firecrawlClient = {
      scrape: vi.fn(async () => ({
        markdown: `
Edition

Trending

Mob kills van driver after his urine spills on woman in Chennai

CHENNAI: A mob beat a 30-year-old van driver to death after a fight erupted when the driver urinated in a public place on Prakasam Salai in Broadway.

Police said the victim, Kalaiselvan, was taken to Govt Stanley Hospital where doctors declared him dead on arrival.

About the Author

Selvaraj Arunachalam is a veteran journalist with over 31 years of experience.
        `,
        html: `
          <html>
            <body>
              <div id="author_desc">
                <p>Selvaraj Arunachalam is a veteran journalist with over 31 years of experience.</p>
              </div>
            </body>
          </html>
        `,
        metadata: {
          title: 'Mob kills van driver after his urine spills on woman in Chennai',
          description:
            'CHENNAI: A mob beat a 30-year-old van driver to death after a fight erupted when the driver urinated in a public place on Prakasam Salai in Broadway.'
        }
      }))
    };

    const rss = createRssService({
      userAgent: 'test-agent',
      maxItemsPerFeed: 10,
      firecrawlClient
    });

    const article = await rss.fetchStandaloneArticle('https://example.org/news-story');

    expect(article.content).toContain('Prakasam Salai in Broadway');
    expect(article.content).toContain('Govt Stanley Hospital');
    expect(article.content).not.toContain('31 years of experience');
  });
});
