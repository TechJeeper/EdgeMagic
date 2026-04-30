import * as THREE from "three";

/**
 * Build a vertex adjacency map from an indexed BufferGeometry.
 * @param {THREE.BufferGeometry} geometry
 * @returns {{ adj: Map<number, Set<number>> }}
 */
function buildTopology(geometry) {
  const idx = geometry.getIndex();
  /** @type {Map<number, Set<number>>} */
  const adj = new Map();
  if (!idx) return { adj };
  const arr = idx.array;
  const triCount = arr.length / 3;
  function link(u, v) {
    if (!adj.has(u)) adj.set(u, new Set());
    if (!adj.has(v)) adj.set(v, new Set());
    adj.get(u).add(v);
    adj.get(v).add(u);
  }
  for (let f = 0; f < triCount; f++) {
    const i0 = arr[f * 3];
    const i1 = arr[f * 3 + 1];
    const i2 = arr[f * 3 + 2];
    link(i0, i1);
    link(i1, i2);
    link(i2, i0);
  }
  return { adj };
}

/**
 * Quantize a vertex position into a string key so vertices that are at the
 * same physical location but stored as separate indices (typical of
 * BoxGeometry / STL where each face keeps its own normal-shaded copy of
 * each corner) collapse to the same identifier.
 */
function makePosKeys(pos, vertCount, tol) {
  const inv = 1 / tol;
  const keys = new Array(vertCount);
  for (let v = 0; v < vertCount; v++) {
    const x = Math.round(pos[v * 3] * inv);
    const y = Math.round(pos[v * 3 + 1] * inv);
    const z = Math.round(pos[v * 3 + 2] * inv);
    keys[v] = `${x}_${y}_${z}`;
  }
  return keys;
}

function edgePosKey(pa, pb) {
  return pa < pb ? `${pa}|${pb}` : `${pb}|${pa}`;
}

/**
 * Build a map from position-keyed edge to all face entries (face index + the
 * two edge vertices in their triangle's winding order + the third vertex).
 * Using position keys means the two index-different copies of the same
 * physical edge in an unwelded mesh are merged into a single entry list.
 *
 * @param {Uint16Array | Uint32Array | number[]} idx
 * @param {string[]} posKeys
 */
function buildEdgeFaceMap(idx, posKeys) {
  /** @type {Map<string, Array<{ face: number, va: number, vb: number, vc: number }>>} */
  const map = new Map();
  const triCount = idx.length / 3;
  for (let f = 0; f < triCount; f++) {
    const i0 = idx[f * 3];
    const i1 = idx[f * 3 + 1];
    const i2 = idx[f * 3 + 2];
    const tri = [i0, i1, i2];
    for (let e = 0; e < 3; e++) {
      const va = tri[e];
      const vb = tri[(e + 1) % 3];
      const vc = tri[(e + 2) % 3];
      const k = edgePosKey(posKeys[va], posKeys[vb]);
      let arr = map.get(k);
      if (!arr) {
        arr = [];
        map.set(k, arr);
      }
      arr.push({ face: f, va, vb, vc });
    }
  }
  return map;
}

/**
 * Compute a unit face normal for the triangle (i0,i1,i2) sampled from `pos`.
 */
function faceNormal(pos, i0, i1, i2, out) {
  const ax = pos[i0 * 3], ay = pos[i0 * 3 + 1], az = pos[i0 * 3 + 2];
  const bx = pos[i1 * 3], by = pos[i1 * 3 + 1], bz = pos[i1 * 3 + 2];
  const cx = pos[i2 * 3], cy = pos[i2 * 3 + 1], cz = pos[i2 * 3 + 2];
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
  const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  const l = Math.hypot(nx, ny, nz) || 1;
  out.set(nx / l, ny / l, nz / l);
  return out;
}

/**
 * Group triangles into "face regions" — maximal connected sets of triangles
 * whose mutual edges are NOT feature edges (i.e., the triangles are nearly
 * coplanar). Regions are bounded by feature edges (sharp creases) and by
 * boundary edges. Selected edges are also feature edges (since they exceed
 * the threshold), so two adjacent regions across a chamfered edge always
 * end up distinct.
 *
 * @param {Float32Array} basePos
 * @param {Uint16Array | Uint32Array} baseIdx
 * @param {Map<string, Array<{ face: number, va: number, vb: number, vc: number }>>} edgeFaceMap
 * @param {number} featureCos cosine of feature angle threshold
 * @returns {{ regionOf: Int32Array, faceNormals: Float32Array }}
 */
function buildFaceRegions(basePos, baseIdx, edgeFaceMap, featureCos) {
  const triCount = baseIdx.length / 3;
  const faceNormals = new Float32Array(triCount * 3);
  const tmp = new THREE.Vector3();
  for (let f = 0; f < triCount; f++) {
    faceNormal(
      basePos,
      baseIdx[f * 3],
      baseIdx[f * 3 + 1],
      baseIdx[f * 3 + 2],
      tmp
    );
    faceNormals[f * 3] = tmp.x;
    faceNormals[f * 3 + 1] = tmp.y;
    faceNormals[f * 3 + 2] = tmp.z;
  }

  // Build face adjacency across non-feature edges only.
  /** @type {Map<number, number[]>} */
  const faceAdj = new Map();
  function link(a, b) {
    let la = faceAdj.get(a);
    if (!la) { la = []; faceAdj.set(a, la); }
    la.push(b);
  }
  for (const [, faces] of edgeFaceMap) {
    if (faces.length < 2) continue;
    // Use the first two unique faces for this edge.
    let f1 = -1, f2 = -1;
    for (const fi of faces) {
      if (f1 === -1) f1 = fi.face;
      else if (fi.face !== f1) { f2 = fi.face; break; }
    }
    if (f1 === -1 || f2 === -1) continue;
    const dot =
      faceNormals[f1 * 3] * faceNormals[f2 * 3] +
      faceNormals[f1 * 3 + 1] * faceNormals[f2 * 3 + 1] +
      faceNormals[f1 * 3 + 2] * faceNormals[f2 * 3 + 2];
    if (dot >= featureCos) {
      link(f1, f2);
      link(f2, f1);
    }
  }

  const regionOf = new Int32Array(triCount).fill(-1);
  let regionCount = 0;
  const stack = [];
  for (let f = 0; f < triCount; f++) {
    if (regionOf[f] !== -1) continue;
    regionOf[f] = regionCount;
    stack.length = 0;
    stack.push(f);
    while (stack.length) {
      const cur = stack.pop();
      const nb = faceAdj.get(cur);
      if (!nb) continue;
      for (const next of nb) {
        if (regionOf[next] !== -1) continue;
        regionOf[next] = regionCount;
        stack.push(next);
      }
    }
    regionCount++;
  }

  return { regionOf, faceNormals };
}

/**
 * Replace the geometry's position and index attributes with the given arrays.
 * Recomputes vertex normals and bounding box.
 */
function replaceGeometryBuffers(geometry, positions, indices) {
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

const _polyN = new THREE.Vector3();
const _polyE = new THREE.Vector3();
const _polyU = new THREE.Vector3();
const _polyW = new THREE.Vector3();
const _polyA = new THREE.Vector3();
const _polyB = new THREE.Vector3();
const _polyC = new THREE.Vector3();
const _polyP = new THREE.Vector3();

/**
 * Newell-method robust normal for a 3D polygon (vertex indices into `pos`).
 */
function polygonNewellNormal(pos, ring, out) {
  out.set(0, 0, 0);
  const n = ring.length;
  if (n < 3) return out;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vi = ring[i];
    const vj = ring[j];
    const x1 = pos[vi * 3];
    const y1 = pos[vi * 3 + 1];
    const z1 = pos[vi * 3 + 2];
    const x2 = pos[vj * 3];
    const y2 = pos[vj * 3 + 1];
    const z2 = pos[vj * 3 + 2];
    out.x += (y1 - y2) * (z1 + z2);
    out.y += (z1 - z2) * (x1 + x2);
    out.z += (x1 - x2) * (y1 + y2);
  }
  const l = out.length();
  if (l > 1e-14) out.multiplyScalar(1 / l);
  return out;
}

function buildPlanarBasis(planeN, u, w) {
  _polyA.copy(planeN);
  if (Math.abs(_polyA.x) < 0.9) _polyB.set(1, 0, 0);
  else _polyB.set(0, 1, 0);
  u.crossVectors(_polyB, planeN);
  const ul = u.length();
  if (ul < 1e-12) {
    _polyB.set(0, 0, 1);
    u.crossVectors(_polyB, planeN);
    u.normalize();
  } else u.multiplyScalar(1 / ul);
  w.crossVectors(planeN, u);
  const wl = w.length();
  if (wl > 1e-12) w.multiplyScalar(1 / wl);
}

function projectPolygonCoords(pos, vertsIdx, planeN, xsOut, ysOut) {
  buildPlanarBasis(planeN, _polyU, _polyW);
  for (let i = 0; i < vertsIdx.length; i++) {
    const v = vertsIdx[i];
    _polyP.set(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
    xsOut[i] = _polyP.dot(_polyU);
    ysOut[i] = _polyP.dot(_polyW);
  }
}

function triArea2(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTri2(px, py, ax, ay, bx, by, cx, cy, eps) {
  const a = triArea2(ax, ay, bx, by, cx, cy);
  if (Math.abs(a) < eps) return false;
  const s = triArea2(ax, ay, bx, by, px, py);
  const t = triArea2(bx, by, cx, cy, px, py);
  const u = triArea2(cx, cy, ax, ay, px, py);
  if (a > 0) return s >= -eps && t >= -eps && u >= -eps;
  return s <= eps && t <= eps && u <= eps;
}

/**
 * Ear-clip triangulate a simple polygon. `ring` is ordered CCW when viewed
 * from the direction of `planeOut` (outward mesh normal).
 * @param {(a:number,b:number,c:number)=>void} emit
 */
function triangulatePolygonEarClip(pos, ring, planeOut, emit) {
  const n0 = ring.length;
  if (n0 < 3) return;
  /** @type {number[]} */
  const idx = ring.slice();
  const xs = new Float64Array(Math.max(n0, 64));
  const ys = new Float64Array(Math.max(n0, 64));
  const eps = 1e-10;

  let guard = 0;
  while (idx.length > 3 && guard++ < n0 * n0 + 50) {
    projectPolygonCoords(pos, idx, planeOut, xs, ys);
    let earFound = false;
    const m = idx.length;
    for (let i = 0; i < m; i++) {
      const ip = (i + m - 1) % m;
      const inext = (i + 1) % m;
      const ax = xs[ip],
        ay = ys[ip];
      const bx = xs[i],
        by = ys[i];
      const cx = xs[inext],
        cy = ys[inext];
      const o = triArea2(ax, ay, bx, by, cx, cy);
      if (o <= eps) continue;

      let interior = false;
      for (let k = 0; k < m; k++) {
        if (k === ip || k === i || k === inext) continue;
        const px = xs[k],
          py = ys[k];
        if (pointInTri2(px, py, ax, ay, bx, by, cx, cy, eps)) {
          interior = true;
          break;
        }
      }
      if (interior) continue;

      emit(idx[ip], idx[i], idx[inext]);
      idx.splice(i, 1);
      earFound = true;
      break;
    }
    if (!earFound) break;
  }
  if (idx.length === 3) {
    emit(idx[0], idx[1], idx[2]);
  } else if (idx.length > 3) {
    // Rare: non-simple polygon or numerical trouble — convex fan fallback.
    const v0 = idx[0];
    for (let i = 1; i < idx.length - 1; i++) {
      emit(v0, idx[i], idx[i + 1]);
    }
  }
}

/**
 * Split each selected edge into two parallel in-face edges (one per adjacent
 * face region), insetting them away from the original edge by `amount` along
 * each region's plane, and stitch a strip between them. With `segments=1` the
 * strip is a flat chamfer (2 triangles); with `segments>1` intermediate ring
 * vertices are placed along a circular arc in the cross-section plane
 * perpendicular to the edge, producing a curved fillet (`2*segments` tris).
 *
 * Vertices are duplicated per face region so unrelated regions sharing a
 * corner are unaffected, and coplanar triangles inside a region all see the
 * same displaced corner (no internal seam).
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {import('./edges.js').EdgeInfo[]} selectedEdges
 * @param {number} amount01 normalized 0..1, scaled by bbox diagonal
 * @param {number} [featureAngleDeg=35] threshold used to group coplanar triangles
 * @param {number} [segments=1] number of strip subdivisions; 1 = chamfer, >1 = arc
 */
export function applyChamfer(geometry, selectedEdges, amount01, featureAngleDeg = 35, segments = 1) {
  if (!selectedEdges || !selectedEdges.length) return;
  const posAttr = geometry.getAttribute("position");
  const idxAttr = geometry.getIndex();
  if (!posAttr || !idxAttr) return;

  const basePos = posAttr.array;
  const baseIdx = idxAttr.array;
  const triCount = baseIdx.length / 3;

  geometry.computeBoundingBox();
  const bboxSize = geometry.boundingBox.getSize(new THREE.Vector3());
  const minDim = Math.max(Math.min(bboxSize.x, bboxSize.y, bboxSize.z), 1e-6);
  // Scale slider 0..1 to inset distance along each face's plane. The chamfer
  // face's visible width is ~sqrt(2) * inset, so 0.30 * minDim at slider=1
  // produces a chamfer face roughly 0.42 * minDim wide — bold but still
  // bounded by the faceLimit clamp below so it can never overshoot the face.
  const requestedAmount = Math.max(amount01, 0) * minDim * 0.3;
  if (requestedAmount <= 0) return;

  const baseVertCount = basePos.length / 3;
  const bboxDiag = bboxSize.length();
  const tol = Math.max(bboxDiag * 1e-5, 1e-7);
  const posKeys = makePosKeys(basePos, baseVertCount, tol);

  const edgeFaceMap = buildEdgeFaceMap(baseIdx, posKeys);
  const featureCos = Math.cos((featureAngleDeg * Math.PI) / 180);
  const { regionOf, faceNormals } = buildFaceRegions(
    basePos,
    baseIdx,
    edgeFaceMap,
    featureCos
  );

  // Pre-resolve each selected edge to its position-keyed identifier so we can
  // find both faces that share the physical edge regardless of unwelded copies.
  /** @type {Array<{ key: string, posA: string, posB: string, sed: import('./edges.js').EdgeInfo }>} */
  const selectedPosEdges = [];
  for (const sed of selectedEdges) {
    if (sed.a < 0 || sed.b < 0 || sed.a >= baseVertCount || sed.b >= baseVertCount) continue;
    const pa = posKeys[sed.a];
    const pb = posKeys[sed.b];
    selectedPosEdges.push({ key: edgePosKey(pa, pb), posA: pa, posB: pb, sed });
  }

  /** @type {Map<string, { dx: number, dy: number, dz: number, count: number, region: number, posKey: string, sourceVert: number }>} */
  const dupeDisp = new Map();

  const _ed = new THREE.Vector3();
  const _inFace = new THREE.Vector3();
  const _toC = new THREE.Vector3();
  const _va = new THREE.Vector3();
  const _vb = new THREE.Vector3();
  const _vc = new THREE.Vector3();
  const _fn = new THREE.Vector3();

  for (const sel of selectedPosEdges) {
    const faces = edgeFaceMap.get(sel.key);
    if (!faces || !faces.length) continue;

    // Group adjacent face entries by region, picking one representative per region.
    /** @type {Map<number, { face: number, va: number, vb: number, vc: number }>} */
    const byRegion = new Map();
    for (const fi of faces) {
      const r = regionOf[fi.face];
      if (!byRegion.has(r)) byRegion.set(r, fi);
    }
    if (byRegion.size < 2) continue; // boundary edge or degenerate — skip

    for (const [regionId, fi] of byRegion) {
      _va.fromArray(basePos, fi.va * 3);
      _vb.fromArray(basePos, fi.vb * 3);
      _vc.fromArray(basePos, fi.vc * 3);
      _ed.subVectors(_vb, _va);
      const el = _ed.length();
      if (el < 1e-12) continue;
      _ed.multiplyScalar(1 / el);
      _fn.set(
        faceNormals[fi.face * 3],
        faceNormals[fi.face * 3 + 1],
        faceNormals[fi.face * 3 + 2]
      );
      _inFace.crossVectors(_ed, _fn);
      const il = _inFace.length();
      if (il < 1e-12) continue;
      _inFace.multiplyScalar(1 / il);
      _toC.subVectors(_vc, _va);
      const projHeight = _toC.dot(_inFace);
      if (projHeight < 0) _inFace.negate();
      const faceLimit = Math.abs(projHeight) * 0.45;
      const used = Math.min(requestedAmount, Math.max(0, faceLimit));
      if (used <= 1e-9) continue;
      const dx = _inFace.x * used;
      const dy = _inFace.y * used;
      const dz = _inFace.z * used;

      for (const vert of [fi.va, fi.vb]) {
        const pk = posKeys[vert];
        const dk = `${regionId}|${pk}`;
        let entry = dupeDisp.get(dk);
        if (!entry) {
          entry = { dx: 0, dy: 0, dz: 0, count: 0, region: regionId, posKey: pk, sourceVert: vert };
          dupeDisp.set(dk, entry);
        }
        entry.dx += dx;
        entry.dy += dy;
        entry.dz += dz;
        entry.count += 1;
      }
    }
  }

  if (!dupeDisp.size) return;

  const segs = Math.max(1, Math.round(segments));
  // Corner caps need, per endpoint, per "other" region adjacent to the chamfer:
  //  - (segs+1) R3-local arc-ring vertices,
  //  - up to (segs) cap-fan triangles,
  //  - up to (segs) splitVert (or qRvert) inner-edge fan triangles,
  //  - a couple of slack tris for boundary-case bookkeeping,
  //  - holistic R3 uses ear-clipped fills (~ n−2 tris for an n-vertex perimeter).
  // Each selected edge has 2 endpoints; each endpoint can have multiple
  // adjacent "other" regions (e.g. pyramid-like vertices), so leave room for
  // up to ~3 of them. Underestimating silently clamps caps and leaves gaps.
  const cornerRegionSlots = 3;
  const cornerSlackVerts =
    selectedPosEdges.length * 2 * cornerRegionSlots * (segs + 2);
  const cornerSlackTris =
    selectedPosEdges.length * 2 * cornerRegionSlots * (3 * segs + 4);
  const maxNewVerts =
    baseVertCount +
    dupeDisp.size +
    selectedPosEdges.length * 2 * Math.max(0, segs - 1) +
    cornerSlackVerts;
  const maxNewTris =
    triCount + selectedPosEdges.length * 2 * segs + cornerSlackTris;

  const newPos = new Float32Array(maxNewVerts * 3);
  newPos.set(basePos);
  let vertCursor = baseVertCount;

  /** @type {Map<string, number>} */
  const dupeIndex = new Map();
  for (const [dk, entry] of dupeDisp) {
    const c = entry.count > 0 ? entry.count : 1;
    const dx = entry.dx / c;
    const dy = entry.dy / c;
    const dz = entry.dz / c;
    const ni = vertCursor++;
    const sv = entry.sourceVert;
    newPos[ni * 3] = basePos[sv * 3] + dx;
    newPos[ni * 3 + 1] = basePos[sv * 3 + 1] + dy;
    newPos[ni * 3 + 2] = basePos[sv * 3 + 2] + dz;
    // Tag the dupe with its original corner posKey so that the corner-cap pass
    // can still classify triangles after they've been rewritten in-place by
    // earlier corners (otherwise posKeys[v] is undefined for new vertices and
    // hasL/hasR fail, leaving wing-shaped artifacts on shared faces).
    posKeys[ni] = entry.posKey;
    dupeIndex.set(dk, ni);
  }

  const useUint32 = vertCursor > 65535;
  const newIdx = useUint32
    ? new Uint32Array(maxNewTris * 3)
    : new Uint16Array(maxNewTris * 3);
  let triCursor = 0;

  for (let f = 0; f < triCount; f++) {
    const r = regionOf[f];
    const i0 = baseIdx[f * 3];
    const i1 = baseIdx[f * 3 + 1];
    const i2 = baseIdx[f * 3 + 2];
    const k0 = `${r}|${posKeys[i0]}`;
    const k1 = `${r}|${posKeys[i1]}`;
    const k2 = `${r}|${posKeys[i2]}`;
    const o = triCursor * 3;
    newIdx[o] = dupeIndex.has(k0) ? dupeIndex.get(k0) : i0;
    newIdx[o + 1] = dupeIndex.has(k1) ? dupeIndex.get(k1) : i1;
    newIdx[o + 2] = dupeIndex.has(k2) ? dupeIndex.get(k2) : i2;
    triCursor++;
  }

  // Stitch a (possibly subdivided) strip between the two region-duplicates
  // of each selected edge. For segments>1 the intermediate ring vertices are
  // placed along a circular arc in the plane perpendicular to the edge so the
  // strip approximates a fillet (rolling-ball) rather than a flat chamfer.
  const _pa1 = new THREE.Vector3();
  const _pa2 = new THREE.Vector3();
  const _pb1 = new THREE.Vector3();
  const _pb2 = new THREE.Vector3();
  const _avgN = new THREE.Vector3();
  const _fn2 = new THREE.Vector3();
  const _edgeDir = new THREE.Vector3();
  const _u = new THREE.Vector3();
  const _v = new THREE.Vector3();
  const _ringPosA = new THREE.Vector3();
  const _ringPosB = new THREE.Vector3();

  /**
   * Compute (segs+1) ring positions at endpoint `endP` interpolating from the
   * region-1 inset point toward the region-2 inset point along an arc lying
   * in the plane perpendicular to the edge. The resulting positions are
   * written into `outArr` starting at `outOffset` (each entry is a Vector3).
   */
  function buildArcRing(endP, insetP1, insetP2, edgeDir, outRing) {
    // Vectors from endpoint to each inset, projected to the cross-section plane.
    _u.subVectors(insetP1, endP);
    _u.addScaledVector(edgeDir, -_u.dot(edgeDir));
    const u1len = _u.length();
    if (u1len < 1e-12) {
      // Degenerate; just lerp linearly.
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const p = new THREE.Vector3().lerpVectors(insetP1, insetP2, t);
        outRing[i] = p;
      }
      return;
    }
    _u.multiplyScalar(1 / u1len);
    _v.subVectors(insetP2, endP);
    _v.addScaledVector(edgeDir, -_v.dot(edgeDir));
    const u2len = _v.length();
    if (u2len < 1e-12) {
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const p = new THREE.Vector3().lerpVectors(insetP1, insetP2, t);
        outRing[i] = p;
      }
      return;
    }
    _v.multiplyScalar(1 / u2len);
    // Build orthonormal basis (u, w) in the cross-section plane, where w is
    // perpendicular to u in the cross-section and on the same side as v.
    const _w = new THREE.Vector3().subVectors(_v, _u.clone().multiplyScalar(_u.dot(_v)));
    const wlen = _w.length();
    if (wlen < 1e-12) {
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const p = new THREE.Vector3().lerpVectors(insetP1, insetP2, t);
        outRing[i] = p;
      }
      return;
    }
    _w.multiplyScalar(1 / wlen);
    // Average inset distance is the arc radius (matches chamfer width).
    const r = (u1len + u2len) * 0.5;
    // Arc center = endpoint + r * bisector_direction, where bisector points
    // INTO the corner (between u and v from the endpoint's perspective). The
    // direction (u + v) points along the bisector outward from the corner;
    // the arc center is along the OPPOSITE side, i.e. -bisector.
    const bisectorDir = new THREE.Vector3().addVectors(_u, _v);
    const blen = bisectorDir.length();
    if (blen < 1e-12) {
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const p = new THREE.Vector3().lerpVectors(insetP1, insetP2, t);
        outRing[i] = p;
      }
      return;
    }
    bisectorDir.multiplyScalar(1 / blen);
    // Distance from endpoint to arc center: r / cos(half-corner-angle).
    // cos(half-corner) = bisectorDir · u (since u is one corner edge).
    const cosHalf = Math.max(1e-6, Math.abs(bisectorDir.dot(_u)));
    const centerDist = r / cosHalf;
    const center = new THREE.Vector3().copy(endP).addScaledVector(bisectorDir, centerDist);
    // Cross-section basis at the arc: e1 = (insetP1 - center)/r, e2 = (insetP2 - center)/r.
    const e1 = new THREE.Vector3().subVectors(insetP1, center);
    const e2 = new THREE.Vector3().subVectors(insetP2, center);
    const r1len = e1.length() || 1;
    const r2len = e2.length() || 1;
    e1.multiplyScalar(1 / r1len);
    e2.multiplyScalar(1 / r2len);
    // Sweep angle β: angle between e1 and e2.
    const cosBeta = Math.max(-1, Math.min(1, e1.dot(e2)));
    const beta = Math.acos(cosBeta);
    // Orthonormal frame: e1 and e1Perp where e1Perp lies on the e2 side.
    const e1Perp = new THREE.Vector3().subVectors(e2, e1.clone().multiplyScalar(cosBeta));
    const eplen = e1Perp.length();
    if (eplen < 1e-12) {
      for (let i = 0; i <= segs; i++) {
        const t = i / segs;
        const p = new THREE.Vector3().lerpVectors(insetP1, insetP2, t);
        outRing[i] = p;
      }
      return;
    }
    e1Perp.multiplyScalar(1 / eplen);
    // Effective radius averages the two inset distances (slightly off if dihedrals are oblique).
    const rArc = (r1len + r2len) * 0.5;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const ang = beta * t;
      const c = Math.cos(ang), s = Math.sin(ang);
      const p = new THREE.Vector3()
        .copy(center)
        .addScaledVector(e1, rArc * c)
        .addScaledVector(e1Perp, rArc * s);
      outRing[i] = p;
    }
  }

  /**
   * Per-endpoint arc ring info captured during strip stitching, used later by
   * the corner-cap pass to fan-close the un-chamfered side faces' corners.
   * @type {Map<string, { ring: number[], regionAtZero: number, regionAtSegs: number }>}
   */
  const arcRings = new Map();

  for (const sel of selectedPosEdges) {
    const faces = edgeFaceMap.get(sel.key);
    if (!faces) continue;
    /** @type {Map<number, { face: number, va: number, vb: number, vc: number }>} */
    const byRegion = new Map();
    for (const fi of faces) {
      const r = regionOf[fi.face];
      if (!byRegion.has(r)) byRegion.set(r, fi);
    }
    if (byRegion.size < 2) continue;

    const iter = byRegion.entries();
    const [r1, f1Info] = iter.next().value;
    const [r2, f2Info] = iter.next().value;

    const a1i = dupeIndex.get(`${r1}|${sel.posA}`);
    const b1i = dupeIndex.get(`${r1}|${sel.posB}`);
    const a2i = dupeIndex.get(`${r2}|${sel.posA}`);
    const b2i = dupeIndex.get(`${r2}|${sel.posB}`);
    if (a1i == null || b1i == null || a2i == null || b2i == null) continue;

    _pa1.fromArray(newPos, a1i * 3);
    _pb1.fromArray(newPos, b1i * 3);
    _pa2.fromArray(newPos, a2i * 3);
    _pb2.fromArray(newPos, b2i * 3);

    _fn.set(
      faceNormals[f1Info.face * 3],
      faceNormals[f1Info.face * 3 + 1],
      faceNormals[f1Info.face * 3 + 2]
    );
    _fn2.set(
      faceNormals[f2Info.face * 3],
      faceNormals[f2Info.face * 3 + 1],
      faceNormals[f2Info.face * 3 + 2]
    );
    _avgN.copy(_fn).add(_fn2);
    if (_avgN.lengthSq() < 1e-12) _avgN.copy(_fn);

    // Build endpoint-A and endpoint-B rings.
    // endpoint A position on edge: average the two adjacent vertices that have posA.
    const aSrc = dupeDisp.get(`${r1}|${sel.posA}`)?.sourceVert ?? f1Info.va;
    const bSrc = dupeDisp.get(`${r1}|${sel.posB}`)?.sourceVert ?? f1Info.vb;
    const endA = new THREE.Vector3().fromArray(basePos, aSrc * 3);
    const endB = new THREE.Vector3().fromArray(basePos, bSrc * 3);
    _edgeDir.subVectors(endB, endA);
    const edl = _edgeDir.length();
    if (edl < 1e-12) continue;
    _edgeDir.multiplyScalar(1 / edl);

    /** @type {THREE.Vector3[]} */
    const ringA = new Array(segs + 1);
    /** @type {THREE.Vector3[]} */
    const ringB = new Array(segs + 1);

    if (segs <= 1) {
      ringA[0] = _pa1.clone(); ringA[1] = _pa2.clone();
      ringB[0] = _pb1.clone(); ringB[1] = _pb2.clone();
    } else {
      buildArcRing(endA, _pa1, _pa2, _edgeDir, ringA);
      buildArcRing(endB, _pb1, _pb2, _edgeDir, ringB);
    }

    // Add intermediate ring vertices (skipping i=0 and i=segs which are the
    // chamfer dupes already in the buffer).
    /** @type {number[]} */
    const ringAi = new Array(segs + 1);
    /** @type {number[]} */
    const ringBi = new Array(segs + 1);
    ringAi[0] = a1i; ringAi[segs] = a2i;
    ringBi[0] = b1i; ringBi[segs] = b2i;
    for (let i = 1; i < segs; i++) {
      const ni = vertCursor++;
      newPos[ni * 3] = ringA[i].x;
      newPos[ni * 3 + 1] = ringA[i].y;
      newPos[ni * 3 + 2] = ringA[i].z;
      // Tag intermediate ring verts with the endpoint's posKey; they aren't a
      // cube corner but the corner-cap classifier only checks "does this match
      // qLpk or qRpk" and these intermediates should match neither.
      posKeys[ni] = sel.posA;
      ringAi[i] = ni;
    }
    for (let i = 1; i < segs; i++) {
      const ni = vertCursor++;
      newPos[ni * 3] = ringB[i].x;
      newPos[ni * 3 + 1] = ringB[i].y;
      newPos[ni * 3 + 2] = ringB[i].z;
      posKeys[ni] = sel.posB;
      ringBi[i] = ni;
    }

    // Capture each endpoint's arc ring for the corner-cap pass below.
    arcRings.set(`${sel.key}|${sel.posA}`, {
      ring: ringAi.slice(),
      regionAtZero: r1,
      regionAtSegs: r2,
    });
    arcRings.set(`${sel.key}|${sel.posB}`, {
      ring: ringBi.slice(),
      regionAtZero: r1,
      regionAtSegs: r2,
    });

    // Determine winding for the first segment (i=0). All segments share the
    // same winding direction since they form a continuous strip.
    _ringPosA.copy(ringA[0]);
    _ringPosB.copy(ringB[0]);
    const _ringPosB1 = ringB[1] || ringB[segs];
    const _stripN = new THREE.Vector3()
      .crossVectors(
        new THREE.Vector3().subVectors(_ringPosB, _ringPosA),
        new THREE.Vector3().subVectors(_ringPosB1, _ringPosA)
      );
    const flip = _stripN.dot(_avgN) < 0;

    for (let i = 0; i < segs; i++) {
      const ai = ringAi[i];
      const bi = ringBi[i];
      const aiNext = ringAi[i + 1];
      const biNext = ringBi[i + 1];
      let oo = triCursor * 3;
      if (!flip) {
        newIdx[oo] = ai; newIdx[oo + 1] = bi; newIdx[oo + 2] = biNext;
        triCursor++;
        oo = triCursor * 3;
        newIdx[oo] = ai; newIdx[oo + 1] = biNext; newIdx[oo + 2] = aiNext;
        triCursor++;
      } else {
        newIdx[oo] = ai; newIdx[oo + 1] = biNext; newIdx[oo + 2] = bi;
        triCursor++;
        oo = triCursor * 3;
        newIdx[oo] = ai; newIdx[oo + 1] = aiNext; newIdx[oo + 2] = biNext;
        triCursor++;
      }
    }
  }

  // ---- Carry the chamfer/fillet through endpoint corners ----
  // At each chamfered edge endpoint, the third (un-chamfered) face region still
  // ends at the original sharp corner, leaving a visible gap/T-junction. For
  // each such region we re-route its corner triangulation so it ends at the
  // chamfer's two new corner positions, and add a small in-plane corner cap
  // that fills the area where the original corner used to be.

  /** @type {Map<string, Set<number>>} */
  const regionsAtPos = new Map();
  /** @type {Map<string, number>} */
  const vertOfRegionPos = new Map();
  /** @type {Map<number, number>} */
  const oneFaceOfRegion = new Map();
  for (let f = 0; f < triCount; f++) {
    const r = regionOf[f];
    if (!oneFaceOfRegion.has(r)) oneFaceOfRegion.set(r, f);
    for (let k = 0; k < 3; k++) {
      const vi = baseIdx[f * 3 + k];
      const pk = posKeys[vi];
      let s = regionsAtPos.get(pk);
      if (!s) { s = new Set(); regionsAtPos.set(pk, s); }
      s.add(r);
      const rk = `${r}|${pk}`;
      if (!vertOfRegionPos.has(rk)) vertOfRegionPos.set(rk, vi);
    }
  }

  /** @type {Map<string, Array<{ otherPk: string, regions: Set<number> }>>} */
  const edgesAtPos = new Map();
  for (const [edgeKey, faceList] of edgeFaceMap) {
    const sep = edgeKey.indexOf("|");
    const pa = edgeKey.slice(0, sep);
    const pb = edgeKey.slice(sep + 1);
    const regions = new Set();
    for (const fi of faceList) regions.add(regionOf[fi.face]);
    let arrA = edgesAtPos.get(pa);
    if (!arrA) { arrA = []; edgesAtPos.set(pa, arrA); }
    arrA.push({ otherPk: pb, regions });
    let arrB = edgesAtPos.get(pb);
    if (!arrB) { arrB = []; edgesAtPos.set(pb, arrB); }
    arrB.push({ otherPk: pa, regions });
  }

  /** @type {Map<string, Set<number>>} */
  const chamferedRegionsAtPos = new Map();
  for (const sel of selectedPosEdges) {
    const faces = edgeFaceMap.get(sel.key);
    if (!faces) continue;
    const byRegion = new Set();
    for (const fi of faces) byRegion.add(regionOf[fi.face]);
    if (byRegion.size < 2) continue;
    for (const pk of [sel.posA, sel.posB]) {
      let s = chamferedRegionsAtPos.get(pk);
      if (!s) { s = new Set(); chamferedRegionsAtPos.set(pk, s); }
      for (const r of byRegion) s.add(r);
    }
  }

  // Per-corner record gathered without mutating the mesh; the actual rewrite
  // happens later, grouped by R3, so corners that share an R3 face don't fight
  // over its triangles in newIdx (which used to leave huge wing-shaped tris
  // when the per-corner classifier saw vertices another corner had already
  // remapped).
  /**
   * @typedef CornerRec
   * @property {string} pk
   * @property {number} wR3
   * @property {{rOther:number, otherPk:string, di:number}} info1
   * @property {{rOther:number, otherPk:string, di:number}} info2
   * @property {number[]} ringR3
   */
  /** @type {Map<number, CornerRec[]>} */
  const r3Corners = new Map();
  /** @type {Set<string>} */
  const processedR3 = new Set();

  for (const [pk, chSet] of chamferedRegionsAtPos) {
    const allRegions = regionsAtPos.get(pk);
    if (!allRegions) continue;
    for (const r3 of allRegions) {
      if (chSet.has(r3)) continue;
      const procKey = `${pk}|${r3}`;
      if (processedR3.has(procKey)) continue;
      processedR3.add(procKey);

      // Find chamfered regions adjacent to r3 via cube edges incident to pk.
      /** @type {Array<{ rOther: number, otherPk: string, di: number }>} */
      const incidentCham = [];
      const seenOther = new Set();
      const edges = edgesAtPos.get(pk) || [];
      for (const e of edges) {
        if (!e.regions.has(r3)) continue;
        for (const rOther of e.regions) {
          if (rOther === r3) continue;
          if (!chSet.has(rOther)) continue;
          if (seenOther.has(rOther)) continue;
          const di = dupeIndex.get(`${rOther}|${pk}`);
          if (di == null) continue;
          incidentCham.push({ rOther, otherPk: e.otherPk, di });
          seenOther.add(rOther);
          break;
        }
      }
      if (incidentCham.length !== 2) continue;

      const wR3 = vertOfRegionPos.get(`${r3}|${pk}`);
      if (wR3 == null) continue;

      const [info1, info2] = incidentCham;

      // Find the matching selected edge's arc ring at this endpoint so we can
      // fan-close every segment of the chamfer/fillet, not just the outer dL/dR.
      let arcInfo = null;
      for (const sel of selectedPosEdges) {
        if (sel.posA !== pk && sel.posB !== pk) continue;
        const candidate = arcRings.get(`${sel.key}|${pk}`);
        if (!candidate) continue;
        const involves =
          (candidate.regionAtZero === info1.rOther && candidate.regionAtSegs === info2.rOther) ||
          (candidate.regionAtZero === info2.rOther && candidate.regionAtSegs === info1.rOther);
        if (involves) { arcInfo = candidate; break; }
      }
      if (!arcInfo) continue;

      // Order the arc so ring[0] is on info1's cube edge and ring[last] on
      // info2's, regardless of which way the chamfer-edge stitcher captured it.
      const orientedRing =
        arcInfo.regionAtZero === info1.rOther
          ? arcInfo.ring.slice()
          : arcInfo.ring.slice().reverse();
      const arcLen = orientedRing.length;
      if (arcLen < 2) continue;

      // Allocate R3-local copies of every arc ring vertex so smooth shading
      // doesn't average across regions: only R3 triangles will reference them,
      // so under computeVertexNormals they pick up R3's outward normal.
      if (vertCursor + arcLen > maxNewVerts) continue;
      const ringR3 = new Array(arcLen);
      for (let i = 0; i < arcLen; i++) {
        const src = orientedRing[i];
        const ni = vertCursor++;
        newPos[ni * 3] = newPos[src * 3];
        newPos[ni * 3 + 1] = newPos[src * 3 + 1];
        newPos[ni * 3 + 2] = newPos[src * 3 + 2];
        posKeys[ni] = posKeys[src];
        ringR3[i] = ni;
      }

      let arr = r3Corners.get(r3);
      if (!arr) { arr = []; r3Corners.set(r3, arr); }
      arr.push({ pk, wR3, info1, info2, ringR3 });
    }
  }

  /**
   * Emit a triangle, picking the winding that matches R3's outward normal.
   * @param {number} r3
   * @param {number} va
   * @param {number} vb
   * @param {number} vc
   */
  const addOrientedFor = (r3, va, vb, vc) => {
    if (triCursor >= maxNewTris) return;
    const ax = newPos[va * 3], ay = newPos[va * 3 + 1], az = newPos[va * 3 + 2];
    const bx = newPos[vb * 3], by = newPos[vb * 3 + 1], bz = newPos[vb * 3 + 2];
    const cx = newPos[vc * 3], cy = newPos[vc * 3 + 1], cz = newPos[vc * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    if (Math.abs(nx) + Math.abs(ny) + Math.abs(nz) < 1e-14) return;
    const r3Face = oneFaceOfRegion.get(r3);
    const r3Nx = r3Face != null ? faceNormals[r3Face * 3] : 0;
    const r3Ny = r3Face != null ? faceNormals[r3Face * 3 + 1] : 1;
    const r3Nz = r3Face != null ? faceNormals[r3Face * 3 + 2] : 0;
    const oo = triCursor * 3;
    if (nx * r3Nx + ny * r3Ny + nz * r3Nz >= 0) {
      newIdx[oo] = va; newIdx[oo + 1] = vb; newIdx[oo + 2] = vc;
    } else {
      newIdx[oo] = va; newIdx[oo + 1] = vc; newIdx[oo + 2] = vb;
    }
    triCursor++;
  };

  /**
   * Walk R3's boundary as a directed cycle of **position keys** (same idea as
   * feature-edge detection). Raw vertex indices fail on unwelded STL/OBJ where
   * one geometric corner uses multiple indices — the cycle breaks, holistic
   * falls back to chained per-corner caps, and thin "wing" triangles appear.
   * @returns {string[] | null} ordered corners pk0..pk_{n-1} around the boundary
   */
  const walkR3PerimeterSeqPk = (r3) => {
    /** @type {Set<string>} */
    const dirPk = new Set();
    for (let f = 0; f < triCount; f++) {
      if (regionOf[f] !== r3) continue;
      for (let k = 0; k < 3; k++) {
        const va = baseIdx[f * 3 + k];
        const vb = baseIdx[f * 3 + ((k + 1) % 3)];
        const pa = posKeys[va];
        const pb = posKeys[vb];
        if (pa === pb) continue;
        dirPk.add(`${pa}\x1f${pb}`);
      }
    }
    /** @type {Array<{ pa: string, pb: string }>} */
    const rawPerim = [];
    for (const fk of dirPk) {
      const sep = fk.indexOf("\x1f");
      const pa = fk.slice(0, sep);
      const pb = fk.slice(sep + 1);
      if (!dirPk.has(`${pb}\x1f${pa}`)) rawPerim.push({ pa, pb });
    }
    if (!rawPerim.length) return null;

    /** @type {Set<string>} */
    const seenDir = new Set();
    /** @type {Array<{ pa: string, pb: string }>} */
    const edges = [];
    for (const e of rawPerim) {
      const dk = `${e.pa}\x1f${e.pb}`;
      if (seenDir.has(dk)) continue;
      seenDir.add(dk);
      edges.push(e);
    }

    /** @type {Map<string, string>} */
    const succ = new Map();
    for (const { pa, pb } of edges) {
      if (succ.has(pa)) return null;
      succ.set(pa, pb);
    }

    const startPa = edges[0].pa;
    /** @type {string[]} */
    const seqPk = [];
    let cur = startPa;
    for (let guard = 0; guard <= edges.length + 4; guard++) {
      seqPk.push(cur);
      const nx = succ.get(cur);
      if (nx == null) return null;
      if (nx === startPa && seqPk.length === edges.length) return seqPk;
      cur = nx;
      if (seqPk.length > edges.length) return null;
    }
    return null;
  };

  /**
   * Vertex-index perimeter walk (welded meshes); kept as fallback.
   * @returns {Array<{ va: number, vb: number, faceIdx: number }> | null}
   */
  const walkR3PerimeterVertexLoop = (r3) => {
    /** @type {Array<{ va: number, vb: number, faceIdx: number }>} */
    const all = [];
    const dirSet = new Set();
    for (let f = 0; f < triCount; f++) {
      if (regionOf[f] !== r3) continue;
      for (let k = 0; k < 3; k++) {
        const va = baseIdx[f * 3 + k];
        const vb = baseIdx[f * 3 + ((k + 1) % 3)];
        all.push({ va, vb, faceIdx: f });
        dirSet.add(`${va}|${vb}`);
      }
    }
    /** @type {Array<{ va: number, vb: number, faceIdx: number }>} */
    const perim = all.filter((e) => !dirSet.has(`${e.vb}|${e.va}`));
    if (!perim.length) return null;
    /** @type {Map<number, { va: number, vb: number, faceIdx: number }>} */
    const startMap = new Map();
    for (const e of perim) {
      // If two perimeter edges start at the same vertex (R3 has a pinched
      // bowtie), we can't walk a simple loop unambiguously — bail.
      if (startMap.has(e.va)) return null;
      startMap.set(e.va, e);
    }
    const start = perim[0];
    const loop = [start];
    let curr = startMap.get(start.vb);
    while (curr && curr !== start) {
      loop.push(curr);
      curr = startMap.get(curr.vb);
      if (loop.length > perim.length) return null;
    }
    if (loop.length !== perim.length) return null;
    return loop;
  };

  /** @returns {string[] | null} */
  const walkR3PerimeterSeqPkFallbackVertex = (r3) => {
    const loop = walkR3PerimeterVertexLoop(r3);
    if (!loop) return null;
    /** @type {string[]} */
    const seqPk = [];
    for (const e of loop) seqPk.push(posKeys[e.va]);
    return seqPk.length >= 3 ? seqPk : null;
  };

  for (const [r3, corners] of r3Corners) {
    if (corners.length === 1) {
      // Single chamfered corner — keep the in-place per-corner rewrite, which
      // is conservative (modifies just the 1–2 R3 tris around the corner)
      // and never tangles with another corner's edits.
      applyPerCornerCap(r3, corners[0]);
    } else {
      // Multiple chamfered corners on the same R3 — re-triangulate the whole
      // face from scratch so coverage stays watertight without depending on
      // sequential vertex rewrites.
      applyHolisticR3(r3, corners);
    }
  }

  /**
   * @param {number} r3
   * @param {CornerRec} c
   */
  function applyPerCornerCap(r3, c) {
    const { pk, wR3, info1, info2, ringR3 } = c;
    const dLR3 = ringR3[0];
    const dRR3 = ringR3[ringR3.length - 1];
    const arcLen = ringR3.length;
    const qLpk = info1.otherPk;
    const qRpk = info2.otherPk;

    /** @type {Array<{ f: number, others: number[] }>} */
    const lTris = [];
    /** @type {Array<{ f: number, others: number[] }>} */
    const rTris = [];
    /** @type {Array<{ f: number, others: number[], qLvert: number, qRvert: number }>} */
    const boundaryTris = [];
    for (let f = 0; f < triCount; f++) {
      if (regionOf[f] !== r3) continue;
      const i0 = newIdx[f * 3];
      const i1 = newIdx[f * 3 + 1];
      const i2 = newIdx[f * 3 + 2];
      let wPos = -1;
      if (i0 === wR3) wPos = 0;
      else if (i1 === wR3) wPos = 1;
      else if (i2 === wR3) wPos = 2;
      if (wPos === -1) continue;
      const others = [i0, i1, i2].filter((_, idx) => idx !== wPos);
      const otherPks = others.map((v) => posKeys[v]);
      const hasL = otherPks.includes(qLpk);
      const hasR = otherPks.includes(qRpk);
      if (hasL && hasR) {
        let qLv = -1, qRv = -1;
        for (const v of others) {
          if (qLv < 0 && posKeys[v] === qLpk) qLv = v;
          else if (qRv < 0 && posKeys[v] === qRpk) qRv = v;
        }
        if (qLv >= 0 && qRv >= 0) boundaryTris.push({ f, others, qLvert: qLv, qRvert: qRv });
      } else if (hasL) lTris.push({ f, others });
      else if (hasR) rTris.push({ f, others });
    }
    if (!boundaryTris.length && (!lTris.length || !rTris.length)) return;

    const fan = (apex, reverse) => {
      for (let i = 0; i < arcLen - 1; i++) {
        if (reverse) addOrientedFor(r3, apex, ringR3[i + 1], ringR3[i]);
        else addOrientedFor(r3, apex, ringR3[i], ringR3[i + 1]);
      }
    };

    // Once we fan from qRvert or splitVert across the arc ring, the planar
    // pocket between dLR3–dRR3 and that apex is fully covered. A second fan
    // from wR3 duplicates that region (often nearly coplanar on quads), reads
    // as thin "wings" at chamfer ends, and fights smoothing normals.
    let arcFilledWithoutPk = false;

    for (const t of boundaryTris) {
      for (let k = 0; k < 3; k++) {
        if (newIdx[t.f * 3 + k] === wR3) newIdx[t.f * 3 + k] = dLR3;
      }
      fan(t.qRvert, true);
      arcFilledWithoutPk = true;
    }
    for (const t of lTris) {
      for (let k = 0; k < 3; k++) {
        if (newIdx[t.f * 3 + k] === wR3) newIdx[t.f * 3 + k] = dLR3;
      }
    }
    for (const t of rTris) {
      for (let k = 0; k < 3; k++) {
        if (newIdx[t.f * 3 + k] === wR3) newIdx[t.f * 3 + k] = dRR3;
      }
    }
    if (lTris.length && rTris.length) {
      const lOthers = new Set();
      for (const t of lTris) for (const v of t.others) lOthers.add(v);
      let splitVert = -1;
      for (const t of rTris) {
        for (const v of t.others) {
          if (lOthers.has(v)) { splitVert = v; break; }
        }
        if (splitVert >= 0) break;
      }
      if (splitVert >= 0) {
        fan(splitVert, false);
        arcFilledWithoutPk = true;
      }
    }
    if (!arcFilledWithoutPk) fan(wR3, false);
  }

  /**
   * Holistic re-triangulation of an R3 face that has 2+ chamfered corners.
   * @param {number} r3
   * @param {CornerRec[]} corners
   */
  function applyHolisticR3(r3, corners) {
    let seqPk = walkR3PerimeterSeqPk(r3);
    if (!seqPk) seqPk = walkR3PerimeterSeqPkFallbackVertex(r3);
    if (!seqPk) {
      // Still can't walk boundary — last resort per-corner edits (may wing).
      for (const c of corners) applyPerCornerCap(r3, c);
      return;
    }

    /** @type {Map<string, CornerRec>} */
    const byPk = new Map();
    for (const c of corners) byPk.set(c.pk, c);

    /** @type {number[]} */
    const polyVerts = [];
    for (let i = 0; i < seqPk.length; i++) {
      const pkA = seqPk[i];
      const prevPk = seqPk[(i + seqPk.length - 1) % seqPk.length];
      const corner = byPk.get(pkA);
      if (!corner) {
        const wi = vertOfRegionPos.get(`${r3}|${pkA}`);
        if (wi != null) polyVerts.push(wi);
        continue;
      }
      // ringR3 is oriented so ring[0] sits on info1's cube edge and ring[last]
      // on info2's. The walk's incoming edge tells us which side is "first".
      let ring = corner.ringR3.slice();
      if (prevPk === corner.info2.otherPk) ring.reverse();
      else if (prevPk !== corner.info1.otherPk) {
        for (const c of corners) applyPerCornerCap(r3, c);
        return;
      }
      for (const v of ring) polyVerts.push(v);
    }

    if (polyVerts.length < 3) return;

    // Deduplicate consecutive polygon verts (when a chamfered corner's outgoing
    // arc end is at the same index as the next corner's incoming end — only
    // happens in degenerate adjacency, but kills triangle area if left).
    const dedup = [];
    for (const v of polyVerts) {
      if (dedup.length && dedup[dedup.length - 1] === v) continue;
      dedup.push(v);
    }
    if (dedup.length >= 2 && dedup[0] === dedup[dedup.length - 1]) dedup.pop();
    if (dedup.length < 3) return;

    const r3FaceIdx = oneFaceOfRegion.get(r3);
    _polyN.set(
      faceNormals[r3FaceIdx * 3],
      faceNormals[r3FaceIdx * 3 + 1],
      faceNormals[r3FaceIdx * 3 + 2]
    );

    polygonNewellNormal(newPos, dedup, _polyE);
    if (_polyE.lengthSq() > 1e-16 && _polyE.dot(_polyN) < 0) dedup.reverse();

    // Mark R3's original triangles as degenerate (collapse all three indices
    // to the same vertex). They'll occupy slots in newIdx but render to zero
    // area; the new fan triangles below cover R3's actual surface.
    for (let f = 0; f < triCount; f++) {
      if (regionOf[f] !== r3) continue;
      const v0 = newIdx[f * 3];
      newIdx[f * 3 + 1] = v0;
      newIdx[f * 3 + 2] = v0;
    }

    const emitTri = (va, vb, vc) => addOrientedFor(r3, va, vb, vc);
    triangulatePolygonEarClip(newPos, dedup, _polyN, emitTri);
  }

  const finalPos = vertCursor === maxNewVerts
    ? newPos
    : newPos.slice(0, vertCursor * 3);
  const finalIdx = triCursor === maxNewTris
    ? newIdx
    : (useUint32
        ? new Uint32Array(newIdx.buffer, 0, triCursor * 3).slice()
        : new Uint16Array(newIdx.buffer, 0, triCursor * 3).slice());

  replaceGeometryBuffers(geometry, finalPos, finalIdx);
}

/**
 * Apply a rounded fillet on selected edges by running the chamfer with a
 * subdivided cross-section: each segment lies on a circular arc, giving a
 * curved fillet face that meets the originating faces tangentially.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {import('./edges.js').EdgeInfo[]} selectedEdges
 * @param {number} strength01 normalized 0..1
 * @param {number} passes maps to arc-segment count (more = smoother arc)
 * @param {number} [featureAngleDeg=35]
 */
export function applyFillet(geometry, selectedEdges, strength01, passes, featureAngleDeg = 35) {
  if (!selectedEdges || !selectedEdges.length) return;
  // A fillet is just a subdivided chamfer where the strip vertices lie on a
  // circular arc in the cross-section. Map the "smoothing passes" slider
  // (1..12) to a segment count: more segments = smoother arc.
  const segments = Math.max(2, Math.min(16, Math.round(Number(passes) || 4) + 2));
  applyChamfer(geometry, selectedEdges, strength01, featureAngleDeg, segments);
}
