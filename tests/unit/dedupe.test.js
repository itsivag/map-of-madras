import { describe, it, expect } from 'vitest';
import { buildDedupeKey } from '../../src/services/dedupe.js';

describe('buildDedupeKey', () => {
  it('generates same key for normalized-equivalent titles and rounded coordinates', () => {
    const first = buildDedupeKey({
      sourceUrl: 'https://www.example.com/a',
      title: 'Police Arrest Suspect in Robbery!',
      occurredAt: '2026-03-01T08:00:00.000Z',
      lat: 13.08271,
      lng: 80.27071
    });

    const second = buildDedupeKey({
      sourceUrl: 'https://example.com/a',
      title: 'police arrest suspect in robbery',
      occurredAt: '2026-03-01T22:00:00.000Z',
      lat: 13.08279,
      lng: 80.27079
    });

    expect(first.key).toBe(second.key);
  });

  it('generates different keys when location bucket changes', () => {
    const first = buildDedupeKey({
      sourceUrl: 'https://example.com/a',
      title: 'Same title',
      occurredAt: '2026-03-01T08:00:00.000Z',
      lat: 13.0827,
      lng: 80.2707
    });

    const second = buildDedupeKey({
      sourceUrl: 'https://example.com/a',
      title: 'Same title',
      occurredAt: '2026-03-01T08:00:00.000Z',
      lat: 13.091,
      lng: 80.301
    });

    expect(first.key).not.toBe(second.key);
  });
});
