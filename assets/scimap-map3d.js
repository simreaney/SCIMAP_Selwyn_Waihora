/* SCIMAP dashboard — the 3D scene.
 *
 * ============================ READ THIS FIRST ============================
 * Two rules here are not style preferences; break either and the view is
 * blank on a user's machine even though it worked on yours.
 *
 * 1. NEVER use THREE.TextureLoader (or any <img>) for a texture. The page is
 *    on file://, so the document has an opaque origin and WebGL refuses to
 *    upload an image from it — texImage2D throws SecurityError in Chrome.
 *    Every texture is a THREE.DataTexture built from an embedded array.
 *
 * 2. This is three.js r147, pinned because it is the last release shipping a
 *    classic UMD build and examples/js (file:// cannot load ES modules). The
 *    r147 API differs from current docs:
 *      renderer.outputEncoding = THREE.sRGBEncoding   (not outputColorSpace)
 *      texture.encoding        = THREE.sRGBEncoding   (not texture.colorSpace)
 *      renderer.physicallyCorrectLights               (not useLegacyLights)
 * =========================================================================
 */
(function (global) {
  'use strict';

  var scene, camera, renderer, controls, terrain, skirt, terrainBuild = null;
  var streamGroup, flowPoints, flowState = null;
  //: what the Features switches show and hide, by the same names as the 2D map
  var features = {};
  //: fat-line materials, which need the viewport size to draw their width
  var fatLines = [];
  //: markers kept at true scale, lifted by hand when the exaggeration changes
  var markers = [];
  var animationHandle = null, started = false, disposed = false;
  var host = null, sun = null;
  var meshWidth = 0, meshHeight = 0, spanX = 0, spanY = 0, baseZ = 0;

  function supported() {
    try {
      var canvas = document.createElement('canvas');
      return !!(global.WebGLRenderingContext &&
                (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')));
    } catch (error) { return false; }
  }

  // ── terrain ─────────────────────────────────────────────────────────────

  function decimation(grid, cap) {
    return Math.max(1, Math.ceil(Math.max(grid.width, grid.height) / cap));
  }

  function buildTerrain(grid, cap) {
    var step = decimation(grid, cap);
    meshWidth = Math.floor((grid.width - 1) / step) + 1;
    meshHeight = Math.floor((grid.height - 1) / step) + 1;

    var dem = grid.dem;
    var elevation = global.SCIMAP.decode(dem);

    // EPSG:3857 metres are inflated by 1/cos(lat); scale back to ground metres
    // so the vertical exaggeration on screen is the number we claim it is.
    spanX = (grid.bounds3857[2] - grid.bounds3857[0]) * grid.mercatorScale;
    spanY = (grid.bounds3857[3] - grid.bounds3857[1]) * grid.mercatorScale;

    var vertices = meshWidth * meshHeight;
    var positions = new Float32Array(vertices * 3);
    var uvs = new Float32Array(vertices * 2);
    var valid = new Uint8Array(vertices);
    var zMin = Infinity, zMax = -Infinity;

    for (var row = 0; row < meshHeight; row++) {
      var sourceRow = Math.min(row * step, grid.height - 1);
      for (var column = 0; column < meshWidth; column++) {
        var sourceColumn = Math.min(column * step, grid.width - 1);
        var at = row * meshWidth + column;
        var code = elevation[sourceRow * grid.width + sourceColumn];
        var z = code === dem.nodata ? 0 : code * dem.scale + dem.offset;
        if (code !== dem.nodata) {
          valid[at] = 1;
          if (z < zMin) zMin = z;
          if (z > zMax) zMax = z;
        }
        positions[at * 3] = (column / (meshWidth - 1) - 0.5) * spanX;
        positions[at * 3 + 1] = (0.5 - row / (meshHeight - 1)) * spanY;
        positions[at * 3 + 2] = z;
        uvs[at * 2] = column / (meshWidth - 1);
        uvs[at * 2 + 1] = 1 - row / (meshHeight - 1);
      }
    }
    if (!isFinite(zMin)) { zMin = 0; zMax = 1; }
    baseZ = zMin - Math.max((zMax - zMin) * 0.35, 25);

    // Drop any triangle touching a nodata corner, so the block takes the
    // catchment's own shape instead of sitting in a square slab.
    var indices = [];
    for (var y = 0; y < meshHeight - 1; y++) {
      for (var x = 0; x < meshWidth - 1; x++) {
        var a = y * meshWidth + x, b = a + 1, c = a + meshWidth, d = c + 1;
        if (valid[a] && valid[b] && valid[c]) indices.push(a, c, b);
        if (valid[b] && valid[c] && valid[d]) indices.push(b, c, d);
      }
    }

    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return {geometry: geometry, valid: valid, positions: positions,
            indices: indices, zMin: zMin, zMax: zMax, step: step};
  }

  /** A vertical wall around the catchment edge, so it reads as a solid block.
   *
   * Built from boundary *edges* rather than boundary vertices: wherever two
   * adjacent valid vertices have nodata (or the grid edge) on one side, that
   * segment gets a quad dropped to the base plane. Walking an ordered outline
   * would be fragile on a catchment with islands and pinch points; this is
   * order-free and handles any number of separate pieces.
   */
  //: material shared by the skirt and the base cap, so the sides and bottom
  //: of the printed block match
  function rockMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0x8c8578, roughness: 1.0, metalness: 0.0, side: THREE.DoubleSide,
      flatShading: true
    });
  }

  /** Edges used by exactly one terrain triangle — the outline of the surface.
   *
   * Derived from the triangles themselves rather than from which grid vertices
   * hold data. A cell with three valid corners contributes one triangle and so
   * a diagonal edge, which no row/column test can see; skirting the vertex
   * grid instead left those diagonals open and the solid full of slots.
   * Each edge is kept in the winding direction of the triangle that owns it,
   * which is what tells the skirt which way is outward.
   */
  function boundaryEdges(indices) {
    var seen = {};
    for (var i = 0; i < indices.length; i += 3) {
      for (var e = 0; e < 3; e++) {
        var a = indices[i + e], b = indices[i + (e + 1) % 3];
        var key = a < b ? a + '_' + b : b + '_' + a;
        if (seen[key]) seen[key].count++;
        else seen[key] = {a: a, b: b, count: 1};
      }
    }
    var out = [];
    Object.keys(seen).forEach(function (key) {
      if (seen[key].count === 1) out.push(seen[key]);
    });
    return out;
  }

  /* The terrain triangles wind anticlockwise seen from above, so on a boundary
   * edge a->b the surface lies to the left and the outside is to the right:
   * outward normal is (dy, -dx). */
  function buildSkirt(built) {
    var positions = built.positions;
    var edges = boundaryEdges(built.indices);
    if (!edges.length) return null;

    var vertices = [], normals = [];
    edges.forEach(function (edge) {
      var a = edge.a * 3, b = edge.b * 3;
      var ax = positions[a], ay = positions[a + 1], az = positions[a + 2];
      var bx = positions[b], by = positions[b + 1], bz = positions[b + 2];
      var dx = bx - ax, dy = by - ay;
      var length = Math.hypot(dx, dy) || 1;
      var nx = dy / length, ny = -dx / length;

      // Two triangles, wound so the face looks outward.
      vertices.push(ax, ay, az, ax, ay, baseZ, bx, by, baseZ,
                    ax, ay, az, bx, by, baseZ, bx, by, bz);
      for (var i = 0; i < 6; i++) normals.push(nx, ny, 0);
    });

    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(normals), 3));
    return new THREE.Mesh(geometry, rockMaterial());
  }

  /** The flat underside: the terrain's own triangles, dropped to the base and
   *  wound the other way so they face down.
   *
   *  Built only when exporting. Nothing can see it on screen — the camera is
   *  capped just above the horizon — and it would double the scene's triangle
   *  count for nothing. A printable solid needs it.
   *
   *  Indexed on the terrain's own vertex numbering rather than three fresh
   *  vertices per triangle: the same triangles in the same order, with each
   *  vertex stored once instead of about six times, which is what keeps a
   *  text format like USDZ a sensible size.
   */
  function buildBaseCap(built) {
    var positions = built.positions;
    var indices = built.indices;
    if (!indices.length) return null;

    var vertices = new Float32Array(positions.length);
    var normals = new Float32Array(positions.length);
    for (var v = 0; v < positions.length; v += 3) {
      vertices[v] = positions[v];
      vertices[v + 1] = positions[v + 1];
      vertices[v + 2] = baseZ;
      normals[v + 2] = -1;
    }
    var reversed = new Array(indices.length);
    for (var i = 0; i < indices.length; i += 3) {
      // Reversed winding: a, b, c instead of the surface's a, c, b.
      reversed[i] = indices[i];
      reversed[i + 1] = indices[i + 2];
      reversed[i + 2] = indices[i + 1];
    }

    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(reversed);
    return new THREE.Mesh(geometry, rockMaterial());
  }

  /** The terrain's colours: shaded relief with every ticked layer over it.
   *
   * The same stack as the 2D map, from the same switches: layers composed in
   * SCIMAP.drawOrder() at their opacity slider's setting, so the two views
   * cannot disagree about what is shown.
   */
  function drapeTexture() {
    var grid = global.SCIMAP_GRID;
    var state = global.SCIMAP.state;
    var shade = global.SCIMAP.hillshade(state.sun.azimuth, state.sun.altitude);
    var count = grid.width * grid.height;
    var rgba = new Uint8Array(count * 4);

    // Shaded rock underneath, always. A layer like in-channel risk only exists
    // in the channels, so draping it alone would leave the rest of the
    // catchment as a black hole instead of terrain.
    var relief = global.SCIMAP.rampLut('relief');
    for (var i = 0; i < count; i++) {
      var slot = shade[i] * 3;
      rgba[i * 4] = relief[slot];
      rgba[i * 4 + 1] = relief[slot + 1];
      rgba[i * 4 + 2] = relief[slot + 2];
      rgba[i * 4 + 3] = 255;
    }

    global.SCIMAP.drawOrder().forEach(function (layer) {
      var payload = (global.SCIMAP_PAYLOAD || {})[layer.key];
      var alpha = state.opacity[layer.key];
      if (alpha === undefined) alpha = 1;
      if (!payload || !(alpha > 0)) return;
      var keep = 1 - alpha;
      var codes = global.SCIMAP.decode(payload);
      var lut = global.SCIMAP.rampLut(global.SCIMAP.rampFor(layer.key));
      for (var p = 0; p < count; p++) {
        var code = codes[p];
        if (code === global.SCIMAP.NODATA_U8) continue;     // keep what is below
        var at = code * 3;
        var light = (0.45 + 0.55 * (shade[p] / 255)) * alpha;
        rgba[p * 4] = rgba[p * 4] * keep + lut[at] * light;
        rgba[p * 4 + 1] = rgba[p * 4 + 1] * keep + lut[at + 1] * light;
        rgba[p * 4 + 2] = rgba[p * 4 + 2] * keep + lut[at + 2] * light;
      }
    });

    // Store the grid bottom row first and leave flipY alone.
    //
    // GL texture rows run bottom-up while the grid runs north-first, so the
    // drape has to be turned over somewhere. texture.flipY = true does it on
    // screen but cannot survive an export: r147's GLTFExporter sets a flip
    // transform on its canvas and then writes a DataTexture with
    // putImageData, which ignores the transform by definition — so the
    // exported PNG comes out unflipped and the risk sits mirrored north-south
    // over the terrain, crossing ridges instead of following valleys.
    // Flipping the rows here is the one form both the renderer and the
    // exporter agree on.
    var rowBytes = grid.width * 4;
    var flipped = new Uint8Array(count * 4);
    for (var row = 0; row < grid.height; row++) {
      flipped.set(rgba.subarray(row * rowBytes, (row + 1) * rowBytes),
                  (grid.height - 1 - row) * rowBytes);
    }

    // DataTexture, never TextureLoader - see the header.
    var texture = new THREE.DataTexture(flipped, grid.width, grid.height,
                                        THREE.RGBAFormat);
    texture.encoding = THREE.sRGBEncoding;
    texture.flipY = false;
    texture.magFilter = global.SCIMAP.state.pixelated ? THREE.NearestFilter : THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  //: the drape no longer matches the switches, and is rebuilt when next seen
  var drapeStale = false, drapeQueued = false;

  /** Rebuild the drape after a switch, slider or sun change.
   *
   * At most once a frame, since an opacity slider fires on every pixel of a
   * drag and each rebuild walks the whole grid; and not at all while the 3D
   * view is hidden, so dragging a slider on the 2D map costs nothing here.
   */
  function refreshDrape() {
    if (!terrain) return;
    if (!animationHandle) { drapeStale = true; return; }    // see resume()
    if (drapeQueued) return;
    drapeQueued = true;
    requestAnimationFrame(function () {
      drapeQueued = false;
      applyDrape();
    });
  }

  function applyDrape() {
    if (!terrain) return;
    drapeStale = false;
    var old = terrain.material.map;
    terrain.material.map = drapeTexture();
    terrain.material.needsUpdate = true;
    if (old) old.dispose();
  }

  // ── streams and flow ────────────────────────────────────────────────────

  /** Scene position of a lat/lng on the terrain; z is NaN off the DEM.
   *
   * With *reach*, a point in a nodata cell takes the elevation of the nearest
   * cell with data within that many cells. The catchment boundary needs it:
   * it runs along the edge of the DEM's data, so about half its vertices fall
   * just outside.
   */
  function lift(lat, lng, reach) {
    var grid = global.SCIMAP_GRID;
    var bounds = grid.bounds3857;
    var x = lng * 6378137.0 * Math.PI / 180;
    var clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    var y = 6378137.0 * Math.log(Math.tan(Math.PI / 4 + clamped * Math.PI / 360));
    var fx = (x - bounds[0]) / (bounds[2] - bounds[0]);
    var fy = (y - bounds[1]) / (bounds[3] - bounds[1]);

    var index = global.SCIMAP.gridIndex(lat, lng);
    var z = index === null ? NaN : global.SCIMAP.elevationAt(index);
    if (!isFinite(z) && index !== null && reach) z = elevationNear(index, reach);
    return {x: (fx - 0.5) * spanX, y: (fy - 0.5) * spanY, z: z};
  }

  function elevationNear(index, reach) {
    var grid = global.SCIMAP_GRID;
    var row = Math.floor(index / grid.width), column = index % grid.width;
    var best = NaN, nearest = Infinity;
    for (var dy = -reach; dy <= reach; dy++) {
      for (var dx = -reach; dx <= reach; dx++) {
        var r = row + dy, c = column + dx;
        if (r < 0 || c < 0 || r >= grid.height || c >= grid.width) continue;
        var z = global.SCIMAP.elevationAt(r * grid.width + c);
        var distance = dx * dx + dy * dy;
        if (isFinite(z) && distance < nearest) { best = z; nearest = distance; }
      }
    }
    return best;
  }

  //: how far lines and points sit above the surface, or z-fighting eats them
  function surfaceOffset() { return Math.max((spanX / meshWidth) * 0.6, 3); }

  function fatLine(flat, colours, options) {
    var geometry = new THREE.LineGeometry();
    geometry.setPositions(flat);
    if (colours) geometry.setColors(colours);
    var material = new THREE.LineMaterial(options);
    material.resolution.set(hostWidth(), hostHeight());
    fatLines.push(material);
    var line = new THREE.Line2(geometry, material);
    if (options.dashed) line.computeLineDistances();
    return line;
  }

  function buildStreams() {
    var data = (global.SCIMAP_VECTORS || {}).streams;
    streamGroup = new THREE.Group();
    // The lines answer to the Stream network switch; the flowing water has
    // its own (Animate flow), so it lives beside them rather than inside.
    features.streams = new THREE.Group();
    streamGroup.add(features.streams);
    if (!data || !data.features || !data.features.length) return;

    var offset = surfaceOffset();
    var paths = [];

    data.features.forEach(function (feature) {
      var coords = feature.geometry.coordinates;
      if (!coords || coords.length < 2) return;
      var points = [], flat = [], colours = [];
      var norm = feature.properties.riskNorm;
      if (norm === null || norm === undefined) norm = 0;
      var lut = global.SCIMAP.rampLut('plasma');
      var slot = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3;
      var r = lut[slot] / 255, g = lut[slot + 1] / 255, b = lut[slot + 2] / 255;

      for (var i = 0; i < coords.length; i++) {
        var p = lift(coords[i][1], coords[i][0]);
        if (!isFinite(p.z)) continue;
        points.push(p);
        flat.push(p.x, p.y, p.z + offset);
        colours.push(r, g, b);
      }
      if (points.length < 2) return;

      features.streams.add(fatLine(flat, colours, {
        vertexColors: true, linewidth: 1.5 + norm * 3.5,
        transparent: true, opacity: 0.55 + norm * 0.45, dashed: false
      }));

      paths.push({points: points, risk: norm, offset: offset});
    });

    buildFlow(paths);
  }

  /** The other Features: catchment outline, stream risk points, pour point.
   *
   * Styled as on the 2D map, so a switch shows the same thing in both views.
   * The outline and the points sit in streamGroup's frame and so follow the
   * vertical exaggeration with it; the pour point is a sphere, which scaling
   * would squash, so it is kept at true scale and lifted by hand instead.
   */
  function buildFeatures() {
    var data = global.SCIMAP_VECTORS || {};
    var offset = surfaceOffset();

    if (data.catchment) {
      features.catchment = new THREE.Group();
      var dash = Math.hypot(spanX, spanY) / 160;
      polygonRings(data.catchment).forEach(function (ring) {
        var flat = [];
        ring.forEach(function (coord) {
          var p = lift(coord[1], coord[0], 3);
          if (isFinite(p.z)) flat.push(p.x, p.y, p.z + offset);
        });
        if (flat.length < 6) return;
        features.catchment.add(fatLine(flat, null, {
          color: 0xf4f1ea, linewidth: 2, transparent: true, opacity: 0.9,
          dashed: true, dashSize: dash, gapSize: dash * 0.65
        }));
      });
      streamGroup.add(features.catchment);
    }

    var points = (data.points || {}).features || [];
    if (points.length) {
      var lut = global.SCIMAP.rampLut('plasma');
      var positions = [], colours = [];
      points.forEach(function (feature) {
        var coord = (feature.geometry || {}).coordinates;
        if (!coord) return;
        var p = lift(coord[1], coord[0]);
        if (!isFinite(p.z)) return;
        var norm = feature.properties.riskNorm || 0;
        var slot = Math.max(0, Math.min(255, Math.round(norm * 255))) * 3;
        positions.push(p.x, p.y, p.z + offset * 1.5);
        colours.push(lut[slot] / 255, lut[slot + 1] / 255, lut[slot + 2] / 255);
      });
      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
      // Dots a fixed six pixels across, as on the 2D map: sized in metres
      // they shrink below a pixel at catchment scale and vanish.
      features.points = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 6, sizeAttenuation: false, vertexColors: true,
        map: roundSprite(), alphaTest: 0.5
      }));
      streamGroup.add(features.points);
    }

    var outlets = (data.pourPoint || {}).features || [];
    if (outlets.length) {
      features.pourPoint = new THREE.Group();
      var radius = Math.hypot(spanX, spanY) / 120;
      var ball = new THREE.SphereGeometry(radius, 24, 16);
      var rim = new THREE.SphereGeometry(radius * 1.3, 24, 16);
      outlets.forEach(function (feature) {
        var coord = (feature.geometry || {}).coordinates;
        if (!coord) return;
        var p = lift(coord[1], coord[0], 3);
        if (!isFinite(p.z)) return;
        var marker = new THREE.Group();
        marker.add(new THREE.Mesh(ball, new THREE.MeshStandardMaterial({
          color: 0x2a78d6, emissive: 0x0d2f5c, roughness: 0.45
        })));
        // A white rim, as on the 2D marker: the far side of a slightly larger
        // sphere shows only around the edge.
        marker.add(new THREE.Mesh(rim, new THREE.MeshBasicMaterial({
          color: 0xffffff, side: THREE.BackSide
        })));
        marker.position.set(p.x, p.y, p.z);
        features.pourPoint.add(marker);
        markers.push({object: marker, z: p.z, lift: radius * 1.3});
      });
      scene.add(features.pourPoint);
    }

    var areas = (data.priorityAreas || {}).features || [];
    if (areas.length) {
      features.priorityAreas = new THREE.Group();
      var badge = Math.hypot(spanX, spanY) / 42;
      areas.forEach(function (feature) {
        var props = feature.properties;
        var colour = global.SCIMAP.driverOf(props.driver).colour;
        // Hex colours are sRGB; the renderer works linear and encodes on
        // output, so convert or the outline comes out paler than on the map.
        var linear = new THREE.Color(colour).convertSRGBToLinear();
        polygonRings({features: [feature]}).forEach(function (ring) {
          var flat = [];
          ring.forEach(function (coord) {
            var p = lift(coord[1], coord[0], 2);
            if (isFinite(p.z)) flat.push(p.x, p.y, p.z + offset);
          });
          if (flat.length < 6) return;
          features.priorityAreas.add(fatLine(flat, null, {
            color: linear, linewidth: 2.6, transparent: true, opacity: 0.95, dashed: false
          }));
        });
        if (props.labelLat === null || props.labelLat === undefined) return;
        var at = lift(props.labelLat, props.labelLon, 2);
        if (!isFinite(at.z)) return;
        var sprite = rankSprite(props.rank, colour, badge);
        // Raised clear of the ground; streamGroup's vertical scale carries it
        // up and down with the exaggeration.
        sprite.position.set(at.x, at.y, at.z + badge * 0.9);
        features.priorityAreas.add(sprite);
      });
      streamGroup.add(features.priorityAreas);
    }

    Object.keys(features).forEach(function (name) {
      features[name].visible = !!global.SCIMAP.state.vectors[name];
    });
  }

  /** A white disc, so points draw round rather than square. Built in JS as a
   *  DataTexture, like every texture here (see the header). */
  function roundSprite() {
    var size = 32, pixels = new Uint8Array(size * size * 4);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var at = (y * size + x) * 4;
        var inside = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) <= size / 2;
        pixels[at] = pixels[at + 1] = pixels[at + 2] = 255;
        pixels[at + 3] = inside ? 255 : 0;
      }
    }
    var texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat);
    texture.needsUpdate = true;
    return texture;
  }

  /** A numbered badge facing the camera, as on the 2D map.
   *
   * Drawn from a canvas made here, which WebGL accepts on file:// where it
   * would refuse an image file. Drawn over the terrain rather than hidden by
   * it, so an area behind a ridge can still be found. */
  function rankSprite(rank, colour, size) {
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    var ctx = canvas.getContext('2d');
    ctx.beginPath();
    ctx.arc(32, 32, 27, 0, Math.PI * 2);
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 30px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(rank), 32, 34);

    var texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;      // as the drape: see the header
    var sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, depthTest: false, transparent: true, fog: false
    }));
    sprite.scale.set(size, size, 1);
    sprite.renderOrder = 10;
    return sprite;
  }

  function polygonRings(collection) {
    var rings = [];
    (collection.features || []).forEach(function (feature) {
      var geometry = feature.geometry || {};
      if (geometry.type === 'Polygon') rings.push.apply(rings, geometry.coordinates);
      else if (geometry.type === 'MultiPolygon') {
        geometry.coordinates.forEach(function (polygon) { rings.push.apply(rings, polygon); });
      }
    });
    return rings;
  }

  /** Particles advected downstream, with direction taken from the terrain.
   *
   * Vertex order out of RasterStreamsToVector is not reliably downstream, so
   * direction comes from comparing elevation at the two ends. Getting this
   * wrong makes water visibly run uphill.
   */
  function buildFlow(paths) {
    var perPath = [], total = 0;
    var budget = 6000;
    var minFlowLength = Math.max((spanX / meshWidth) * 3, 30);

    paths.forEach(function (path) {
      var points = path.points.slice();
      if (points[0].z < points[points.length - 1].z) points.reverse();

      var cumulative = [0];
      for (var i = 1; i < points.length; i++) {
        var dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
        cumulative.push(cumulative[i - 1] + Math.hypot(dx, dy));
      }
      var length = cumulative[cumulative.length - 1];
      if (length < minFlowLength) return;
      perPath.push({points: points, cumulative: cumulative, length: length,
                    risk: path.risk, offset: path.offset});
      total += length;
    });
    if (!perPath.length) return;

    var particles = [];
    perPath.forEach(function (path) {
      // Denser on long reaches and on risky ones, so the eye goes where it matters.
      var share = Math.max(1, Math.round(budget * (path.length / total) * (0.5 + path.risk)));
      for (var i = 0; i < share && particles.length < budget; i++) {
        particles.push({path: path, s: Math.random() * path.length,
                        speed: 12 + path.risk * 40 + Math.random() * 8});
      }
    });

    var positions = new Float32Array(particles.length * 3);
    var colours = new Float32Array(particles.length * 3);
    // Same plasma ramp as the stream lines, so a particle and the reach it
    // runs along read as the same risk.
    //
    // Brightened by scaling and a small floor, NOT by adding a big per-channel
    // offset: offsets of +0.35/+0.45/+0.55 saturate two channels at every risk
    // level, which collapses deep violet and bright yellow into much the same
    // white and loses the colouring entirely under additive blending.
    var lut = global.SCIMAP.rampLut('plasma');
    var BOOST = 1.15, FLOOR = 0.06;
    particles.forEach(function (particle, i) {
      var slot = Math.max(0, Math.min(255, Math.round(particle.path.risk * 255))) * 3;
      colours[i * 3] = Math.min(1, lut[slot] / 255 * BOOST + FLOOR);
      colours[i * 3 + 1] = Math.min(1, lut[slot + 1] / 255 * BOOST + FLOOR);
      colours[i * 3 + 2] = Math.min(1, lut[slot + 2] / 255 * BOOST + FLOOR);
    });

    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
    flowPoints = new THREE.Points(geometry, new THREE.PointsMaterial({
      size: Math.max(spanX / 420, 3), vertexColors: true, transparent: true,
      opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending
    }));
    flowState = {particles: particles};
    streamGroup.add(flowPoints);
  }

  function advanceFlow(delta) {
    if (!flowState || !flowPoints || !global.SCIMAP.state.flow) return;
    var attribute = flowPoints.geometry.attributes.position;
    var array = attribute.array;

    flowState.particles.forEach(function (particle, i) {
      var path = particle.path;
      particle.s = (particle.s + particle.speed * delta) % path.length;

      // Walk to the segment holding s. Reaches are short, so a linear scan
      // beats keeping a search structure per particle.
      var at = 1;
      while (at < path.cumulative.length - 1 && path.cumulative[at] < particle.s) at++;
      var previous = path.cumulative[at - 1];
      var segment = path.cumulative[at] - previous || 1;
      var t = (particle.s - previous) / segment;
      var a = path.points[at - 1], b = path.points[at];

      array[i * 3] = a.x + (b.x - a.x) * t;
      array[i * 3 + 1] = a.y + (b.y - a.y) * t;
      array[i * 3 + 2] = (a.z + (b.z - a.z) * t) + path.offset * 1.6;
    });
    attribute.needsUpdate = true;
  }

  // ── scene lifecycle ─────────────────────────────────────────────────────

  function hostWidth() { return Math.max(host.clientWidth, 1); }
  function hostHeight() { return Math.max(host.clientHeight, 1); }

  function start(elementId, options) {
    if (started) { resize(); return true; }
    host = document.getElementById(elementId);
    if (!host || !supported()) return false;
    options = options || {};

    var grid = global.SCIMAP_GRID;
    var built = buildTerrain(grid, options.meshCap || 512);

    renderer = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true});
    // preserveDrawingBuffer is required or screenshots and printing come out blank.
    renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2));
    renderer.setSize(hostWidth(), hostHeight());
    renderer.outputEncoding = THREE.sRGBEncoding;
    host.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1016);
    scene.fog = new THREE.Fog(0x0b1016, spanX * 1.4, spanX * 4.5);

    terrain = new THREE.Mesh(built.geometry, new THREE.MeshStandardMaterial({
      map: drapeTexture(),
      roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide
    }));
    scene.add(terrain);

    terrainBuild = built;
    skirt = buildSkirt(built);
    if (skirt) scene.add(skirt);

    scene.add(new THREE.AmbientLight(0xdfe7f2, 0.5));
    sun = new THREE.DirectionalLight(0xfff2dd, 1.35);
    scene.add(sun);
    positionSun();
    scene.add(new THREE.HemisphereLight(0x8fb2d9, 0x2b2a26, 0.35));

    buildStreams();
    scene.add(streamGroup);
    buildFeatures();

    var diagonal = Math.hypot(spanX, spanY);
    camera = new THREE.PerspectiveCamera(42, hostWidth() / hostHeight(),
                                         diagonal / 500, diagonal * 12);
    camera.up.set(0, 0, 1);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = diagonal * 0.12;
    controls.maxDistance = diagonal * 4;
    // Auto-rotate needs controls.update() every frame, which the render loop
    // already does for damping. A slow orbit: about one turn every 40 seconds,
    // enough to read the terrain without making anyone seasick.
    controls.autoRotate = !!global.SCIMAP.state.spin && !prefersReducedMotion();
    controls.autoRotateSpeed = 0.9;
    frame((built.zMin + built.zMax) / 2);

    applyExaggeration(global.SCIMAP.state.exaggeration);
    started = true;
    wireState();
    loop();
    return true;
  }

  function positionSun() {
    var state = global.SCIMAP.state.sun;
    var azimuth = (state.azimuth - 90) * Math.PI / 180;
    var altitude = state.altitude * Math.PI / 180;
    var distance = Math.hypot(spanX, spanY) * 1.5;
    sun.position.set(
      Math.cos(azimuth) * Math.cos(altitude) * distance,
      -Math.sin(azimuth) * Math.cos(altitude) * distance,
      Math.sin(altitude) * distance + 100
    );
  }

  function applyExaggeration(factor) {
    if (!terrain) return;
    terrain.scale.z = factor;
    if (skirt) skirt.scale.z = factor;
    if (streamGroup) streamGroup.scale.z = factor;
    markers.forEach(function (marker) {
      marker.object.position.z = marker.z * factor + marker.lift;
    });
  }

  var lastFrame = 0;
  function loop(now) {
    animationHandle = requestAnimationFrame(loop);
    if (disposed) return;
    var delta = lastFrame ? Math.min((now - lastFrame) / 1000, 0.1) : 0.016;
    lastFrame = now || 0;

    if (!prefersReducedMotion()) advanceFlow(delta);
    controls.update();
    renderer.render(scene, camera);
  }

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function wireState() {
    global.SCIMAP.on('layer-visibility', refreshDrape);
    global.SCIMAP.on('layer-opacity', refreshDrape);
    global.SCIMAP.on('vector-visibility', function (event) {
      if (features[event.name]) features[event.name].visible = event.visible;
    });
    global.SCIMAP.on('state', function (event) {
      var changed = event.changed;
      if (changed.indexOf('exaggeration') >= 0) applyExaggeration(event.state.exaggeration);
      if (changed.indexOf('sun') >= 0) { positionSun(); refreshDrape(); }
      if (changed.indexOf('pixelated') >= 0) refreshDrape();
      if (changed.indexOf('flow') >= 0 && flowPoints) {
        flowPoints.visible = !!event.state.flow;
      }
      if (changed.indexOf('spin') >= 0 && controls) {
        controls.autoRotate = !!event.state.spin && !prefersReducedMotion();
      }
    });
  }

  function resize() {
    if (!started || !host) return;
    renderer.setSize(hostWidth(), hostHeight());
    camera.aspect = hostWidth() / hostHeight();
    camera.updateProjectionMatrix();
    fatLines.forEach(function (material) {
      material.resolution.set(hostWidth(), hostHeight());
    });
  }

  function pause() { if (animationHandle) { cancelAnimationFrame(animationHandle); animationHandle = null; } }
  function resume() {
    if (!started || animationHandle) return;
    if (drapeStale) applyDrape();          // switches changed while hidden
    lastFrame = 0;
    loop();
  }

  function screenshot() {
    if (!renderer) return null;
    renderer.render(scene, camera);           // guarantee a fresh frame
    return renderer.domElement.toDataURL('image/png');
  }

  // ── exporting the model ─────────────────────────────────────────────────

  /* The catchment as a solid object: the terrain surface and the skirt that
   * closes it down to a base, exactly as displayed — current drape, current
   * vertical exaggeration. What you export is what you are looking at.
   *
   * Surface, sides and a flat base, so the mesh is watertight and a slicer
   * will take it without repair.
   *
   * The stream network is deliberately left out. Those are Line2 fat lines:
   * instanced geometry drawn by a custom shader that fakes thickness in screen
   * space. No interchange format carries that, and exporting the instance
   * buffers would produce a mesh that means nothing. The risk they show is
   * already in the drape texture.
   *
   * Coordinates are ground metres (Web Mercator metres corrected by
   * cos(latitude)) with Z as elevation, so a catchment is tens of thousands of
   * units across. Slicers read STL as millimetres and will need it scaled.
   */
  function exportGroup(withBase) {
    if (!terrain) return null;
    var group = new THREE.Group();
    // Named, so the parts are labelled in Blender and in the USDZ.
    var surface = terrain.clone();
    surface.name = 'Terrain';
    group.add(surface);
    if (skirt) {
      var sides = skirt.clone();
      sides.name = 'Sides';
      group.add(sides);
    }

    // The underside, built here only. Surface + sides + base is a closed
    // solid: every edge belongs to exactly two triangles, which is what a
    // slicer needs before it will print the catchment.
    //
    // Skipped when only the size is wanted: it allocates a couple of million
    // floats, and it cannot change the bounding box — it lies flat at the base
    // the skirt already reaches, inside the terrain's own footprint.
    if (withBase !== false) {
      var cap = terrainBuild ? buildBaseCap(terrainBuild) : null;
      if (cap) {
        cap.name = 'Base';
        cap.scale.z = terrain.scale.z;    // match the exaggeration on screen
        group.add(cap);
      }
    }

    group.updateMatrixWorld(true);
    return group;
  }

  //: longest side of an exported model, in millimetres
  var DEFAULT_PRINT_MM = 200;

  /* How many model units make a millimetre, per format.
   *
   * STL and OBJ record no unit at all and every slicer reads them as
   * millimetres, so one unit is one millimetre. glTF defines its unit as the
   * metre. The same physical object is therefore a thousand times smaller in
   * glTF than in STL, and using one number for both gives a model 1000x wrong
   * in whichever world you did not think about. USDZ is written in metres
   * too, and AR Quick Look shows it at that true size: a 200 mm model stands
   * on the table 200 mm across. */
  var UNITS_PER_MM = {stl: 1, obj: 1, glb: 0.001, usdz: 0.001};

  /** Shrink *group* until its longest side is *sizeMm*, and stand it on z = 0.
   *
   * Scaled on the longest of all three axes, so the result fits inside a cube
   * of that size whichever way the catchment is elongated. In practice relief
   * is a rounding error next to the width of a catchment, so it is the map
   * footprint that decides.
   */
  /** Bounding box of the triangles that will actually be written out.
   *
   * Box3.setFromObject measures a geometry's whole position buffer, and the
   * terrain's holds the full grid rectangle — every vertex outside the
   * catchment included, none of which any triangle references. Measuring that
   * makes the catchment come out short of the size asked for and off centre.
   */
  function drawnBox(group) {
    var box = new THREE.Box3();
    var point = new THREE.Vector3();
    group.updateMatrixWorld(true);
    group.traverse(function (node) {
      if (!node.isMesh) return;
      var position = node.geometry.getAttribute('position');
      var index = node.geometry.getIndex();
      var count = index ? index.count : position.count;
      for (var i = 0; i < count; i++) {
        var at = index ? index.getX(i) : i;
        point.set(position.getX(at), position.getY(at), position.getZ(at));
        box.expandByPoint(point.applyMatrix4(node.matrixWorld));
      }
    });
    return box.isEmpty() ? null : box;
  }

  function fitToBox(group, sizeMm, unitsPerMm) {
    group.updateMatrixWorld(true);
    var box = drawnBox(group);
    if (!box) return null;
    var size = box.getSize(new THREE.Vector3());
    var longest = Math.max(size.x, size.y, size.z);
    if (!(longest > 0)) return null;

    var scale = (sizeMm * unitsPerMm) / longest;
    group.scale.multiplyScalar(scale);
    // Centred on the plate and sitting on it, rather than half-buried: the
    // model's own zero is the middle of the terrain, not the bottom.
    group.position.set(-(box.min.x + box.max.x) / 2 * scale,
                       -(box.min.y + box.max.y) / 2 * scale,
                       -box.min.z * scale);
    group.updateMatrixWorld(true);

    return {
      scale: scale,
      mm: {x: size.x * scale / unitsPerMm,
           y: size.y * scale / unitsPerMm,
           z: size.z * scale / unitsPerMm},
      // Map scale from the ground footprint, which is what "1:25,000" means.
      // The vertical is separately exaggerated and is quoted on its own.
      ratio: Math.max(size.x, size.y) / (sizeMm * 0.001)
    };
  }

  /** What a given printed size works out as, for the panel to show. */
  function modelSize(sizeMm) {
    var group = exportGroup(false);
    if (!group) return null;
    return fitToBox(group, sizeMm || DEFAULT_PRINT_MM, 1);
  }

  /** Build a model file. Calls *done(blob, extension)*, or done(null, reason). */
  function exportModel(format, options, done) {
    // Saved from the 2D map, the drape may predate the latest switches.
    if (drapeStale) applyDrape();
    var group = exportGroup();
    if (!group) { done(null, 'the terrain has not been built yet'); return; }

    var sizeMm = (options && options.sizeMm) || DEFAULT_PRINT_MM;
    if (!fitToBox(group, sizeMm, UNITS_PER_MM[format] || 1)) {
      done(null, 'the terrain has no size to scale');
      return;
    }

    try {
      if (format === 'stl') {
        if (!THREE.STLExporter) { done(null, 'the STL exporter is missing'); return; }
        var stl = new THREE.STLExporter().parse(group, {binary: true});
        done(new Blob([stl], {type: 'model/stl'}), 'stl');
        return;
      }
      if (format === 'obj') {
        if (!THREE.OBJExporter) { done(null, 'the OBJ exporter is missing'); return; }
        done(new Blob([new THREE.OBJExporter().parse(group)],
                      {type: 'text/plain'}), 'obj');
        return;
      }
      if (format === 'usdz') {
        if (!global.SCIMAP_USDZ) { done(null, 'the USDZ writer is missing'); return; }
        // Asynchronous for the same reason as glTF: the drape becomes a PNG.
        global.SCIMAP_USDZ.build(group, function (blob, reason) {
          done(blob, blob ? 'usdz' : reason);
        });
        return;
      }
      if (!THREE.GLTFExporter) { done(null, 'the glTF exporter is missing'); return; }
      // Asynchronous because it rasterises the drape DataTexture to a PNG.
      // That canvas is clean: the texture was built in JS from embedded
      // arrays, never loaded from a file:// image, so toDataURL works here
      // where it would throw on anything Leaflet drew.
      new THREE.GLTFExporter().parse(group, function (result) {
        done(new Blob([result], {type: 'model/gltf-binary'}), 'glb');
      }, function (error) {
        done(null, (error && error.message) || 'the glTF exporter failed');
      }, {binary: true});
    } catch (error) {
      done(null, error.message || String(error));
    }
  }

  /** Place the camera so the whole catchment sits in frame, looking north. */
  function frame(centreZ) {
    if (!controls) return;
    var diagonal = Math.hypot(spanX, spanY);
    // Back off far enough for the wider of the two axes to fit the viewport.
    var vertical = Math.tan(camera.fov * Math.PI / 360);
    var horizontal = vertical * camera.aspect;
    var distance = Math.max(spanY / (2 * vertical), spanX / (2 * horizontal)) * 1.55;
    var pitch = 38 * Math.PI / 180;

    controls.target.set(0, 0, centreZ === undefined ? 0 : centreZ);
    camera.position.set(
      controls.target.x,
      controls.target.y - Math.cos(pitch) * distance,
      controls.target.z + Math.sin(pitch) * distance + diagonal * 0.05
    );
    controls.update();
  }

  function resetView() { frame(); }

  global.SCIMAP_MAP3D = {
    start: start, resize: resize, pause: pause, resume: resume,
    screenshot: screenshot, exportModel: exportModel, modelSize: modelSize,
    resetView: resetView, supported: supported,
    isStarted: function () { return started; }
  };
})(window);
