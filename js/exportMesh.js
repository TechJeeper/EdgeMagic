import * as THREE from "three";
import { zipSync, strToU8 } from "fflate";

/**
 * @param {THREE.BufferGeometry} geometry
 * @returns {ArrayBuffer}
 */
export function exportBinarySTL(geometry) {
  const g = geometry.clone();
  g.computeBoundingSphere();
  if (!g.getIndex()) {
    const pos = g.getAttribute("position");
    const n = pos.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const pos = g.getAttribute("position");
  const idx = g.getIndex();
  const triCount = idx.count / 3;
  const headerSize = 80;
  const dataSize = headerSize + 4 + triCount * 50;
  const buf = new ArrayBuffer(dataSize);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.fill(0, 0, headerSize);
  dv.setUint32(headerSize, triCount, true);
  let o = headerSize + 4;
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _c = new THREE.Vector3();
  const _ab = new THREE.Vector3();
  const _ac = new THREE.Vector3();
  const _n = new THREE.Vector3();
  for (let f = 0; f < triCount; f++) {
    const i0 = idx.getX(f * 3);
    const i1 = idx.getX(f * 3 + 1);
    const i2 = idx.getX(f * 3 + 2);
    _a.fromBufferAttribute(pos, i0);
    _b.fromBufferAttribute(pos, i1);
    _c.fromBufferAttribute(pos, i2);
    _ab.subVectors(_b, _a);
    _ac.subVectors(_c, _a);
    _n.crossVectors(_ab, _ac).normalize();
    if (!_n.lengthSq()) _n.set(0, 0, 1);
    dv.setFloat32(o, _n.x, true);
    dv.setFloat32(o + 4, _n.y, true);
    dv.setFloat32(o + 8, _n.z, true);
    dv.setFloat32(o + 12, _a.x, true);
    dv.setFloat32(o + 16, _a.y, true);
    dv.setFloat32(o + 20, _a.z, true);
    dv.setFloat32(o + 24, _b.x, true);
    dv.setFloat32(o + 28, _b.y, true);
    dv.setFloat32(o + 32, _b.z, true);
    dv.setFloat32(o + 36, _c.x, true);
    dv.setFloat32(o + 40, _c.y, true);
    dv.setFloat32(o + 44, _c.z, true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return buf;
}

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Minimal 3MF Core package (single mesh object).
 * @param {THREE.BufferGeometry} geometry
 * @param {string} objectName
 * @returns {Uint8Array}
 */
export function export3MF(geometry, objectName = "Mesh") {
  const g = geometry.index ? geometry : geometry.clone();
  if (!g.getIndex()) {
    const pos = g.getAttribute("position");
    const n = pos.count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  const pos = g.getAttribute("position");
  const idx = g.getIndex();
  const triCount = idx.count / 3;
  const verts = pos.count;
  const vParts = [];
  for (let i = 0; i < verts; i++) {
    vParts.push(
      `<vertex x="${pos.getX(i)}" y="${pos.getY(i)}" z="${pos.getZ(i)}" />`
    );
  }
  const tParts = [];
  for (let f = 0; f < triCount; f++) {
    const i0 = idx.getX(f * 3) + 1;
    const i1 = idx.getX(f * 3 + 1) + 1;
    const i2 = idx.getX(f * 3 + 2) + 1;
    tParts.push(`<triangle v1="${i0}" v2="${i1}" v3="${i2}" />`);
  }

  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${escapeXml(objectName)}</metadata>
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>
          ${vParts.join("\n          ")}
        </vertices>
        <triangles>
          ${tParts.join("\n          ")}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="1" />
  </build>
</model>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model" />
</Relationships>`;

  const files = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rels),
    "3D/3dmodel.model": strToU8(modelXml),
  };

  return zipSync(files);
}
