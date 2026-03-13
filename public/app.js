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
  { id: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { id: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { id: '90d', label: 'Last 90 days', hours: 24 * 90 }
];

const DEFAULT_META = {
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

const map = L.map('map', {
  zoomControl: true,
  minZoom: 10,
  maxZoom: 18,
  maxBoundsViscosity: 1.0,
  worldCopyJump: false
});

const markerLayer = L.layerGroup();
const timeSlider = document.querySelector('#time-slider');
const timeRangeLabel = document.querySelector('#time-range-label');
const APP_CONFIG = window.CCM_CONFIG || {};
const API_BASE_URL = typeof APP_CONFIG.apiBaseUrl === 'string' ? APP_CONFIG.apiBaseUrl.trim() : '';

const state = {
  incidents: [],
  maxBounds: null,
  baseZoom: 10,
  requestToken: 0,
  timePreset: '30d',
  pinnedMarker: null,
  mapControlsInstalled: false
};

function clearPinnedMarker() {
  if (!state.pinnedMarker) {
    return;
  }

  state.pinnedMarker.closePopup();
  state.pinnedMarker = null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildApiUrl(path) {
  if (!API_BASE_URL) {
    return path;
  }

  const normalizedBase = API_BASE_URL.endsWith('/') ? API_BASE_URL : `${API_BASE_URL}/`;
  const normalizedPath = path.startsWith('/') ? path.slice(1) : path;
  return new URL(normalizedPath, normalizedBase).toString();
}

function getPreset() {
  return TIME_PRESETS.find((preset) => preset.id === state.timePreset) || TIME_PRESETS[2];
}

function computeRange() {
  const preset = getPreset();
  const to = new Date();
  const from = new Date(to);
  from.setHours(from.getHours() - preset.hours);

  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
    label: preset.label
  };
}

function buildIncidentsUrl() {
  const { fromIso, toIso } = computeRange();
  const params = new URLSearchParams({
    limit: '1500',
    from: fromIso,
    to: toIso
  });

  return buildApiUrl(`/api/incidents?${params.toString()}`);
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

function buildEmojiIcon(incident) {
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
  markerLayer.clearLayers();
  state.pinnedMarker = null;

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
      if (state.pinnedMarker && state.pinnedMarker !== marker) {
        return;
      }

      marker.openPopup();
    });

    marker.on('mouseout', () => {
      if (state.pinnedMarker === marker) {
        return;
      }

      marker.closePopup();
    });

    marker.on('focus', () => {
      if (state.pinnedMarker && state.pinnedMarker !== marker) {
        return;
      }

      marker.openPopup();
    });

    marker.on('blur', () => {
      if (state.pinnedMarker === marker) {
        return;
      }

      marker.closePopup();
    });

    marker.on('click', () => {
      if (state.pinnedMarker && state.pinnedMarker !== marker) {
        state.pinnedMarker.closePopup();
      }

      state.pinnedMarker = marker;
      marker.openPopup();
    });

    marker.on('popupclose', () => {
      if (state.pinnedMarker === marker && !marker.isPopupOpen()) {
        state.pinnedMarker = null;
      }
    });

    markerLayer.addLayer(marker);
  }

  state.incidents = incidents;
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

async function fetchFallbackJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Unable to load fallback resource: ${path}`);
  }

  return response.json();
}

function applyChennaiBounds(meta) {
  state.maxBounds = L.latLngBounds(meta.boundary.maxBounds);
  map.setMaxBounds(state.maxBounds);

  const fillScreenZoom = map.getBoundsZoom(state.maxBounds, true);
  if (Number.isFinite(fillScreenZoom)) {
    state.baseZoom = fillScreenZoom;
    map.setMinZoom(fillScreenZoom);
    map.setView(state.maxBounds.getCenter(), fillScreenZoom, { animate: false });
    return;
  }

  state.baseZoom = 10;
  map.fitBounds(state.maxBounds, { padding: [0, 0], animate: false });
}

function focusIncidents() {
  if (!state.incidents.length) {
    if (state.maxBounds) {
      map.fitBounds(state.maxBounds, { padding: [18, 18], animate: false });
    }
    return;
  }

  const markerBounds = L.latLngBounds(state.incidents.map((incident) => [incident.lat, incident.lng]));
  const zoomForIncidents = Math.min(Math.max(state.baseZoom + 1, 12), 14);

  if (state.incidents.length === 1) {
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
  if (state.mapControlsInstalled) {
    return;
  }

  const tileOptions = {
    maxZoom: 20,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    noWrap: true,
    bounds: maxBounds
  };

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', tileOptions).addTo(map);

  map.whenReady(() => {
    map.invalidateSize();
  });
  window.addEventListener('resize', () => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 120);

  map.addLayer(markerLayer);
  state.mapControlsInstalled = true;
}

function syncTimeControls() {
  const preset = getPreset();
  const index = TIME_PRESETS.findIndex((entry) => entry.id === preset.id);
  timeSlider.value = String(index === -1 ? 2 : index);
  timeRangeLabel.textContent = preset.label;
}

async function loadIncidents() {
  const token = ++state.requestToken;
  const url = buildIncidentsUrl();
  let payload;

  try {
    payload = await fetchIncidents(url);
  } catch (error) {
    console.error('Primary incidents API failed, using fallback snapshot:', error.message);
    payload = await fetchFallbackJson('./fallback-incidents.json');
  }

  if (token !== state.requestToken) {
    return;
  }

  renderIncidents(payload.incidents || []);
  focusIncidents();
}

function wireControls() {
  map.on('click', () => {
    clearPinnedMarker();
  });

  timeSlider.addEventListener('input', () => {
    const preset = TIME_PRESETS[Number(timeSlider.value)] || TIME_PRESETS[2];
    state.timePreset = preset.id;
    syncTimeControls();
    loadIncidents().catch((error) => {
      console.error('Failed to load incidents:', error.message);
    });
  });
}

async function init() {
  syncTimeControls();
  wireControls();
  installMapControls(DEFAULT_META.boundary.maxBounds);
  applyChennaiBounds(DEFAULT_META);

  try {
    const meta = await fetchMeta();
    applyChennaiBounds(meta);
  } catch (error) {
    console.error('Primary metadata API failed, using fallback boundary:', error.message);
    try {
      const fallbackMeta = await fetchFallbackJson('./fallback-meta.json');
      applyChennaiBounds(fallbackMeta);
    } catch (fallbackError) {
      console.error('Fallback metadata failed:', fallbackError.message);
    }
  }

  try {
    await loadIncidents();
  } catch (error) {
    console.error('Map initialization failed:', error.message);
  }
}

init();
