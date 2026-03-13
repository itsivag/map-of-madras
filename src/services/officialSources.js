const OFFICIAL_SOURCE_DEFS = [
  {
    id: 'tn-police-metro-stations',
    name: 'Tamil Nadu Police Metro Station Master',
    category: 'police-directory',
    integrationState: 'active',
    accessMode: 'public',
    sourceUrl: 'https://www.police.tn.gov.in/citizenportal/contactus',
    notes:
      'Public contact directory endpoints expose metro police units and station masters for Chennai, Tambaram, and Avadi.'
  },
  {
    id: 'tn-police-view-fir',
    name: 'Tamil Nadu Police FIR View',
    category: 'fir-summary',
    integrationState: 'blocked',
    accessMode: 'token',
    sourceUrl: 'https://www.police.tn.gov.in/citizenportal/viewfir',
    notes:
      'Citizen portal route exists, but the underlying FIR report endpoint currently rejects unauthenticated requests with token validation.'
  },
  {
    id: 'tn-police-arrested-person-list',
    name: 'Tamil Nadu Police Arrested Persons',
    category: 'arrest-bulletin',
    integrationState: 'blocked',
    accessMode: 'token',
    sourceUrl: 'https://www.police.tn.gov.in/citizenportal/opencitizencases',
    notes:
      'Public client bundle exposes the endpoint, but live requests return token validation failures without an authenticated citizen-session token.'
  },
  {
    id: 'tn-police-missing-person-search',
    name: 'Tamil Nadu Police Missing Persons Search',
    category: 'public-safety',
    integrationState: 'blocked',
    accessMode: 'captcha',
    sourceUrl: 'https://www.police.tn.gov.in/citizenportal',
    notes:
      'Live endpoint requires captcha validation and cannot be ingested headlessly without a compliant interactive flow.'
  },
  {
    id: 'madras-high-court-cause-lists',
    name: 'Madras High Court Cause Lists',
    category: 'court-cause-list',
    integrationState: 'blocked',
    accessMode: 'captcha',
    sourceUrl: 'https://mhc.tn.gov.in/cause-list/',
    notes:
      'Cause-list access is public, but stable machine extraction is constrained by captcha and session requirements.'
  }
];

function buildUrl(baseUrl, path, params = {}) {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(normalizedPath, normalizedBase);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function normalizeSourceResponse(payload) {
  if (Array.isArray(payload?.responseObject?.data)) {
    return payload.responseObject.data;
  }
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }
  return [];
}

function normalizeMetroUnitName(value = '') {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

export class OfficialSourceService {
  constructor({
    db,
    fetchImpl = fetch,
    userAgent,
    tnPoliceBaseUrl = 'https://www.police.tn.gov.in/digigov',
    tnPoliceMetroUnits = ['CHENNAI CITY', 'TAMBARAM CITY', 'AVADI CITY']
  }) {
    this.db = db;
    this.fetchImpl = fetchImpl;
    this.userAgent = userAgent;
    this.tnPoliceBaseUrl = tnPoliceBaseUrl;
    this.tnPoliceMetroUnits = tnPoliceMetroUnits.map(normalizeMetroUnitName);

    this.upsertOfficialSource = db.prepare(`
      INSERT INTO official_sources (
        id,
        name,
        category,
        integration_state,
        access_mode,
        source_url,
        notes,
        last_success_at,
        last_error,
        record_count,
        updated_at
      ) VALUES (
        @id,
        @name,
        @category,
        @integrationState,
        @accessMode,
        @sourceUrl,
        @notes,
        @lastSuccessAt,
        @lastError,
        @recordCount,
        datetime('now')
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        category = excluded.category,
        integration_state = excluded.integration_state,
        access_mode = excluded.access_mode,
        source_url = excluded.source_url,
        notes = excluded.notes,
        last_success_at = excluded.last_success_at,
        last_error = excluded.last_error,
        record_count = excluded.record_count,
        updated_at = datetime('now')
    `);

    this.upsertPoliceStation = db.prepare(`
      INSERT INTO official_police_stations (
        station_org_id,
        station_name,
        metro_unit_org_id,
        metro_unit_name,
        source_name,
        source_url,
        synced_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(station_org_id) DO UPDATE SET
        station_name = excluded.station_name,
        metro_unit_org_id = excluded.metro_unit_org_id,
        metro_unit_name = excluded.metro_unit_name,
        source_name = excluded.source_name,
        source_url = excluded.source_url,
        synced_at = excluded.synced_at,
        updated_at = datetime('now')
    `);

    this.deleteMissingPoliceStations = db.prepare(`
      DELETE FROM official_police_stations
      WHERE station_org_id NOT IN (${Array(1).fill('?').join(',')})
    `);

    this.deleteAllPoliceStations = db.prepare(`DELETE FROM official_police_stations`);
    this.selectOfficialSources = db.prepare(`
      SELECT
        id,
        name,
        category,
        integration_state,
        access_mode,
        source_url,
        notes,
        last_success_at,
        last_error,
        record_count
      FROM official_sources
      ORDER BY name ASC
    `);
    this.selectPoliceStations = db.prepare(`
      SELECT
        station_org_id,
        station_name,
        metro_unit_org_id,
        metro_unit_name,
        source_name,
        source_url,
        synced_at
      FROM official_police_stations
      WHERE (? IS NULL OR metro_unit_name = ?)
      ORDER BY metro_unit_name ASC, station_name ASC
    `);
    this.selectPoliceStationCountByUnit = db.prepare(`
      SELECT metro_unit_name, COUNT(*) AS count
      FROM official_police_stations
      GROUP BY metro_unit_name
      ORDER BY metro_unit_name ASC
    `);

    this.seedSourceDefs();
  }

  seedSourceDefs() {
    for (const source of OFFICIAL_SOURCE_DEFS) {
      this.upsertOfficialSource.run({
        ...source,
        lastSuccessAt: null,
        lastError: null,
        recordCount: 0
      });
    }
  }

  async fetchJson(path, params = {}) {
    const url = buildUrl(this.tnPoliceBaseUrl, path, params);
    const response = await this.fetchImpl(url, {
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-IN,en;q=0.9',
        Referer: 'https://www.police.tn.gov.in/citizenportal/contactus',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    if (!response.ok) {
      throw new Error(`Official source request failed: ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    if (!contentType.includes('application/json')) {
      throw new Error(`Official source returned non-JSON content for ${url}`);
    }

    return JSON.parse(text);
  }

  async syncMetroPoliceStations() {
    const sourceId = 'tn-police-metro-stations';
    const sourceDef = OFFICIAL_SOURCE_DEFS.find((source) => source.id === sourceId);

    try {
      const districtsPayload = await this.fetchJson('/contactUs/getDistrict', { officeTypeId: 7 });
      const districts = normalizeSourceResponse(districtsPayload);
      const metroUnits = districts.filter((district) =>
        this.tnPoliceMetroUnits.includes(normalizeMetroUnitName(district.ORGANIZATION_NAME))
      );

      const stationRows = [];
      for (const metroUnit of metroUnits) {
        const stationsPayload = await this.fetchJson('/contactUs/getPoliceStation', {
          prntOrgId: metroUnit.ORGANIZATION_ID
        });
        const stations = normalizeSourceResponse(stationsPayload);

        for (const station of stations) {
          stationRows.push({
            stationOrgId: String(station.ORGANIZATION_ID),
            stationName: String(station.ORGANIZATION_NAME || '').trim(),
            metroUnitOrgId: String(metroUnit.ORGANIZATION_ID),
            metroUnitName: normalizeMetroUnitName(metroUnit.ORGANIZATION_NAME),
            sourceName: sourceDef.name,
            sourceUrl: sourceDef.sourceUrl
          });
        }
      }

      const tx = this.db.transaction((rows) => {
        if (rows.length === 0) {
          this.deleteAllPoliceStations.run();
          return;
        }

        const seen = new Set();
        const syncedAt = new Date().toISOString();
        for (const row of rows) {
          if (seen.has(row.stationOrgId)) {
            continue;
          }
          seen.add(row.stationOrgId);
          this.upsertPoliceStation.run(
            row.stationOrgId,
            row.stationName,
            row.metroUnitOrgId,
            row.metroUnitName,
            row.sourceName,
            row.sourceUrl,
            syncedAt
          );
        }

        this.db
          .prepare(
            `DELETE FROM official_police_stations
             WHERE station_org_id NOT IN (${[...seen].map(() => '?').join(',')})`
          )
          .run(...seen);
      });

      tx(stationRows);

      this.upsertOfficialSource.run({
        ...sourceDef,
        lastSuccessAt: new Date().toISOString(),
        lastError: null,
        recordCount: stationRows.length
      });

      return {
        sourceId,
        status: 'ok',
        metroUnits: metroUnits.map((unit) => normalizeMetroUnitName(unit.ORGANIZATION_NAME)),
        recordCount: stationRows.length
      };
    } catch (error) {
      this.upsertOfficialSource.run({
        ...sourceDef,
        lastSuccessAt: null,
        lastError: error.message,
        recordCount: 0
      });
      throw error;
    }
  }

  async syncAll() {
    const result = {
      startedAt: new Date().toISOString(),
      sources: []
    };

    try {
      result.sources.push(await this.syncMetroPoliceStations());
      result.status = 'ok';
    } catch (error) {
      result.status = 'error';
      result.error = error.message;
    }

    result.completedAt = new Date().toISOString();
    return result;
  }

  getMeta() {
    return {
      sources: this.selectOfficialSources.all(),
      metroStationCounts: this.selectPoliceStationCountByUnit.all()
    };
  }

  getPoliceStations({ metroUnit = null } = {}) {
    const normalizedUnit = metroUnit ? normalizeMetroUnitName(metroUnit) : null;
    return this.selectPoliceStations.all(normalizedUnit, normalizedUnit).map((row) => ({
      stationOrgId: row.station_org_id,
      stationName: row.station_name,
      metroUnitOrgId: row.metro_unit_org_id,
      metroUnitName: row.metro_unit_name,
      sourceName: row.source_name,
      sourceUrl: row.source_url,
      syncedAt: row.synced_at
    }));
  }
}
