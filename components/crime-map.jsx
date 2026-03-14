'use client';

import { useEffect, useRef, useState } from 'react';

const CATEGORY_COLORS = {
  murder: '#5f0f12',
  rape: '#741417',
  assault: '#8a1b1f',
  'robbery/theft': '#a1262b',
  kidnapping: '#c13339',
  'fraud/scam': '#8c5407',
  'drug offense': '#3c4f0e',
  other: '#7d2227'
};

const CATEGORY_EMOJIS = {
  murder: '🔪',
  rape: '⚠️',
  assault: '👊',
  'robbery/theft': '💸',
  kidnapping: '🚨',
  'fraud/scam': '🧾',
  'drug offense': '💊',
  other: '📍'
};

const TIME_PRESETS = [
  { id: '24h', label: 'Last 24 hours', hours: 24 },
  { id: '2d', label: 'Last 2 days', hours: 24 * 2 },
  { id: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { id: '30d', label: 'Last 30 days', hours: 24 * 30 }
];

const DEFAULT_META = {
  disclaimer:
    'Markers are fetched and filtered by AI from news reports and may contain errors. This is not an official police record.',
  boundary: {
    maxBounds: [
      [12.86, 79.85],
      [13.42, 80.41]
    ],
    bbox: {
      minLng: 79.85,
      minLat: 12.86,
      maxLng: 80.41,
      maxLat: 13.42
    }
  }
};

function getPreset(presetId) {
  return TIME_PRESETS.find((preset) => preset.id === presetId) || TIME_PRESETS[2];
}

function getApiBaseUrl() {
  if (typeof window === 'undefined') {
    return '';
  }

  const baseUrl = window.CCM_CONFIG?.apiBaseUrl;
  return typeof baseUrl === 'string' ? baseUrl.trim() : '';
}

function buildApiUrl(requestPath) {
  const apiBaseUrl = getApiBaseUrl();
  if (!apiBaseUrl) {
    return requestPath;
  }

  const normalizedBase = apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`;
  const normalizedPath = requestPath.startsWith('/') ? requestPath.slice(1) : requestPath;
  return new URL(normalizedPath, normalizedBase).toString();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function markerPopup(incident) {
  const occurred = incident.occurredAt
    ? new Intl.DateTimeFormat('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric'
      }).format(new Date(incident.occurredAt))
    : 'Unknown';

  const sources = Array.isArray(incident.sources) ? incident.sources : [];
  const sourceMarkup = sources.length
    ? `
        <div class="popup-sources">
          ${sources
            .slice(0, 5)
            .map((source) => {
              const label = source.sourceName || source.title || 'Source article';
              return `<a href="${escapeHtml(source.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
            })
            .join('')}
        </div>
      `
    : incident.sourceUrl
      ? `<div class="popup-sources"><a href="${escapeHtml(incident.sourceUrl)}" target="_blank" rel="noreferrer">Source article</a></div>`
      : '';

  return `
    <div class="popup-card">
      <strong>${escapeHtml(incident.category || 'other')}</strong>
      <div>${escapeHtml(incident.locality || 'Unknown locality')}</div>
      <div>${escapeHtml(occurred)}</div>
      ${sourceMarkup}
    </div>
  `;
}

function formatLastUpdated(lastRun) {
  if (!lastRun) {
    return 'Unavailable';
  }

  const timestamp = lastRun.finished_at || lastRun.started_at;
  if (!timestamp) {
    return 'Unavailable';
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Kolkata'
  }).format(new Date(timestamp));
}

function getIncidentHeadline(incident) {
  return (
    incident.title ||
    (Array.isArray(incident.sources) ? incident.sources.find((source) => source?.title)?.title : null) ||
    'Untitled incident'
  );
}

export function CrimeMap() {
  const mapNodeRef = useRef(null);
  const mapRef = useRef(null);
  const leafletRef = useRef(null);
  const markerLayerRef = useRef(null);
  const markerByIncidentIdRef = useRef(new Map());
  const listPanelRef = useRef(null);
  const maxBoundsRef = useRef(null);
  const baseZoomRef = useRef(10);
  const pinnedMarkerRef = useRef(null);
  const incidentsRef = useRef([]);
  const requestTokenRef = useRef(0);
  const mapControlsInstalledRef = useRef(false);
  const resizeHandlerRef = useRef(null);
  const [timePreset, setTimePreset] = useState('30d');
  const [mapReady, setMapReady] = useState(false);
  const [statusText, setStatusText] = useState('Loading recent incidents');
  const [lastUpdatedText, setLastUpdatedText] = useState('Checking latest ingest');
  const [disclaimerText, setDisclaimerText] = useState(DEFAULT_META.disclaimer);
  const [allIncidents, setAllIncidents] = useState([]);
  const [activeIncidentId, setActiveIncidentId] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');

  function clearPinnedMarker() {
    if (!pinnedMarkerRef.current) {
      return;
    }

    pinnedMarkerRef.current.closePopup();
    pinnedMarkerRef.current = null;
  }

  function buildEmojiIcon(incident) {
    const L = leafletRef.current;
    const color = CATEGORY_COLORS[incident.category] || CATEGORY_COLORS.other;
    const emoji = CATEGORY_EMOJIS[incident.category] || CATEGORY_EMOJIS.other;

    return L.divIcon({
      className: 'crime-emoji-icon',
      html: `
        <div class="crime-emoji-marker" style="background:${color}" title="${escapeHtml(incident.category)}">
          <span>${emoji}</span>
        </div>
      `,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
      popupAnchor: [0, -18]
    });
  }

  function renderIncidents(incidents) {
    const L = leafletRef.current;
    const markerLayer = markerLayerRef.current;

    if (!L || !markerLayer) {
      return;
    }

    markerLayer.clearLayers();
    markerByIncidentIdRef.current = new Map();
    pinnedMarkerRef.current = null;

    for (const incident of incidents) {
      const marker = L.marker([incident.lat, incident.lng], {
        icon: buildEmojiIcon(incident),
        keyboard: true,
        riseOnHover: true
      }).bindPopup(markerPopup(incident), {
        autoClose: true,
        closeButton: false,
        closeOnClick: false,
        offset: [0, -10]
      });

      marker.on('mouseover', () => {
        if (pinnedMarkerRef.current && pinnedMarkerRef.current !== marker) {
          return;
        }

        marker.openPopup();
      });

      marker.on('mouseout', () => {
        if (pinnedMarkerRef.current === marker) {
          return;
        }

        marker.closePopup();
      });

      marker.on('focus', () => {
        if (pinnedMarkerRef.current && pinnedMarkerRef.current !== marker) {
          return;
        }

        marker.openPopup();
      });

      marker.on('blur', () => {
        if (pinnedMarkerRef.current === marker) {
          return;
        }

        marker.closePopup();
      });

      marker.on('click', () => {
        if (pinnedMarkerRef.current && pinnedMarkerRef.current !== marker) {
          pinnedMarkerRef.current.closePopup();
        }

        pinnedMarkerRef.current = marker;
        setActiveIncidentId(incident.id);
        marker.openPopup();
      });

      marker.on('popupclose', () => {
        if (pinnedMarkerRef.current === marker && !marker.isPopupOpen()) {
          pinnedMarkerRef.current = null;
        }
      });

      markerByIncidentIdRef.current.set(incident.id, marker);
      markerLayer.addLayer(marker);
    }

    incidentsRef.current = incidents;
    setActiveIncidentId((current) =>
      incidents.some((incident) => incident.id === current) ? current : incidents[0]?.id ?? null
    );
  }

  function focusIncidentById(incidentId) {
    const map = mapRef.current;
    const marker = markerByIncidentIdRef.current.get(incidentId);

    if (!map || !marker) {
      return;
    }

    const markerLatLng = marker.getLatLng();
    const currentZoom = map.getZoom();
    const point = map.project(markerLatLng, currentZoom);
    const panelWidth = listPanelRef.current?.clientWidth || 0;
    const targetCenter = map.unproject([point.x + panelWidth * 0.4, point.y], currentZoom);
    const nextZoom = Math.max(currentZoom, Math.min(Math.max(baseZoomRef.current + 1, 12), 14));

    if (pinnedMarkerRef.current && pinnedMarkerRef.current !== marker) {
      pinnedMarkerRef.current.closePopup();
    }

    pinnedMarkerRef.current = marker;
    setActiveIncidentId(incidentId);
    map.setView(targetCenter, nextZoom, { animate: true });
    marker.openPopup();
  }

  function formatIncidentDate(incident) {
    const timestamp = incident.occurredAt || incident.publishedAt;
    if (!timestamp) {
      return 'Unknown date';
    }

    return new Intl.DateTimeFormat('en-IN', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'Asia/Kolkata'
    }).format(new Date(timestamp));
  }

  function applyChennaiBounds(meta) {
    const L = leafletRef.current;
    const map = mapRef.current;

    if (!L || !map) {
      return;
    }

    maxBoundsRef.current = L.latLngBounds(meta.boundary.maxBounds);
    map.setMaxBounds(maxBoundsRef.current);

    const fillScreenZoom = map.getBoundsZoom(maxBoundsRef.current, true);
    if (Number.isFinite(fillScreenZoom)) {
      baseZoomRef.current = fillScreenZoom;
      map.setMinZoom(fillScreenZoom);
      map.setView(maxBoundsRef.current.getCenter(), fillScreenZoom, { animate: false });
      return;
    }

    baseZoomRef.current = 10;
    map.fitBounds(maxBoundsRef.current, { padding: [0, 0], animate: false });
  }

  function focusIncidents() {
    const L = leafletRef.current;
    const map = mapRef.current;

    if (!L || !map) {
      return;
    }

    if (!incidentsRef.current.length) {
      if (maxBoundsRef.current) {
        map.fitBounds(maxBoundsRef.current, { padding: [18, 18], animate: false });
      }
      return;
    }

    const markerBounds = L.latLngBounds(
      incidentsRef.current.map((incident) => [incident.lat, incident.lng])
    );
    const zoomForIncidents = Math.min(Math.max(baseZoomRef.current + 1, 12), 14);

    if (incidentsRef.current.length === 1) {
      map.setView(markerBounds.getCenter(), zoomForIncidents, { animate: false });
      return;
    }

    map.fitBounds(markerBounds, {
      padding: [48, 48],
      maxZoom: zoomForIncidents,
      animate: false
    });
  }

  function installMapControls(maxBounds) {
    const L = leafletRef.current;
    const map = mapRef.current;

    if (!L || !map || mapControlsInstalledRef.current) {
      return;
    }

    const tileOptions = {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      subdomains: 'abcd',
      noWrap: true,
      bounds: maxBounds
    };

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
      tileOptions
    ).addTo(map);

    L.tileLayer(
      'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
      {
        ...tileOptions,
        pane: 'overlayPane'
      }
    ).addTo(map);

    resizeHandlerRef.current = () => map.invalidateSize();

    map.whenReady(() => {
      map.invalidateSize();
    });
    window.addEventListener('resize', resizeHandlerRef.current);
    setTimeout(() => map.invalidateSize(), 120);

    map.addLayer(markerLayerRef.current);
    mapControlsInstalledRef.current = true;
  }

  async function fetchMeta() {
    const response = await fetch(buildApiUrl('/api/meta'));
    if (!response.ok) {
      throw new Error('Unable to load metadata');
    }

    return response.json();
  }

  async function fetchIncidents(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Unable to load incidents');
    }

    return response.json();
  }

  async function fetchFallbackJson(requestPath) {
    const response = await fetch(requestPath);
    if (!response.ok) {
      throw new Error(`Unable to load fallback resource: ${requestPath}`);
    }

    return response.json();
  }

  function buildIncidentsUrl() {
    const preset = getPreset(timePreset);
    const to = new Date();
    const from = new Date(to);
    from.setHours(from.getHours() - preset.hours);

    const params = new URLSearchParams({
      limit: '1500',
      from: from.toISOString(),
      to: to.toISOString()
    });

    return buildApiUrl(`/api/incidents?${params.toString()}`);
  }

  useEffect(() => {
    let isActive = true;

    async function initMap() {
      const leafletModule = await import('leaflet');
      const L = leafletModule.default || leafletModule;

      if (!isActive || !mapNodeRef.current) {
        return;
      }

      leafletRef.current = L;
      markerLayerRef.current = L.layerGroup();
      mapRef.current = L.map(mapNodeRef.current, {
        zoomControl: true,
        minZoom: 10,
        maxZoom: 18,
        maxBoundsViscosity: 1.0,
        worldCopyJump: false
      });

      mapRef.current.on('click', clearPinnedMarker);

      installMapControls(DEFAULT_META.boundary.maxBounds);
      applyChennaiBounds(DEFAULT_META);

      try {
        const metaPayload = await fetchMeta();
        if (isActive) {
          applyChennaiBounds(metaPayload);
          setLastUpdatedText(formatLastUpdated(metaPayload.lastRun));
          setDisclaimerText(metaPayload.disclaimer || DEFAULT_META.disclaimer);
        }
      } catch (error) {
        console.error('Primary metadata API failed, using fallback boundary:', error.message);
        try {
          const fallbackMeta = await fetchFallbackJson('/fallback-meta.json');
          if (isActive) {
            applyChennaiBounds(fallbackMeta);
            setLastUpdatedText('Fallback snapshot');
            setDisclaimerText(fallbackMeta?.disclaimer || DEFAULT_META.disclaimer);
          }
        } catch (fallbackError) {
          console.error('Fallback metadata failed:', fallbackError.message);
          if (isActive) {
            setLastUpdatedText('Unavailable');
            setDisclaimerText(DEFAULT_META.disclaimer);
          }
        }
      }

      if (isActive) {
        setMapReady(true);
      }
    }

    initMap().catch((error) => {
      console.error('Map initialization failed:', error.message);
      setStatusText('Map failed to initialize');
    });

    return () => {
      isActive = false;
      clearPinnedMarker();
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      if (resizeHandlerRef.current) {
        window.removeEventListener('resize', resizeHandlerRef.current);
        resizeHandlerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!mapReady) {
      return;
    }

    let isActive = true;
    const token = ++requestTokenRef.current;

    async function loadIncidents() {
      setStatusText(`Loading ${getPreset(timePreset).label.toLowerCase()}`);
      const url = buildIncidentsUrl();
      let payload;

      try {
        payload = await fetchIncidents(url);
      } catch (error) {
        console.error('Primary incidents API failed, using fallback snapshot:', error.message);
        payload = await fetchFallbackJson('/fallback-incidents.json');
      }

      if (!isActive || token !== requestTokenRef.current) {
        return;
      }

      setAllIncidents(payload.incidents || []);
    }

    loadIncidents().catch((error) => {
      console.error('Failed to load incidents:', error.message);
      if (isActive) {
        setStatusText('Unable to load incidents');
      }
    });

    return () => {
      isActive = false;
    };
  }, [mapReady, timePreset]);

  useEffect(() => {
    const categories = new Set(allIncidents.map((incident) => incident.category || 'other'));
    if (selectedCategory !== 'all' && !categories.has(selectedCategory)) {
      setSelectedCategory('all');
    }
  }, [allIncidents, selectedCategory]);

  const filteredIncidents = allIncidents.filter(
    (incident) => selectedCategory === 'all' || (incident.category || 'other') === selectedCategory
  );

  useEffect(() => {
    if (!mapReady) {
      return;
    }

    renderIncidents(filteredIncidents);
    focusIncidents();
    setStatusText(`${filteredIncidents.length} incidents mapped`);
  }, [mapReady, allIncidents, selectedCategory]);

  const currentPreset = getPreset(timePreset);
  const sliderIndex = TIME_PRESETS.findIndex((preset) => preset.id === currentPreset.id);
  const categoryChips = [
    { id: 'all', label: 'All', count: allIncidents.length },
    ...[...new Set(allIncidents.map((incident) => incident.category || 'other'))].map((category) => ({
      id: category,
      label: category,
      count: allIncidents.filter((incident) => (incident.category || 'other') === category).length
    }))
  ];

  return (
    <section className="map-stage" aria-label="Map of Chennai incidents">
      <div id="map" ref={mapNodeRef} />
      <div className="map-sidebar">
        <aside className="incident-rail" aria-label="Incident list" ref={listPanelRef}>
          <div className="incident-rail__header">
            <strong>Incidents</strong>
            <span>{filteredIncidents.length}</span>
          </div>
          <div className="incident-rail__filters" aria-label="Incident category filters">
            {categoryChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`incident-rail__chip${selectedCategory === chip.id ? ' is-active' : ''}`}
              onClick={() => setSelectedCategory(chip.id)}
              aria-label={`${chip.label} incidents`}
            >
              {chip.id !== 'all' ? <span>{CATEGORY_EMOJIS[chip.id] || CATEGORY_EMOJIS.other}</span> : <span>{chip.label}</span>}
              <span>{chip.count}</span>
            </button>
          ))}
          </div>
          <div className="incident-rail__list">
            {filteredIncidents.length ? (
              filteredIncidents.map((incident) => (
                <button
                  key={incident.id}
                  type="button"
                  className={`incident-rail__item${activeIncidentId === incident.id ? ' is-active' : ''}`}
                  onClick={() => focusIncidentById(incident.id)}
                >
                  <span
                    className="incident-rail__dot"
                    style={{ backgroundColor: CATEGORY_COLORS[incident.category] || CATEGORY_COLORS.other }}
                    aria-hidden="true"
                  />
                  <span className="incident-rail__body">
                  <span className="incident-rail__title">
                    {getIncidentHeadline(incident)}
                  </span>
                    <span className="incident-rail__meta">
                      {(incident.locality || 'Unknown locality') +
                        ' · ' +
                        (incident.category || 'other') +
                        ' · ' +
                        formatIncidentDate(incident)}
                    </span>
                  </span>
                </button>
              ))
            ) : (
              <div className="incident-rail__empty">No incidents for this filter.</div>
            )}
          </div>
        </aside>
        <section className="time-widget" aria-label="Time range filter">
          <div className="time-widget__label" id="time-range-label">
            {currentPreset.label}
          </div>
          <input
            id="time-slider"
            className="time-slider"
            type="range"
            min="0"
            max="3"
            step="1"
            value={sliderIndex === -1 ? 2 : sliderIndex}
            aria-label="Time range slider"
            onChange={(event) => {
              const nextPreset = TIME_PRESETS[Number(event.target.value)] || TIME_PRESETS[2];
              setTimePreset(nextPreset.id);
            }}
          />
          <div className="time-slider-scale" aria-hidden="true">
            <span>24h</span>
            <span>2d</span>
            <span>7d</span>
            <span>30d</span>
          </div>
          <div className="status-pill">{statusText}</div>
          <div className="time-widget__updated">Last updated: {lastUpdatedText}</div>
        </section>
      </div>
      <div className="map-disclaimer">{disclaimerText}</div>
    </section>
  );
}
