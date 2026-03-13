import { z } from 'zod';

export const SEMANTIC_CATEGORY_VALUES = [
  'murder',
  'rape',
  'assault',
  'robbery/theft',
  'kidnapping',
  'fraud/scam',
  'drug offense',
  'other',
  'not-a-crime-event'
];

export const semanticExtractionSchema = z.object({
  isCrimeEvent: z.boolean(),
  category: z.enum(SEMANTIC_CATEGORY_VALUES),
  subcategory: z.string().nullable().default(null),
  occurredAt: z.string().nullable().default(null),
  locationText: z.string().nullable().default(null),
  locationPrecision: z.enum(['locality', 'city']).nullable().default('city'),
  evidence: z
    .array(
      z.object({
        chunkId: z.string(),
        supports: z.enum(['offense', 'location', 'time', 'context'])
      })
    )
    .default([]),
  confidence: z.number().min(0).max(1),
  rejectionReason: z.string().nullable().default(null)
});

function normalizeSupportType(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

  if (!normalized) {
    return null;
  }

  if (['offense', 'offence', 'crime', 'category', 'type'].includes(normalized)) {
    return 'offense';
  }

  if (['location', 'place', 'area', 'locality', 'where'].includes(normalized)) {
    return 'location';
  }

  if (['time', 'date', 'when', 'occurredat', 'occurred at'].includes(normalized)) {
    return 'time';
  }

  if (['context', 'background'].includes(normalized)) {
    return 'context';
  }

  return null;
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) {
    return evidence;
  }

  return evidence.flatMap((entry) => {
    const chunkId = typeof entry?.chunkId === 'string' ? entry.chunkId : null;
    if (!chunkId) {
      return [];
    }

    const rawSupports = Array.isArray(entry.supports)
      ? entry.supports
      : String(entry.supports || '')
          .split(/[,\|/]/)
          .map((value) => value.trim())
          .filter(Boolean);

    const supports = [...new Set(rawSupports.map(normalizeSupportType).filter(Boolean))];

    return supports.map((support) => ({
      chunkId,
      supports: support
    }));
  });
}

export function parseSemanticExtraction(value) {
  const parsed = semanticExtractionSchema.parse({
    ...value,
    evidence: normalizeEvidence(value?.evidence)
  });

  if (parsed.category === 'not-a-crime-event') {
    return {
      ...parsed,
      isCrimeEvent: false,
      rejectionReason: parsed.rejectionReason || 'Model classified the article as not a crime event.'
    };
  }

  return parsed;
}

export function hasSemanticEvidence(extraction, supportType) {
  return extraction.evidence.some((entry) => entry.supports === supportType);
}
