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
 * Convert a single MeshData into a Three.js Mesh.
 * Matches the ifc-lite reference viewer implementation.
 */
export function meshDataToThree(mesh: MeshData): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingSphere();

  const [r, g, b, a] = mesh.color;
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(r, g, b),
    transparent: a < 1,
    opacity: a,
    side: THREE.DoubleSide,
    depthWrite: a >= 1,
  });

  const threeMesh = new THREE.Mesh(geometry, material);
  threeMesh.userData.expressId = mesh.expressId;
  threeMesh.userData.ifcType = mesh.ifcType;
  return threeMesh;
}
