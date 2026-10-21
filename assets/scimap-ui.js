/* SCIMAP dashboard — the shell: tabs, layer rail, legend, probe, downloads. */
(function (global) {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  var activeView = 'map';
  //: which layer the charts are showing, kept across theme redraws
  var chartLayerKey = null;

  // ── boot ────────────────────────────────────────────────────────────────

  function boot() {
    var meta = global.SCIMAP_META || {};
    if (meta.schema !== global.SCIMAP.SCHEMA) {
      fail('This dashboard was written by a different version of the SCIMAP ' +
           'plugin (data format ' + meta.schema + ', this page reads ' +
           global.SCIMAP.SCHEMA + '). Re-export it from QGIS.');
      return;
    }

    try {
      fillHeader(meta);
      buildLayerRail();
      buildControls();
      buildCharts();
      buildDownloads(meta);
      buildProvenance(meta);
      wireTabs();
      wireProbe();
      wireReachInspector();

      // The map must exist before the feature toggles: they list the vector
      // layers it actually managed to add.
      global.SCIMAP_MAP2D.create('map2d');
      buildVectorToggles();
      // Compose the printable still now, while the page is idle.
      setTimeout(prepareForPrint, 400);
      setView(initialView());
      $('loading').classList.add('gone');
    } catch (error) {
      console.error(error);
      fail('Something went wrong building this dashboard: ' + error.message);
    }
  }

  function fail(message) {
    var overlay = $('loading');
    overlay.classList.remove('gone');
    overlay.innerHTML = '';
    overlay.appendChild(make('div', 'load-error', message));
  }

  function fillHeader(meta) {
    $('title').textContent = meta.title || 'SCIMAP results';
    $('subtitle').textContent = meta.subtitle || '';
    var stamp = meta.generated ? new Date(meta.generated) : null;
    $('generated').textContent = stamp && !isNaN(stamp)
      ? 'Generated ' + stamp.toLocaleString()
      : '';
    if (meta.organisation) $('organisation').textContent = meta.organisation;
    document.title = (meta.title || 'SCIMAP results') + ' — SCIMAP';
  }

  // ── layer rail ──────────────────────────────────────────────────────────

  function buildLayerRail() {
    var host = $('layer-list');
    host.innerHTML = '';

    global.SCIMAP.rasterLayers().forEach(function (layer) {
      var row = make('div', 'layer');
      var head = make('div', 'layer-head');

      var toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.id = 'toggle-' + layer.key;
      toggle.checked = !!layer.defaultVisible;
      toggle.addEventListener('change', function () {
        global.SCIMAP.setLayerVisible(layer.key, toggle.checked);
      });

      var label = make('label', 'layer-name', layer.label);
      label.setAttribute('for', toggle.id);
      if (layer.description) label.title = layer.description;

      head.appendChild(toggle);
      head.appendChild(label);
      row.appendChild(head);

      var swatch = make('div', 'legend');
      swatch.style.background = global.SCIMAP.rampCss(layer.ramp);
      row.appendChild(swatch);

      var scale = make('div', 'legend-scale');
      scale.appendChild(make('span', null, global.SCIMAP.formatValue(layer.vmin, 3)));
      if (layer.units) scale.appendChild(make('span', 'legend-units', layer.units));
      scale.appendChild(make('span', null, global.SCIMAP.formatValue(layer.vmax, 3)));
      row.appendChild(scale);

      var slider = document.createElement('input');
      slider.type = 'range'; slider.min = 0; slider.max = 1; slider.step = 0.05;
      slider.value = 1;
      slider.className = 'opacity';
      slider.setAttribute('aria-label', layer.label + ' opacity');
      slider.addEventListener('input', function () {
        global.SCIMAP.setLayerOpacity(layer.key, parseFloat(slider.value));
      });
      row.appendChild(slider);

      host.appendChild(row);
    });

    if (!global.SCIMAP.rasterLayers().length) {
      host.appendChild(make('p', 'chart-note', 'No raster layers in this export.'));
    }
  }

  function buildVectorToggles() {
    var host = $('vector-list');
    host.innerHTML = '';
    var labels = {
      priorityAreas: 'Critical source areas',
      streams: 'Stream network (risk)',
      catchment: 'Catchment boundary',
      points: 'Stream risk points',
      pourPoint: 'Pour point'
    };

    Object.keys(labels).forEach(function (name) {
      if (!global.SCIMAP_MAP2D.hasVector(name)) return;
      var row = make('label', 'vector-toggle');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !!global.SCIMAP.state.vectors[name];
      box.addEventListener('change', function () {
        global.SCIMAP.setVectorVisible(name, box.checked);
      });
      // Switched on from elsewhere too: selecting an area in the Analysis table.
      global.SCIMAP.on('vector-visibility', function (event) {
        if (event.name === name) box.checked = event.visible;
      });
      row.appendChild(box);
      row.appendChild(make('span', null, labels[name]));
      host.appendChild(row);
    });
  }

  // ── controls ────────────────────────────────────────────────────────────

  function buildControls() {
    bindRange('exaggeration', 'exaggeration-value', function (value) {
      global.SCIMAP.setState({exaggeration: value}, 'exaggeration');
      describeModel();          // after the state change: the height follows it
      return value.toFixed(1) + '×';
    });
    bindRange('sun-azimuth', 'sun-azimuth-value', function (value) {
      global.SCIMAP.setState({
        sun: {azimuth: value, altitude: global.SCIMAP.state.sun.altitude}
      }, 'sun');
      return Math.round(value) + '°';
    });
    bindRange('sun-altitude', 'sun-altitude-value', function (value) {
      global.SCIMAP.setState({
        sun: {azimuth: global.SCIMAP.state.sun.azimuth, altitude: value}
      }, 'sun');
      return Math.round(value) + '°';
    });

    bindRange('print-size', 'print-size-value', function (value) {
      describeModel();
      return value + ' mm';
    });
    bindCheck('flow-toggle', function (on) { global.SCIMAP.setState({flow: on}, 'flow'); });
    bindCheck('spin-toggle', function (on) { global.SCIMAP.setState({spin: on}, 'spin'); });
    bindCheck('pixelated-toggle', function (on) {
      global.SCIMAP.setState({pixelated: on}, 'pixelated');
    });

    $('reset-view').addEventListener('click', function () {
      if (activeView === 'scene') global.SCIMAP_MAP3D.resetView();
      else global.SCIMAP_MAP2D.reset();
    });
    $('screenshot').addEventListener('click', takeScreenshot);
    $('export-model').addEventListener('click', saveModel);
    $('save-map-screen').addEventListener('click', function () { saveMapImage('screen'); });
    $('save-map-print').addEventListener('click', function () { saveMapImage('print'); });
    describeMapImage();
    $('print').addEventListener('click', function () {
      prepareForPrint();
      // One frame for Leaflet to request the tiles the new layout needs.
      requestAnimationFrame(function () { setTimeout(function () { global.print(); }, 120); });
    });
    $('theme').addEventListener('click', toggleTheme);
  }

  function bindRange(id, valueId, apply) {
    var input = $(id), readout = $(valueId);
    if (!input) return;
    function update() { readout.textContent = apply(parseFloat(input.value)); }
    input.addEventListener('input', update);
    update();
  }

  function bindCheck(id, apply) {
    var input = $(id);
    if (!input) return;
    input.addEventListener('change', function () { apply(input.checked); });
  }

  /** Hand the browser a file. Works on file:// — the page is its own origin. */
  function save(href, filename, revoke) {
    var link = document.createElement('a');
    link.href = href;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    if (revoke) setTimeout(function () { URL.revokeObjectURL(href); }, 4000);
  }

  /** A filename stem from the dashboard title, safe on every filesystem. */
  function stem() {
    var title = (global.SCIMAP_META || {}).title || 'scimap';
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '').slice(0, 60) || 'scimap';
  }

  function takeScreenshot() {
    if (activeView !== 'scene' || !global.SCIMAP_MAP3D.isStarted()) {
      alert('Open the 3D view to save a rendered image of the terrain.');
      return;
    }
    var url = global.SCIMAP_MAP3D.screenshot();
    if (!url) return;
    save(url, stem() + '-3d.png');
  }

  function saveMapImage(size) {
    var button = $(size === 'print' ? 'save-map-print' : 'save-map-screen');
    var label = button.textContent;
    button.disabled = true;
    button.textContent = 'Rendering…';
    // Yield first, or the button never repaints before the canvas work starts.
    setTimeout(function () {
      try {
        var url = global.SCIMAP_MAP2D.renderStaticMap(size);
        if (url) save(url, stem() + '-map-' + size + '.png');
        else alert('Could not render the map image.');
      } catch (error) {
        alert('Could not render the map image: ' + (error.message || error));
      }
      button.disabled = false;
      button.textContent = label;
    }, 30);
  }

  //: the printed size the panel is currently asking for, in millimetres
  function printSizeMm() {
    var input = $('print-size');
    var value = input ? parseFloat(input.value) : NaN;
    return isFinite(value) && value > 0 ? value : 200;
  }

  /** Say what the chosen size works out as, once the terrain exists. */
  function describeModel() {
    var note = $('model-size-note');
    if (!note) return;
    if (!global.SCIMAP_MAP3D.isStarted() || !global.SCIMAP_MAP3D.modelSize) {
      note.textContent = 'Open the 3D view to see the printed dimensions.';
      return;
    }
    var fit = global.SCIMAP_MAP3D.modelSize(printSizeMm());
    if (!fit) { note.textContent = ''; return; }
    var round = function (n) { return n < 10 ? n.toFixed(1) : Math.round(n); };
    note.textContent =
      round(fit.mm.x) + ' × ' + round(fit.mm.y) + ' × ' + round(fit.mm.z) +
      ' mm, about 1:' + Math.round(fit.ratio / 1000) * 1000 +
      ' with the relief exaggerated ' +
      (global.SCIMAP.state.exaggeration || 1) + '×.';
  }

  function saveModel() {
    if (!global.SCIMAP_MAP3D.isStarted()) {
      alert('Open the 3D view first so the terrain is built, then save it.');
      return;
    }
    var button = $('export-model');
    var format = $('model-format').value;
    var label = button.textContent;
    button.disabled = true;
    button.textContent = 'Building…';
    setTimeout(function () {
      global.SCIMAP_MAP3D.exportModel(format, {sizeMm: printSizeMm()},
                                      function (blob, result) {
        button.disabled = false;
        button.textContent = label;
        if (!blob) {
          alert('Could not export the model: ' + result + '.');
          return;
        }
        save(URL.createObjectURL(blob), stem() + '-terrain.' + result, true);
      });
    }, 30);
  }

  /** State the true cell size, so a big pixel count is not read as detail. */
  function describeMapImage() {
    var note = $('map-image-note');
    if (!note || !global.SCIMAP_MAP2D.imageSize) return;
    var grid = global.SCIMAP_GRID;
    var ground = grid.pixelSize3857[0] * (grid.mercatorScale || 1);
    var screen = global.SCIMAP_MAP2D.imageSize('screen');
    var print = global.SCIMAP_MAP2D.imageSize('print');
    note.textContent =
      'Screen ' + screen.width + ' × ' + screen.height + ' px, print ' +
      print.width + ' × ' + print.height + ' px. Both are drawn from the ' +
      'embedded data at about ' + ground.toFixed(0) + ' m per cell, with the ' +
      'layers, opacities and stream colours you have set. Larger sizes sharpen ' +
      'the lines and labels, not the underlying cells.';
  }

  function toggleTheme() {
    var root = document.documentElement;
    var next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    $('theme').textContent = next === 'light' ? 'Dark' : 'Light';
    buildCharts();          // chart ink follows the theme, so redraw them
    try { localStorage.setItem('scimap-theme', next); } catch (e) { /* private mode */ }
  }

  // ── tabs ────────────────────────────────────────────────────────────────

  var VIEWS = ['map', 'scene', 'charts', 'data', 'about'];

  function wireTabs() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
      button.addEventListener('click', function () { setView(button.dataset.view); });
    });
    // The view lives in the URL hash, so a particular tab can be linked to
    // and the back button behaves.
    global.addEventListener('hashchange', function () {
      var wanted = global.location.hash.replace('#', '');
      if (VIEWS.indexOf(wanted) >= 0 && wanted !== activeView) setView(wanted, true);
    });
  }

  function initialView() {
    var wanted = global.location.hash.replace('#', '');
    return VIEWS.indexOf(wanted) >= 0 ? wanted : 'map';
  }

  function setView(view, fromHash) {
    activeView = view;
    if (!fromHash) {
      try { global.history.replaceState(null, '', '#' + view); }
      catch (e) { global.location.hash = view; }
    }
    Array.prototype.forEach.call(document.querySelectorAll('[data-view]'), function (button) {
      button.classList.toggle('on', button.dataset.view === view);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.view'), function (panel) {
      panel.classList.toggle('on', panel.id === 'view-' + view);
    });

    document.body.classList.toggle('scene-active', view === 'scene');
    document.body.classList.toggle('map-active', view === 'map');

    if (view === 'map') {
      global.SCIMAP_MAP3D.pause();
      setTimeout(global.SCIMAP_MAP2D.invalidate, 30);
    } else if (view === 'scene') {
      // Built on first open: the mesh and textures cost a second or so, and
      // plenty of readers never leave the 2D map.
      if (!global.SCIMAP_MAP3D.isStarted()) {
        if (!global.SCIMAP_MAP3D.supported()) {
          $('scene-unavailable').classList.remove('gone');
          return;
        }
        $('scene-building').classList.remove('gone');
        setTimeout(function () {
          var ok = global.SCIMAP_MAP3D.start('scene3d', {
            meshCap: (global.SCIMAP_META.mesh || {}).cap || 512
          });
          $('scene-building').classList.add('gone');
          if (!ok) $('scene-unavailable').classList.remove('gone');
          describeModel();          // the terrain exists now, so it has a size
        }, 40);
      } else {
        global.SCIMAP_MAP3D.resume();
        global.SCIMAP_MAP3D.resize();
      }
    } else {
      global.SCIMAP_MAP3D.pause();
    }
  }

  // ── probe readout ───────────────────────────────────────────────────────

  function wireProbe() {
    var host = $('probe');
    var pinned = false;

    global.SCIMAP.on('probe', function (reading) {
      if (pinned) return;
      render(reading);
    });
    global.SCIMAP.on('probe-pinned', function (reading) {
      pinned = !!reading;
      render(reading, true);
    });

    function render(reading, isPinned) {
      if (!reading) { host.classList.add('gone'); return; }
      host.classList.remove('gone');
      host.innerHTML = '';

      var head = make('div', 'probe-head');
      head.appendChild(make('span', 'probe-coord',
        global.SCIMAP.formatLatLng(reading.lat, reading.lng)));
      if (reading.elevation !== null) {
        head.appendChild(make('span', 'probe-elev',
          Math.round(reading.elevation) + ' m'));
      }
      if (isPinned) {
        var clear = make('button', 'probe-clear', 'unpin');
        clear.addEventListener('click', function () {
          pinned = false; host.classList.add('gone');
        });
        head.appendChild(clear);
      }
      host.appendChild(head);

      reading.readings.forEach(function (item) {
        if (!item.visible && item.value === null) return;
        var row = make('div', 'probe-row' + (item.visible ? '' : ' dim'));
        row.appendChild(make('span', 'probe-label', item.label));
        row.appendChild(make('span', 'probe-value',
          global.SCIMAP.formatValue(item.value, 4)));
        host.appendChild(row);
      });
    }
  }

  function wireReachInspector() {
    global.SCIMAP.on('reach-selected', function (event) {
      var host = $('reach');
      var props = event.properties;
      host.classList.remove('gone');
      host.innerHTML = '';
      host.appendChild(make('h3', null, 'Reach #' + props.rank));

      var rows = [
        ['In-channel risk', global.SCIMAP.formatValue(props.Risk, 4)],
        ['Rank', '#' + props.rank + ' of ' +
          ((global.SCIMAP_VECTORS.streams || {}).features || []).length],
        ['Percentile', props.pct + '%'],
        ['Length', Math.round(props.lengthM).toLocaleString() + ' m']
      ];
      rows.forEach(function (pair) {
        var row = make('div', 'reach-row');
        row.appendChild(make('span', 'reach-label', pair[0]));
        row.appendChild(make('span', 'reach-value', pair[1]));
        host.appendChild(row);
      });

      var close = make('button', 'reach-close', 'Close');
      close.addEventListener('click', function () { host.classList.add('gone'); });
      host.appendChild(close);
    });
  }

  // ── charts tab ──────────────────────────────────────────────────────────

  function buildCharts() {
    var picker = $('histogram-layer');
    var layers = global.SCIMAP.rasterLayers();
    // Rebuilt on every theme change, so start from empty or the list doubles.
    picker.innerHTML = '';
    layers.forEach(function (layer) {
      var option = document.createElement('option');
      option.value = layer.key;
      option.textContent = layer.label;
      picker.appendChild(option);
    });
    if (chartLayerKey) picker.value = chartLayerKey;
    function draw() {
      var layer = global.SCIMAP.layerByKey(picker.value) || layers[0];
      if (!layer) return;
      chartLayerKey = layer.key;
      global.SCIMAP_CHARTS_UI.histogram($('chart-histogram'), layer);
      global.SCIMAP_CHARTS_UI.concentration($('chart-concentration'), layer);
    }
    picker.addEventListener('change', draw);
    draw();

    global.SCIMAP_CHARTS_UI.priorityAreas($('chart-priority'), function (area) {
      setView('map');
      if (!global.SCIMAP.state.vectors.priorityAreas) {
        global.SCIMAP.setVectorVisible('priorityAreas', true);
      }
      setTimeout(function () { global.SCIMAP_MAP2D.zoomToArea(area); }, 60);
    });
    global.SCIMAP_CHARTS_UI.scatter($('chart-scatter'));
    global.SCIMAP_CHARTS_UI.topReaches($('chart-reaches'), function (row) {
      setView('map');
      var map = global.SCIMAP_MAP2D.map;
      if (map && row.lat !== undefined) {
        setTimeout(function () { map.setView([row.lat, row.lon], 15); }, 60);
      }
    });
  }

  // ── data + provenance tabs ──────────────────────────────────────────────

  function buildDownloads(meta) {
    var host = $('download-list');
    host.innerHTML = '';
    var files = meta.downloads || [];
    if (!files.length) {
      host.appendChild(global.SCIMAP_CHARTS_UI.note(
        'This dashboard was exported without the data bundle.'));
      return;
    }

    var table = make('table', 'download-table');
    table.innerHTML = '<thead><tr><th>File</th><th>What it is</th>' +
                      '<th>Format</th><th>Size</th></tr></thead>';
    var body = document.createElement('tbody');
    files.forEach(function (file) {
      var tr = document.createElement('tr');
      var link = make('a', null, file.file.split('/').pop());
      link.href = file.file;
      link.setAttribute('download', '');
      var cell = document.createElement('td');
      cell.appendChild(link);
      tr.appendChild(cell);
      tr.appendChild(make('td', null, file.label || ''));
      tr.appendChild(make('td', null, file.format || ''));
      tr.appendChild(make('td', null, global.SCIMAP.formatBytes(file.bytes)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    host.appendChild(table);
  }

  function buildProvenance(meta) {
    var host = $('provenance');
    host.innerHTML = '';

    section(host, 'Run', [
      ['Algorithm', (meta.run || {}).algorithm],
      ['Generated', meta.generated],
      ['Plugin', (meta.plugin || {}).name + ' ' + (meta.plugin || {}).version],
      ['QGIS', (meta.plugin || {}).qgis],
      ['GDAL', (meta.plugin || {}).gdal],
      ['Connectivity backend', (meta.run || {}).connectivityBackend]
    ]);

    if (meta.weights && Object.keys(meta.weights).length) {
      var rows = Object.keys(meta.weights).map(function (key) {
        return [(meta.classNames || {})[key] || ('Class ' + key), meta.weights[key]];
      });
      section(host, 'Land cover risk weights', rows);
    }

    if ((meta.run || {}).parameters) {
      section(host, 'Parameters', Object.keys(meta.run.parameters).map(function (key) {
        return [key, meta.run.parameters[key]];
      }));
    }

    (meta.inputs || []).forEach(function (input) {
      section(host, 'Input: ' + (input.role || 'layer'), [
        ['Name', input.name], ['Source', input.source], ['CRS', input.crs],
        ['Size', input.size ? input.size.join(' × ') + ' px' : null],
        ['Pixel size', input.pixel ? input.pixel.map(function (v) {
          return Math.abs(v).toFixed(2);
        }).join(' × ') + ' m' : null]
      ]);
    });

    var grid = global.SCIMAP_GRID;
    section(host, 'Dashboard grid', [
      ['Projection', 'EPSG:3857 (Web Mercator)'],
      ['Source CRS', grid.sourceCrs],
      ['Grid size', grid.width + ' × ' + grid.height + ' px'],
      ['Ground pixel', (grid.pixelSize3857[0] * grid.mercatorScale).toFixed(1) + ' m'],
      ['Mercator scale', grid.mercatorScale.toFixed(4) + ' at ' +
        grid.centreLat.toFixed(3) + '° latitude']
    ]);

    if (meta.citation) {
      var cite = make('div', 'cite');
      cite.appendChild(make('h3', null, 'Method'));
      cite.appendChild(make('p', null, meta.citation.text || ''));
      if (meta.citation.doi) {
        var link = make('a', null, 'doi:' + meta.citation.doi);
        link.href = 'https://doi.org/' + meta.citation.doi;
        cite.appendChild(link);
      }
      host.appendChild(cite);
    }
    if (meta.disclaimer) {
      var note = make('p', 'disclaimer', meta.disclaimer);
      host.appendChild(note);
    }
  }

  function section(host, title, rows) {
    var clean = rows.filter(function (row) {
      return row[1] !== null && row[1] !== undefined && row[1] !== '';
    });
    if (!clean.length) return;
    host.appendChild(make('h3', null, title));
    var table = make('table', 'meta-table');
    var body = document.createElement('tbody');
    clean.forEach(function (row) {
      var tr = document.createElement('tr');
      tr.appendChild(make('th', null, row[0]));
      tr.appendChild(make('td', null, String(row[1])));
      body.appendChild(tr);
    });
    table.appendChild(body);
    host.appendChild(table);
  }

  // ── startup ─────────────────────────────────────────────────────────────

  try {
    var saved = localStorage.getItem('scimap-theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch (e) { /* private browsing */ }

  global.addEventListener('resize', function () {
    global.SCIMAP_MAP2D.invalidate();
    global.SCIMAP_MAP3D.resize();
  });
  /* Printing relays out the page, which changes the map's size — Leaflet has
   * to be told, or it prints the tiles for the old viewport (or none at all).
   * beforeprint is not fired by every print path, so the print media query is
   * watched as well; both run the same synchronous resize. */
  function prepareForPrint() {
    document.body.classList.add('printing');
    var target = $('print-map');
    if (!target || target.dataset.ready === 'yes') return;
    try {
      var url = global.SCIMAP_MAP2D.renderStaticMap();
      if (url) {
        target.src = url;
        target.dataset.ready = 'yes';
      }
    } catch (error) {
      console.error('Could not build the printable map', error);
    }
  }

  function invalidatePrintMap() {
    var target = $('print-map');
    if (target) delete target.dataset.ready;
  }
  function finishPrint() { document.body.classList.remove('printing'); }

  // The printed figure is a still of the whole catchment, so it goes stale
  // whenever the layers or lighting behind it change.
  global.SCIMAP.on('state', invalidatePrintMap);
  global.SCIMAP.on('layer-visibility', invalidatePrintMap);
  global.SCIMAP.on('layer-opacity', invalidatePrintMap);
  global.SCIMAP.on('vector-visibility', invalidatePrintMap);

  global.addEventListener('beforeprint', prepareForPrint);
  global.addEventListener('afterprint', finishPrint);
  if (global.matchMedia) {
    var printQuery = global.matchMedia('print');
    var onPrintChange = function (event) {
      if (event.matches) prepareForPrint(); else finishPrint();
    };
    if (printQuery.addEventListener) printQuery.addEventListener('change', onPrintChange);
    else if (printQuery.addListener) printQuery.addListener(onPrintChange);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})(window);
