/* SCIMAP dashboard — the 2D map.
 *
 * Leaflet draws tiles as ordinary <img> elements, which is why a real XYZ
 * pyramid works here even though the page is on file:// and WebGL cannot touch
 * a local image. Tiles stop at the source's own resolution; maxNativeZoom lets
 * Leaflet stretch them further rather than us storing an upscale.
 */
(function (global) {
  'use strict';

  var TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  var map = null;
  var tileLayers = {};
  var vectorLayers = {};
  //: each critical source area's outline, by rank, for the table to find
  var areaShapes = {};
  var probeHandler = null;

  function bounds() {
    var b = global.SCIMAP_GRID.boundsWgs84;
    return L.latLngBounds(L.latLng(b[0][0], b[0][1]), L.latLng(b[1][0], b[1][1]));
  }

  function create(elementId) {
    map = L.map(elementId, {
      // On, because the OpenStreetMap and Esri base layers are only licensed
      // with their attribution shown. Leaflet's own "Leaflet" prefix is not.
      attributionControl: true,
      zoomControl: false,
      preferCanvas: true,        // thousands of reaches draw far faster on canvas
      maxZoom: 22
    });
    map.attributionControl.setPrefix('');
    map.fitBounds(bounds(), {padding: [24, 24]});
    L.control.zoom({position: 'topright'}).addTo(map);
    L.control.scale({position: 'bottomleft', imperial: false}).addTo(map);

    addBaseLayers();
    global.SCIMAP.rasterLayers().forEach(addRasterLayer);
    addVectors();
    wireProbe();
    wireState();
    return map;
  }

  // ── base layers ─────────────────────────────────────────────────────────

  var ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  var ESRI_ATTR = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a>';
  // World Street Map is compiled from OpenStreetMap among other sources, so it
  // carries the fuller credit Esri publishes as the service's copyrightText.
  var ESRI_STREET_ATTR = ESRI_ATTR + ', HERE, Garmin, USGS, NGCC, &copy; ' +
    '<a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  /** One Esri ArcGIS Online raster tile service. Note {z}/{y}/{x} — Esri's
   *  MapServer path puts row before column, the reverse of the usual XYZ. */
  function esri(service, zIndex, attribution) {
    return L.tileLayer(ESRI + service + '/MapServer/tile/{z}/{y}/{x}', {
      minZoom: 0, maxZoom: 22, maxNativeZoom: 19,
      attribution: attribution || ESRI_ATTR, zIndex: zIndex
    });
  }

  function addBaseLayers() {
    // The hillshade is generated from the run's own DEM and shipped as tiles,
    // so the map is readable with no internet at all. It stays the default.
    var hillshade = L.tileLayer('tiles/hillshade/{z}/{x}/{y}.png', {
      minZoom: 0, maxZoom: 22,
      maxNativeZoom: (global.SCIMAP_META.tiles || {}).hillshadeMaxZoom || 16,
      errorTileUrl: TRANSPARENT, bounds: bounds(), zIndex: 1,
      attribution: 'Relief from the run\'s own DEM'
    });
    hillshade.addTo(map);
    tileLayers.hillshade = hillshade;

    if (!global.SCIMAP_META.onlineBasemaps) return;

    // Optional context for people with a connection. These are mutually
    // exclusive *base* layers rather than overlays: as overlays underneath the
    // hillshade they were hidden wherever the catchment has data, which is
    // everywhere anyone is looking. The result rasters sit above at zIndex 10
    // either way, so switching base map never hides a result.
    //
    // World Street Map is one service with its labels baked in; the Esri
    // canvases publish theirs as a separate reference service, hence the
    // layer groups. Leaflet adds each group member to the map individually,
    // so their attributions register and de-register on their own.
    var bases = {
      'Shaded relief (offline)': hillshade,
      'Esri Street Map': esri('World_Street_Map', 1, ESRI_STREET_ATTR),
      'Esri Dark Gray': L.layerGroup([
        esri('Canvas/World_Dark_Gray_Base', 1),
        esri('Canvas/World_Dark_Gray_Reference', 2)
      ]),
      'Esri Satellite': L.layerGroup([
        esri('World_Imagery', 1),
        esri('Reference/World_Boundaries_and_Places', 2)
      ])
    };
    L.control.layers(bases, null, {position: 'topright', collapsed: true}).addTo(map);
  }

  // ── result layers ───────────────────────────────────────────────────────

  function addRasterLayer(layer, index, all) {
    var tiles = L.tileLayer(layer.tiles, {
      minZoom: 0, maxZoom: 22,
      minNativeZoom: layer.minzoom,
      maxNativeZoom: layer.maxzoom,
      errorTileUrl: TRANSPARENT,
      bounds: bounds(),
      // Visibility is add/remove from the map, never opacity: a hidden layer
      // created at opacity 0 stays invisible when toggled on, because
      // setVisible() only adds it back and the opacity slider still reads 100%.
      opacity: 1,
      // Fixed by the rail's order, top of the list uppermost (see
      // SCIMAP.drawOrder). With one shared zIndex Leaflet stacks by when a
      // layer was last added, so ticking one again would lift it over the rest
      // and the map would stop matching the 3D drape.
      zIndex: 10 + (all.length - index),
      className: 'scimap-raster-tile'
    });
    tileLayers[layer.key] = tiles;

    global.SCIMAP.state.visible[layer.key] = !!layer.defaultVisible;
    global.SCIMAP.state.opacity[layer.key] = 1;
    if (layer.defaultVisible) tiles.addTo(map);
  }

  function setVisible(key, visible) {
    var tiles = tileLayers[key];
    if (!tiles) return;
    if (visible && !map.hasLayer(tiles)) tiles.addTo(map);
    else if (!visible && map.hasLayer(tiles)) map.removeLayer(tiles);
  }

  function setOpacity(key, opacity) {
    if (tileLayers[key]) tileLayers[key].setOpacity(opacity);
  }

  // ── vectors ─────────────────────────────────────────────────────────────

  function addVectors() {
    var data = global.SCIMAP_VECTORS || {};

    if (data.catchment) {
      vectorLayers.catchment = L.geoJSON(data.catchment, {
        style: {color: '#f4f1ea', weight: 2, opacity: 0.9, fill: false,
                dashArray: '6 4', interactive: false}
      });
    }

    if (data.streams) {
      var range = data.streams.riskRange || [0, 1];
      vectorLayers.streams = L.geoJSON(data.streams, {
        style: function (feature) { return streamStyle(feature, range); },
        onEachFeature: bindReach
      });
    }

    if (data.points && data.points.features && data.points.features.length) {
      vectorLayers.points = L.geoJSON(data.points, {
        pointToLayer: function (feature, latlng) {
          return L.circleMarker(latlng, {
            radius: 3, weight: 0, fillOpacity: 0.85,
            fillColor: global.SCIMAP.rampColour('plasma', feature.properties.riskNorm || 0)
          });
        }
      });
    }

    if (data.pourPoint) {
      vectorLayers.pourPoint = L.geoJSON(data.pourPoint, {
        pointToLayer: function (feature, latlng) {
          return L.circleMarker(latlng, {radius: 6, weight: 2, color: '#fff',
                                         fillColor: '#2a78d6', fillOpacity: 1});
        }
      });
    }

    if (data.priorityAreas && (data.priorityAreas.features || []).length) {
      vectorLayers.priorityAreas = priorityAreaLayer(data.priorityAreas);
    }

    // Shown as the shared switches say; stream risk points start off, being
    // tens of thousands of markers.
    Object.keys(vectorLayers).forEach(function (name) {
      showVector(name, global.SCIMAP.state.vectors[name]);
    });
  }

  /** The critical source areas: each outlined in its driver's colour over a
   * dark casing, so it reads on any layer or basemap, and numbered as in the
   * Analysis table. */
  function priorityAreaLayer(collection) {
    var group = L.featureGroup();
    L.geoJSON(collection, {
      style: {color: '#0b1016', weight: 5.5, opacity: 0.55, fill: false,
              interactive: false}
    }).addTo(group);
    L.geoJSON(collection, {
      style: areaStyle,
      onEachFeature: function (feature, layer) {
        areaShapes[feature.properties.rank] = layer;
        layer.bindTooltip(describeArea(feature.properties), {sticky: true});
      }
    }).addTo(group);

    collection.features.forEach(function (feature) {
      var props = feature.properties;
      if (props.labelLat === null || props.labelLat === undefined) return;
      L.marker([props.labelLat, props.labelLon], {
        icon: L.divIcon({
          className: 'area-label',
          html: '<span style="background:' + global.SCIMAP.driverOf(props.driver).colour +
                '">' + props.rank + '</span>',
          iconSize: [22, 22], iconAnchor: [11, 11]
        }),
        interactive: false, keyboard: false
      }).addTo(group);
    });
    return group;
  }

  function areaStyle(feature) {
    var colour = global.SCIMAP.driverOf(feature.properties.driver).colour;
    return {color: colour, weight: 2.4, opacity: 1, fillColor: colour, fillOpacity: 0.16};
  }

  function describeArea(props) {
    var size = props.areaHa !== null && props.areaHa !== undefined
      ? props.areaHa.toFixed(1) + ' ha' : '';
    return 'Area ' + props.rank + (size ? ' \u00b7 ' + size : '') +
      ' \u00b7 driven by ' + global.SCIMAP.driverOf(props.driver).label.toLowerCase() +
      '<br>Connectivity ' + global.SCIMAP.formatValue(props.connectivity, 2) +
      ', erosion ' + global.SCIMAP.formatValue(props.erosion, 2);
  }

  /** Fly to a critical source area and flash its outline. */
  function zoomToArea(area) {
    var shape = areaShapes[area.rank];
    var box = area.bounds
      ? L.latLngBounds(area.bounds[0], area.bounds[1])
      : shape && shape.getBounds();
    if (!box) return;
    map.fitBounds(box, {maxZoom: 16, padding: [80, 80]});
    if (!shape) return;
    shape.setStyle({weight: 5, fillOpacity: 0.34});
    setTimeout(function () { shape.setStyle(areaStyle(shape.feature)); }, 1600);
  }

  function streamStyle(feature, range) {
    var norm = feature.properties.riskNorm;
    if (norm === null || norm === undefined) norm = 0;
    return {
      color: global.SCIMAP.rampColour('plasma', norm),
      // Risky reaches read as heavier without hiding the rest of the network.
      weight: 1.2 + norm * 3.2,
      opacity: 0.55 + norm * 0.45,
      lineCap: 'round'
    };
  }

  function bindReach(feature, layer) {
    layer.on('click', function (event) {
      L.DomEvent.stop(event);
      global.SCIMAP.emit('reach-selected', {properties: feature.properties, layer: layer});
    });
    layer.on('mouseover', function () { layer.setStyle({weight: 6, opacity: 1}); });
    layer.on('mouseout', function () {
      var range = (global.SCIMAP_VECTORS.streams || {}).riskRange || [0, 1];
      layer.setStyle(streamStyle(feature, range));
    });
  }

  function zoomToReach(layer) {
    if (layer && layer.getBounds) map.fitBounds(layer.getBounds(), {maxZoom: 16, padding: [60, 60]});
  }

  // ── the value probe ─────────────────────────────────────────────────────

  function wireProbe() {
    var pending = null;
    map.on('mousemove', function (event) {
      // One read per animation frame; mousemove fires far faster than that.
      if (pending) return;
      pending = requestAnimationFrame(function () {
        pending = null;
        global.SCIMAP.emit('probe', readAt(event.latlng));
      });
    });
    map.on('mouseout', function () { global.SCIMAP.emit('probe', null); });
    map.on('click', function (event) {
      global.SCIMAP.emit('probe-pinned', readAt(event.latlng));
    });
  }

  function readAt(latlng) {
    var readings = global.SCIMAP.rasterLayers().map(function (layer) {
      return {
        key: layer.key, label: layer.label, units: layer.units,
        visible: !!global.SCIMAP.state.visible[layer.key],
        value: global.SCIMAP.sample(layer.key, latlng.lat, latlng.lng)
      };
    });
    return {
      lat: latlng.lat, lng: latlng.lng,
      elevation: global.SCIMAP.sampleElevation(latlng.lat, latlng.lng),
      readings: readings
    };
  }

  // ── reacting to shared state ────────────────────────────────────────────

  function wireState() {
    global.SCIMAP.on('layer-visibility', function (event) {
      setVisible(event.key, event.visible);
    });
    global.SCIMAP.on('layer-opacity', function (event) {
      setOpacity(event.key, event.opacity);
    });
    global.SCIMAP.on('vector-visibility', function (event) {
      showVector(event.name, event.visible);
    });
    global.SCIMAP.on('state', function (event) {
      if (event.changed.indexOf('pixelated') >= 0) {
        var container = map.getContainer();
        container.classList.toggle('pixelated', !!global.SCIMAP.state.pixelated);
      }
    });
  }

  function showVector(name, visible) {
    var layer = vectorLayers[name];
    if (!layer) return;
    if (visible && !map.hasLayer(layer)) layer.addTo(map);
    else if (!visible && map.hasLayer(layer)) map.removeLayer(layer);
  }

  function invalidate() { if (map) map.invalidateSize(); }

  /** Render the whole catchment to a PNG data URI, for printing.
   *
   * Leaflet cannot be printed reliably: the print layout resizes the map, and
   * the tiles the new viewport needs are requested too late to appear in the
   * output. Everything needed to draw the map is embedded in the page anyway,
   * so the printed figure is composited here instead — from the same arrays
   * the 3D view and the value probe use, at full grid resolution, showing the
   * whole catchment rather than whatever happened to be on screen.
   *
   * The canvas is only ever written by JavaScript, never from a file:// image,
   * so toDataURL is not blocked.
   */
  //: longest side in pixels for each offered export size
  var IMAGE_SIZES = {screen: 1600, print: 4000};

  /** Pixels per grid cell for a named size, never below 1:1. */
  function imageScale(size) {
    var grid = global.SCIMAP_GRID;
    var target = IMAGE_SIZES[size];
    if (!target) return 1;
    return Math.max(1, target / Math.max(grid.width, grid.height));
  }

  /** What a given size actually produces, for the UI to state up front. */
  function imageSize(size) {
    var grid = global.SCIMAP_GRID, scale = imageScale(size);
    return {
      scale: scale,
      width: Math.round(grid.width * scale),
      height: Math.round(grid.height * scale)
    };
  }

  /* Composited from the embedded arrays rather than grabbed from Leaflet.
   * Leaflet's tiles are file:// <img> elements, so drawing them to a canvas
   * taints it and toDataURL throws; everything here is generated in JS and
   * therefore clean. The raster is upscaled from the grid because the tiles
   * cannot be read back — the UI states the true cell size so nobody mistakes
   * the pixel count for new detail. */
  function renderStaticMap(size) {
    var grid = global.SCIMAP_GRID;
    var scale = imageScale(size);
    var width = Math.round(grid.width * scale);
    var height = Math.round(grid.height * scale);

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var out = canvas.getContext('2d');
    if (!out) return null;
    out.fillStyle = '#ffffff';
    out.fillRect(0, 0, width, height);

    // Layers are composed at grid resolution, then scaled up in one step;
    // vectors and the scale bar are drawn at full output size so they stay
    // crisp instead of being magnified along with the pixels.
    var stack = document.createElement('canvas');
    stack.width = grid.width;
    stack.height = grid.height;
    var ctx = stack.getContext('2d');
    if (!ctx) return null;

    if (grid.hasTerrain) {
      var shade = global.SCIMAP.hillshade(global.SCIMAP.state.sun.azimuth,
                                          global.SCIMAP.state.sun.altitude);
      var elevation = global.SCIMAP.decode(grid.dem);
      var nodata = grid.dem.nodata;
      var relief = new Uint8ClampedArray(grid.width * grid.height * 4);
      var lut = global.SCIMAP.rampLut('relief');
      for (var i = 0; i < shade.length; i++) {
        // Outside the DEM there is nothing to shade; leaving these transparent
        // keeps the page white there rather than painting the ramp's darkest end.
        if (elevation[i] === nodata) continue;
        var slot = shade[i] * 3;
        relief[i * 4] = lut[slot];
        relief[i * 4 + 1] = lut[slot + 1];
        relief[i * 4 + 2] = lut[slot + 2];
        relief[i * 4 + 3] = 255;
      }
      var base = document.createElement('canvas');
      base.width = grid.width;
      base.height = grid.height;
      base.getContext('2d').putImageData(
        new ImageData(relief, grid.width, grid.height), 0, 0);
      ctx.drawImage(base, 0, 0);
    }

    global.SCIMAP.drawOrder().forEach(function (layer) {
      var payload = (global.SCIMAP_PAYLOAD || {})[layer.key];
      if (!payload) return;
      var rgba = global.SCIMAP.colourise(
        global.SCIMAP.decode(payload), global.SCIMAP.rampFor(layer.key), {shade: null});

      // Compose through a scratch canvas so per-layer opacity applies.
      var scratch = document.createElement('canvas');
      scratch.width = grid.width;
      scratch.height = grid.height;
      scratch.getContext('2d').putImageData(
        new ImageData(new Uint8ClampedArray(rgba.buffer), grid.width, grid.height), 0, 0);
      ctx.globalAlpha = global.SCIMAP.state.opacity[layer.key];
      if (ctx.globalAlpha === undefined) ctx.globalAlpha = 1;
      ctx.drawImage(scratch, 0, 0);
      ctx.globalAlpha = 1;
    });

    out.imageSmoothingEnabled = !global.SCIMAP.state.pixelated;
    out.drawImage(stack, 0, 0, width, height);
    drawVectorsOnCanvas(out, grid, scale);
    drawScaleBar(out, width, height, scale);
    return canvas.toDataURL('image/png');
  }

  /** A scale bar burned into the exported image.
   *
   * The live map has one; an exported map without it is a picture, not a map.
   * Web Mercator metres are inflated by 1/cos(latitude), so ground distance is
   * the projected distance times mercatorScale — the same correction the 3D
   * scene applies to its horizontal extents. */
  function drawScaleBar(ctx, width, height, scale) {
    var grid = global.SCIMAP_GRID;
    var groundPerPixel = grid.pixelSize3857[0] * (grid.mercatorScale || 1) / scale;
    if (!isFinite(groundPerPixel) || groundPerPixel <= 0) return;

    var target = width * 0.22;                       // aim for about a fifth
    var metres = target * groundPerPixel;
    var power = Math.pow(10, Math.floor(Math.log(metres) / Math.LN10));
    var nice = [1, 2, 5, 10].map(function (m) { return m * power; });
    var rounded = nice.reduce(function (best, value) {
      return Math.abs(value - metres) < Math.abs(best - metres) ? value : best;
    }, nice[0]);

    var barPx = rounded / groundPerPixel;
    var label = rounded >= 1000 ? (rounded / 1000) + ' km' : rounded + ' m';
    var pad = Math.round(14 * scale);
    var thickness = Math.max(3, Math.round(3 * scale));
    var font = Math.max(11, Math.round(11 * scale));
    var x = pad;
    var y = height - pad - thickness - font;

    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillRect(x - pad / 2, y - font * 0.7,
                 barPx + pad, thickness + font * 2.1);
    ctx.fillStyle = '#16181c';
    ctx.font = '500 ' + font + 'px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(label, x, y - font * 0.35);
    ctx.fillRect(x, y + font * 0.9, barPx, thickness);
    // End ticks, so the bar reads as a measurement rather than a rule.
    ctx.fillRect(x, y + font * 0.9 - thickness, thickness, thickness * 3);
    ctx.fillRect(x + barPx - thickness, y + font * 0.9 - thickness,
                 thickness, thickness * 3);
    ctx.restore();
  }

  function drawVectorsOnCanvas(ctx, grid, scale) {
    var bounds = grid.bounds3857;
    scale = scale || 1;
    function toPixel(lng, lat) {
      var x = lng * 6378137.0 * Math.PI / 180;
      var clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
      var y = 6378137.0 * Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360));
      return [(x - bounds[0]) / grid.pixelSize3857[0] * scale,
              (bounds[3] - y) / grid.pixelSize3857[1] * scale];
    }

    function stroke(collection, style) {
      if (!collection) return;
      (collection.features || []).forEach(function (feature) {
        var geometry = feature.geometry || {};
        var parts = geometry.type === 'MultiLineString' ? geometry.coordinates
                  : geometry.type === 'LineString' ? [geometry.coordinates]
                  : geometry.type === 'Polygon' ? geometry.coordinates
                  : geometry.type === 'MultiPolygon'
                    ? [].concat.apply([], geometry.coordinates) : [];
        parts.forEach(function (coords) {
          if (!coords || coords.length < 2) return;
          ctx.beginPath();
          coords.forEach(function (point, index) {
            var pixel = toPixel(point[0], point[1]);
            if (index === 0) ctx.moveTo(pixel[0], pixel[1]);
            else ctx.lineTo(pixel[0], pixel[1]);
          });
          style(feature);
          ctx.stroke();
        });
      });
    }

    var data = global.SCIMAP_VECTORS || {};
    var shown = global.SCIMAP.state.vectors;
    stroke(shown.catchment ? data.catchment : null, function () {
      ctx.strokeStyle = '#333333';
      ctx.lineWidth = 2 * scale;
      ctx.setLineDash([7 * scale, 5 * scale]);
    });
    ctx.setLineDash([]);
    stroke(shown.streams ? data.streams : null, function (feature) {
      var norm = feature.properties.riskNorm;
      if (norm === null || norm === undefined) norm = 0;
      ctx.strokeStyle = global.SCIMAP.rampColour('plasma', norm);
      ctx.lineWidth = (1 + norm * 3) * scale;
      ctx.lineCap = 'round';
    });

    var areas = shown.priorityAreas ? data.priorityAreas : null;
    if (!areas) return;
    ctx.lineJoin = 'round';
    stroke(areas, function () {
      ctx.strokeStyle = 'rgba(11, 16, 22, 0.6)';
      ctx.lineWidth = 4.5 * scale;
    });
    stroke(areas, function (feature) {
      ctx.strokeStyle = global.SCIMAP.driverOf(feature.properties.driver).colour;
      ctx.lineWidth = 2.2 * scale;
    });
    // Numbered as on screen, so the printed map and the printed table agree.
    var radius = 9 * scale;
    ctx.font = '700 ' + Math.round(11 * scale) + 'px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    (areas.features || []).forEach(function (feature) {
      var props = feature.properties;
      if (props.labelLat === null || props.labelLat === undefined) return;
      var at = toPixel(props.labelLon, props.labelLat);
      ctx.beginPath();
      ctx.arc(at[0], at[1], radius, 0, Math.PI * 2);
      ctx.fillStyle = global.SCIMAP.driverOf(props.driver).colour;
      ctx.fill();
      ctx.lineWidth = 1.5 * scale;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.fillText(String(props.rank), at[0], at[1] + 0.5 * scale);
    });
  }
  function reset() { if (map) map.fitBounds(bounds(), {padding: [24, 24]}); }

  global.SCIMAP_MAP2D = {
    create: create, invalidate: invalidate, reset: reset,
    renderStaticMap: renderStaticMap, imageSize: imageSize,
    zoomToReach: zoomToReach, zoomToArea: zoomToArea,
    hasVector: function (name) { return !!vectorLayers[name]; },
    get map() { return map; }
  };
})(window);
