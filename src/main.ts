import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { IfcParser } from '@ifc-lite/parser';
import { meshDataToThree, shouldHideMesh } from './ifc-to-threejs.js';
import { extractMaterialGroups, renderMaterialPanel, renderMaterialPanelWithLCA } from './material-panel.js';
import { initChatPanel, updateChatContext } from './chat/chat-panel.js';
import { autoMatch } from './chat/llm-client.js';

// DOM elements
const canvas = document.getElementById('viewer') as HTMLCanvasElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const status = document.getElementById('status')!;

// ── Three.js setup ──────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 10000);
camera.position.set(20, 15, 20);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;

// Lighting
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(50, 80, 50);
scene.add(dirLight);

// IFC-Lite processors
const geometry = new GeometryProcessor();
const parser = new IfcParser();

// ── Initialize chat panel ──────────────────────────────────────────────
initChatPanel();

// ── Resize ──────────────────────────────────────────────────────────────
function resize() {
  const container = canvas.parentElement ?? document.body;
  renderer.setSize(container.clientWidth, container.clientHeight);
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ── Panel resize drag ───────────────────────────────────────────────────
const panelResize = document.getElementById('panel-resize')!;
const materialPanel = document.getElementById('material-panel')!;
let isDragging = false;

panelResize.addEventListener('mousedown', (e) => {
  isDragging = true;
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  const appHeight = document.getElementById('app')!.clientHeight;
  const newHeight = Math.max(100, Math.min(appHeight - 150, appHeight - e.clientY));
  materialPanel.style.height = newHeight + 'px';
  resize();
});

window.addEventListener('mouseup', () => {
  isDragging = false;
});

// ── Render loop ─────────────────────────────────────────────────────────
(function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
})();

// ── Helpers ─────────────────────────────────────────────────────────────
function clearModel() {
  const toRemove = scene.children.filter(
    (c) => c instanceof THREE.Mesh || c instanceof THREE.Group
  );
  for (const obj of toRemove) {
    scene.remove(obj);
    obj.traverse((child) => {
      if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else {
          child.material.dispose();
        }
      }
    });
  }
}

function fitCamera() {
  const box = new THREE.Box3().setFromObject(scene);
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.y, size.z) * 1.5;
  camera.position.set(center.x + d * 0.5, center.y + d * 0.5, center.z + d * 0.5);
  controls.target.copy(center);
  controls.update();
  camera.near = Math.max(size.x, size.y, size.z) * 0.001;
  camera.far = Math.max(size.x, size.y, size.z) * 100;
  camera.updateProjectionMatrix();
}

// ── File loading ────────────────────────────────────────────────────────
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  status.textContent = `Loading ${file.name}...`;

  try {
    const buffer = new Uint8Array(await file.arrayBuffer());

    // Clear previous model
    clearModel();

    // Run geometry streaming and data parsing in parallel
    await geometry.init();

    // Start geometry streaming for 3D view
    let meshCount = 0;
    const geometryPromise = (async () => {
      for await (const event of geometry.processStreaming(buffer)) {
        if (event.type === 'batch') {
          for (const mesh of event.meshes) {
            if (shouldHideMesh(mesh)) continue;
            scene.add(meshDataToThree(mesh));
          }
          meshCount += event.meshes.length;
          status.textContent = `Loading meshes: ${meshCount}...`;
        }
        if (event.type === 'complete') {
          fitCamera();
          status.textContent = `${file.name} — ${event.totalMeshes} meshes`;
        }
      }
    })();

    // Parse IFC data for materials and quantities
    status.textContent = `Parsing ${file.name}...`;
    const dataPromise = (async () => {
      const store = await parser.parseColumnar(buffer.buffer);
      return store;
    })();

    // Wait for both to complete
    const [, store] = await Promise.all([geometryPromise, dataPromise]);

    // Extract material groups and render panel (basic view first)
    status.textContent = `Extracting materials...`;
    const groups = extractMaterialGroups(store);
    renderMaterialPanel(groups);

    status.textContent = `${file.name} — ${meshCount} meshes | ${groups.length} materials — matching EPDs...`;

    // Run LCA auto-matching (keyword fallback if no API key)
    const lcaResult = await autoMatch(groups);
    renderMaterialPanelWithLCA(groups, lcaResult);
    updateChatContext(groups, lcaResult.matches);

    const gwpStr = Math.abs(lcaResult.totalGWP) >= 1000
      ? (lcaResult.totalGWP / 1000).toFixed(1) + ' t'
      : lcaResult.totalGWP.toFixed(0) + ' kg';
    status.textContent = `${file.name} — ${meshCount} meshes | ${groups.length} materials | GWP: ${gwpStr} CO₂e`;
  } catch (err: any) {
    status.textContent = 'Error: ' + err.message;
    console.error(err);
  }
});
