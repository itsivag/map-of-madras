import { describe, it, expect } from 'vitest';
import { createGeoService } from '../../src/services/geo.js';
import { loadBoundaryGeoJson, loadLocalities } from '../../src/config.js';

describe('geo boundary checks', () => {
  const geoService = createGeoService({
    boundaryGeoJson: loadBoundaryGeoJson(),
    localities: loadLocalities(),
    userAgent: 'test-agent'
  });

  it('accepts a point in central Chennai', () => {
    const inside = geoService.isPointInsideBoundary(13.0827, 80.2707);
    expect(inside).toBe(true);
  });

  it('rejects a point far outside Chennai', () => {
    const outside = geoService.isPointInsideBoundary(12.2958, 76.6394);
    expect(outside).toBe(false);
  });
});
