/* SCIMAP dashboard — USDZ writer, for AR Quick Look on iPhone and iPad.
 *
 * three.js r147 does ship a classic-script USDZExporter, but it cannot be used
 * for this scene, for three reasons:
 *   - it only rasterises <img> and <canvas> textures and throws on a
 *     DataTexture, which is the only kind this page may use (see the header
 *     of scimap-map3d.js);
 *   - it writes texture coordinates as 1 - v without turning the image over
 *     to match, which mirrors the drape north-south;
 *   - it writes every vertex in the buffer at seven significant figures. The
 *     terrain's buffer is the whole grid rectangle, most of it outside the
 *     catchment, so the file comes out several times the size it needs to be.
 * A USDZ is only USDA text plus a PNG in an uncompressed zip, so writing it
 * here is less code than working around all three.
 *
 * Input is the group scimap-map3d.js builds for export, already scaled to
 * metres and standing on z = 0. The scene is Z-up; USDZ is read Y-up, and AR
 * Quick Look ignores a file that says otherwise, so the axes are turned here.
 */
(function (global) {
  'use strict';

  // ── zip ─────────────────────────────────────────────────────────────────

  var crcTable = null;

  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /** Zip *entries* ({name, data}) the way USDZ requires.
   *
   * Every member is stored, never deflated, and its data starts on a 64-byte
   * boundary so a viewer can map it straight from the archive. The padding
   * goes in the local header's extra field, under an ID readers skip. The
   * first member is the one a viewer opens, so the scene goes first.
   */
  function zipStored(entries) {
    var encoder = new TextEncoder();
    var parts = [], directory = [], offset = 0;
    var DOS_DATE = (1 << 5) | 1;               // 1 January 1980: no clock in the file

    entries.forEach(function (entry) {
      var name = encoder.encode(entry.name);
      var size = entry.data.length;
      var crc = crc32(entry.data);
      var dataAt = offset + 30 + name.length;
      var extra = dataAt % 64 ? 4 + (64 - (dataAt + 4) % 64) % 64 : 0;

      var local = new DataView(new ArrayBuffer(30 + name.length + extra));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 10, true);             // version needed: stored
      local.setUint16(12, DOS_DATE, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, extra, true);
      new Uint8Array(local.buffer).set(name, 30);
      if (extra) {
        local.setUint16(30 + name.length, 0x3039, true);
        local.setUint16(32 + name.length, extra - 4, true);
      }
      parts.push(local.buffer, entry.data);

      var central = new DataView(new ArrayBuffer(46 + name.length));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);           // version made by
      central.setUint16(6, 10, true);
      central.setUint16(14, DOS_DATE, true);
      central.setUint32(16, crc, true);
      central.setUint32(20, size, true);
      central.setUint32(24, size, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, offset, true);
      new Uint8Array(central.buffer).set(name, 46);
      directory.push(central.buffer);

      offset = dataAt + extra + size;
    });

    var directorySize = directory.reduce(function (sum, b) { return sum + b.byteLength; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);

    return new Blob(parts.concat(directory, [end.buffer]), {type: 'model/vnd.usdz+zip'});
  }

  // ── geometry ────────────────────────────────────────────────────────────

  /* Trim "0.50000" to "0.5" and "-0.00000" to "0". A catchment has hundreds
   * of thousands of these numbers, and trailing zeros would be much of the
   * file. Five places of a metre is a hundredth of a millimetre. */
  function num(value, places) { return String(+value.toFixed(places)); }

  /** One mesh as a USD Mesh prim: world space, Y-up, used vertices only. */
  function meshPrim(node, name, materialPath) {
    var geometry = node.geometry;
    var position = geometry.getAttribute('position');
    var normal = geometry.getAttribute('normal');
    var uv = geometry.getAttribute('uv');
    var index = geometry.getIndex();
    var count = index ? index.count : position.count;
    if (count < 3) return '';

    // Renumber to the vertices a triangle actually uses.
    var remap = new Int32Array(position.count).fill(-1);
    var used = [];
    var faces = new Uint32Array(count);
    for (var i = 0; i < count; i++) {
      var source = index ? index.getX(i) : i;
      if (remap[source] < 0) { remap[source] = used.length; used.push(source); }
      faces[i] = remap[source];
    }

    var normalMatrix = new THREE.Matrix3().getNormalMatrix(node.matrixWorld);
    var p = new THREE.Vector3(), n = new THREE.Vector3();
    var box = new THREE.Box3();
    var points = new Array(used.length);
    var normals = normal ? new Array(used.length) : null;
    var st = uv ? new Array(used.length) : null;

    // (x, y, z) Z-up becomes (x, z, -y) Y-up: a rotation, so the triangles
    // keep their winding and still face outward.
    used.forEach(function (at, out) {
      p.fromBufferAttribute(position, at).applyMatrix4(node.matrixWorld);
      p.set(p.x, p.z, -p.y);
      box.expandByPoint(p);
      points[out] = '(' + num(p.x, 5) + ',' + num(p.y, 5) + ',' + num(p.z, 5) + ')';
      if (normals) {
        n.fromBufferAttribute(normal, at).applyMatrix3(normalMatrix).normalize();
        normals[out] = '(' + num(n.x, 4) + ',' + num(n.z, 4) + ',' + num(-n.y, 4) + ')';
      }
      // USD reads t = 0 as the bottom of the image, as GL does, so the
      // coordinates go through unchanged; texturePng puts the rows the same
      // way round.
      if (st) st[out] = '(' + num(uv.getX(at), 5) + ',' + num(uv.getY(at), 5) + ')';
    });

    var lines = [
      '    def Mesh "' + name + '" (',
      '        prepend apiSchemas = ["MaterialBindingAPI"]',
      '    )',
      '    {',
      '        uniform bool doubleSided = ' + (node.material.side === THREE.DoubleSide ? 1 : 0),
      '        float3[] extent = [(' + num(box.min.x, 5) + ',' + num(box.min.y, 5) + ',' +
        num(box.min.z, 5) + '),(' + num(box.max.x, 5) + ',' + num(box.max.y, 5) + ',' +
        num(box.max.z, 5) + ')]',
      '        int[] faceVertexCounts = [' + new Array(count / 3).fill(3).join(',') + ']',
      '        int[] faceVertexIndices = [' + faces.join(',') + ']',
      '        rel material:binding = <' + materialPath + '>'
    ];
    if (normals) {
      lines.push('        normal3f[] normals = [' + normals.join(',') + '] (',
                 '            interpolation = "vertex"', '        )');
    }
    lines.push('        point3f[] points = [' + points.join(',') + ']');
    if (st) {
      lines.push('        texCoord2f[] primvars:st = [' + st.join(',') + '] (',
                 '            interpolation = "vertex"', '        )');
    }
    lines.push('        uniform token subdivisionScheme = "none"', '    }', '');
    return lines.join('\n');
  }

  // ── materials ───────────────────────────────────────────────────────────

  /** A UsdPreviewSurface matching a MeshStandardMaterial, as the screen shows it. */
  function materialPrim(material, path, name, textureFile) {
    var colour = material.color;
    var lines = [
      '        def Material "' + name + '"',
      '        {',
      '            token outputs:surface.connect = <' + path + '/Surface.outputs:surface>',
      '',
      '            def Shader "Surface"',
      '            {',
      '                uniform token info:id = "UsdPreviewSurface"',
      textureFile
        ? '                color3f inputs:diffuseColor.connect = <' + path + '/Texture.outputs:rgb>'
        : '                color3f inputs:diffuseColor = (' + num(colour.r, 4) + ',' +
          num(colour.g, 4) + ',' + num(colour.b, 4) + ')',
      '                float inputs:metallic = ' + num(material.metalness, 3),
      '                float inputs:roughness = ' + num(material.roughness, 3),
      '                token outputs:surface',
      '            }'
    ];
    if (textureFile) {
      lines.push(
        '',
        '            def Shader "Reader"',
        '            {',
        '                uniform token info:id = "UsdPrimvarReader_float2"',
        '                float2 inputs:fallback = (0,0)',
        '                string inputs:varname = "st"',
        '                float2 outputs:result',
        '            }',
        '',
        '            def Shader "Texture"',
        '            {',
        '                uniform token info:id = "UsdUVTexture"',
        '                asset inputs:file = @' + textureFile + '@',
        '                float2 inputs:st.connect = <' + path + '/Reader.outputs:result>',
        // The drape is sRGB, exactly as the renderer decodes it on screen.
        '                token inputs:sourceColorSpace = "sRGB"',
        '                token inputs:wrapS = "clamp"',
        '                token inputs:wrapT = "clamp"',
        '                float3 outputs:rgb',
        '            }'
      );
    }
    lines.push('        }', '');
    return lines.join('\n');
  }

  /** A DataTexture as PNG bytes. Calls *done(bytes)*, or done(null, reason). */
  function texturePng(texture, done) {
    var image = texture.image;
    if (!image || !image.data || !image.width || !image.height) {
      done(null, 'the drape texture has no pixel data');
      return;
    }
    var width = image.width, height = image.height, rowBytes = width * 4;
    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var context = canvas.getContext('2d');
    var pixels = context.createImageData(width, height);

    // A PNG is stored top row first, and USD puts its first row at t = 1. A
    // DataTexture with flipY off holds its bottom row first (the drape is
    // built that way: see drapeTexture), so its rows go in reversed.
    for (var row = 0; row < height; row++) {
      var from = texture.flipY ? row : height - 1 - row;
      pixels.data.set(image.data.subarray(from * rowBytes, (from + 1) * rowBytes),
                      row * rowBytes);
    }
    context.putImageData(pixels, 0, 0);

    // A clean canvas, built from embedded arrays and never from a file://
    // image, so toBlob is allowed here.
    canvas.toBlob(function (blob) {
      if (!blob) { done(null, 'the browser could not encode the drape as PNG'); return; }
      blob.arrayBuffer().then(function (buffer) { done(new Uint8Array(buffer)); },
                              function () { done(null, 'could not read the drape PNG'); });
    }, 'image/png');
  }

  // ── the file ────────────────────────────────────────────────────────────

  /** Write *group* as a USDZ. Calls *done(blob)*, or done(null, reason). */
  function build(group, done) {
    try {
      group.updateMatrixWorld(true);
      var meshes = [];
      group.traverse(function (node) { if (node.isMesh) meshes.push(node); });

      var materials = [], byUuid = {}, texture = null;
      var prims = meshes.map(function (node, i) {
        var material = node.material;
        var entry = byUuid[material.uuid];
        if (!entry) {
          entry = {material: material, name: 'Material' + materials.length};
          // One texture: the drape. Anything else with a map would need its
          // own file, and nothing in this scene has one.
          if (material.map && !texture) { texture = material.map; entry.textured = true; }
          byUuid[material.uuid] = entry;
          materials.push(entry);
        }
        var name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(node.name) ? node.name : 'Mesh' + i;
        return meshPrim(node, name, '/Catchment/Materials/' + entry.name);
      });

      var TEXTURE_FILE = 'textures/drape.png';
      var text = [
        '#usda 1.0',
        '(',
        '    customLayerData = {',
        '        string creator = "SCIMAP dashboard"',
        '    }',
        '    defaultPrim = "Catchment"',
        '    metersPerUnit = 1',
        '    upAxis = "Y"',
        ')',
        '',
        'def Xform "Catchment" (',
        '    kind = "component"',
        ')',
        '{',
        prims.join('\n'),
        '    def Scope "Materials"',
        '    {',
        materials.map(function (entry) {
          return materialPrim(entry.material, '/Catchment/Materials/' + entry.name,
                              entry.name, entry.textured ? TEXTURE_FILE : null);
        }).join('\n'),
        '    }',
        '}',
        ''
      ].join('\n');
      var scene = new TextEncoder().encode(text);
      text = null;

      if (!texture) {
        done(zipStored([{name: 'scene.usda', data: scene}]));
        return;
      }
      texturePng(texture, function (png, reason) {
        if (!png) { done(null, reason); return; }
        try {
          done(zipStored([{name: 'scene.usda', data: scene},
                          {name: TEXTURE_FILE, data: png}]));
        } catch (error) {
          done(null, error.message || String(error));
        }
      });
    } catch (error) {
      done(null, error.message || String(error));
    }
  }

  global.SCIMAP_USDZ = {build: build};
})(window);
