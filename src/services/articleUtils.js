import { createHash } from 'node:crypto';

export function canonicalizeArticleUrl(value = '') {
  if (!value) {
    return '';
  }

  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function hashContent(value = '') {
  return createHash('sha256').update(value).digest('hex');
}

export function buildArticleContentHash({ title = '', content = '' }) {
  return hashContent(`${title.trim()}\n\n${content.trim()}`);
}

export function getSourceDomain(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
