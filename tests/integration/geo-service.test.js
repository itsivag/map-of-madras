import { describe, it, expect, vi } from 'vitest';
import { createGeoService } from '../../src/services/geo.js';
import {
  loadBoundaryGeoJson,
  loadGreaterChennaiLocalities,
  loadLocalities
} from '../../src/config.js';

describe('geo service', () => {
  it('geocodes in-boundary locality and rejects outside-boundary result', async () => {
    const fetchMock = vi.fn(async (url) => {
      const query = new URL(url).searchParams.get('q') || '';

      if (query.includes('Adyar')) {
        return new Response(
          JSON.stringify([
            {
              lat: '13.007',
              lon: '80.257',
              display_name: 'Adyar, Chennai, Tamil Nadu, India'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (query.includes('Chennai Airport')) {
        return new Response(
          JSON.stringify([
            {
              lat: '12.9825',
              lon: '80.1636',
              display_name: 'Chennai Airport, Chennai, Tamil Nadu, India'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(
        JSON.stringify([
          {
            lat: '12.9716',
            lon: '77.5946',
            display_name: 'Bengaluru, Karnataka, India'
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const service = createGeoService({
      boundaryGeoJson: loadBoundaryGeoJson(),
      localities: loadLocalities(),
      regionalLocalities: loadGreaterChennaiLocalities(),
      fetchImpl: fetchMock,
      userAgent: 'test-agent'
    });

    const adyar = await service.extractAndGeocodeLocation({
      title: 'Robbery case in Adyar',
      content: 'Police are investigating the robbery in Adyar locality.'
    });

    expect(adyar).toBeTruthy();
    expect(adyar.locality).toBe('Adyar');
    expect(service.isPointInsideBoundary(adyar.lat, adyar.lng)).toBe(true);

    const unknown = await service.extractAndGeocodeLocation({
      title: 'Unknown place incident',
      content: 'Incident in Atlantis area with no known locality.'
    });

    expect(unknown).toBeNull();
  });

  it('prefers special Chennai localities from the title', async () => {
    const fetchMock = vi.fn(async (url) => {
      const query = new URL(url).searchParams.get('q') || '';

      if (query.includes('Chennai Airport')) {
        return new Response(
          JSON.stringify([
            {
              lat: '12.9825',
              lon: '80.1636',
              display_name: 'Chennai Airport, Chennai, Tamil Nadu, India'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const service = createGeoService({
      boundaryGeoJson: loadBoundaryGeoJson(),
      localities: loadLocalities(),
      regionalLocalities: loadGreaterChennaiLocalities(),
      fetchImpl: fetchMock,
      userAgent: 'test-agent'
    });

    const airport = await service.extractAndGeocodeLocation({
      title: '2 youths killed in sleep by armed gang near Chennai airport',
      content: 'The Times of India reported the murder near Chennai airport late at night.'
    });

    expect(airport).toBeTruthy();
    expect(airport.locality).toBe('Chennai Airport');
  });

  it('accepts known greater Chennai localities just outside the strict boundary', async () => {
    const fetchMock = vi.fn(async (url) => {
      const query = new URL(url).searchParams.get('q') || '';

      if (query.includes('Gummidipoondi')) {
        return new Response(
          JSON.stringify([
            {
              lat: '13.4500',
              lon: '80.1200',
              display_name: 'Gummidipoondi, Tiruvallur, Tamil Nadu, India'
            }
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });

    const service = createGeoService({
      boundaryGeoJson: loadBoundaryGeoJson(),
      localities: loadLocalities(),
      regionalLocalities: loadGreaterChennaiLocalities(),
      fetchImpl: fetchMock,
      userAgent: 'test-agent'
    });

    const result = await service.extractAndGeocodeLocation({
      title: '3 held after assault near Gummidipoondi',
      content: 'Police said the crime happened near Gummidipoondi on Friday.'
    });

    expect(result).toBeTruthy();
    expect(result.locality).toBe('Gummidipoondi');
    expect(service.isPointInsideBoundary(result.lat, result.lng)).toBe(false);
  });
});
