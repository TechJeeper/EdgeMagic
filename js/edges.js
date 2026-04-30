import * as THREE from "three";

/** @typedef {{ key: string, a: number, b: number, faceA: number, faceB: number | null, oppositeA: number, oppositeB: number | null }} EdgeInfo */

/**
 * @param {THREE.BufferGeometry} geometry
 * @param {number} featureAngleDeg
 * @returns {{ lines: THREE.LineSegments, edges: EdgeInfo[], edgeBySegment: EdgeInfo[], bboxSize: number }}
 */
export function buildFeatureEdges(geometry, featureAngleDeg) {
  const g = geometry.index ? geometry.clone() : geometry.clone();
  if (!g.getIndex()) {
    const n = g.getAttribute("position").count;
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  g.computeVertexNormals();

  const pos = g.getAttribute("position");
  const idx = g.getIndex();
  const triCount = idx.count / 3;

  const faceNormals = new Float32Array(triCount * 3);
  const _v0 = new THREE.Vector3();
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _e1 = new THREE.Vector3();
  const _e2 = new THREE.Vector3();
  const _n = new THREE.Vector3();

  for (let f = 0; f < triCount; f++) {
    const i0 = idx.getX(f * 3);
    const i1 = idx.getX(f * 3 + 1);
    const i2 = idx.getX(f * 3 + 2);
    _v0.fromBufferAttribute(pos, i0);
    _v1.fromBufferAttribute(pos, i1);
    _v2.fromBufferAttribute(pos, i2);
    _e1.subVectors(_v1, _v0);
    _e2.subVectors(_v2, _v0);
    _n.crossVectors(_e1, _e2).normalize();
    faceNormals[f * 3] = _n.x;
    faceNormals[f * 3 + 1] = _n.y;
    faceNormals[f * 3 + 2] = _n.z;
  }

  const threshold = Math.cos((featureAngleDeg * Math.PI) / 180);

  /** @type {Map<string, { faces: number[], verts: [number, number][], opposites: number[] }>} */
  const edgeMap = new Map();

  function addEdge(va, vb, face, opposite) {
    const a = Math.min(va, vb);
    const b = Math.max(va, vb);
    const key = `${a}_${b}`;
    let e = edgeMap.get(key);
    if (!e) {
      e = { faces: [], verts: [], opposites: [] };
      edgeMap.set(key, e);
    }
    e.faces.push(face);
    e.verts.push([va, vb]);
    e.opposites.push(opposite);
  }

  for (let f = 0; f < triCount; f++) {
    const i0 = idx.getX(f * 3);
    const i1 = idx.getX(f * 3 + 1);
    const i2 = idx.getX(f * 3 + 2);
    addEdge(i0, i1, f, i2);
    addEdge(i1, i2, f, i0);
    addEdge(i2, i0, f, i1);
  }

  /** @type {EdgeInfo[]} */
  const edges = [];

  for (const [key, e] of edgeMap) {
    const uniqFaces = [...new Set(e.faces)];
    let isFeature = false;
    if (uniqFaces.length === 1) {
      isFeature = true;
    } else if (uniqFaces.length >= 2) {
      const f0 = uniqFaces[0];
      let f1 = uniqFaces[1];
      if (uniqFaces.length > 2) {
        for (let k = 1; k < uniqFaces.length; k++) {
          if (uniqFaces[k] !== f0) {
            f1 = uniqFaces[k];
            break;
          }
        }
      }
      const nx0 = faceNormals[f0 * 3];
      const ny0 = faceNormals[f0 * 3 + 1];
      const nz0 = faceNormals[f0 * 3 + 2];
      const nx1 = faceNormals[f1 * 3];
      const ny1 = faceNormals[f1 * 3 + 1];
      const nz1 = faceNormals[f1 * 3 + 2];
      const dot = nx0 * nx1 + ny0 * ny1 + nz0 * nz1;
      if (dot < threshold) isFeature = true;
    }

    if (!isFeature) continue;

    const [aStr, bStr] = key.split("_");
    const a = Number(aStr);
    const b = Number(bStr);
    let faceA = uniqFaces[0];
    let faceB = uniqFaces.length > 1 ? uniqFaces[1] : null;
    let oppositeA = -1;
    let oppositeB = null;

    for (let i = 0; i < e.faces.length; i++) {
      if (e.faces[i] === faceA) {
        const [va, vb] = e.verts[i];
        if ((va === a && vb === b) || (va === b && vb === a)) {
          oppositeA = e.opposites[i];
          break;
        }
      }
    }
    if (faceB !== null) {
      for (let i = 0; i < e.faces.length; i++) {
        if (e.faces[i] === faceB) {
          const [va, vb] = e.verts[i];
          if ((va === a && vb === b) || (va === b && vb === a)) {
            oppositeB = e.opposites[i];
            break;
          }
        }
      }
    }
    if (oppositeA < 0 && e.opposites.length) oppositeA = e.opposites[0];
    if ((oppositeB === null || oppositeB < 0) && e.opposites.length > 1) {
      oppositeB = e.opposites[1];
    }

    edges.push({
      key,
      a,
      b,
      faceA,
      faceB,
      oppositeA,
      oppositeB,
    });
  }

  const linePos = new Float32Array(edges.length * 6);
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const ax = pos.getX(e.a);
    const ay = pos.getY(e.a);
    const az = pos.getZ(e.a);
    const bx = pos.getX(e.b);
    const by = pos.getY(e.b);
    const bz = pos.getZ(e.b);
    linePos[i * 6] = ax;
    linePos[i * 6 + 1] = ay;
    linePos[i * 6 + 2] = az;
    linePos[i * 6 + 3] = bx;
    linePos[i * 6 + 4] = by;
    linePos[i * 6 + 5] = bz;
  }

  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute("position", new THREE.BufferAttribute(linePos, 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xffffff,
    depthTest: true,
    transparent: true,
    opacity: 0.75,
    vertexColors: true,
  });
  const lines = new THREE.LineSegments(lineGeom, lineMat);
  lines.frustumCulled = false;

  const bbox = new THREE.Box3().setFromBufferAttribute(pos);
  const size = bbox.getSize(new THREE.Vector3()).length();

  return { lines, edges, edgeBySegment: edges, bboxSize: Math.max(size, 1e-6) };
}

/**
 * @param {THREE.LineSegments} lines
 * @param {EdgeInfo[]} edgeBySegment
 * @param {Set<string>} selected
 */
export function updateEdgeSelectionStyle(lines, edgeBySegment, selected) {
  const colors = new Float32Array(edgeBySegment.length * 6);
  const sel = new THREE.Color(0xff4db0);
  const def = new THREE.Color(0x1b2a38);
  for (let i = 0; i < edgeBySegment.length; i++) {
    const c = selected.has(edgeBySegment[i].key) ? sel : def;
    for (let k = 0; k < 2; k++) {
      colors[i * 6 + k * 3] = c.r;
      colors[i * 6 + k * 3 + 1] = c.g;
      colors[i * 6 + k * 3 + 2] = c.b;
    }
  }
  lines.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  lines.material.needsUpdate = true;
}

/**
 * @param {THREE.LineSegments} sourceLines
 * @param {EdgeInfo[]} edgeBySegment
 * @param {Set<string>} selected
 */
export function buildSelectedEdgeOverlay(sourceLines, edgeBySegment, selected) {
  if (!selected.size) return null;
  const srcPos = sourceLines.geometry.getAttribute("position");
  if (!srcPos) return null;
  const srcArr = srcPos.array;
  const segments = [];
  for (let i = 0; i < edgeBySegment.length; i++) {
    if (!selected.has(edgeBySegment[i].key)) continue;
    const o = i * 6;
    segments.push(
      srcArr[o],
      srcArr[o + 1],
      srcArr[o + 2],
      srcArr[o + 3],
      srcArr[o + 4],
      srcArr[o + 5]
    );
  }
  if (!segments.length) return null;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(new Float32Array(segments), 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0xffd166,
    transparent: true,
    opacity: 0.98,
    depthTest: false,
  });
  const overlay = new THREE.LineSegments(geom, mat);
  overlay.renderOrder = 99;
  overlay.frustumCulled = false;
  return overlay;
}
