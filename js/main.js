import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { loadModelBuffer } from "./modelLoader.js";
import { buildFeatureEdges, buildSelectedEdgeOverlay, updateEdgeSelectionStyle } from "./edges.js";
import { pickEdgeNearestRay } from "./pickEdges.js";
import { applyChamfer, applyFillet } from "./meshOps.js";
import { exportBinarySTL, export3MF } from "./exportMesh.js";

const STORAGE_WELCOME = "edgemagic_hide_welcome";

const els = {
  viewport: document.getElementById("viewport"),
  fileDrop: document.getElementById("file-drop"),
  fileInput: document.getElementById("file-input"),
  modelStatus: document.getElementById("model-status"),
  btnResetView: document.getElementById("btn-reset-view"),
  btnZoomIn: document.getElementById("btn-zoom-in"),
  btnZoomOut: document.getElementById("btn-zoom-out"),
  btnCenterView: document.getElementById("btn-center-view"),
  btnClearModel: document.getElementById("btn-clear-model"),
  sliderFeature: document.getElementById("slider-feature-angle"),
  valFeature: document.getElementById("val-feature-angle"),
  btnRebuildEdges: document.getElementById("btn-rebuild-edges"),
  btnClearSelection: document.getElementById("btn-clear-selection"),
  selectionCount: document.getElementById("selection-count"),
  opChamfer: document.getElementById("op-chamfer"),
  opFillet: document.getElementById("op-fillet"),
  fieldChamfer: document.getElementById("field-chamfer-size"),
  fieldFillet: document.getElementById("field-fillet"),
  sliderChamfer: document.getElementById("slider-chamfer"),
  valChamfer: document.getElementById("val-chamfer"),
  sliderFillet: document.getElementById("slider-fillet"),
  valFillet: document.getElementById("val-fillet"),
  sliderFilletPasses: document.getElementById("slider-fillet-passes"),
  valFilletPasses: document.getElementById("val-fillet-passes"),
  btnApply: document.getElementById("btn-apply"),
  btnExportStl: document.getElementById("btn-export-stl"),
  btnExport3mf: document.getElementById("btn-export-3mf"),
  toast: document.getElementById("toast"),
  loadingOverlay: document.getElementById("loading-overlay"),
  loadingText: document.getElementById("loading-text"),
  modalWelcome: document.getElementById("modal-welcome"),
  welcomeNever: document.getElementById("welcome-never"),
  welcomeDismiss: document.getElementById("welcome-dismiss"),
  modalHelp: document.getElementById("modal-help"),
  btnHelp: document.getElementById("btn-help"),
  helpClose: document.getElementById("help-close"),
};

/** @type {THREE.PerspectiveCamera | null} */
let camera = null;
/** @type {THREE.WebGLRenderer | null} */
let renderer = null;
/** @type {OrbitControls | null} */
let controls = null;
/** @type {THREE.Scene | null} */
let scene = null;
/** @type {THREE.Mesh | null} */
let mesh = null;
/** @type {THREE.LineSegments | null} */
let edgeLines = null;
/** @type {THREE.LineSegments | null} */
let selectedEdgeOverlay = null;
/** @type {import('./edges.js').EdgeInfo[]} */
let edgeList = [];
let bboxSize = 1;
/** @type {Set<string>} */
const selected = new Set();
let featureAngleDeg = 35;
let currentOp = "chamfer";
let lastFileName = "model";
let pickThreshold = 0.05;
/** @type {{ basePos: Float32Array, baseIdx: Uint16Array | Uint32Array | null, selectedEdges: import('./edges.js').EdgeInfo[] } | null} */
let livePreviewState = null;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("is-visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.toast.classList.remove("is-visible"), 2600);
}

function setLoading(show, text = "Loading…") {
  els.loadingText.textContent = text;
  els.loadingOverlay.classList.toggle("hidden", !show);
}

function initWelcome() {
  if (localStorage.getItem(STORAGE_WELCOME) === "1") {
    els.modalWelcome.classList.add("hidden");
  }
  els.welcomeDismiss.addEventListener("click", () => {
    if (els.welcomeNever.checked) localStorage.setItem(STORAGE_WELCOME, "1");
    els.modalWelcome.classList.add("hidden");
  });
}

function initHelp() {
  els.btnHelp.addEventListener("click", () => {
    els.modalHelp.classList.remove("hidden");
  });
  els.helpClose.addEventListener("click", () => {
    els.modalHelp.classList.add("hidden");
  });
  els.modalHelp.addEventListener("click", (e) => {
    if (e.target === els.modalHelp) els.modalHelp.classList.add("hidden");
  });
}

function initThree() {
  const w = els.viewport.clientWidth || 640;
  const h = els.viewport.clientHeight || 480;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, w / h, 0.001, 5000);
  camera.position.set(1.2, 0.9, 1.6);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.setClearColor(0x0c0e12, 1);
  els.viewport.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;

  scene.add(new THREE.HemisphereLight(0x9fb8ff, 0x1a1f28, 0.85));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(2, 4, 3);
  scene.add(dir);

  const grid = new THREE.GridHelper(4, 20, 0x334155, 0x1e293b);
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  scene.add(grid);

  window.addEventListener("resize", onResize);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  animate();
}

function onResize() {
  if (!renderer || !camera) return;
  const w = els.viewport.clientWidth;
  const h = els.viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  controls?.update();
  renderer?.render(scene, camera);
}

function frameObject(object) {
  if (!camera || !controls) return;
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  controls.target.copy(center);
  const dist = size * 0.9 || 1;
  controls.minDistance = Math.max(dist * 0.04, 0.0001);
  controls.maxDistance = Math.max(dist * 120, 10);
  camera.near = Math.max(dist / 2000, 0.0001);
  camera.far = Math.max(dist * 50, 100);
  camera.updateProjectionMatrix();
  camera.position.copy(center.clone().add(new THREE.Vector3(dist, dist * 0.65, dist)));
  controls.update();
  pickThreshold = Math.max(size * 0.015, 0.002);
}

/** @param {number} factor Multiplier for eye–target distance; below 1 zooms in, above 1 zooms out. */
function dollyCamera(factor) {
  if (!camera || !controls || !mesh) return;
  const offset = camera.position.clone().sub(controls.target);
  const len = offset.length();
  if (len < 1e-10) return;
  const next = THREE.MathUtils.clamp(len * factor, controls.minDistance, controls.maxDistance);
  offset.multiplyScalar(next / len);
  camera.position.copy(controls.target.clone().add(offset));
  controls.update();
}

function clearModel() {
  cancelLivePreview(false);
  selected.clear();
  clearSelectionOverlay();
  if (edgeLines) {
    scene.remove(edgeLines);
    edgeLines.geometry.dispose();
    edgeLines.material.dispose();
    edgeLines = null;
  }
  edgeList = [];
  if (mesh) {
    scene.remove(mesh);
    mesh.geometry.dispose();
    mesh.material.dispose();
    mesh = null;
  }
  updateUi();
}

function rebuildEdges() {
  if (!mesh) return;
  cancelLivePreview(false);
  clearSelectionOverlay();
  if (edgeLines) {
    scene.remove(edgeLines);
    edgeLines.geometry.dispose();
    edgeLines.material.dispose();
    edgeLines = null;
  }
  selected.clear();
  const { lines, edges, bboxSize: bs } = buildFeatureEdges(mesh.geometry, featureAngleDeg);
  edgeLines = lines;
  edgeList = edges;
  bboxSize = bs;
  scene.add(edgeLines);
  updateEdgeSelectionStyle(edgeLines, edgeList, selected);
  els.selectionCount.textContent = `${selected.size} edges selected`;
  if (!edges.length) showToast("No feature edges at this angle — try lowering feature angle.");
  updateUi();
}

function updateUi() {
  const hasMesh = !!mesh;
  els.btnResetView.disabled = !hasMesh;
  els.btnZoomIn.disabled = !hasMesh;
  els.btnZoomOut.disabled = !hasMesh;
  els.btnCenterView.disabled = !hasMesh;
  els.btnClearModel.disabled = !hasMesh;
  els.btnRebuildEdges.disabled = !hasMesh;
  els.btnClearSelection.disabled = !hasMesh || !selected.size;
  els.btnApply.disabled = !hasMesh || !selected.size;
  els.btnExportStl.disabled = !hasMesh;
  els.btnExport3mf.disabled = !hasMesh;
}

function clearSelectionOverlay() {
  if (!selectedEdgeOverlay) return;
  scene.remove(selectedEdgeOverlay);
  selectedEdgeOverlay.geometry.dispose();
  selectedEdgeOverlay.material.dispose();
  selectedEdgeOverlay = null;
}

function refreshSelectionOverlay() {
  clearSelectionOverlay();
  if (!scene || !edgeLines || !selected.size) return;
  selectedEdgeOverlay = buildSelectedEdgeOverlay(edgeLines, edgeList, selected);
  if (selectedEdgeOverlay) scene.add(selectedEdgeOverlay);
}

function restoreGeometryToBase(state) {
  if (!mesh || !state) return;
  const newPos = new Float32Array(state.basePos);
  mesh.geometry.deleteAttribute("normal");
  mesh.geometry.deleteAttribute("uv");
  mesh.geometry.setAttribute("position", new THREE.BufferAttribute(newPos, 3));
  if (state.baseIdx) {
    const Ctor = state.baseIdx instanceof Uint32Array ? Uint32Array : Uint16Array;
    const newIdx = new Ctor(state.baseIdx);
    mesh.geometry.setIndex(new THREE.BufferAttribute(newIdx, 1));
  }
  mesh.geometry.computeVertexNormals();
  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
}

function cancelLivePreview(restoreBase = true) {
  if (!livePreviewState) return;
  if (restoreBase) restoreGeometryToBase(livePreviewState);
  livePreviewState = null;
}

function applyLivePreview() {
  if (!mesh || !selected.size) return;
  const pos = mesh.geometry.getAttribute("position");
  if (!pos) return;
  if (!livePreviewState || !livePreviewState.selectedEdges.length) {
    const idx = mesh.geometry.getIndex();
    let baseIdx = null;
    if (idx) {
      const Ctor = idx.array instanceof Uint32Array ? Uint32Array : Uint16Array;
      baseIdx = new Ctor(idx.array);
    }
    livePreviewState = {
      basePos: new Float32Array(pos.array),
      baseIdx,
      selectedEdges: getSelectedEdges(),
    };
  }
  restoreGeometryToBase(livePreviewState);
  if (currentOp === "chamfer") {
    const amount = Number(els.sliderChamfer.value) / 100;
    applyChamfer(mesh.geometry, livePreviewState.selectedEdges, amount, featureAngleDeg);
  } else {
    const strength = Number(els.sliderFillet.value) / 100;
    const passes = Number(els.sliderFilletPasses.value);
    applyFillet(mesh.geometry, livePreviewState.selectedEdges, strength, passes, featureAngleDeg);
  }
  const updatedPos = mesh.geometry.getAttribute("position");
  if (updatedPos) updatedPos.needsUpdate = true;
}

function commitLivePreviewOrApply() {
  if (!mesh || !selected.size) return;
  if (livePreviewState) {
    livePreviewState = null;
    rebuildEdges();
    showToast("Applied.");
    return;
  }
  const edges = getSelectedEdges();
  if (currentOp === "chamfer") {
    const amount = Number(els.sliderChamfer.value) / 100;
    applyChamfer(mesh.geometry, edges, amount, featureAngleDeg);
  } else {
    const strength = Number(els.sliderFillet.value) / 100;
    const passes = Number(els.sliderFilletPasses.value);
    applyFillet(mesh.geometry, edges, strength, passes, featureAngleDeg);
  }
  mesh.geometry.attributes.position.needsUpdate = true;
  rebuildEdges();
  showToast("Applied.");
}

function downloadBlob(data, mime, name) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function onPointerDown(e) {
  if (!mesh || !edgeLines || !camera) return;
  cancelLivePreview(true);
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hit = pickEdgeNearestRay(raycaster, edgeLines, edgeList, pickThreshold);
  if (!hit) return;
  if (e.shiftKey) {
    if (selected.has(hit.key)) selected.delete(hit.key);
    else selected.add(hit.key);
  } else {
    selected.clear();
    selected.add(hit.key);
  }
  updateEdgeSelectionStyle(edgeLines, edgeList, selected);
  refreshSelectionOverlay();
  els.selectionCount.textContent = `${selected.size} edges selected`;
  if (selected.size) applyLivePreview();
  updateUi();
}

/**
 * Weld coincident vertices after import so chamfer/fillet sees one logical corner.
 * STL/OBJ often duplicate positions per face with split vertex normals;
 * mergeVertices only merges when all attributes hash equal — stripping normals
 * makes hashing effectively position-based at corners (UV/color retained).
 */
function weldGeometryForEditing(geom, tol = 1e-5) {
  const g = geom.clone();
  g.deleteAttribute("normal");
  const welded = mergeVertices(g, tol);
  welded.computeVertexNormals();
  return welded;
}

async function handleFile(file) {
  if (!file) return;
  lastFileName = file.name.replace(/\.[^.]+$/, "") || "model";
  setLoading(true, "Reading file…");
  try {
    const buf = await file.arrayBuffer();
    const rawGeom = await loadModelBuffer(buf, file.name, (m) => setLoading(true, m));
    let geom = weldGeometryForEditing(rawGeom);
    clearModel();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x94a3b8,
      metalness: 0.15,
      roughness: 0.55,
      side: THREE.DoubleSide,
      flatShading: false,
    });
    mesh = new THREE.Mesh(geom, mat);
    scene.add(mesh);
    frameObject(mesh);
    rebuildEdges();
    els.modelStatus.textContent = file.name;
    showToast("Model loaded. Click edges to select.");
  } catch (err) {
    console.error(err);
    showToast(err?.message || String(err));
    els.modelStatus.textContent = "Load failed";
  } finally {
    setLoading(false);
  }
  updateUi();
}

function getSelectedEdges() {
  return edgeList.filter((e) => selected.has(e.key));
}

function initUi() {
  els.fileDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.fileDrop.style.borderColor = "var(--accent)";
  });
  els.fileDrop.addEventListener("dragleave", () => {
    els.fileDrop.style.borderColor = "";
  });
  els.fileDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    els.fileDrop.style.borderColor = "";
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });
  els.fileInput.addEventListener("change", () => {
    const f = els.fileInput.files?.[0];
    if (f) handleFile(f);
    els.fileInput.value = "";
  });

  els.btnResetView.addEventListener("click", () => {
    if (mesh) frameObject(mesh);
  });
  els.btnZoomIn.addEventListener("click", () => dollyCamera(0.82));
  els.btnZoomOut.addEventListener("click", () => dollyCamera(1 / 0.82));
  els.btnCenterView.addEventListener("click", () => {
    if (mesh) frameObject(mesh);
  });
  els.btnClearModel.addEventListener("click", () => {
    clearModel();
    els.modelStatus.textContent = "No file loaded";
    updateUi();
  });

  const syncFeature = () => {
    featureAngleDeg = Number(els.sliderFeature.value);
    els.valFeature.textContent = `${featureAngleDeg}°`;
  };
  els.sliderFeature.addEventListener("input", syncFeature);
  syncFeature();
  els.btnRebuildEdges.addEventListener("click", rebuildEdges);
  els.btnClearSelection.addEventListener("click", () => {
    cancelLivePreview(true);
    selected.clear();
    if (edgeLines) updateEdgeSelectionStyle(edgeLines, edgeList, selected);
    refreshSelectionOverlay();
    els.selectionCount.textContent = "0 edges selected";
    updateUi();
  });

  const setOp = (op) => {
    if (currentOp === op) return;
    currentOp = op;
    els.opChamfer.classList.toggle("is-active", op === "chamfer");
    els.opFillet.classList.toggle("is-active", op === "fillet");
    els.fieldChamfer.classList.toggle("hidden", op !== "chamfer");
    els.fieldFillet.classList.toggle("hidden", op !== "fillet");
    if (selected.size) applyLivePreview();
  };
  els.opChamfer.addEventListener("click", () => setOp("chamfer"));
  els.opFillet.addEventListener("click", () => setOp("fillet"));

  const syncCh = () => {
    els.valChamfer.textContent = `${els.sliderChamfer.value}%`;
    if (selected.size && currentOp === "chamfer") applyLivePreview();
  };
  els.sliderChamfer.addEventListener("input", syncCh);
  syncCh();
  const syncFi = () => {
    els.valFillet.textContent = `${els.sliderFillet.value}%`;
    if (selected.size && currentOp === "fillet") applyLivePreview();
  };
  els.sliderFillet.addEventListener("input", syncFi);
  syncFi();
  const syncFp = () => {
    els.valFilletPasses.textContent = els.sliderFilletPasses.value;
    if (selected.size && currentOp === "fillet") applyLivePreview();
  };
  els.sliderFilletPasses.addEventListener("input", syncFp);
  syncFp();

  els.btnApply.addEventListener("click", commitLivePreviewOrApply);

  els.btnExportStl.addEventListener("click", () => {
    if (!mesh) return;
    const buf = exportBinarySTL(mesh.geometry);
    downloadBlob(buf, "model/stl", `${lastFileName}-edgemagic.stl`);
    showToast("STL downloaded.");
  });
  els.btnExport3mf.addEventListener("click", () => {
    if (!mesh) return;
    try {
      const u8 = export3MF(mesh.geometry, lastFileName);
      downloadBlob(u8, "model/3mf", `${lastFileName}-edgemagic.3mf`);
      showToast("3MF downloaded.");
    } catch (err) {
      console.error(err);
      showToast("3MF export failed.");
    }
  });

  updateUi();
}

initWelcome();
initHelp();
initThree();
initUi();
