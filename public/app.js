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

const CATEGORY_ORDER = [
  'murder',
  'rape',
  'assault',
  'robbery/theft',
  'kidnapping',
  'fraud/scam',
  'drug offense',
  'other'
];

const TIME_PRESETS = [
  { id: '24h', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'custom', label: 'Custom range' }
];

const map = L.map('map', {
  zoomControl: true,
  minZoom: 10,
  maxZoom: 18,
  maxBoundsViscosity: 1.0,
  worldCopyJump: false
});

const markerLayer = L.layerGroup();

const timeSlider = document.querySelector('#time-slider');
const timeOptionButtons = [...document.querySelectorAll('.time-option')];
const timeRangeLabel = document.querySelector('#time-range-label');
const customRangeSection = document.querySelector('#custom-range');
const customFromInput = document.querySelector('#custom-from');
const customToInput = document.querySelector('#custom-to');
const applyCustomRangeButton = document.querySelector('#apply-custom-range');
const categoryToggles = document.querySelector('#category-toggles');
const categoryCountLabel = document.querySelector('#category-count-label');
const resultsSummary = document.querySelector('#results-summary');
const filterStatus = document.querySelector('#filter-status');
const resetFiltersButton = document.querySelector('#reset-filters');

const state = {
  maxBounds: null,
  incidents: [],
  baseZoom: 10,
  requestToken: 0,
  filters: {
    timePreset: '30d',
    customFrom: null,
    customTo: null,
    categories: new Set(CATEGORY_ORDER)
  }
};

function formatDateTimeLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function toDisplayLabel(value) {
  return value
    .split('/')
    .map((part) => part.replace(/\b\w/g, (char) => char.toUpperCase()))
    .join(' / ');
}

function computeFromDateForPreset(preset) {
  const from = new Date();

  if (preset === '24h') {
    from.setHours(from.getHours() - 24);
    return from;
  }

  if (preset === '7d') {
    from.setDate(from.getDate() - 7);
    return from;
  }

  from.setDate(from.getDate() - 30);
  return from;
}

function formatFilterDate(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function getTimePresetIndex(presetId) {
  const index = TIME_PRESETS.findIndex((preset) => preset.id === presetId);
  return index === -1 ? 2 : index;
}

function syncTimeControls() {
  timeSlider.value = String(getTimePresetIndex(state.filters.timePreset));

  for (const button of timeOptionButtons) {
    const active = button.dataset.preset === state.filters.timePreset;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  }

  const customActive = state.filters.timePreset === 'custom';
  customRangeSection.hidden = !customActive;
}

function renderCategoryToggles() {
  categoryToggles.innerHTML = '';

  for (const category of CATEGORY_ORDER) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'category-toggle';
    button.dataset.category = category;

    const isActive = state.filters.categories.has(category);
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
    button.innerHTML = `
      <span class="category-toggle__swatch" style="background:${CATEGORY_COLORS[category]}"></span>
      <span class="category-toggle__emoji">${CATEGORY_EMOJIS[category]}</span>
      <span class="category-toggle__label">${toDisplayLabel(category)}</span>
    `;

    button.addEventListener('click', () => {
      if (state.filters.categories.has(category)) {
        state.filters.categories.delete(category);
      } else {
        state.filters.categories.add(category);
      }

      renderCategoryToggles();
      updateCategorySummary();
      loadIncidents();
    });

    categoryToggles.appendChild(button);
  }
}

function updateCategorySummary() {
  const activeCount = state.filters.categories.size;
  categoryCountLabel.textContent = `${activeCount} active`;
}

function setStatus(message, tone = 'muted') {
  filterStatus.textContent = message;
  filterStatus.dataset.tone = tone;
}

function getResolvedRange() {
  const to = new Date();

  if (state.filters.timePreset !== 'custom') {
    const from = computeFromDateForPreset(state.filters.timePreset);
    return {
      fromIso: from.toISOString(),
      toIso: to.toISOString(),
      label: `Last ${TIME_PRESETS[getTimePresetIndex(state.filters.timePreset)].label}`
    };
  }

  const fromDate = new Date(customFromInput.value);
  const toDate = new Date(customToInput.value);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error('Pick both custom dates before applying the range.');
  }

  if (fromDate > toDate) {
    throw new Error('Custom range start must be earlier than the end date.');
  }

  return {
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
    label: `${formatFilterDate(fromDate.toISOString())} to ${formatFilterDate(toDate.toISOString())}`
  };
}

function buildIncidentsUrl() {
  if (state.filters.categories.size === 0) {
    return { url: null, rangeLabel: 'No categories selected' };
  }

  const { fromIso, toIso, label } = getResolvedRange();
  const params = new URLSearchParams();
  params.set('limit', '1500');
  params.set('from', fromIso);
  params.set('to', toIso);

  if (state.filters.categories.size !== CATEGORY_ORDER.length) {
    params.set('category', [...state.filters.categories].join(','));
  }

  return {
    url: `/api/incidents?${params.toString()}`,
    rangeLabel: label
  };
}

function markerPopup(incident) {
  const occurred = incident.occurredAt ? incident.occurredAt.slice(0, 10) : 'Unknown';
  const sources = Array.isArray(incident.sources) ? incident.sources : [];
  const sourceMarkup = sources.length
    ? `
        <div style="margin-top: 0.35rem;">
          <strong>Sources:</strong>
          <ul style="margin: 0.25rem 0 0 1rem; padding: 0;">
            ${sources
              .slice(0, 5)
              .map((source) => {
                const label = source.sourceName || source.title || 'Source article';
                return `<li><a href="${source.sourceUrl}" target="_blank" rel="noreferrer">${label}</a></li>`;
              })
              .join('')}
          </ul>
        </div>
      `
    : incident.sourceUrl
      ? `<div style="margin-top: 0.35rem;"><a href="${incident.sourceUrl}" target="_blank" rel="noreferrer">Source article</a></div>`
      : '<div style="margin-top: 0.35rem;">Source unavailable</div>';

  return `
    <div>
      <strong>${incident.category}</strong>
      <div><strong>Locality:</strong> ${incident.locality || 'Unknown'}</div>
      <div><strong>Date:</strong> ${occurred}</div>
      ${incident.sourceCount > 1 ? `<div><strong>Reports:</strong> ${incident.sourceCount}</div>` : ''}
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

async function fetchIncidents(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Unable to load incidents');
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
      map.fitBounds(state.maxBounds, { padding: [24, 24], animate: false });
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

function updateSummary(rangeLabel) {
  const activeCategories = state.filters.categories.size;

  if (activeCategories === 0) {
    timeRangeLabel.textContent = 'No time range';
    resultsSummary.textContent = 'No categories selected. Turn at least one offense type back on.';
    return;
  }

  timeRangeLabel.textContent = rangeLabel;

  const incidentCount = state.incidents.length;
  const categoryText = activeCategories === CATEGORY_ORDER.length ? 'all categories' : `${activeCategories} categories`;
  const incidentText = incidentCount === 1 ? '1 incident' : `${incidentCount} incidents`;
  resultsSummary.textContent = `Showing ${incidentText} across ${categoryText}.`;
}

function initializeCustomRangeDefaults() {
  const defaultTo = new Date();
  const defaultFrom = computeFromDateForPreset('30d');

  state.filters.customFrom = defaultFrom.toISOString();
  state.filters.customTo = defaultTo.toISOString();
  customFromInput.value = formatDateTimeLocal(defaultFrom);
  customToInput.value = formatDateTimeLocal(defaultTo);
}

function resetFilters() {
  state.filters.timePreset = '30d';
  state.filters.categories = new Set(CATEGORY_ORDER);
  initializeCustomRangeDefaults();
  syncTimeControls();
  renderCategoryToggles();
  updateCategorySummary();
  loadIncidents();
}

async function loadIncidents() {
  const token = ++state.requestToken;

  let urlData;
  try {
    urlData = buildIncidentsUrl();
    updateSummary(urlData.rangeLabel);
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }

  if (!urlData.url) {
    renderIncidents([]);
    focusIncidents();
    setStatus('Category filters are all off.', 'muted');
    return;
  }

  setStatus('Refreshing map incidents...', 'muted');

  try {
    const payload = await fetchIncidents(urlData.url);
    if (token !== state.requestToken) {
      return;
    }

    renderIncidents(payload.incidents || []);
    updateSummary(urlData.rangeLabel);
    focusIncidents();
    setStatus(`Updated ${new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`, 'success');
  } catch (error) {
    if (token !== state.requestToken) {
      return;
    }

    setStatus(error.message, 'error');
  }
}

function applyTimePreset(presetId) {
  state.filters.timePreset = presetId;
  syncTimeControls();

  if (presetId === 'custom') {
    updateSummary('Custom range');
    setStatus('Choose dates and apply the custom range.', 'muted');
    return;
  }

  loadIncidents();
}

function wireControls() {
  timeSlider.addEventListener('input', () => {
    const preset = TIME_PRESETS[Number(timeSlider.value)]?.id || '30d';
    applyTimePreset(preset);
  });

  for (const button of timeOptionButtons) {
    button.addEventListener('click', () => {
      applyTimePreset(button.dataset.preset || '30d');
    });
  }

  applyCustomRangeButton.addEventListener('click', () => {
    state.filters.timePreset = 'custom';
    syncTimeControls();
    loadIncidents();
  });

  resetFiltersButton.addEventListener('click', () => {
    resetFilters();
  });
}

async function init() {
  try {
    initializeCustomRangeDefaults();
    syncTimeControls();
    renderCategoryToggles();
    updateCategorySummary();
    wireControls();

    const meta = await fetchMeta();

    installMapControls(meta.boundary.maxBounds);
    applyChennaiBounds(meta);
    await loadIncidents();
  } catch (error) {
    console.error('Map initialization failed:', error.message);
    setStatus(error.message, 'error');
    resultsSummary.textContent = 'Map initialization failed.';
  }
}

init();
