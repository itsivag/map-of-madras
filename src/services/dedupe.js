import { createHash } from 'node:crypto';

function safeDomain(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown-domain';
  }
}

function normalizeTitle(title = '') {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function dayBucket(isoString) {
  if (!isoString) {
    return new Date().toISOString().slice(0, 10);
  }

  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

export function buildDedupeParts({ sourceUrl, title, occurredAt, lat, lng }) {
  return {
    domain: safeDomain(sourceUrl),
    titleFingerprint: normalizeTitle(title),
    dateBucket: dayBucket(occurredAt),
    latRounded: Number(lat).toFixed(3),
    lngRounded: Number(lng).toFixed(3)
  };
}

export function buildDedupeKey(payload) {
  const parts = buildDedupeParts(payload);
  const raw = `${parts.domain}|${parts.titleFingerprint}|${parts.dateBucket}|${parts.latRounded}|${parts.lngRounded}`;
  const key = createHash('sha1').update(raw).digest('hex');
  return { key, raw, parts };
}
