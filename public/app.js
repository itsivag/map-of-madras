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

const map = L.map('map', {
  zoomControl: true,
  minZoom: 10,
  maxZoom: 18,
  maxBoundsViscosity: 1.0,
  worldCopyJump: false
});

const markerLayer = L.layerGroup();

const state = {
  maxBounds: null,
  incidents: [],
  baseZoom: 10
};

function buildIncidentsUrl() {
  const params = new URLSearchParams();
  params.set('limit', '1500');
  return `/api/incidents?${params.toString()}`;
}

function markerPopup(incident) {
  const occurred = incident.occurredAt ? incident.occurredAt.slice(0, 10) : 'Unknown';
  const sourceLink = incident.sourceUrl
    ? `<a href="${incident.sourceUrl}" target="_blank" rel="noreferrer">Source article</a>`
    : 'Source unavailable';

  return `
    <div>
      <strong>${incident.category}</strong>
      <div><strong>Locality:</strong> ${incident.locality || 'Unknown'}</div>
      <div><strong>Date:</strong> ${occurred}</div>
      <div style="margin-top: 0.35rem;">${sourceLink}</div>
    </div>
  `;
}

function buildEmojiIcon(incident) {
  const color = CATEGORY_COLORS[incident.category] || CATEGORY_COLORS.other;
  const emoji = CATEGORY_EMOJIS[incident.category] || CATEGORY_EMOJIS.other;

  return L.divIcon({
    className: 'crime-emoji-icon',
    html: `
      <div class="crime-emoji-marker" style="background:${color}" title="${incident.category}">
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

  for (const incident of incidents) {
    const marker = L.marker([incident.lat, incident.lng], {
      icon: buildEmojiIcon(incident),
      keyboard: true,
      riseOnHover: true
    }).bindPopup(markerPopup(incident));

    markerLayer.addLayer(marker);
  }

  state.incidents = incidents;
}

async function fetchMeta() {
  const response = await fetch('/api/meta');
  if (!response.ok) {
    throw new Error('Unable to load metadata');
  }
  return response.json();
}

async function fetchIncidents() {
  const response = await fetch(buildIncidentsUrl());
  if (!response.ok) {
    throw new Error('Unable to load incidents');
  }
  const payload = await response.json();
  return payload.incidents || [];
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
    return;
  }

  const markerBounds = L.latLngBounds(state.incidents.map((incident) => [incident.lat, incident.lng]));
  const zoomForIncidents = Math.min(Math.max(state.baseZoom + 1, 12), 14);

  if (state.incidents.length === 1) {
    map.setView(markerBounds.getCenter(), zoomForIncidents, { animate: false });
    return;
  }

  map.fitBounds(markerBounds, {
    padding: [60, 60],
    maxZoom: zoomForIncidents,
    animate: false
  });
}

function installMapControls(maxBounds) {
  const tileOptions = {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    noWrap: true,
    bounds: maxBounds,
    subdomains: 'abcd'
  };

  map.createPane('bloodmap');
  const bloodPane = map.getPane('bloodmap');
  bloodPane.style.zIndex = '200';
  bloodPane.style.filter = 'sepia(1) hue-rotate(305deg) saturate(7.5) brightness(0.58) contrast(1.3)';

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
    ...tileOptions,
    pane: 'bloodmap'
  }).addTo(map);

  map.createPane('labels');
  const labelsPane = map.getPane('labels');
  labelsPane.classList.add('map-labels-pane');
  labelsPane.style.zIndex = '450';
  labelsPane.style.pointerEvents = 'none';
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    ...tileOptions,
    pane: 'labels'
  }).addTo(map);

  map.whenReady(() => {
    map.invalidateSize();
  });
  window.addEventListener('resize', () => map.invalidateSize());
  setTimeout(() => map.invalidateSize(), 120);

  map.addLayer(markerLayer);
}

async function init() {
  try {
    const [meta, incidents] = await Promise.all([fetchMeta(), fetchIncidents()]);

    installMapControls(meta.boundary.maxBounds);
    applyChennaiBounds(meta);
    renderIncidents(incidents);
    focusIncidents();
  } catch (error) {
    console.error('Map initialization failed:', error.message);
  }
}

init();
