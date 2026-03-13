import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { point as turfPoint } from '@turf/helpers';

function flattenCoordinates(geometry) {
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'Polygon') {
    return geometry.coordinates.flat();
  }

  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flat(2);
  }

  return [];
}

function computeBounds(boundaryGeoJson) {
  const feature = boundaryGeoJson.features[0];
  const coordinates = flattenCoordinates(feature?.geometry);

  let minLng = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  for (const [lng, lat] of coordinates) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  if (!Number.isFinite(minLng)) {
    throw new Error('Invalid Chennai boundary polygon');
  }

  return {
    minLng,
    minLat,
    maxLng,
    maxLat,
    leafletMaxBounds: [
      [minLat, minLng],
      [maxLat, maxLng]
    ]
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeLocality(locality) {
  return locality.replace(/\s+/g, ' ').trim();
}

const INVALID_LOCALITY_PATTERNS = [
  /^the times$/i,
  /^times of india$/i,
  /^the hindu$/i,
  /^police$/i,
  /^tamil nadu$/i,
  /^india$/i,
  /^chennai news$/i,
  /^high court$/i,
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i,
  /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i
];

const SPECIAL_LOCALITIES = [
  { pattern: /\bchennai airport\b/i, locality: 'Chennai Airport' },
  { pattern: /\bmeenambakkam\b/i, locality: 'Meenambakkam' },
  { pattern: /\bbroadway\b/i, locality: 'Broadway' },
  { pattern: /\bparrys\b/i, locality: 'Parrys' },
  { pattern: /\bpark town\b/i, locality: 'Park Town' },
  { pattern: /\bprakasam salai\b/i, locality: 'Prakasam Salai' }
];

function isReasonableLocality(locality) {
  if (!locality) {
    return false;
  }

  const normalized = normalizeLocality(locality);
  if (normalized.length < 4 || normalized.length > 40) {
    return false;
  }

  return !INVALID_LOCALITY_PATTERNS.some((pattern) => pattern.test(normalized));
}

function extractLocalityFromNamedList(text, localitiesSorted) {
  for (const locality of localitiesSorted) {
    const pattern = new RegExp(`\\b${escapeRegex(locality)}\\b`, 'i');
    if (pattern.test(text)) {
      return locality;
    }
  }

  return null;
}

function extractLocalityFromPatterns(text) {
  const candidates = [];
  const patterns = [
    /\b(?:in|near|at)\s+([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+){0,3})\b/g,
    /\b([A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+){0,3})\s+(?:area|locality|suburb)\b/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(text);
    while (match) {
      const location = normalizeLocality(match[1]);
      if (isReasonableLocality(location)) {
        candidates.push(location);
      }
      match = pattern.exec(text);
    }
  }

  return candidates;
}

export function createGeoService({ boundaryGeoJson, localities, fetchImpl = fetch, userAgent }) {
  const boundaryFeature = boundaryGeoJson.features[0];
  const bounds = computeBounds(boundaryGeoJson);
  const geocodeCache = new Map();
  const localitiesSorted = [...new Set(localities)].sort((a, b) => b.length - a.length);

  function isPointInsideBoundary(lat, lng) {
    const candidate = turfPoint([lng, lat]);
    return booleanPointInPolygon(candidate, boundaryFeature);
  }

  function buildLocalityQueries(locality) {
    const normalized = normalizeLocality(locality);
    const candidates = [normalized];

    const embeddedLocality = extractLocalityFromNamedList(normalized, localitiesSorted);
    if (embeddedLocality) {
      candidates.push(embeddedLocality);
    }

    const commaParts = normalized
      .split(',')
      .map((part) => normalizeLocality(part))
      .filter((part) => part && !/^chennai$/i.test(part));

    candidates.push(...commaParts);

    for (const special of SPECIAL_LOCALITIES) {
      if (special.pattern.test(normalized)) {
        candidates.push(special.locality);
      }
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  async function geocodeLocality(locality) {
    const cacheKey = locality.toLowerCase();
    if (geocodeCache.has(cacheKey)) {
      return geocodeCache.get(cacheKey);
    }

    async function tryPhoton(candidateLocality) {
      const query = `${candidateLocality}, Chennai, Tamil Nadu, India`;
      const url = new URL('https://photon.komoot.io/api');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '5');

      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      const features = Array.isArray(payload?.features) ? payload.features : [];

      for (const feature of features) {
        const coordinates = feature?.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) {
          continue;
        }

        const lng = Number(coordinates[0]);
        const lat = Number(coordinates[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          continue;
        }

        if (!isPointInsideBoundary(lat, lng)) {
          continue;
        }

        return {
          locality,
          lat,
          lng,
          displayName: feature?.properties?.name || null
        };
      }

      return null;
    }

    async function tryNominatim(candidateLocality) {
      const query = `${candidateLocality}, Chennai, Tamil Nadu, India`;
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '3');
      url.searchParams.set('q', query);

      const response = await fetchImpl(url, {
        headers: {
          'User-Agent': userAgent,
          Accept: 'application/json'
        }
      });

      if (!response.ok) {
        return null;
      }

      const payload = await response.json();
      const results = Array.isArray(payload) ? payload : [];

      for (const result of results) {
        const lat = Number(result.lat);
        const lng = Number(result.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          continue;
        }

        if (!isPointInsideBoundary(lat, lng)) {
          continue;
        }

        return {
          locality,
          lat,
          lng,
          displayName: result.display_name || null
        };
      }

      return null;
    }

    let geocoded = null;

    for (const candidateLocality of buildLocalityQueries(locality)) {
      geocoded =
        (await tryPhoton(candidateLocality)) || (await tryNominatim(candidateLocality));

      if (geocoded) {
        break;
      }
    }

    geocodeCache.set(cacheKey, geocoded);
    return geocoded;
  }

  async function extractAndGeocodeLocation({ title = '', content = '' }) {
    const candidates = [];

    for (const text of [title, content]) {
      for (const special of SPECIAL_LOCALITIES) {
        if (special.pattern.test(text)) {
          candidates.push(special.locality);
        }
      }

      const listMatch = extractLocalityFromNamedList(text, localitiesSorted);
      if (listMatch) {
        candidates.push(listMatch);
      }

      for (const inferred of extractLocalityFromPatterns(text)) {
        const cleaned = normalizeLocality(inferred);
        if (isReasonableLocality(cleaned)) {
          candidates.push(cleaned);
        }
      }
    }

    const uniqueCandidates = [];
    for (const candidate of candidates) {
      if (!uniqueCandidates.find((item) => item.toLowerCase() === candidate.toLowerCase())) {
        uniqueCandidates.push(candidate);
      }
    }

    const combined = `${title}\n${content}`;
    if (uniqueCandidates.length === 0 && /\bchennai\b/i.test(combined)) {
      uniqueCandidates.push('Chennai');
    }

    for (const candidate of uniqueCandidates) {
      try {
        const geocoded = await geocodeLocality(candidate);
        if (geocoded) {
          return geocoded;
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  return {
    bounds,
    boundaryGeoJson,
    isPointInsideBoundary,
    geocodeLocality,
    extractAndGeocodeLocation
  };
}
