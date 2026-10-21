/* SCIMAP dashboard — shared state, decoding and sampling.
 *
 * This page is opened from disk with file://, which rules out fetch(), ES
 * modules and Web Workers. Everything therefore arrives through classic
 * <script> tags as globals (window.SCIMAP_*), and all decoding happens on the
 * main thread behind the loading overlay.
 *
 * One more rule matters more than it looks: pixel arrays are decoded here once
 * and shared. The 2D probe, the 3D drape and the charts all read the same
 * Uint8Array, so they can never disagree about what a place is worth.
 */
(function (global) {
  'use strict';

  var SCHEMA = 1;

  // ── binary decoding ─────────────────────────────────────────────────────

  function base64Bytes(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  var BYTES_PER = {u8: 1, i16: 2, u16: 2, f32: 4};

  function inflateRaw(bytes, expectedLength) {
    // tiny-inflate needs the output buffer up front. DecompressionStream would
    // be neater but it is async, and every caller here is synchronous.
    return global.tinyInflate(bytes, new Uint8Array(expectedLength));
  }

  function typedView(bytes, dtype) {
    var buffer = bytes.buffer, offset = bytes.byteOffset, length = bytes.byteLength;
    if (dtype === 'u8') return bytes;
    if (dtype === 'i16') return new Int16Array(buffer, offset, length / 2);
    if (dtype === 'u16') return new Uint16Array(buffer, offset, length / 2);
    if (dtype === 'f32') return new Float32Array(buffer, offset, length / 4);
    throw new Error('Unknown payload dtype: ' + dtype);
  }

  /** Decode a {enc,dtype,w,h,data} payload into a typed array. */
  function decode(payload) {
    if (!payload) return null;
    if (payload.__decoded) return payload.__decoded;

    var raw = base64Bytes(payload.data);
    var count = (payload.w || 0) * (payload.h || 0);
    var bytes = payload.enc === 'deflate-raw-b64'
      ? inflateRaw(raw, count * (BYTES_PER[payload.dtype] || 1))
      : raw;

    var view = typedView(bytes, payload.dtype);
    try { Object.defineProperty(payload, '__decoded', {value: view, enumerable: false}); }
    catch (e) { payload.__decoded = view; }
    return view;
  }

  // ── colour ramps ────────────────────────────────────────────────────────

  var rampCache = {};

  /** A ramp's 256x3 RGB table as a flat Uint8Array(768). */
  function rampLut(name) {
    var key = String(name || 'viridis').toLowerCase();
    if (rampCache[key]) return rampCache[key];
    var source = (global.SCIMAP_RAMPS || {})[key] || (global.SCIMAP_RAMPS || {}).viridis;
    // Plain base64, not deflated: 768 bytes does not compress usefully.
    var lut = source ? base64Bytes(source) : new Uint8Array(768);
    rampCache[key] = lut;
    return lut;
  }

  function rampColour(name, fraction) {
    var lut = rampLut(name);
    var index = Math.max(0, Math.min(255, Math.round(fraction * 255))) * 3;
    return 'rgb(' + lut[index] + ',' + lut[index + 1] + ',' + lut[index + 2] + ')';
  }

  function rampCss(name, stops) {
    var parts = [], count = stops || 12;
    for (var i = 0; i < count; i++) {
      parts.push(rampColour(name, i / (count - 1)));
    }
    return 'linear-gradient(to right,' + parts.join(',') + ')';
  }

  // ── the grid: index <-> position ────────────────────────────────────────

  var NODATA_U8 = 255, QUANT_MAX = 254, EARTH_RADIUS = 6378137.0;

  function lngToMercatorX(lng) { return lng * EARTH_RADIUS * Math.PI / 180; }
  function latToMercatorY(lat) {
    var clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI / 360)));
  }

  /** Grid column/row for a lat/lng, or null when outside the grid. */
  function gridIndex(lat, lng) {
    var grid = global.SCIMAP_GRID;
    var bounds = grid.bounds3857;
    var x = lngToMercatorX(lng), y = latToMercatorY(lat);
    var column = Math.floor((x - bounds[0]) / grid.pixelSize3857[0]);
    var row = Math.floor((bounds[3] - y) / grid.pixelSize3857[1]);
    if (column < 0 || row < 0 || column >= grid.width || row >= grid.height) return null;
    return row * grid.width + column;
  }

  /** Dequantise one layer's stored code back to a real value. */
  function valueFromCode(layer, code) {
    if (code === NODATA_U8) return null;
    return layer.vmin + (code / QUANT_MAX) * (layer.vmax - layer.vmin);
  }

  /** The value of *layerKey* at a lat/lng, or null if there is no data there. */
  function sample(layerKey, lat, lng) {
    var layer = layerByKey(layerKey);
    var payload = (global.SCIMAP_PAYLOAD || {})[layerKey];
    if (!layer || !payload) return null;
    var index = gridIndex(lat, lng);
    if (index === null) return null;
    return valueFromCode(layer, decode(payload)[index]);
  }

  /** Elevation in metres at a lat/lng, or null. */
  function sampleElevation(lat, lng) {
    var dem = global.SCIMAP_GRID && global.SCIMAP_GRID.dem;
    if (!dem) return null;
    var index = gridIndex(lat, lng);
    if (index === null) return null;
    var code = decode(dem)[index];
    return code === dem.nodata ? null : code * dem.scale + dem.offset;
  }

  /** Elevation at a grid cell, or NaN where the DEM has no data. */
  function elevationAt(index) {
    var dem = global.SCIMAP_GRID.dem;
    var code = decode(dem)[index];
    return code === dem.nodata ? NaN : code * dem.scale + dem.offset;
  }

  // ── derived rasters ─────────────────────────────────────────────────────

  var hillshadeCache = {};

  /** Lambertian hillshade of the DEM, as a Uint8Array of grid size.
   *
   * Computed here rather than shipped so the sun can be moved interactively.
   * The horizontal step is corrected by mercatorScale: EPSG:3857 metres are
   * inflated by 1/cos(latitude), and shading the raw grid would flatten the
   * relief by that factor (about 0.59x at 54degN).
   */
  function hillshade(azimuth, altitude) {
    var key = azimuth + ':' + altitude;
    if (hillshadeCache[key]) return hillshadeCache[key];

    var grid = global.SCIMAP_GRID;
    var width = grid.width, height = grid.height;
    var elevation = decode(grid.dem), nodata = grid.dem.nodata;
    var scale = grid.dem.scale;
    var stepX = grid.pixelSize3857[0] * grid.mercatorScale;
    var stepY = grid.pixelSize3857[1] * grid.mercatorScale;

    var azimuthRad = (360.0 - azimuth + 90.0) * Math.PI / 180.0;
    var zenithRad = (90.0 - altitude) * Math.PI / 180.0;
    var sinZenith = Math.sin(zenithRad), cosZenith = Math.cos(zenithRad);

    var out = new Uint8Array(width * height);
    for (var row = 0; row < height; row++) {
      var up = Math.max(row - 1, 0) * width;
      var here = row * width;
      var down = Math.min(row + 1, height - 1) * width;
      for (var column = 0; column < width; column++) {
        var index = here + column;
        if (elevation[index] === nodata) { out[index] = 0; continue; }
        var left = Math.max(column - 1, 0), right = Math.min(column + 1, width - 1);

        // Horn's 3x3 gradient, in metres of elevation per metre of ground.
        var dzdx = ((elevation[up + right] + 2 * elevation[here + right] + elevation[down + right])
                  - (elevation[up + left] + 2 * elevation[here + left] + elevation[down + left]))
                  * scale / (8 * stepX);
        var dzdy = ((elevation[down + left] + 2 * elevation[down + column] + elevation[down + right])
                  - (elevation[up + left] + 2 * elevation[up + column] + elevation[up + right]))
                  * scale / (8 * stepY);

        var slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
        var aspect = Math.atan2(dzdy, -dzdx);
        var shade = cosZenith * Math.cos(slope)
                  + sinZenith * Math.sin(slope) * Math.cos(azimuthRad - aspect);
        out[index] = Math.max(0, Math.min(255, Math.round(shade * 255)));
      }
    }

    hillshadeCache = {};              // one at a time; these are megabytes
    hillshadeCache[key] = out;
    return out;
  }

  /** Colour a layer's codes into RGBA, optionally multiplied by a hillshade. */
  function colourise(codes, rampName, options) {
    options = options || {};
    var lut = rampLut(rampName);
    var shade = options.shade || null;
    var shadeStrength = options.shadeStrength === undefined ? 0.65 : options.shadeStrength;
    var alpha = options.alpha === undefined ? 255 : options.alpha;

    var rgba = new Uint8Array(codes.length * 4);
    for (var i = 0; i < codes.length; i++) {
      var code = codes[i], out = i * 4;
      if (code === NODATA_U8) continue;                 // leaves alpha at 0
      var slot = code * 3;
      var light = shade ? (1 - shadeStrength) + shadeStrength * (shade[i] / 255) : 1;
      rgba[out] = lut[slot] * light;
      rgba[out + 1] = lut[slot + 1] * light;
      rgba[out + 2] = lut[slot + 2] * light;
      rgba[out + 3] = alpha;
    }
    return rgba;
  }

  // ── descriptors ─────────────────────────────────────────────────────────

  function layers() { return global.SCIMAP_LAYERS || []; }

  function layerByKey(key) {
    var all = layers();
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
  }

  function rasterLayers() {
    return layers().filter(function (layer) { return layer.kind === 'raster'; });
  }

  // ── state + events ──────────────────────────────────────────────────────

  var listeners = {};

  function on(event, handler) {
    (listeners[event] = listeners[event] || []).push(handler);
    return function () { off(event, handler); };
  }

  function off(event, handler) {
    var list = listeners[event];
    if (!list) return;
    var at = list.indexOf(handler);
    if (at >= 0) list.splice(at, 1);
  }

  function emit(event, detail) {
    (listeners[event] || []).slice().forEach(function (handler) {
      try { handler(detail); }
      catch (error) { console.error('SCIMAP listener failed for ' + event, error); }
    });
  }

  // One set of switches for both views: the 2D map and the 3D terrain each
  // draw the ticked layers and features, so they always show the same thing.
  var state = {
    visible: {},          // layer key -> boolean
    opacity: {},          // layer key -> 0..1
    vectors: {streams: true, catchment: true, points: false, pourPoint: true,
              priorityAreas: true},
    ramp: {},             // layer key -> ramp override (3D + legend only)
    sun: {azimuth: 315, altitude: 45},
    exaggeration: 1.5,
    flow: true,
    spin: false,          // 3D camera orbiting on its own
    pixelated: false
  };

  function setState(patch, reason) {
    Object.keys(patch).forEach(function (key) { state[key] = patch[key]; });
    emit('state', {state: state, reason: reason || null, changed: Object.keys(patch)});
  }

  function setLayerVisible(key, visible) {
    state.visible[key] = !!visible;
    emit('layer-visibility', {key: key, visible: !!visible});
    emit('state', {state: state, reason: 'visibility', changed: ['visible']});
  }

  function setLayerOpacity(key, opacity) {
    state.opacity[key] = opacity;
    emit('layer-opacity', {key: key, opacity: opacity});
  }

  function setVectorVisible(name, visible) {
    state.vectors[name] = !!visible;
    emit('vector-visibility', {name: name, visible: !!visible});
  }

  /** Visible raster layers, bottom of the stack first.
   *
   * The rail's order is the drawing order, top of the list uppermost as in
   * QGIS's Layers panel, so a sparse layer such as in-channel risk stays
   * visible over a full-coverage one beneath it. The 2D map, the 3D drape and
   * the saved map image all compose in this order.
   */
  function drawOrder() {
    return rasterLayers().filter(function (layer) {
      return state.visible[layer.key];
    }).reverse();
  }

  function rampFor(key) {
    var layer = layerByKey(key);
    return state.ramp[key] || (layer && layer.ramp) || 'viridis';
  }

  /* What makes each critical source area critical (see core/csa.py), and its
   * colour wherever an area is drawn: map and 3D outlines, the printed map and
   * the table. Three slots of a categorical palette checked for colour-blind
   * separation; the table's own swatches take theme-stepped versions from
   * app.css, and every use also says the driver in words. */
  var DRIVERS = {
    connectivity: {label: 'Connectivity', colour: '#2a78d6'},
    erosion: {label: 'Erosion', colour: '#eb6834'},
    both: {label: 'Both', colour: '#1baf7a'}
  };

  function driverOf(name) { return DRIVERS[name] || DRIVERS.both; }

  // ── formatting helpers shared by every view ─────────────────────────────

  function formatValue(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return '—';
    var magnitude = Math.abs(value);
    if (magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e6)) return value.toExponential(2);
    return value.toFixed(digits === undefined ? 3 : digits);
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '—';
    var units = ['B', 'KB', 'MB', 'GB'], at = 0, size = bytes;
    while (size >= 1024 && at < units.length - 1) { size /= 1024; at++; }
    return (at === 0 ? size : size.toFixed(1)) + ' ' + units[at];
  }

  function formatLatLng(lat, lng) {
    return Math.abs(lat).toFixed(5) + (lat >= 0 ? 'N' : 'S') + ', ' +
           Math.abs(lng).toFixed(5) + (lng >= 0 ? 'E' : 'W');
  }

  global.SCIMAP = {
    SCHEMA: SCHEMA, NODATA_U8: NODATA_U8, QUANT_MAX: QUANT_MAX,
    decode: decode, base64Bytes: base64Bytes,
    rampLut: rampLut, rampColour: rampColour, rampCss: rampCss, rampFor: rampFor,
    gridIndex: gridIndex, sample: sample, sampleElevation: sampleElevation,
    elevationAt: elevationAt, valueFromCode: valueFromCode,
    hillshade: hillshade, colourise: colourise,
    layers: layers, rasterLayers: rasterLayers, layerByKey: layerByKey,
    on: on, off: off, emit: emit,
    state: state, setState: setState,
    setLayerVisible: setLayerVisible, setLayerOpacity: setLayerOpacity,
    setVectorVisible: setVectorVisible, drawOrder: drawOrder,
    DRIVERS: DRIVERS, driverOf: driverOf,
    formatValue: formatValue, formatBytes: formatBytes, formatLatLng: formatLatLng
  };
})(window);
