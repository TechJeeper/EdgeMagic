import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";

function mergeGroupToGeometry(group) {
  const geometries = [];
  group.updateWorldMatrix(true, true);
  group.traverse((child) => {
    if (child.isMesh && child.geometry) {
      const g = child.geometry.clone();
      g.applyMatrix4(child.matrixWorld);
      for (const name of Object.keys(g.attributes)) {
        if (name !== "position") g.deleteAttribute(name);
      }
      geometries.push(g);
    }
  });
  if (geometries.length === 0) return null;
  const merged = mergeGeometries(geometries, false);
  merged.computeVertexNormals();
  return merged;
}

/** @param {import('three').Object3D} root */
function flattenObject3D(root) {
  const dummy = new THREE.Group();
  dummy.add(root);
  return mergeGroupToGeometry(dummy);
}

/**
 * @param {ArrayBuffer} buffer
 * @param {string} fileName
 * @param {(msg: string) => void} onProgress
 */
export async function loadModelBuffer(buffer, fileName, onProgress) {
  const ext = fileName.split(".").pop().toLowerCase();

  if (ext === "stl") {
    onProgress("Parsing STL…");
    const geom = new STLLoader().parse(buffer);
    geom.computeVertexNormals();
    return geom;
  }

  if (ext === "obj") {
    onProgress("Parsing OBJ…");
    const text = new TextDecoder().decode(buffer);
    const obj = new OBJLoader().parse(text);
    const g = flattenObject3D(obj);
    if (!g) throw new Error("OBJ contained no mesh geometry.");
    return g;
  }

  if (ext === "3mf") {
    onProgress("Parsing 3MF…");
    const loader = new ThreeMFLoader();
    const group = loader.parse(buffer);
    const g = flattenObject3D(group);
    if (!g) throw new Error("3MF contained no mesh geometry.");
    return g;
  }

  if (ext === "step" || ext === "stp") {
    return loadStepBuffer(new Uint8Array(buffer), onProgress);
  }

  throw new Error(`Unsupported extension: .${ext}`);
}

/**
 * @param {Uint8Array} data
 * @param {(msg: string) => void} onProgress
 */
async function loadStepBuffer(data, onProgress) {
  onProgress("Loading STEP engine (first time may download WASM)…");
  const factory = globalThis.occtimportjs || globalThis.occtImportJs;
  if (typeof factory !== "function") {
    throw new Error("STEP support script missing. Include occt-import-js before the app module.");
  }
  const occt = await factory();
  onProgress("Tessellating STEP…");
  const result = occt.ReadStepFile(data, {
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.003,
    angularDeflection: 0.5,
  });
  if (!result.success) {
    throw new Error("STEP import failed.");
  }
  const geom = occtResultToGeometry(result);
  if (!geom) throw new Error("STEP produced no mesh data.");
  geom.computeVertexNormals();
  return geom;
}

/** @param {object} result */
function occtResultToGeometry(result) {
  const positions = [];
  const indices = [];
  let vBase = 0;
  const meshes = result.meshes || [];
  for (const mesh of meshes) {
    const posObj = mesh.attributes?.position || mesh.position;
    const arr = posObj?.array;
    if (!arr || arr.length < 9) continue;
    const nVerts = arr.length / 3;
    for (let i = 0; i < arr.length; i++) positions.push(arr[i]);

    const idxObj = mesh.index;
    const idxArr = idxObj?.array;
    if (idxArr && idxArr.length) {
      for (let i = 0; i < idxArr.length; i++) indices.push(vBase + idxArr[i]);
    } else {
      for (let i = 0; i < nVerts; i++) indices.push(vBase + i);
    }
    vBase += nVerts;
  }
  if (positions.length < 9) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (indices.length) g.setIndex(indices);
  return g;
}
