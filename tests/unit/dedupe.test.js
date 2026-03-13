import { describe, it, expect } from 'vitest';
import { buildDedupeKey, isLikelySameIncident } from '../../src/services/dedupe.js';

describe('buildDedupeKey', () => {
  it('generates same key for same incident details across different outlets', () => {
    const first = buildDedupeKey({
      title: 'Mob kills van driver after his urine spills on woman in Chennai',
      category: 'murder',
      subcategory: 'mob beating',
      occurredAt: '2026-03-01T08:00:00.000Z',
      locality: 'Prakasam Salai, Broadway, Chennai',
      lat: 13.08271,
      lng: 80.27071
    });

    const second = buildDedupeKey({
      title: 'Man urinates on woman from auto, mob beats him to death',
      category: 'murder',
      subcategory: 'mob beating',
      occurredAt: '2026-03-01T10:00:00.000Z',
      locality: 'Prakasam Salai, Broadway, Chennai',
      lat: 13.08279,
      lng: 80.27079
    });

    expect(first.key).toBe(second.key);
  });

  it('generates different keys when category or locality bucket changes', () => {
    const first = buildDedupeKey({
      title: 'Same title',
      category: 'murder',
      subcategory: 'mob beating',
      occurredAt: '2026-03-01T08:00:00.000Z',
      locality: 'Broadway',
      lat: 13.0827,
      lng: 80.2707
    });

    const second = buildDedupeKey({
      title: 'Same title',
      category: 'fraud/scam',
      subcategory: 'digital arrest scam',
      occurredAt: '2026-03-01T08:00:00.000Z',
      locality: 'Chennai',
      lat: 13.091,
      lng: 80.301
    });

    expect(first.key).not.toBe(second.key);
  });

  it('detects likely same incident across two outlet headlines', () => {
    const existing = {
      title: 'Mob kills van driver after his urine spills on woman in Chennai',
      category: 'murder',
      subcategory: 'mob beating',
      occurredAt: '2026-03-13T02:00:00.000Z',
      locality: 'Prakasam Salai, Broadway, Chennai',
      lat: 13.0430,
      lng: 80.2738
    };

    const candidate = {
      title: 'Man urinates on woman from auto, mob beats him to death',
      category: 'murder',
      subcategory: 'mob beating',
      occurredAt: '2026-03-13T03:00:00.000Z',
      locality: 'Prakasam Salai, Broadway, Chennai',
      lat: 13.0431,
      lng: 80.2739
    };

    expect(isLikelySameIncident(existing, candidate)).toBe(true);
  });
});
