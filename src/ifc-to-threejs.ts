import * as THREE from 'three';
import type { MeshData } from '@ifc-lite/geometry';

/** IFC types to hide globally */
const HIDDEN_TYPES = new Set([
  'IFCOPENINGELEMENT',
  'IFCSPACE',
  'IFCOPENINGSTANDARDCASE',
]);

/** Check if a mesh should be hidden based on its IFC type */
export function shouldHideMesh(mesh: MeshData): boolean {
  if (!mesh.ifcType) return false;
  return HIDDEN_TYPES.has(mesh.ifcType.toUpperCase());
}

/**
 * Convert a single MeshData into a Three.js Group with mesh + edge outlines.
 */
export function meshDataToThree(mesh: MeshData): THREE.Group {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

  const [r, g, b, a] = mesh.color;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(r, g, b),
    transparent: a < 1,
    opacity: a,
    side: a < 1 ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: a >= 1,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  const threeMesh = new THREE.Mesh(geometry, material);

  // Edge outlines
  const edges = new THREE.EdgesGeometry(geometry, 30);
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.15,
  });
  const lineSegments = new THREE.LineSegments(edges, lineMat);

  const group = new THREE.Group();
  group.add(threeMesh);
  group.add(lineSegments);
  group.userData.expressId = mesh.expressId;
  group.userData.ifcType = mesh.ifcType;
  return group;
}
