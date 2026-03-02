import type { IfcDataStore } from '@ifc-lite/parser';
import { extractMaterialsOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import type { EPDMatch, LCAResult } from './lca/types.js';
import { formatGWP } from './lca/calculator.js';

export interface MaterialGroup {
  name: string;
  color: string;
  elementCount: number;
  totalVolume: number;
  totalArea: number;
  elements: number[];
}

/** IFC types that represent physical building elements.
 *  We match case-insensitively since byType keys can be PascalCase or UPPERCASE. */
const ELEMENT_TYPE_NAMES = [
  'IfcWall', 'IfcWallStandardCase', 'IfcSlab', 'IfcColumn', 'IfcBeam',
  'IfcDoor', 'IfcWindow', 'IfcRoof', 'IfcStair', 'IfcStairFlight',
  'IfcRailing', 'IfcRamp', 'IfcRampFlight', 'IfcPlate', 'IfcMember',
  'IfcCurtainWall', 'IfcFooting', 'IfcPile', 'IfcBuildingElementProxy',
  'IfcFurnishingElement', 'IfcFlowSegment', 'IfcFlowTerminal',
  'IfcFlowController', 'IfcFlowFitting', 'IfcCovering',
];
const ELEMENT_TYPES_UPPER = new Set(ELEMENT_TYPE_NAMES.map(t => t.toUpperCase()));

/** Simple hash-based color for material names */
function materialColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 55%, 55%)`;
}

/** Check if a type name from the entity index is a physical building element */
function isElementType(typeName: string): boolean {
  return ELEMENT_TYPES_UPPER.has(typeName.toUpperCase());
}

/** Infer a material name from an IFC type when no material assignment exists */
function inferMaterialFromType(typeName: string): string {
  const upper = typeName.toUpperCase().replace(/^IFC/, '');
  const typeMap: Record<string, string> = {
    'WALL': 'Concrete Wall',
    'WALLSTANDARDCASE': 'Concrete Wall',
    'SLAB': 'Concrete Slab',
    'COLUMN': 'Concrete Column',
    'BEAM': 'Steel Beam',
    'WINDOW': 'Glass Window',
    'DOOR': 'Wood Door',
    'ROOF': 'Roof Assembly',
    'STAIR': 'Concrete Stair',
    'STAIRFLIGHT': 'Concrete Stair',
    'RAILING': 'Steel Railing',
    'CURTAINWALL': 'Aluminum Curtain Wall',
    'PLATE': 'Steel Plate',
    'MEMBER': 'Steel Member',
    'FOOTING': 'Concrete Footing',
    'PILE': 'Concrete Pile',
    'COVERING': 'Gypsum Board',
    'BUILDINGELEMENTPROXY': 'Building Element',
  };
  return typeMap[upper] || `${typeName.replace(/^Ifc/i, '')} Material`;
}

/**
 * Extract materials grouped by name with aggregated volumes from the IFC data store.
 */
export function extractMaterialGroups(store: IfcDataStore): MaterialGroup[] {
  const groups = new Map<string, MaterialGroup>();

  // Debug: log all available types in the entity index
  const allTypes = Array.from(store.entityIndex.byType.keys());
  const matchingTypes = allTypes.filter(isElementType);
  console.log('[MaterialPanel] Entity types in model:', allTypes.join(', '));
  console.log('[MaterialPanel] Matching element types:', matchingTypes.join(', '));
  console.log('[MaterialPanel] Has onDemandMaterialMap:', !!store.onDemandMaterialMap, store.onDemandMaterialMap?.size ?? 0, 'entries');

  let materialHits = 0;
  let materialMisses = 0;

  // Iterate over all building element types (case-insensitive match)
  for (const [typeName, ids] of store.entityIndex.byType) {
    if (!isElementType(typeName)) continue;

    for (const expressId of ids) {
      // Get material for this element
      const materialInfo = extractMaterialsOnDemand(store, expressId);
      let materialName = '';

      if (materialInfo) {
        materialHits++;
        if (materialInfo.name) {
          materialName = materialInfo.name;
        } else if (materialInfo.layers && materialInfo.layers.length > 0) {
          const layerNames = materialInfo.layers
            .map(l => l.materialName)
            .filter(Boolean);
          materialName = layerNames.length > 0 ? layerNames.join(' + ') : '';
        } else if (materialInfo.constituents && materialInfo.constituents.length > 0) {
          const constNames = materialInfo.constituents
            .map(c => c.materialName)
            .filter(Boolean);
          materialName = constNames.length > 0 ? constNames.join(' + ') : '';
        } else if (materialInfo.profiles && materialInfo.profiles.length > 0) {
          const profNames = materialInfo.profiles
            .map(p => p.materialName)
            .filter(Boolean);
          materialName = profNames.length > 0 ? profNames.join(' + ') : '';
        } else if (materialInfo.materials && materialInfo.materials.length > 0) {
          materialName = materialInfo.materials.join(' + ');
        }
      } else {
        materialMisses++;
      }

      // Fallback: infer material from IFC type if no material assignment
      if (!materialName) {
        materialName = inferMaterialFromType(typeName);
      }

      // Get quantities for this element
      const quantitySets = extractQuantitiesOnDemand(store, expressId);
      let volume = 0;
      let area = 0;

      for (const qset of quantitySets) {
        for (const q of qset.quantities) {
          if (q.type === 2) {
            volume += q.value;
          } else if (q.type === 1) {
            area += q.value;
          }
        }
      }

      // Add to group
      let group = groups.get(materialName);
      if (!group) {
        group = {
          name: materialName,
          color: materialColor(materialName),
          elementCount: 0,
          totalVolume: 0,
          totalArea: 0,
          elements: [],
        };
        groups.set(materialName, group);
      }
      group.elementCount++;
      group.totalVolume += volume;
      group.totalArea += area;
      group.elements.push(expressId);
    }
  }

  console.log(`[MaterialPanel] Material extraction: ${materialHits} hits, ${materialMisses} misses, ${groups.size} groups`);

  // Sort by volume descending, then by element count
  return Array.from(groups.values()).sort((a, b) => b.totalVolume - a.totalVolume || b.elementCount - a.elementCount);
}

/**
 * Render the material groups into the panel (basic view, no LCA).
 */
export function renderMaterialPanel(groups: MaterialGroup[]): void {
  renderMaterialPanelWithLCA(groups, null);
}

/**
 * Render the material groups with LCA matching results.
 */
export function renderMaterialPanelWithLCA(groups: MaterialGroup[], lcaResult: LCAResult | null): void {
  const listEl = document.getElementById('material-list')!;
  const summaryEl = document.getElementById('panel-summary')!;

  if (groups.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No materials found in this model</div>';
    summaryEl.textContent = '';
    return;
  }

  const totalElements = groups.reduce((sum, g) => sum + g.elementCount, 0);
  const totalVolume = groups.reduce((sum, g) => sum + g.totalVolume, 0);

  const matchMap = new Map<string, EPDMatch>();
  if (lcaResult) {
    for (const m of lcaResult.matches) matchMap.set(m.materialName, m);
  }

  // Summary line
  if (lcaResult) {
    summaryEl.innerHTML = `${groups.length} materials | ${totalElements} elements | <strong>Total GWP: ${formatGWP(lcaResult.totalGWP)} CO₂e</strong>`;
  } else {
    summaryEl.textContent = `${groups.length} materials | ${totalElements} elements | ${formatVolume(totalVolume)} total volume`;
  }

  // Table header
  let html = `<table>
    <thead>
      <tr>
        <th>Material</th>
        <th>Elements</th>
        <th>Volume (m³)</th>`;

  if (lcaResult) {
    html += `
        <th>Matched EPD</th>
        <th>Conf.</th>
        <th>GWP (CO₂e)</th>`;
  } else {
    html += `
        <th>Area (m²)</th>`;
  }

  html += `
      </tr>
    </thead>
    <tbody>`;

  for (const group of groups) {
    const match = matchMap.get(group.name);

    html += `<tr>
      <td><span class="color-swatch" style="background:${group.color}"></span><span class="material-name">${escapeHtml(group.name)}</span></td>
      <td>${group.elementCount}</td>
      <td>${formatVolume(group.totalVolume)}</td>`;

    if (lcaResult) {
      if (match) {
        const confClass = `conf-${match.confidence}`;
        const altText = match.alternatives.length > 0
          ? ` (alt: ${match.alternatives.map(a => a.name).join(', ')})`
          : '';
        html += `
      <td><span class="epd-name" title="${escapeHtml(match.reason + altText)}">${escapeHtml(match.epd.name)}</span></td>
      <td><span class="conf-badge ${confClass}">${match.confidence}</span></td>
      <td class="gwp-cell ${match.gwpTotal < 0 ? 'gwp-negative' : ''}">${formatGWP(match.gwpTotal)}</td>`;
      } else {
        html += `
      <td class="unmatched">—</td>
      <td>—</td>
      <td>—</td>`;
      }
    } else {
      html += `
      <td>${formatArea(group.totalArea)}</td>`;
    }

    html += `</tr>`;
  }

  // Warnings row
  if (lcaResult && lcaResult.warnings.length > 0) {
    const colspan = 6;
    html += `<tr class="warning-row"><td colspan="${colspan}">⚠ ${lcaResult.warnings.map(escapeHtml).join(' | ')}</td></tr>`;
  }

  html += `</tbody></table>`;
  listEl.innerHTML = html;
}

function formatVolume(v: number): string {
  if (v === 0) return '-';
  if (v < 0.001) return '< 0.001';
  return v.toFixed(3);
}

function formatArea(a: number): string {
  if (a === 0) return '-';
  if (a < 0.01) return '< 0.01';
  return a.toFixed(2);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
