/**
 * GWP calculation helpers.
 * Converts material group volumes/areas into GWP using matched EPDs.
 */
import type { EPD } from './types.js';
import type { MaterialGroup } from '../material-panel.js';

/**
 * Compute the quantity in the EPD's declared unit for a material group.
 * volume (m³) and area (m²) come from the IFC extraction.
 * If the EPD unit is kg, we convert via density.
 */
export function computeQuantity(
  group: MaterialGroup,
  epd: EPD,
): number {
  switch (epd.declaredUnit) {
    case 'm3':
      return group.totalVolume;
    case 'm2':
      // If we have area, use it. Otherwise estimate from volume / assumed thickness.
      if (group.totalArea > 0) return group.totalArea;
      if (group.totalVolume > 0) return group.totalVolume / 0.015; // assume ~15mm
      return 0;
    case 'kg':
      // Convert volume to mass via density
      if (group.totalVolume > 0) return group.totalVolume * epd.density;
      // Rough estimate from area * thickness * density
      if (group.totalArea > 0) return group.totalArea * 0.015 * epd.density;
      return 0;
  }
}

/**
 * Compute total GWP (kg CO₂e) for a material group with a matched EPD.
 */
export function computeGWP(
  group: MaterialGroup,
  epd: EPD,
): number {
  const qty = computeQuantity(group, epd);
  return qty * epd.gwp;
}

/**
 * Format a GWP value for display.
 */
export function formatGWP(value: number): string {
  if (value === 0) return '-';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return (value / 1_000_000).toFixed(1) + ' t';
  if (abs >= 1000) return (value / 1000).toFixed(1) + ' t';
  return value.toFixed(0) + ' kg';
}
