import { loadHeightfield, pixelOf, slopeAspect, contains, elevationAt } from './terrain.js';
import { decodeImage } from './decode.js';
import { Renderer, MODES } from './renderer.js';
import { sunPosition } from './solar.js';
import { clearSky, surfaceIrradiance, integrate } from './radiation.js';
import { horizonProfile, horizonAt, skyViewFactor, directBeamFactor } from './horizon.js';
import { TERRAIN_SOURCE, metersPerPixel } from './tiles.js';

const STEP_MINUTES = 15;

// Below this map zoom the terrain sample would be coarser than the landforms
// that cast the shadows, producing an overlay that looks unrelated to the
// topography. Refusing to compute is more honest than showing mush.
const MIN_MAP_ZOOM = 11;
const MIN_TERRAIN_ZOOM = 12;
const MAX_TERRAIN_ZOOM = 14;
const MAX_FIELD = 2048;
const MIN_FIELD = 1024;
// Shadows are cast from outside the viewport, so the field overhangs it.
const SHADOW_MARGIN = 1.35;

const el = (id) => document.getElementById(id);
const status = el('status');

const state = {
  date: new Date(),
  minutes: 11 * 60,
  mode: 'binary',
  opacity: 0.75,
  zoom: 12,
  hf: null,
  renderer: null,
  busy: false,
  point: null,
  token: 0,
};

function say(text, busy = false) {
  status.textContent = text;
  status.classList.toggle('busy', busy);
  status.classList.add('show');
  if (!busy) setTimeout(() => status.classList.remove('show'), 2200);
}

const instantOf = () => {
  const d = new Date(state.date);
  d.setHours(0, state.minutes, 0, 0);
  return d;
};

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/liberty',
  center: [6.8694, 45.9237],
  zoom: 11.5,
  hash: true,
  maxPitch: 0,
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

const canvas = el('overlay');
try {
  state.renderer = new Renderer(canvas);
} catch (err) {
  say(err.message);
  document.querySelector('.modes').style.opacity = 0.4;
}

// ---------------------------------------------------------------- terrain

/**
 * Pick the finest terrain zoom whose field still covers the viewport plus a
 * shadow margin without exceeding the texture budget.
 */
function fieldPlan() {
  const lat = map.getCenter().lat;
  const spanMetres = metersPerPixel(lat, map.getZoom()) * map.getCanvas().clientWidth;
  const wanted = spanMetres * SHADOW_MARGIN;
  for (let z = MAX_TERRAIN_ZOOM; z >= MIN_TERRAIN_ZOOM; z--) {
    const size = Math.ceil(wanted / metersPerPixel(lat, z));
    if (size <= MAX_FIELD) return { zoom: z, size: Math.max(MIN_FIELD, size) };
  }
  return { zoom: MIN_TERRAIN_ZOOM, size: MAX_FIELD };
}

function setOverlayVisible(visible) {
  if (map.getLayer('sun')) {
    map.setLayoutProperty('sun', 'visibility', visible ? 'visible' : 'none');
  }
}

function tooFarOut() {
  return map.getZoom() < MIN_MAP_ZOOM;
}

function showZoomHint() {
  state.hf = null;
  setOverlayVisible(false);
  el('zoomHint').hidden = false;
  say('Zoom in to compute sun exposure');
}

async function loadForView() {
  if (!state.renderer || state.busy) return;
  if (tooFarOut()) { showZoomHint(); return; }
  el('zoomHint').hidden = true;
  const token = ++state.token;
  const c = map.getCenter();
  const { zoom, size: fieldSize } = fieldPlan();

  state.busy = true;
  say('Loading terrain…', true);
  try {
    const hf = await loadHeightfield({
      lat: c.lat, lon: c.lng, zoom, size: fieldSize, decode: decodeImage, concurrency: 12,
    });
    if (token !== state.token) return;
    state.hf = hf;
    state.zoom = zoom;
    state.renderer.setHeightfield(hf);
    attachOverlay(hf);
    setOverlayVisible(true);
    say(`Terrain ready — ${hf.metresPerPixel.toFixed(0)} m/px, ${(hf.width * hf.metresPerPixel / 1000).toFixed(0)} km across`);
    await render();
  } catch (err) {
    console.error(err);
    say(`Terrain failed: ${err.message}`);
  } finally {
    state.busy = false;
  }
}

function attachOverlay(hf) {
  const coordinates = [
    [hf.bounds.west, hf.bounds.north],
    [hf.bounds.east, hf.bounds.north],
    [hf.bounds.east, hf.bounds.south],
    [hf.bounds.west, hf.bounds.south],
  ];
  if (map.getSource('sun')) {
    map.getSource('sun').setCoordinates(coordinates);
  } else {
    map.addSource('sun', { type: 'canvas', canvas: 'overlay', coordinates, animate: false });
    map.addLayer({ id: 'sun', type: 'raster', source: 'sun', paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 } });
  }
}

const repaint = () => map.getSource('sun')?.play?.() ?? map.triggerRepaint();

// ------------------------------------------------------------- rendering

function scaleFor(mode) {
  const hf = state.hf;
  if (!hf) return 1000;
  const alt = hf.elevationRange ? hf.elevationRange[1] : 2500;
  const { lat, lon } = hf.centre;
  let peak = 0, total = 0, hours = 0;
  for (let m = 0; m < 1440; m += STEP_MINUTES) {
    const d = new Date(state.date);
    d.setHours(0, m, 0, 0);
    const s = sunPosition(lat, lon, d);
    if (s.elevation <= 0) continue;
    const cs = clearSky(s.elevation, alt, d);
    peak = Math.max(peak, cs.dni + cs.dhi);
    total += cs.dni + cs.dhi;
    hours += 1;
  }
  if (mode === 'power') return Math.max(peak, 200);
  if (mode === 'energy') return Math.max((total * STEP_MINUTES) / 60, 500);
  if (mode === 'sunHours') return Math.max((hours * STEP_MINUTES) / 60, 1);
  return 1000;
}

function dayTimesteps() {
  const { lat, lon } = state.hf.centre;
  const out = [];
  for (let m = 0; m < 1440; m += STEP_MINUTES) {
    const d = new Date(state.date);
    d.setHours(0, m, 0, 0);
    if (sunPosition(lat, lon, d).elevation > 0) out.push(d);
  }
  return out;
}

let renderToken = 0;

async function render() {
  const r = state.renderer;
  if (!r || !state.hf) return;
  const token = ++renderToken;
  const mode = state.mode;
  const scale = scaleFor(mode);
  const common = { mode: MODES[mode], scale, stepHours: STEP_MINUTES / 60, opacity: state.opacity };

  if (mode === 'slope') {
    r.colorize(common);
    repaint();
    updateLegend(mode, scale);
    return;
  }

  if (mode === 'binary' || mode === 'power') {
    r.clearAccumulator();
    r.addTimestep(instantOf());
    r.colorize({ ...common, stepHours: 1 });
    repaint();
    updateLegend(mode, scale);
    return;
  }

  // Whole-day accumulation, spread across frames so the UI keeps breathing.
  const steps = dayTimesteps();
  r.clearAccumulator();
  say(`Integrating ${steps.length} timesteps…`, true);
  for (let i = 0; i < steps.length; i++) {
    if (token !== renderToken) return;
    r.addTimestep(steps[i]);
    if (i % 8 === 7 || i === steps.length - 1) {
      r.colorize(common);
      repaint();
      await new Promise((res) => requestAnimationFrame(res));
    }
  }
  updateLegend(mode, scale);
  say(`${steps.length} timesteps integrated`);
}

function updateLegend(mode, scale) {
  const legend = el('legend');
  const unit = { power: 'W/m²', energy: 'Wh/m²', sunHours: 'h', slope: '°', binary: '' }[mode];
  if (mode === 'binary') {
    legend.style.background = 'linear-gradient(90deg,#1a1f26,#f0e0b0)';
    legend.innerHTML = '<span>shade</span><span>sun</span>';
    return;
  }
  if (mode === 'slope') {
    legend.style.background = 'linear-gradient(90deg,#59a666 0 33%,#f2d94d 33% 50%,#f28c33 50% 67%,#d93333 67% 83%,#a62698 83% 92%,#40268c 92%)';
    legend.innerHTML = '<span>&lt;25°</span><span>50°+</span>';
    return;
  }
  legend.style.background = 'linear-gradient(90deg,#000004,#420a68,#932667,#dd513a,#fca50a,#fcffa4)';
  legend.innerHTML = `<span>0</span><span>${Math.round(scale).toLocaleString()} ${unit}</span>`;
}

// ------------------------------------------------------------- inspector

function inspect(lngLat) {
  const hf = state.hf;
  if (!hf || !contains(hf, lngLat.lat, lngLat.lng)) return;
  state.point = lngLat;
  const p = pixelOf(hf, lngLat.lat, lngLat.lng);
  const elevation = elevationAt(hf, lngLat.lat, lngLat.lng);
  const { slope, aspect } = slopeAspect(hf, p.x, p.y);
  const profile = horizonProfile(hf, p.x, p.y, { azimuths: 180 });
  const svf = skyViewFactor(profile);

  const samples = [];
  let litMinutes = 0;
  let firstSun = null, lastSun = null;
  for (let m = 0; m < 1440; m += STEP_MINUTES) {
    const d = new Date(state.date);
    d.setHours(0, m, 0, 0);
    const s = sunPosition(hf.centre.lat, hf.centre.lon, d);
    if (s.elevation <= 0) { samples.push({ m, total: 0, lit: false }); continue; }
    const cs = clearSky(s.elevation, elevation, d);
    const beam = directBeamFactor(hf, p.x, p.y, profile, s.elevation, s.azimuth);
    const irr = surfaceIrradiance(cs, beam, svf, slope, 0.6);
    const lit = beam > 0;
    if (lit) { litMinutes += STEP_MINUTES; firstSun ??= m; lastSun = m; }
    samples.push({ m, total: irr.total, lit });
  }

  const energy = integrate(samples.map((s) => s.total), STEP_MINUTES);
  const now = samples[Math.round(state.minutes / STEP_MINUTES) % samples.length];
  const soFar = integrate(samples.filter((s) => s.m <= state.minutes).map((s) => s.total), STEP_MINUTES);

  const hhmm = (m) => m == null ? '—' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const stat = (label, value, cls = '') => `<div class="stat ${cls}"><b>${value}</b><i>${label}</i></div>`;
  el('pointStats').innerHTML = [
    stat('elevation', `${elevation.toFixed(0)} m`),
    stat('slope / aspect', `${slope.toFixed(0)}° ${compass(aspect)}`),
    stat('now', `${now.total.toFixed(0)} W/m²`, now.lit ? 'lit' : ''),
    stat('energy so far', `${(soFar / 1000).toFixed(1)} kWh/m²`),
    stat('day total', `${(energy / 1000).toFixed(1)} kWh/m²`),
    stat('direct sun', `${(litMinutes / 60).toFixed(1)} h`),
    stat('sun on slope', `${hhmm(firstSun)}–${hhmm(lastSun)}`),
    stat('sky view', `${(svf * 100).toFixed(0)}%`),
  ].join('');

  drawCurve(samples);
  drawHorizon(profile);
  el('inspector').hidden = false;
  marker.setLngLat(lngLat).addTo(map);
}

const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

function drawCurve(samples) {
  const c = el('curve');
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, pad = 4;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(200, ...samples.map((s) => s.total));

  for (const frac of [0.25, 0.5, 0.75]) {
    ctx.strokeStyle = '#1f252d'; ctx.beginPath();
    ctx.moveTo(0, h - pad - frac * (h - 2 * pad)); ctx.lineTo(w, h - pad - frac * (h - 2 * pad)); ctx.stroke();
  }

  const x = (m) => (m / 1440) * w;
  const y = (v) => h - pad - (v / max) * (h - 2 * pad);

  ctx.beginPath();
  ctx.moveTo(0, h);
  for (const s of samples) ctx.lineTo(x(s.m), y(s.total));
  ctx.lineTo(w, h); ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(240,169,59,.55)');
  grad.addColorStop(1, 'rgba(240,169,59,.03)');
  ctx.fillStyle = grad; ctx.fill();

  ctx.strokeStyle = '#f0a93b'; ctx.lineWidth = 1.5; ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.m), y(s.total)) : ctx.moveTo(x(s.m), y(s.total))));
  ctx.stroke();

  ctx.strokeStyle = '#e6edf3'; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(x(state.minutes), 0); ctx.lineTo(x(state.minutes), h); ctx.stroke();

  ctx.fillStyle = '#5c6570'; ctx.font = '9px ui-monospace, monospace';
  for (const hr of [6, 12, 18]) ctx.fillText(`${hr}:00`, x(hr * 60) + 2, h - 2);
}

function drawHorizon(profile) {
  const c = el('horizonPlot');
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height, pad = 3;
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(30, ...profile);
  ctx.beginPath();
  ctx.moveTo(0, h);
  profile.forEach((v, i) => ctx.lineTo((i / profile.length) * w, h - pad - (Math.max(0, v) / max) * (h - 2 * pad)));
  ctx.lineTo(w, h); ctx.closePath();
  ctx.fillStyle = 'rgba(139,148,158,.28)'; ctx.fill();
  ctx.strokeStyle = '#8b949e'; ctx.lineWidth = 1; ctx.stroke();

  const sun = sunPosition(state.hf.centre.lat, state.hf.centre.lon, instantOf());
  if (sun.elevation > 0) {
    const sx = (sun.azimuth / 360) * w;
    const sy = h - pad - (sun.elevation / max) * (h - 2 * pad);
    ctx.fillStyle = sun.elevation > horizonAt(profile, sun.azimuth) ? '#f0a93b' : '#4a5058';
    ctx.beginPath(); ctx.arc(sx, Math.max(4, sy), 3.5, 0, 7); ctx.fill();
  }
  ctx.fillStyle = '#5c6570'; ctx.font = '9px ui-monospace, monospace';
  ['N', 'E', 'S', 'W'].forEach((d, i) => ctx.fillText(d, (i / 4) * w + 2, h - 2));
}

const marker = new maplibregl.Marker({ color: '#f0a93b', scale: 0.7 });

// ---------------------------------------------------------------- events

function updateSunLine() {
  const c = state.hf ? state.hf.centre : { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const s = sunPosition(c.lat, c.lon, instantOf());
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  el('sunInfo').innerHTML = s.elevation > 0
    ? `sun <b>${s.elevation.toFixed(1)}°</b> above horizon, bearing <b>${s.azimuth.toFixed(0)}°</b> · ${tz}`
    : `sun is <b>below the horizon</b> · ${tz}`;
}

// The date input speaks UTC through valueAsDate, but every calculation here
// runs on local wall-clock time. Parsing the string keeps them in the same day.
const toInputValue = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromInputValue = (v) => {
  const [y, m, d] = v.split('-').map(Number);
  return new Date(y, m - 1, d);
};

el('date').value = toInputValue(state.date);
el('date').addEventListener('change', (e) => {
  if (!e.target.value) return;
  state.date = fromInputValue(e.target.value);
  updateSunLine();
  render();
  if (state.point) inspect(state.point);
});

const timeInput = el('time');
timeInput.value = state.minutes;
const setTime = (v) => {
  state.minutes = +v;
  el('timeLabel').textContent = `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  updateSunLine();
};
setTime(state.minutes);

let timeTimer;
timeInput.addEventListener('input', (e) => {
  setTime(e.target.value);
  clearTimeout(timeTimer);
  timeTimer = setTimeout(() => {
    if (state.mode === 'binary' || state.mode === 'power') render();
    if (state.point) inspect(state.point);
  }, 60);
});

document.querySelectorAll('.modes button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.modes button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.mode = b.dataset.mode;
    render();
  })
);

el('opacity').addEventListener('input', (e) => {
  state.opacity = e.target.value / 100;
  render();
});

el('closeInspector').addEventListener('click', () => {
  el('inspector').hidden = true;
  state.point = null;
  marker.remove();
});

el('panelToggle').addEventListener('click', () => el('panel').classList.toggle('hidden'));

el('zoomIn').addEventListener('click', () => map.easeTo({ zoom: Math.max(MIN_MAP_ZOOM + 0.5, map.getZoom() + 2) }));

map.on('error', (e) => {
  console.error('map error', e && e.error);
  say(`Map error: ${e?.error?.message ?? 'unknown'}`);
});

map.on('click', (e) => inspect(e.lngLat));
map.on('load', () => {
  el('attribution').innerHTML = `${TERRAIN_SOURCE.attribution}<br>Basemap © OpenFreeMap, © OpenStreetMap contributors`;
  loadForView();
});

let moveTimer;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (tooFarOut()) { showZoomHint(); return; }
    const c = map.getCenter();
    const plan = fieldPlan();
    if (!state.hf || plan.zoom !== state.zoom || !contains(state.hf, c.lat, c.lng)) loadForView();
  }, 400);
});

updateSunLine();

window.__sunmap = { map, state, loadForView, render, inspect };
