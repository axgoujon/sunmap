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
const MIN_MAP_ZOOM = 11.5;
const MIN_TERRAIN_ZOOM = 12;
// "Compute anyway" accepts coarse terrain so the whole view can be covered.
const FORCED_MIN_TERRAIN_ZOOM = 9;
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
  forced: false,
};

let sayTimer;
function say(text, busy = false) {
  status.textContent = text;
  status.classList.add('show');
  clearTimeout(sayTimer);
  if (!busy) sayTimer = setTimeout(() => status.classList.remove('show'), 2400);
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
  attributionControl: {
    compact: true,
    customAttribution: TERRAIN_SOURCE.attribution,
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl(), 'bottom-right');

const canvas = el('overlay');
try {
  state.renderer = new Renderer(canvas);
} catch (err) {
  say(err.message);
  document.querySelector('.segmented').style.opacity = 0.4;
}

// ---------------------------------------------------------------- terrain

/**
 * Pick the finest terrain zoom whose field still covers the viewport plus a
 * shadow margin without exceeding the texture budget.
 */
function fieldPlan(forced = state.forced) {
  const lat = map.getCenter().lat;
  const view = map.getCanvas();
  // MapLibre draws 512 px tiles, so a screen pixel at zoom z covers what a
  // 256 px tile pixel covers at z + 1.
  const spanMetres = metersPerPixel(lat, map.getZoom() + 1) * Math.max(view.clientWidth, view.clientHeight);
  const wanted = spanMetres * SHADOW_MARGIN;
  const floor = forced ? FORCED_MIN_TERRAIN_ZOOM : MIN_TERRAIN_ZOOM;
  for (let z = MAX_TERRAIN_ZOOM; z >= floor; z--) {
    const size = Math.ceil(wanted / metersPerPixel(lat, z));
    if (size <= MAX_FIELD) return { zoom: z, size: Math.max(MIN_FIELD, size) };
  }
  return { zoom: floor, size: MAX_FIELD };
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
  state.token++;
  setOverlayVisible(false);
  el('zoomHint').hidden = false;
}

async function loadForView() {
  if (!state.renderer || state.busy) return;
  if (tooFarOut() && !state.forced) { showZoomHint(); return; }
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
    const coarse = zoom < MIN_TERRAIN_ZOOM;
    say(`${coarse ? 'Coarse terrain' : 'Terrain'} · ${hf.metresPerPixel.toFixed(0)} m/px · ${(hf.width * hf.metresPerPixel / 1000).toFixed(0)} km`);
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
  say('Integrating the day…', true);
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
  status.classList.remove('show');
}

function updateLegend(mode, scale) {
  const bar = el('legendBar');
  const unit = { power: 'W/m²', energy: 'Wh/m²', sunHours: 'h' }[mode];
  let min = '0', max = `${Math.round(scale).toLocaleString()} ${unit}`;
  if (mode === 'binary') {
    bar.style.background = 'linear-gradient(90deg,#3a3d44,#3a3d44 50%,#f3dfae 50%,#f3dfae)';
    [min, max] = ['Shade', 'Sun'];
  } else if (mode === 'slope') {
    bar.style.background = 'linear-gradient(90deg,#59a666 0 33%,#f2d94d 33% 50%,#f28c33 50% 67%,#d93333 67% 83%,#a62698 83% 92%,#40268c 92%)';
    [min, max] = ['< 25°', '> 45°'];
  } else {
    bar.style.background = 'linear-gradient(90deg,#000004,#420a68,#932667,#dd513a,#fca50a,#fcffa4)';
  }
  el('legendMin').textContent = min;
  el('legendMax').textContent = max;
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
  const stat = (label, value, cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;
  el('pointTitle').textContent = `${elevation.toFixed(0)} m · ${slope.toFixed(0)}° ${compass(aspect)}`;
  el('pointStats').innerHTML = [
    stat('Now', `${now.total.toFixed(0)} W/m²`, now.lit ? 'lit' : ''),
    stat('Energy so far', `${(soFar / 1000).toFixed(1)} kWh/m²`),
    stat('Day total', `${(energy / 1000).toFixed(1)} kWh/m²`),
    stat('Direct sun', `${(litMinutes / 60).toFixed(1)} h`),
    stat('Sun on slope', firstSun == null ? 'None' : `${hhmm(firstSun)}–${hhmm(lastSun + STEP_MINUTES)}`),
    stat('Sky view', `${(svf * 100).toFixed(0)}%`),
  ].join('');

  drawCurve(samples);
  drawHorizon(profile);
  el('inspector').hidden = false;
  marker.setLngLat(lngLat).addTo(map);
}

const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];

function surface(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '10px system-ui, sans-serif';
  return { ctx, w, h };
}

const INK = '#16181d', MUTED = '#a3a8b0', GRID = '#eceef1', SUN = '#e8912d';

function drawCurve(samples) {
  const { ctx, w, h } = surface(el('curve'));
  const top = 4, bottom = h - 14;
  const max = Math.max(200, ...samples.map((s) => s.total));
  const x = (m) => (m / 1440) * w;
  const y = (v) => bottom - (v / max) * (bottom - top);

  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const hr of [6, 12, 18]) {
    ctx.beginPath(); ctx.moveTo(x(hr * 60), top); ctx.lineTo(x(hr * 60), bottom); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0, bottom); ctx.lineTo(w, bottom); ctx.stroke();

  ctx.beginPath(); ctx.moveTo(0, bottom);
  for (const s of samples) ctx.lineTo(x(s.m), y(s.total));
  ctx.lineTo(w, bottom); ctx.closePath();
  ctx.fillStyle = 'rgba(232,145,45,.14)'; ctx.fill();

  ctx.strokeStyle = SUN; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.m), y(s.total)) : ctx.moveTo(x(s.m), y(s.total))));
  ctx.stroke();

  ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(x(state.minutes), top); ctx.lineTo(x(state.minutes), bottom); ctx.stroke();

  ctx.fillStyle = MUTED; ctx.textAlign = 'center';
  for (const hr of [6, 12, 18]) ctx.fillText(`${hr}:00`, x(hr * 60), h - 2);
  ctx.textAlign = 'left'; ctx.fillText(`${Math.round(max)}`, 2, top + 8);
}

function drawHorizon(profile) {
  const { ctx, w, h } = surface(el('horizonPlot'));
  const top = 4, bottom = h - 14;
  const max = Math.max(30, ...profile);
  const y = (v) => bottom - (Math.max(0, v) / max) * (bottom - top);

  ctx.beginPath(); ctx.moveTo(0, bottom);
  profile.forEach((v, i) => ctx.lineTo((i / profile.length) * w, y(v)));
  ctx.lineTo(w, y(profile[0])); ctx.lineTo(w, bottom); ctx.closePath();
  ctx.fillStyle = '#e4e6ea'; ctx.fill();

  const sun = sunPosition(state.hf.centre.lat, state.hf.centre.lon, instantOf());
  if (sun.elevation > 0) {
    const lit = sun.elevation > horizonAt(profile, sun.azimuth);
    ctx.fillStyle = lit ? SUN : MUTED;
    ctx.beginPath(); ctx.arc((sun.azimuth / 360) * w, Math.max(top + 3, y(sun.elevation)), 3.5, 0, 7); ctx.fill();
  }
  ctx.fillStyle = MUTED; ctx.textAlign = 'center';
  ['N', 'E', 'S', 'W'].forEach((d, i) => ctx.fillText(d, Math.max(5, (i / 4) * w), h - 2));
}

const marker = new maplibregl.Marker({ color: '#16181d', scale: 0.65 });

// ---------------------------------------------------------------- events

function updateSunLine() {
  const c = state.hf ? state.hf.centre : { lat: map.getCenter().lat, lon: map.getCenter().lng };
  const s = sunPosition(c.lat, c.lon, instantOf());
  el('sunInfo').textContent = s.elevation > 0
    ? `Sun ${s.elevation.toFixed(0)}° · ${compass(s.azimuth)}`
    : 'Sun down';
  el('timeLabel').title = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
const setTime = (v) => {
  state.minutes = +v;
  timeInput.value = state.minutes;
  el('timeLabel').textContent = `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  updateSunLine();
};
setTime(state.minutes);

el('now').addEventListener('click', () => {
  const now = new Date();
  state.date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  el('date').value = toInputValue(state.date);
  setTime(now.getHours() * 60 + now.getMinutes());
  render();
  if (state.point) inspect(state.point);
});

let timeTimer;
timeInput.addEventListener('input', (e) => {
  setTime(e.target.value);
  clearTimeout(timeTimer);
  timeTimer = setTimeout(() => {
    if (state.mode === 'binary' || state.mode === 'power') render();
    if (state.point) inspect(state.point);
  }, 60);
});

document.querySelectorAll('.segmented button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.segmented button').forEach((x) => {
      x.classList.toggle('active', x === b);
      x.setAttribute('aria-checked', String(x === b));
    });
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

el('zoomIn').addEventListener('click', () => map.easeTo({ zoom: Math.max(MIN_MAP_ZOOM + 0.5, map.getZoom() + 2) }));

el('computeAnyway').addEventListener('click', () => {
  state.forced = true;
  loadForView();
});

map.on('error', (e) => {
  console.error('map error', e && e.error);
  say(`Map error: ${e?.error?.message ?? 'unknown'}`);
});

map.on('click', (e) => inspect(e.lngLat));
// Terrain only needs the style (to add the overlay source), not the first
// complete basemap render that 'load' waits for; starting here fetches both
// in parallel instead of in sequence.
if (map.isStyleLoaded()) loadForView();
else map.once('style.load', () => loadForView());

let moveTimer;
map.on('moveend', () => {
  clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (!tooFarOut()) state.forced = false;
    if (tooFarOut() && !state.forced) { showZoomHint(); return; }
    const c = map.getCenter();
    const plan = fieldPlan();
    if (!state.hf || plan.zoom !== state.zoom || !contains(state.hf, c.lat, c.lng)) loadForView();
  }, 400);
});

updateSunLine();

window.__sunmap = { map, state, loadForView, render, inspect };
