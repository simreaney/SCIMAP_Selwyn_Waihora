# Vendored third-party libraries

These are committed rather than fetched from a CDN so a generated dashboard works with no
internet connection, and so archived result folders keep working years later.

Re-download with `qgis_plugin/web/fetch_vendor.sh`, then verify against the checksums below.

## Leaflet 1.9.4 — BSD-2-Clause
Source: https://unpkg.com/leaflet@1.9.4/dist/
Files: `leaflet.js`, `leaflet.css`, `images/{marker-icon,marker-icon-2x,marker-shadow,layers,layers-2x}.png`

`leaflet.css` references `images/` relatively, so the directory must stay next to it.

## three.js r147 — MIT
Source: https://unpkg.com/three@0.147.0/
Files: `build/three.min.js`, `examples/js/controls/OrbitControls.js`,
       `examples/js/lines/{LineSegmentsGeometry,LineSegments2,LineGeometry,Line2,LineMaterial}.js`,
       `examples/js/exporters/{GLTFExporter,STLExporter,OBJExporter}.js`

**r147 is pinned deliberately and must not be bumped casually.**
A dashboard is opened over `file://`, where ES modules are CORS-blocked, so three.js has to be
a classic UMD script that sets a `THREE` global:

* `examples/js/` (classic-script builds of OrbitControls, Line2, …) was removed in **r148**.
* `build/three.js` / `three.min.js` (UMD) were removed in **r150**.

r147 is therefore the last release that ships both. Moving to a newer three.js would require
adding a bundler to the plugin build, which this plugin deliberately does not have.

r147-era API, as used by `scimap-map3d.js` (newer names do NOT exist here):
* `renderer.outputEncoding = THREE.sRGBEncoding`  (not `outputColorSpace`, r152+)
* `texture.encoding = THREE.sRGBEncoding`         (not `texture.colorSpace`)
* `renderer.physicallyCorrectLights`              (not `useLegacyLights`, r155+)
* `BufferGeometry` only; `Geometry` is long gone.

## tiny-inflate 1.0.3 — MIT (Devon Govett)
Source: https://unpkg.com/tiny-inflate@1.0.3/index.js
Modified: wrapped in an IIFE that exposes `window.tinyInflate`, since the upstream file is
CommonJS. The algorithm itself is untouched.

Used as the fallback for `DecompressionStream('deflate-raw')` on older browsers. Both consume
**raw** deflate, which is what `core/webexport.py` emits.

## Checksums (SHA-256)
    066daca850d8ffbef007af00b06eac0015728dee279c51f3cb6c716df7c42edf  ./leaflet-1.9.4/images/layers-2x.png
    1dbbe9d028e292f36fcba8f8b3a28d5e8932754fc2215b9ac69e4cdecf5107c6  ./leaflet-1.9.4/images/layers.png
    00179c4c1ee830d3a108412ae0d294f55776cfeb085c60129a39aa6fc4ae2528  ./leaflet-1.9.4/images/marker-icon-2x.png
    574c3a5cca85f4114085b6841596d62f00d7c892c7b03f28cbfa301deb1dc437  ./leaflet-1.9.4/images/marker-icon.png
    264f5c640339f042dd729062cfc04c17f8ea0f29882b538e3848ed8f10edb4da  ./leaflet-1.9.4/images/marker-shadow.png
    a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6  ./leaflet-1.9.4/leaflet.css
    db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a  ./leaflet-1.9.4/leaflet.js
    b4c6e53f98538535b11fd6655627d47fb5877b3ad972568bff0a7026c4b6d5c4  ./three-r147/OrbitControls.js
    69ea3dedbb6d7282006e00741ae41f85672b05aa130a6d6da4f176d9535c44cd  ./three-r147/lines/Line2.js
    b8597c1a3a00e746c0928e0d4e945a932e6fb0bd876c837bd73f78e4ec01c0c8  ./three-r147/lines/LineGeometry.js
    d8c893e2083e632fd3c50c85ee6d75adef3f12a113c6b5b571a1cd4f6a5d4b7f  ./three-r147/lines/LineMaterial.js
    281c6bc39497492714b91eb9f23b4eb2d7f066f92463e5ed898fabb94fc73d2b  ./three-r147/lines/LineSegments2.js
    3d26374757e175cae78efc863294b132bbfeff39214b8c03424f70d3a4d454f3  ./three-r147/lines/LineSegmentsGeometry.js
    7ba9cf5888ff8c11768ff805d50081c383a91ae4dbf487750065bbbeccd45077  ./three-r147/exporters/GLTFExporter.js
    642bb32a1c5855ec08551af5bf971d1a5f0a6eb64a5b8f5f22335d37e7198892  ./three-r147/exporters/OBJExporter.js
    6441d5d5829ed3957e943cb0e254fff05b603824a96b0457f97ac2fc40cd5b47  ./three-r147/exporters/STLExporter.js
    f34446bf875b5fb0dcd93819ffe1d9e182d46634ee855f5d904c6c4ac7cdbc95  ./three-r147/three.min.js
    fa946129579ef6c18f953a0f163bc13448e21ea8a96327c0be6df9eb3b7014c8  ./tiny-inflate/tiny-inflate.js

