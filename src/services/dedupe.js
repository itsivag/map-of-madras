import { createHash } from 'node:crypto';

const TITLE_STOP_WORDS = new Set([
  'a',
  'after',
  'an',
  'and',
  'are',
  'at',
  'be',
  'by',
  'case',
  'chennai',
  'city',
  'for',
  'from',
  'held',
  'in',
  'into',
  'is',
  'man',
  'news',
  'on',
  'over',
  'says',
  'story',
  'that',
  'the',
  'their',
  'them',
  'times',
  'to',
  'two',
  'with',
  'woman'
]);

function normalizeText(value = '') {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLocality(value = '') {
  return normalizeText(value).slice(0, 80);
}

function normalizeSubcategory(value = '') {
  return normalizeText(value).slice(0, 60);
}

function titleTokens(title = '') {
  return [...new Set(
    normalizeText(title)
      .split(' ')
      .filter((token) => token.length >= 4 && !TITLE_STOP_WORDS.has(token))
  )];
}

function titleFingerprint(title = '') {
  return titleTokens(title).slice(0, 8).sort().join('|');
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

function sixHourBucket(isoString) {
  const date = new Date(isoString || Date.now());
  if (Number.isNaN(date.getTime())) {
    return 'unknown';
  }

  return `${dayBucket(date.toISOString())}:${String(Math.floor(date.getUTCHours() / 6)).padStart(2, '0')}`;
}

function roundCoordinate(value, digits = 3) {
  return Number(value).toFixed(digits);
}

function parseIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function jaccardSimilarity(first, second) {
  const firstSet = new Set(first);
  const secondSet = new Set(second);
  const union = new Set([...firstSet, ...secondSet]);
  if (union.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of firstSet) {
    if (secondSet.has(token)) {
      intersection += 1;
    }
  }

  return intersection / union.size;
}

export function buildDedupeParts({ category, subcategory, title, occurredAt, locality, lat, lng }) {
  return {
    category: normalizeText(category).slice(0, 30),
    subcategory: normalizeSubcategory(subcategory),
    locality: normalizeLocality(locality),
    titleFingerprint: titleFingerprint(title),
    dayBucket: dayBucket(occurredAt),
    timeBucket: sixHourBucket(occurredAt),
    latRounded: roundCoordinate(lat),
    lngRounded: roundCoordinate(lng)
  };
}

export function buildDedupeKey(payload) {
  const parts = buildDedupeParts(payload);
  const raw = [
    parts.category,
    parts.subcategory,
    parts.locality,
    parts.dayBucket,
    parts.latRounded,
    parts.lngRounded
  ].join('|');
  const key = createHash('sha1').update(raw).digest('hex');
  return { key, raw, parts };
}

export function buildSourceFingerprint({ sourceUrl = '', title = '' }) {
  const raw = sourceUrl.trim() || normalizeText(title).slice(0, 120);
  return createHash('sha1').update(raw).digest('hex');
}

export function scoreIncidentMatch(existing, candidate) {
  let score = 0;
  const existingLocality = normalizeLocality(existing.locality);
  const candidateLocality = normalizeLocality(candidate.locality);

  if (existing.category === candidate.category) {
    score += 2;
  }

  if (normalizeSubcategory(existing.subcategory) === normalizeSubcategory(candidate.subcategory)) {
    score += 1;
  }

  if (existingLocality && candidateLocality) {
    if (existingLocality === candidateLocality) {
      score += 2;
    } else if (
      existingLocality.includes(candidateLocality) ||
      candidateLocality.includes(existingLocality)
    ) {
      score += 1;
    }
  }

  if (dayBucket(existing.occurredAt) === dayBucket(candidate.occurredAt)) {
    score += 1;
  }

  const existingDate = parseIso(existing.occurredAt);
  const candidateDate = parseIso(candidate.occurredAt);
  if (existingDate && candidateDate) {
    const hourDelta = Math.abs(existingDate.getTime() - candidateDate.getTime()) / (1000 * 60 * 60);
    if (hourDelta <= 6) {
      score += 2;
    } else if (hourDelta <= 24) {
      score += 1;
    }
  }

  const latDelta = Math.abs(Number(existing.lat) - Number(candidate.lat));
  const lngDelta = Math.abs(Number(existing.lng) - Number(candidate.lng));
  if (latDelta <= 0.003 && lngDelta <= 0.003) {
    score += 2;
  } else if (latDelta <= 0.015 && lngDelta <= 0.015) {
    score += 1;
  }

  const similarity = jaccardSimilarity(titleTokens(existing.title), titleTokens(candidate.title));
  if (similarity >= 0.3) {
    score += 2;
  } else if (similarity >= 0.15) {
    score += 1;
  }

  return score;
}

export function isLikelySameIncident(existing, candidate) {
  if (!existing || !candidate) {
    return false;
  }

  return scoreIncidentMatch(existing, candidate) >= 6;
}
