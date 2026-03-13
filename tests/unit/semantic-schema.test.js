import { describe, expect, it } from 'vitest';
import {
  hasSemanticEvidence,
  parseSemanticExtraction
} from '../../src/services/semanticSchema.js';

describe('semantic schema', () => {
  it('normalizes not-a-crime-event into a rejected extraction', () => {
    const result = parseSemanticExtraction({
      isCrimeEvent: true,
      category: 'not-a-crime-event',
      subcategory: null,
      occurredAt: null,
      locationText: null,
      locationPrecision: 'city',
      evidence: [],
      confidence: 0.18,
      rejectionReason: null
    });

    expect(result.isCrimeEvent).toBe(false);
    expect(result.rejectionReason).toContain('not a crime event');
  });

  it('checks whether offense and location evidence exist', () => {
    const extraction = parseSemanticExtraction({
      isCrimeEvent: true,
      category: 'murder',
      subcategory: 'mob beating',
      occurredAt: '2026-03-13T05:53:54.000Z',
      locationText: 'Chennai Airport',
      locationPrecision: 'locality',
      evidence: [
        { chunkId: 'chunk-1', supports: 'offense' },
        { chunkId: 'chunk-2', supports: 'location' }
      ],
      confidence: 0.93,
      rejectionReason: null
    });

    expect(hasSemanticEvidence(extraction, 'offense')).toBe(true);
    expect(hasSemanticEvidence(extraction, 'location')).toBe(true);
    expect(hasSemanticEvidence(extraction, 'time')).toBe(false);
  });

  it('normalizes combined and synonym evidence support labels', () => {
    const extraction = parseSemanticExtraction({
      isCrimeEvent: true,
      category: 'murder',
      subcategory: null,
      occurredAt: null,
      locationText: 'Broadway',
      locationPrecision: 'locality',
      evidence: [{ chunkId: 'chunk-1', supports: 'offence, place' }],
      confidence: 0.82,
      rejectionReason: null
    });

    expect(extraction.evidence).toEqual([
      { chunkId: 'chunk-1', supports: 'offense' },
      { chunkId: 'chunk-1', supports: 'location' }
    ]);
  });
});
