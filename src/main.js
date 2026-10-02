import { loadHeightfield, pixelOf, slopeAspect, contains, elevationAt } from './terrain.js';
import { decodeImage } from './decode.js';
import { Renderer, MODES } from './renderer.js';
import { sunPosition } from './solar.js';
import { clearSky, surfaceIrradiance, integrate } from './radiation.js';
import { horizonProfile, horizonAt, skyViewFactor, directBeamFactor, maxHeight } from './horizon.js';
import { TERRAIN_SOURCE, metersPerPixel, windowTiles } from './tiles.js';

const STEP_MINUTES = 15;
// The point inspector runs on the CPU against a precomputed horizon, so it can
// afford fine steps; 5 minutes keeps a sunrise over a ridge a vertical edge.
const INSPECT_MINUTES = 5;

// Below this map zoom the terrain sample would be coarser than the landforms
// that cast the shadows, producing an overlay that looks unrelated to the
// topography. Refusing to compute is more honest than showing mush.
const MIN_MAP_ZOOM = 11.5;
const MIN_TERRAIN_ZOOM = 12;
// "Compute anyway" accepts coarse terrain so the whole view can be covered.
const FORCED_MIN_TERRAIN_ZOOM = 9;
// Fetching dominates load time, and bytes per area grow ~3.7x per zoom. The
// source is ~30 m over most of Europe, which z12 (27 m/px) already captures,
// so terrain is fetched at z12 and only at z13 (Austria and the US have 10 m
// data) when the field is small enough to be cheap. The output grid is finer
// than the terrain: shaders interpolate it, keeping shadow edges sharp.
const NATIVE_TERRAIN_ZOOM = 12;
const FINE_TERRAIN_ZOOM = 13;
const FINE_TERRAIN_MAX = 1024;
const MAX_OUTPUT_ZOOM = 14;
const MAX_FIELD = 2048;   // output px
const MIN_FIELD = 1024;   // output px
// The far field lets rays that leave the near field keep finding ridges. From
// a valley floor under 3800 m of relief, a 4.5-degree sun is blocked up to
// 48 km away; lower suns carry little energy.
const FAR_RADIUS = 50000;
const FAR_MAX_ZOOM = 9;   // ~210 m px
const FAR_MIN_SIZE = 512;
const FAR_MAX_SIZE = 1024;
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
  // Energy and sun-hours maps: the whole day, or only up to the selected time.
  untilTime: false,
  // Sky light is the roughest part of the model (isotropic sky, fixed
  // albedo), so energy and power show direct sun alone unless asked.
  sky: false,
  fieldId: 0,
  playing: false,
};

// Yields to the event loop between GPU batches. A timeout rather than
// requestAnimationFrame so the work also finishes in a background tab.
const nextTick = () => new Promise((res) => setTimeout(res, 0));
const at = (minutes) => {
  const d = new Date(state.date);
  d.setHours(0, minutes, 0, 0);
  return d;
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
const rendererOptions = { manualFiltering: new URLSearchParams(location.search).has('manualfilter') };

// Mobile browsers drop the GPU context when the app goes to the background or
// memory runs short. Without this the overlay stays blank until a reload.
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();   // asks the browser to restore the context
  state.contextLost = true;
  say('Graphics were reset, restoring…', true);
});
canvas.addEventListener('webglcontextrestored', () => {
  state.renderer = new Renderer(canvas, rendererOptions);
  state.contextLost = false;
  sum.key = null;
  if (state.hf) { useTerrain(state.hf, state.far, state.outScale); render(); }
  status.classList.remove('show');
});

try {
  state.renderer = new Renderer(canvas, rendererOptions);
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
  const mpp = (z) => metersPerPixel(lat, z);
  // MapLibre draws 512 px tiles, so a screen pixel at zoom z covers what a
  // 256 px tile pixel covers at z + 1.
  const wanted = mpp(map.getZoom() + 1) * Math.max(view.clientWidth, view.clientHeight) * SHADOW_MARGIN;

  const floor = forced ? FORCED_MIN_TERRAIN_ZOOM : MIN_TERRAIN_ZOOM;
  let outZoom = floor;
  for (let z = MAX_OUTPUT_ZOOM; z >= floor; z--) {
    if (Math.ceil(wanted / mpp(z)) <= MAX_FIELD) { outZoom = z; break; }
  }
  let zoom = Math.min(outZoom, NATIVE_TERRAIN_ZOOM);
  if (outZoom >= FINE_TERRAIN_ZOOM && Math.ceil(wanted / mpp(FINE_TERRAIN_ZOOM)) <= FINE_TERRAIN_MAX) {
    zoom = FINE_TERRAIN_ZOOM;
  }
  const outScale = 2 ** (outZoom - zoom);
  const size = Math.max(Math.ceil(MIN_FIELD / outScale), Math.ceil(wanted / mpp(zoom)));

  const farZoom = Math.max(0, Math.min(FAR_MAX_ZOOM, zoom - 3));
  const farSize = Math.min(FAR_MAX_SIZE, Math.max(FAR_MIN_SIZE, Math.ceil((2 * FAR_RADIUS) / mpp(farZoom))));
  return { zoom, size, outScale, farZoom, farSize };
}

// The far field spans ~120 km, so it survives pans of a quarter of that.
function farStillValid(far, plan, lat, lon) {
  if (!far || far.z !== plan.farZoom) return false;
  const p = pixelOf(far, lat, lon);
  const margin = (0.75 * FAR_RADIUS) / far.metresPerPixel;
  return p.x > margin && p.y > margin && p.x < far.width - margin && p.y < far.height - margin;
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
  state.loadCtrl?.abort(new DOMException('zoomed out', 'AbortError'));
  state.hf = null;
  state.token++;
  setOverlayVisible(false);
  el('zoomHint').hidden = false;
  status.classList.remove('show');
}

// The overlay must cover the whole screen, not just its centre.
function coversView(hf) {
  const b = map.getBounds();
  return [b.getNorthWest(), b.getNorthEast(), b.getSouthWest(), b.getSouthEast()]
    .every((p) => contains(hf, p.lat, p.lng));
}

// Decides what the current view needs: nothing, a finer or coarser output
// grid on the same terrain, or new terrain.
function ensureField() {
  if (!tooFarOut()) state.forced = false;
  if (tooFarOut() && !state.forced) { showZoomHint(); return; }
  const plan = fieldPlan();
  if (!state.hf || plan.zoom !== state.zoom || !coversView(state.hf)) loadForView();
  else if (plan.outScale !== state.outScale) {
    useTerrain(state.hf, state.far, plan.outScale);
    render();
  }
}

async function loadForView() {
  if (!state.renderer) return;
  if (state.busy) {
    // Moving on cancels the load in flight; the new view loads as soon as
    // it unwinds, rather than queueing behind a request that may never end.
    state.pending = true;
    state.loadCtrl?.abort(new DOMException('superseded', 'AbortError'));
    return;
  }
  if (tooFarOut() && !state.forced) { showZoomHint(); return; }
  el('zoomHint').hidden = true;
  const token = ++state.token;
  const ctrl = (state.loadCtrl = new AbortController());
  const c = map.getCenter();
  const plan = fieldPlan();
  const reuseFar = farStillValid(state.far, plan, c.lat, c.lng);
  // Each tile costs ~0.5 s of latency whatever its size, and the tile host
  // serves many requests at once, so one round of requests beats several.
  const common = { lat: c.lat, lon: c.lng, decode: decodeImage, concurrency: 24, signal: ctrl.signal };

  const total = windowTiles(c.lat, c.lng, plan.zoom, plan.size).tiles.length
    + (reuseFar ? 0 : windowTiles(c.lat, c.lng, plan.farZoom, plan.farSize).tiles.length);
  let loaded = 0;
  const onTile = () => { if (!ctrl.signal.aborted) say(`Loading terrain ${++loaded}/${total}`, true); };

  state.busy = true;
  say(`Loading terrain 0/${total}`, true);
  try {
    const [hf, far] = await Promise.all([
      loadHeightfield({ ...common, zoom: plan.zoom, size: plan.size, onTile }),
      reuseFar ? state.far : loadHeightfield({ ...common, zoom: plan.farZoom, size: plan.farSize, onTile }),
    ]);
    if (token !== state.token) return;
    useTerrain(hf, far, plan.outScale);
    state.failures = 0;
    const coarse = plan.zoom < MIN_TERRAIN_ZOOM;
    say(`${coarse ? 'Coarse terrain' : 'Terrain'} · ${hf.metresPerPixel.toFixed(0)} m/px · ${(hf.width * hf.metresPerPixel / 1000).toFixed(0)} km`);
    await render();
  } catch (err) {
    if (ctrl.signal.aborted) return;   // superseded by a newer view; it reports for itself
    console.error(err);
    state.failures = (state.failures || 0) + 1;
    if (state.failures === 1) {
      say('Terrain did not load, retrying…', true);
      setTimeout(ensureField, 1500);
    } else {
      say('Could not load terrain. Check the connection, then move the map to retry.');
    }
  } finally {
    state.busy = false;
    if (state.loadCtrl === ctrl) state.loadCtrl = null;
    if (state.pending) { state.pending = false; ensureField(); }
  }
}

function useTerrain(hf, far, outScale) {
  state.hf = hf;
  state.far = far;
  state.zoom = hf.z;
  state.outScale = outScale;
  state.highest = maxHeight(hf, far);
  state.renderer.setTerrain(hf, far, outScale);
  state.fieldId++;
  attachOverlay(hf);
  setOverlayVisible(true);
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
    const reference = cs.dni + (state.sky ? cs.dhi : 0);
    peak = Math.max(peak, reference);
    total += reference;
    hours += 1;
  }
  if (mode === 'power') return Math.max(peak, 200);
  if (mode === 'energy') return Math.max((total * STEP_MINUTES) / 60, 500);
  if (mode === 'sunHours') return Math.max((hours * STEP_MINUTES) / 60, 1);
  return 1000;
}

function daylightSteps() {
  const { lat, lon } = state.hf.centre;
  const out = [];
  for (let m = 0; m < 1440; m += STEP_MINUTES) {
    if (sunPosition(lat, lon, at(m)).elevation > 0) out.push(m);
  }
  return out;
}

const cumulative = (mode) => mode === 'energy' || mode === 'sunHours';

/**
 * The energy and sun-hours maps are a running sum over the day's timesteps,
 * always a prefix of them. Moving the cut-off only adds or subtracts the steps
 * in between, so scrubbing and playback cost the distance moved rather than
 * a whole-day recompute.
 */
const sum = { key: null, count: 0 };

let renderToken = 0;

async function render() {
  const r = state.renderer;
  if (!r || !state.hf || state.contextLost) return;
  const token = ++renderToken;
  const mode = state.mode;
  const scale = scaleFor(mode);
  const common = { mode: MODES[mode], scale, stepHours: STEP_MINUTES / 60, opacity: state.opacity, sky: state.sky };

  if (mode === 'slope') {
    r.colorize(common);
    repaint();
    updateLegend(mode, scale);
    return;
  }

  if (!cumulative(mode)) {
    sum.key = null;
    r.clearAccumulator();
    r.addTimestep(instantOf());
    r.colorize({ ...common, stepHours: 1 });
    repaint();
    updateLegend(mode, scale);
    return;
  }

  const steps = daylightSteps();
  const key = `${state.fieldId}|${toInputValue(state.date)}`;
  if (sum.key !== key) {
    r.clearAccumulator();
    sum.key = key;
    sum.count = 0;
  }
  const target = state.untilTime ? steps.filter((m) => m <= state.minutes).length : steps.length;
  const long = Math.abs(target - sum.count) > 8;
  if (long) say('Integrating the day…', true);

  let done = 0;
  while (sum.count !== target) {
    if (token !== renderToken) return;
    if (sum.count < target) {
      r.addTimestep(at(steps[sum.count]), { weight: 1 });
      sum.count++;
    } else {
      sum.count--;
      r.addTimestep(at(steps[sum.count]), { weight: -1 });
    }
    if (++done % 8 === 0) {
      r.colorize(common);
      repaint();
      await nextTick();
    }
  }
  r.colorize(common);
  repaint();
  updateLegend(mode, scale);
  if (long) status.classList.remove('show');
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
  const profile = horizonProfile(hf, p.x, p.y, { azimuths: 180, far: state.far, highest: state.highest });
  const svf = skyViewFactor(profile);

  const samples = [];
  let litMinutes = 0;
  let firstSun = null, lastSun = null;
  for (let m = 0; m < 1440; m += INSPECT_MINUTES) {
    const d = new Date(state.date);
    d.setHours(0, m, 0, 0);
    const s = sunPosition(lngLat.lat, lngLat.lng, d);
    if (s.elevation <= 0) { samples.push({ m, total: 0, direct: 0, sky: 0, lit: false }); continue; }
    const cs = clearSky(s.elevation, elevation, d);
    const beam = directBeamFactor(hf, p.x, p.y, profile, s.elevation, s.azimuth);
    const irr = surfaceIrradiance(cs, beam, svf, slope, 0.6);
    const lit = beam > 0;
    if (lit) { litMinutes += INSPECT_MINUTES; firstSun ??= m; lastSun = m; }
    samples.push({ m, total: irr.total, direct: irr.direct, sky: irr.diffuse + irr.reflected, lit });
  }

  for (const s of samples) s.shown = s.direct + (state.sky ? s.sky : 0);
  const energy = integrate(samples.map((s) => s.shown), INSPECT_MINUTES);
  const now = samples[Math.round(state.minutes / INSPECT_MINUTES) % samples.length];
  const soFar = integrate(samples.filter((s) => s.m <= state.minutes).map((s) => s.shown), INSPECT_MINUTES);

  const hhmm = (m) => m == null ? '—' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const stat = (label, value, cls = '') => `<div><dt>${label}</dt><dd class="${cls}">${value}</dd></div>`;
  el('pointTitle').textContent = `${elevation.toFixed(0)} m · ${slope.toFixed(0)}° ${compass(aspect)}`;
  el('pointStats').innerHTML = [
    stat('Now', `${now.shown.toFixed(0)} W/m²`, now.lit ? 'lit' : ''),
    stat('Energy so far', `${(soFar / 1000).toFixed(1)} kWh/m²`),
    stat('Day total', `${(energy / 1000).toFixed(1)} kWh/m²`),
    stat('Direct sun', `${(litMinutes / 60).toFixed(1)} h`),
    stat('Sun on slope', firstSun == null ? 'None' : `${hhmm(firstSun)}–${hhmm(lastSun + INSPECT_MINUTES)}`),
    stat('Sky view', `${(svf * 100).toFixed(0)}%`),
  ].join('');

  // Charts size themselves from layout, so the card must be visible first.
  el('inspector').hidden = false;
  drawCurve(samples);
  drawHorizon(profile, lngLat.lat, lngLat.lng);
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
  const max = Math.max(200, ...samples.map((s) => s.shown));
  const x = (m) => (m / 1440) * w;
  const y = (v) => bottom - (v / max) * (bottom - top);

  ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (const hr of [6, 12, 18]) {
    ctx.beginPath(); ctx.moveTo(x(hr * 60), top); ctx.lineTo(x(hr * 60), bottom); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0, bottom); ctx.lineTo(w, bottom); ctx.stroke();

  const area = (lower, upper, fill) => {
    ctx.beginPath();
    samples.forEach((s, i) => (i ? ctx.lineTo(x(s.m), y(upper(s))) : ctx.moveTo(x(s.m), y(upper(s)))));
    for (let i = samples.length - 1; i >= 0; i--) ctx.lineTo(x(samples[i].m), y(lower(samples[i])));
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  const base = (s) => (state.sky ? s.sky : 0);
  if (state.sky) area(() => 0, base, '#dfe2e7');
  area(base, (s) => s.shown, 'rgba(232,145,45,.28)');
  el('skyKey').hidden = !state.sky;

  ctx.strokeStyle = SUN; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(x(s.m), y(s.shown)) : ctx.moveTo(x(s.m), y(s.shown))));
  ctx.stroke();

  ctx.strokeStyle = INK; ctx.lineWidth = 1; ctx.beginPath();
  ctx.moveTo(x(state.minutes), top); ctx.lineTo(x(state.minutes), bottom); ctx.stroke();

  ctx.fillStyle = MUTED; ctx.textAlign = 'center';
  for (const hr of [6, 12, 18]) ctx.fillText(`${hr}:00`, x(hr * 60), h - 2);
  ctx.textAlign = 'left'; ctx.fillText(`${Math.round(max)}`, 2, top + 8);
}

function sunPath(lat, lon, day) {
  const points = [];
  for (let m = 0; m <= 1440; m += 5) {
    const d = new Date(day);
    d.setHours(0, m, 0, 0);
    const { azimuth, elevation } = sunPosition(lat, lon, d);
    points.push({ m, az: azimuth, el: elevation });
  }
  return points;
}

// Draws a path as runs that share a style, breaking below the horizon and
// where the azimuth wraps through north (the southern-hemisphere case).
// Neighbouring runs share their boundary point so the line stays continuous.
function strokeRuns(ctx, points, x, y, keyOf, applyStyle) {
  let run = [], key = null;
  const flush = () => {
    if (run.length > 1) {
      ctx.beginPath();
      run.forEach((p, i) => (i ? ctx.lineTo(x(p.az), y(p.el)) : ctx.moveTo(x(p.az), y(p.el))));
      applyStyle(key, ctx);
      ctx.stroke();
    }
    run = [];
  };
  points.forEach((p, i) => {
    const k = p.el > 0 ? keyOf(p) : null;
    if (i && Math.abs(p.az - points[i - 1].az) > 180) flush();
    else if (k !== key && run.length) { run.push(p); flush(); }
    key = k;
    if (k !== null) run.push(p);
  });
  flush();
}

// Sun elevation by bearing over one day, one value per degree. Bearing is
// single-valued over a day, so the solstice paths bound every position the
// sun takes during the year.
const yearBandCache = new Map();
function elevationByBearing(lat, lon, day) {
  const bins = new Float32Array(361).fill(NaN);
  for (let m = 0; m <= 1440; m++) {
    const d = new Date(day);
    d.setHours(0, m, 0, 0);
    const { azimuth, elevation } = sunPosition(lat, lon, d);
    const b = Math.round(azimuth) % 361;
    if (!(bins[b] >= elevation)) bins[b] = elevation;
  }
  for (let b = 0; b <= 360; b++) {
    if (!Number.isNaN(bins[b])) continue;
    let l = b - 1; while (l >= 0 && Number.isNaN(bins[l])) l--;
    let r = b + 1; while (r <= 360 && Number.isNaN(bins[r])) r++;
    if (l >= 0 && r <= 360) bins[b] = bins[l] + ((bins[r] - bins[l]) * (b - l)) / (r - l);
  }
  return bins;
}

function yearBand(lat, lon, year) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)},${year}`;
  if (!yearBandCache.has(key)) {
    const june = elevationByBearing(lat, lon, new Date(year, 5, 21));
    const dec = elevationByBearing(lat, lon, new Date(year, 11, 21));
    const hi = new Float32Array(361), lo = new Float32Array(361);
    for (let b = 0; b <= 360; b++) { hi[b] = Math.max(june[b], dec[b]); lo[b] = Math.min(june[b], dec[b]); }
    if (yearBandCache.size > 50) yearBandCache.clear();
    yearBandCache.set(key, { hi, lo });
  }
  return yearBandCache.get(key);
}

function drawHorizon(profile, lat, lon) {
  const { ctx, w, h } = surface(el('horizonPlot'));
  const top = 16, bottom = h - 14, left = 18;
  const year = state.date.getFullYear();
  const solstices = [
    { label: '21 Jun', path: sunPath(lat, lon, new Date(year, 5, 21)) },
    { label: '21 Dec', path: sunPath(lat, lon, new Date(year, 11, 21)) },
  ];
  const today = sunPath(lat, lon, state.date);

  const peak = Math.max(30, ...profile, ...solstices.flatMap((s) => s.path.map((p) => p.el)));
  const max = Math.ceil(peak / 10) * 10;
  const x = (az) => left + (az / 360) * (w - left);
  const y = (el) => bottom - (Math.max(0, el) / max) * (bottom - top);

  ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.fillStyle = MUTED; ctx.textAlign = 'left';
  for (let g = 30; g < max; g += 30) {
    ctx.beginPath(); ctx.moveTo(left, y(g)); ctx.lineTo(w, y(g)); ctx.stroke();
    ctx.fillText(`${g}°`, 0, y(g) + 3);
  }
  ctx.beginPath(); ctx.moveTo(left, bottom); ctx.lineTo(w, bottom); ctx.stroke();

  // The sun's range over the year: everything between the two solstice paths.
  const band = yearBand(lat, lon, year);
  ctx.fillStyle = 'rgba(232,145,45,.16)';
  for (let b = 0; b <= 360; ) {
    if (!(band.hi[b] > 0)) { b++; continue; }
    const start = b;
    while (b <= 360 && band.hi[b] > 0) b++;
    ctx.beginPath();
    for (let i = start; i < b; i++) ctx.lineTo(x(i), y(band.hi[i]));
    for (let i = b - 1; i >= start; i--) ctx.lineTo(x(i), y(Math.max(0, band.lo[i])));
    ctx.closePath();
    ctx.fill();
  }

  for (const s of solstices) {
    strokeRuns(ctx, s.path, x, y, () => 'solstice', (_, c) => {
      c.strokeStyle = 'rgba(214,128,36,.55)'; c.lineWidth = 1; c.setLineDash([3, 3]);
    });
  }
  ctx.setLineDash([]);

  const lit = (p) => p.el > horizonAt(profile, p.az);
  strokeRuns(ctx, today, x, y, (p) => (lit(p) ? 'lit' : 'blocked'), (k, c) => {
    c.strokeStyle = k === 'lit' ? SUN : '#9aa0a8';
    c.lineWidth = k === 'lit' ? 2 : 1.25;
  });

  // Terrain drawn over the paths, slightly translucent: the sun visibly passes
  // behind the ridge, and the hidden stretch still shows through faintly.
  ctx.beginPath(); ctx.moveTo(x(0), bottom);
  profile.forEach((v, i) => ctx.lineTo(x((i / profile.length) * 360), y(v)));
  ctx.lineTo(x(360), y(profile[0])); ctx.lineTo(x(360), bottom); ctx.closePath();
  ctx.fillStyle = 'rgba(214,218,224,.88)'; ctx.fill();
  ctx.strokeStyle = '#b4b9c0'; ctx.lineWidth = 1; ctx.stroke();

  ctx.fillStyle = MUTED; ctx.textAlign = 'center';
  // Today's path always lies between the two solstices, so labelling the
  // higher one above its arc and the lower one below keeps the labels clear.
  const peaks = solstices
    .map((s) => ({ ...s, peak: s.path.reduce((a, b) => (b.el > a.el ? b : a)) }))
    .sort((a, b) => b.peak.el - a.peak.el);
  peaks.forEach(({ label, peak }, i) => {
    if (peak.el <= horizonAt(profile, peak.az)) return; // hidden behind terrain
    const lx = Math.min(w - 20, Math.max(left + 20, x(peak.az)));
    ctx.fillText(label, lx, i === 0 ? y(peak.el) - 5 : y(peak.el) + 12);
  });

  for (const p of today) {
    if (p.m % 60 || p.m >= 1440 || p.el <= 0 || !lit(p)) continue;
    ctx.fillStyle = SUN;
    ctx.beginPath(); ctx.arc(x(p.az), y(p.el), 1.8, 0, 7); ctx.fill();
    if ((p.m / 60) % 3 === 0) { ctx.fillStyle = INK; ctx.fillText(String(p.m / 60), x(p.az), y(p.el) + 11); }
  }

  const sun = sunPosition(lat, lon, instantOf());
  if (sun.elevation > 0) {
    const visible = sun.elevation > horizonAt(profile, sun.azimuth);
    ctx.beginPath(); ctx.arc(x(sun.azimuth), y(sun.elevation), 4, 0, 7);
    ctx.fillStyle = visible ? SUN : '#fff'; ctx.fill();
    ctx.strokeStyle = visible ? '#fff' : '#8b9098'; ctx.lineWidth = 1.5; ctx.stroke();
  }

  ctx.fillStyle = MUTED;
  ['N', 'E', 'S', 'W', 'N'].forEach((d, i) => {
    ctx.textAlign = i === 0 ? 'left' : i === 4 ? 'right' : 'center';
    ctx.fillText(d, x(i * 90), h - 2);
  });
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
  updateDescriptions();
  render();
  if (state.point) inspect(state.point);
});

const MODE_NAMES = { binary: 'Shade', power: 'Power', energy: 'Energy', sunHours: 'Sun hours', slope: 'Slope' };
const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function sunUpWindow() {
  const c = state.hf ? state.hf.centre : { lat: map.getCenter().lat, lon: map.getCenter().lng };
  let rise = null, set = null;
  for (let m = 0; m < 1440; m++) {
    if (sunPosition(c.lat, c.lon, at(m)).elevation > 0) { rise ??= m; set = m; }
  }
  return { rise, set };
}

// One plain sentence for what the map shows, so the role of the time slider
// never has to be guessed.
function describe() {
  const t = 'the time set on the slider';
  const light = state.sky ? 'direct sun plus sky light' : 'direct sun only';
  switch (state.mode) {
    case 'binary': return `Where direct sun reaches the ground at ${t}.`;
    case 'power': return `Solar power on the ground at ${t}, ${light}.`;
    case 'energy': return state.untilTime
      ? `Solar energy received from sunrise to ${t}, ${light}.`
      : `Solar energy received over the whole day, ${light}.`;
    case 'sunHours': return state.untilTime
      ? `Hours of direct sun from sunrise to ${t}.`
      : 'Hours of direct sun over the whole day.';
    default: return 'Steepness of the terrain.';
  }
}

const timeless = () => state.mode === 'slope' || (cumulative(state.mode) && !state.untilTime);

function updateDescriptions() {
  el('describe').textContent = describe();
  const period = cumulative(state.mode) ? (state.untilTime ? ' · since sunrise' : ' · whole day') : '';
  el('controlsSummary').textContent = MODE_NAMES[state.mode] + period;
  if (timeless()) {
    if (state.mode === 'slope') {
      el('timeNote').textContent = 'Slope does not depend on the time of day.';
    } else {
      const { rise, set } = sunUpWindow();
      el('timeNote').textContent = rise == null
        ? 'Whole day · the sun stays below the horizon.'
        : `Whole day · sun up ${clock(rise)} to ${clock(set + 1)}. Pick "Since sunrise" to choose a time.`;
    }
  }
}

const timeInput = el('time');
const setTime = (v) => {
  state.minutes = +v;
  timeInput.value = state.minutes;
  el('timeLabel').textContent = clock(state.minutes);
  updateSunLine();
};
setTime(state.minutes);

el('now').addEventListener('click', () => {
  const now = new Date();
  state.date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  el('date').value = toInputValue(state.date);
  setTime(now.getHours() * 60 + now.getMinutes());
  updateDescriptions();
  render();
  if (state.point) inspect(state.point);
});

let timeTimer;
timeInput.addEventListener('input', (e) => {
  stopPlaying();
  setTime(e.target.value);
  clearTimeout(timeTimer);
  timeTimer = setTimeout(() => {
    render();
    if (state.point) inspect(state.point);
  }, 40);
});

function selectIn(group, button) {
  group.querySelectorAll('button').forEach((x) => {
    x.classList.toggle('active', x === button);
    x.setAttribute('aria-checked', String(x === button));
  });
}

// The slider only exists when the map depends on the time of day; otherwise
// the time bar says why instead of showing a control that does nothing.
function syncTimeControls() {
  const cum = cumulative(state.mode);
  el('scope').hidden = !cum;
  el('skyRow').hidden = !(state.mode === 'power' || state.mode === 'energy');
  el('timeLive').hidden = timeless();
  el('timeNote').hidden = !timeless();
  if (timeless()) stopPlaying();
  updateDescriptions();
}

el('layers').querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => {
    selectIn(el('layers'), b);
    state.mode = b.dataset.mode;
    syncTimeControls();
    render();
  })
);

el('scope').querySelectorAll('button').forEach((b) =>
  b.addEventListener('click', () => {
    selectIn(el('scope'), b);
    state.untilTime = b.dataset.scope === 'until';
    syncTimeControls();
    render();
  })
);

// ------------------------------------------------------------------ play

const PLAY_ICON = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M4 2.5v9l7.5-4.5z" fill="currentColor"/></svg>';
const PAUSE_ICON = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3.5 2.5h2.5v9H3.5zM8 2.5h2.5v9H8z" fill="currentColor"/></svg>';
const PLAY_STEP_MINUTES = 5;

function stopPlaying() {
  state.playing = false;
  el('play').innerHTML = PLAY_ICON;
  el('play').setAttribute('aria-label', 'Play through the day');
}

async function play() {
  if (!state.hf) return;
  const steps = daylightSteps();
  if (!steps.length) return;
  const sunrise = steps[0] - STEP_MINUTES;
  const sunset = steps[steps.length - 1] + STEP_MINUTES;
  if (state.minutes < sunrise || state.minutes >= sunset) setTime(sunrise);

  state.playing = true;
  el('play').innerHTML = PAUSE_ICON;
  el('play').setAttribute('aria-label', 'Pause');
  while (state.playing && state.minutes < sunset) {
    setTime(Math.min(sunset, state.minutes + PLAY_STEP_MINUTES));
    await render();
    if (state.point) inspect(state.point);
    await nextTick();
  }
  stopPlaying();
}

el('play').innerHTML = PLAY_ICON;
el('play').addEventListener('click', () => (state.playing ? stopPlaying() : play()));

// Always starts off: the default view is the direct beam alone.
try { localStorage.removeItem('sunmap.sky'); } catch {}
el('sky').checked = state.sky;
el('sky').addEventListener('change', (e) => {
  state.sky = e.target.checked;
  updateDescriptions();
  render();
  if (state.point) inspect(state.point);
});

el('opacity').addEventListener('input', (e) => {
  state.opacity = e.target.value / 100;
  render();
});

// Cards collapse to their header, which matters on a phone where they would
// otherwise cover most of the map. The choice is remembered per browser.
function collapsible(card, head, key, collapsedByDefault, onOpen) {
  let collapsed = collapsedByDefault;
  try { const v = localStorage.getItem(key); if (v) collapsed = v === 'collapsed'; } catch {}
  const apply = () => {
    card.classList.toggle('collapsed', collapsed);
    head.setAttribute('aria-expanded', String(!collapsed));
  };
  head.addEventListener('click', () => {
    collapsed = !collapsed;
    apply();
    try { localStorage.setItem(key, collapsed ? 'collapsed' : 'open'); } catch {}
    if (!collapsed) onOpen?.();
  });
  apply();
}

const onPhone = matchMedia('(max-width: 720px)').matches;
collapsible(el('controls'), el('controlsHead'), 'sunmap.controls', onPhone);
// Charts size themselves from layout, so they are redrawn when reopened.
collapsible(el('inspector'), el('inspectorHead'), 'sunmap.inspector', false, () => state.point && inspect(state.point));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('inspector').hidden) el('closeInspector').click();
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
  state.failures = 0;   // every deliberate move earns a fresh automatic retry
  clearTimeout(moveTimer);
  moveTimer = setTimeout(ensureField, 400);
});

updateSunLine();

syncTimeControls();

window.__sunmap = { map, state, loadForView, render, inspect, play, stopPlaying, sum };
