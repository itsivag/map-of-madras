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
const drawerShell = document.querySelector('#drawer-shell');
const drawerBackdrop = document.querySelector('#drawer-backdrop');
const incidentDrawer = document.querySelector('#incident-drawer');
const drawerTitle = document.querySelector('#drawer-title');
const drawerContent = document.querySelector('#drawer-content');
const closeDrawerButton = document.querySelector('#close-drawer');

const state = {
  maxBounds: null,
  incidents: [],
  baseZoom: 10,
  requestToken: 0,
  detailRequestToken: 0,
  selectedIncidentId: null,
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

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
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

function formatDateOnly(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }

  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
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

  customRangeSection.hidden = state.filters.timePreset !== 'custom';
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
  categoryCountLabel.textContent = `${state.filters.categories.size} active`;
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

function buildIncidentDetailUrl(incidentId) {
  return `/api/incidents/${incidentId}`;
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

function openDrawer() {
  drawerShell.classList.remove('is-hidden');
  incidentDrawer.setAttribute('aria-hidden', 'false');
}

function closeDrawer() {
  state.selectedIncidentId = null;
  drawerShell.classList.add('is-hidden');
  incidentDrawer.setAttribute('aria-hidden', 'true');
  drawerTitle.textContent = 'Select a marker';
  drawerContent.innerHTML =
    '<p class="drawer-empty">Open a marker to inspect supporting coverage and extracted evidence.</p>';
}

function renderDrawerLoading(incident) {
  drawerTitle.textContent = incident.title || `${toDisplayLabel(incident.category)} details`;
  drawerContent.innerHTML = '<p class="drawer-empty">Loading incident details...</p>';
  openDrawer();
}

function buildEvidenceMarkup(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return '<p class="drawer-empty">No extracted evidence chunks were stored for this incident.</p>';
  }

  return evidence
    .map(
      (entry) => `
        <article class="drawer-card">
          <div class="drawer-card__chips">
            ${entry.supports
              .map((support) => `<span class="chip chip--muted">${escapeHtml(toDisplayLabel(support))}</span>`)
              .join('')}
          </div>
          <p>${escapeHtml(entry.text || 'Evidence chunk unavailable.')}</p>
        </article>
      `
    )
    .join('');
}

function buildSupportingArticlesMarkup(articles) {
  if (!Array.isArray(articles) || articles.length === 0) {
    return '<p class="drawer-empty">No related supporting coverage found.</p>';
  }

  return articles
    .map(
      (article) => `
        <article class="drawer-card">
          <div class="drawer-card__header">
            <h4>${escapeHtml(article.title || article.sourceName || 'Untitled coverage')}</h4>
            ${article.isPrimary ? '<span class="chip">Primary</span>' : '<span class="chip chip--muted">Related</span>'}
          </div>
          <p>${escapeHtml(article.summary || 'No summary available.')}</p>
          <div class="drawer-meta">
            <span>${escapeHtml(article.locality || 'Unknown locality')}</span>
            <span>${escapeHtml(formatDateOnly(article.occurredAt || article.publishedAt))}</span>
            <span>${Math.round((article.confidence || 0) * 100)}% confidence</span>
          </div>
          ${
            article.sourceUrl
              ? `<a class="drawer-link" href="${escapeHtml(article.sourceUrl)}" target="_blank" rel="noreferrer">Open source article</a>`
              : ''
          }
        </article>
      `
    )
    .join('');
}

function renderIncidentDetail(detail) {
  const incident = detail.incident || {};
  const extraction = detail.extraction || {};
  const headline =
    incident.title || `${toDisplayLabel(incident.category || 'incident')} in ${incident.locality || 'Chennai'}`;

  drawerTitle.textContent = headline;
  drawerContent.innerHTML = `
    <section class="drawer-section">
      <div class="drawer-card drawer-card--hero">
        <div class="drawer-card__header">
          <h3>${escapeHtml(headline)}</h3>
          <span class="chip">${escapeHtml(toDisplayLabel(incident.category || 'other'))}</span>
        </div>
        <p>${escapeHtml(incident.summary || 'No summary available.')}</p>
        <div class="drawer-meta">
          <span>${escapeHtml(incident.locality || 'Unknown locality')}</span>
          <span>${escapeHtml(formatDateOnly(incident.occurredAt || incident.publishedAt))}</span>
          <span>${Math.round((incident.confidence || 0) * 100)}% confidence</span>
        </div>
      </div>
    </section>

    <section class="drawer-section">
      <div class="drawer-section__header">
        <h3>Extracted evidence</h3>
        ${
          detail.primaryArticle?.sourceUrl
            ? `<a class="drawer-link" href="${escapeHtml(detail.primaryArticle.sourceUrl)}" target="_blank" rel="noreferrer">Primary source</a>`
            : ''
        }
      </div>
      <div class="drawer-meta drawer-meta--stack">
        <span>Subcategory: ${escapeHtml(extraction.subcategory || incident.subcategory || 'Unspecified')}</span>
        <span>Extracted location: ${escapeHtml(extraction.locationText || incident.locality || 'Unknown')}</span>
        <span>Extracted time: ${escapeHtml(formatDateOnly(extraction.occurredAt || incident.occurredAt || incident.publishedAt))}</span>
      </div>
      ${buildEvidenceMarkup(detail.evidence)}
    </section>

    <section class="drawer-section">
      <div class="drawer-section__header">
        <h3>Supporting articles</h3>
        <span class="chip chip--muted">${detail.supportingArticles?.length || 0} items</span>
      </div>
      ${buildSupportingArticlesMarkup(detail.supportingArticles)}
    </section>
  `;

  openDrawer();
}

function renderIncidents(incidents) {
  markerLayer.clearLayers();

  for (const incident of incidents) {
    const marker = L.marker([incident.lat, incident.lng], {
      icon: buildEmojiIcon(incident),
      keyboard: true,
      riseOnHover: true
    }).bindPopup(markerPopup(incident));

    marker.on('click', () => {
      openIncidentDrawer(incident);
    });

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

async function fetchIncidentDetail(incidentId) {
  const response = await fetch(buildIncidentDetailUrl(incidentId));
  if (!response.ok) {
    throw new Error('Unable to load incident details');
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

async function openIncidentDrawer(incident) {
  const token = ++state.detailRequestToken;
  state.selectedIncidentId = incident.id;
  renderDrawerLoading(incident);

  try {
    const detail = await fetchIncidentDetail(incident.id);
    if (token !== state.detailRequestToken || state.selectedIncidentId !== incident.id) {
      return;
    }

    renderIncidentDetail(detail);
  } catch (error) {
    if (token !== state.detailRequestToken || state.selectedIncidentId !== incident.id) {
      return;
    }

    drawerTitle.textContent = incident.title || 'Incident detail';
    drawerContent.innerHTML = `<p class="drawer-empty">${escapeHtml(error.message)}</p>`;
    openDrawer();
  }
}

function resetFilters() {
  state.filters.timePreset = '30d';
  state.filters.categories = new Set(CATEGORY_ORDER);
  initializeCustomRangeDefaults();
  syncTimeControls();
  renderCategoryToggles();
  updateCategorySummary();
  closeDrawer();
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
    closeDrawer();
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
    if (state.selectedIncidentId && !state.incidents.some((incident) => incident.id === state.selectedIncidentId)) {
      closeDrawer();
    }
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

  closeDrawerButton.addEventListener('click', () => {
    closeDrawer();
  });

  drawerBackdrop.addEventListener('click', () => {
    closeDrawer();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawerShell.classList.contains('is-hidden')) {
      closeDrawer();
    }
  });
}

async function init() {
  try {
    initializeCustomRangeDefaults();
    syncTimeControls();
    renderCategoryToggles();
    updateCategorySummary();
    wireControls();
    closeDrawer();

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
