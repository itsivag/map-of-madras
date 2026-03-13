import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../../src/db/init.js';
import { OfficialSourceService } from '../../src/services/officialSources.js';

describe('official source service', () => {
  let db;

  beforeEach(() => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crime-map-official-'));
    db = initDatabase(path.join(tempDir, 'official.sqlite'), []);
  });

  it('syncs TN Police metro station masters for Chennai-region city units', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const requestUrl = new URL(url);
      const pathname = requestUrl.pathname;
      const params = requestUrl.searchParams;

      if (pathname.endsWith('/contactUs/getDistrict')) {
        expect(params.get('officeTypeId')).toBe('7');
        return new Response(
          JSON.stringify({
            responseObject: {
              data: [
                { ORGANIZATION_NAME: 'CHENNAI CITY', ORGANIZATION_ID: '70002111' },
                { ORGANIZATION_NAME: 'TAMBARAM CITY', ORGANIZATION_ID: '70002116' },
                { ORGANIZATION_NAME: 'AVADI CITY', ORGANIZATION_ID: '70002112' },
                { ORGANIZATION_NAME: 'COIMBATORE CITY', ORGANIZATION_ID: '70002113' }
              ]
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (pathname.endsWith('/contactUs/getPoliceStation')) {
        const parentId = params.get('prntOrgId');
        const payloadByParent = {
          '70002111': [
            { ORGANIZATION_NAME: 'ADYAR', ORGANIZATION_ID: '70002266' },
            { ORGANIZATION_NAME: 'TRIPLICANE', ORGANIZATION_ID: '70002619' }
          ],
          '70002116': [{ ORGANIZATION_NAME: 'PALLIKARANAI', ORGANIZATION_ID: '70002473' }],
          '70002112': [{ ORGANIZATION_NAME: 'AMBATTUR ESTATE', ORGANIZATION_ID: '70002474' }]
        };

        return new Response(
          JSON.stringify({
            responseObject: {
              data: payloadByParent[parentId] || []
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    });

    const service = new OfficialSourceService({
      db,
      fetchImpl,
      userAgent: 'test-agent',
      tnPoliceMetroUnits: ['CHENNAI CITY', 'TAMBARAM CITY', 'AVADI CITY']
    });

    const result = await service.syncAll();
    const stations = service.getPoliceStations();
    const meta = service.getMeta();

    expect(result.status).toBe('ok');
    expect(stations).toHaveLength(4);
    expect(stations[0].metroUnitName).toBe('AVADI CITY');
    expect(stations.some((station) => station.stationName === 'ADYAR')).toBe(true);
    expect(meta.metroStationCounts).toEqual([
      { metro_unit_name: 'AVADI CITY', count: 1 },
      { metro_unit_name: 'CHENNAI CITY', count: 2 },
      { metro_unit_name: 'TAMBARAM CITY', count: 1 }
    ]);
    expect(
      meta.sources.find((source) => source.id === 'tn-police-metro-stations')?.record_count
    ).toBe(4);
    expect(
      meta.sources.find((source) => source.id === 'tn-police-view-fir')?.integration_state
    ).toBe('blocked');
  });
});
