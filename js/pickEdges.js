import * as THREE from "three";

/**
 * @param {THREE.Raycaster} raycaster
 * @param {THREE.LineSegments} lineObj
 * @param {unknown[]} edgeBySegment
 * @param {number} thresholdWorld
 */
export function pickEdgeNearestRay(raycaster, lineObj, edgeBySegment, thresholdWorld) {
  const geom = lineObj.geometry;
  const pos = geom.getAttribute("position");
  if (!pos) return null;
  const ray = raycaster.ray;
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const segA = new THREE.Vector3();
  const segB = new THREE.Vector3();
  let best = -1;
  let bestD = Infinity;
  const arr = pos.array;
  for (let i = 0; i < edgeBySegment.length; i++) {
    const o = i * 6;
    vA.set(arr[o], arr[o + 1], arr[o + 2]).applyMatrix4(lineObj.matrixWorld);
    vB.set(arr[o + 3], arr[o + 4], arr[o + 5]).applyMatrix4(lineObj.matrixWorld);
    const d2 = ray.distanceSqToSegment(vA, vB, segA, segB);
    if (d2 < bestD) {
      bestD = d2;
      best = i;
    }
  }
  if (best < 0) return null;
  const th2 = thresholdWorld * thresholdWorld;
  if (bestD > th2) return null;
  return edgeBySegment[best];
}
