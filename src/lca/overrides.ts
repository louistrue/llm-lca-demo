/**
 * Material override system with undo/redo.
 * Tracks user-initiated material switches (e.g. "switch steel to timber")
 * and recalculates GWP with adjusted volumes.
 */
import type { EPD, EPDMatch, LCAResult } from './types.js';
import { getEPDById } from '../data/epd-catalog.js';
import { computeQuantity, computeGWP } from './calculator.js';
import type { MaterialGroup } from '../material-panel.js';

export interface MaterialOverride {
  materialName: string;
  originalEpdId: string;
  newEpdId: string;
  volumeFactor: number;
  reason: string;
}

type Snapshot = Map<string, MaterialOverride>;

let overrides: Map<string, MaterialOverride> = new Map();
const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];

/** Listeners for override changes */
type Listener = () => void;
const listeners: Listener[] = [];

export function onOverridesChanged(fn: Listener): void {
  listeners.push(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

function cloneOverrides(): Snapshot {
  return new Map(overrides);
}

/** Apply a material switch override */
export function applyOverride(override: MaterialOverride): void {
  undoStack.push(cloneOverrides());
  redoStack.length = 0;
  overrides.set(override.materialName, override);
  notify();
}

/** Apply multiple overrides at once */
export function applyOverrides(list: MaterialOverride[]): void {
  undoStack.push(cloneOverrides());
  redoStack.length = 0;
  for (const o of list) overrides.set(o.materialName, o);
  notify();
}

/** Remove a single override (revert one material) */
export function removeOverride(materialName: string): void {
  if (!overrides.has(materialName)) return;
  undoStack.push(cloneOverrides());
  redoStack.length = 0;
  overrides.delete(materialName);
  notify();
}

/** Undo last override action */
export function undo(): boolean {
  if (undoStack.length === 0) return false;
  redoStack.push(cloneOverrides());
  overrides = undoStack.pop()!;
  notify();
  return true;
}

/** Redo last undone action */
export function redo(): boolean {
  if (redoStack.length === 0) return false;
  undoStack.push(cloneOverrides());
  overrides = redoStack.pop()!;
  notify();
  return true;
}

export function canUndo(): boolean { return undoStack.length > 0; }
export function canRedo(): boolean { return redoStack.length > 0; }
export function getOverrides(): ReadonlyMap<string, MaterialOverride> { return overrides; }
export function hasOverride(materialName: string): boolean { return overrides.has(materialName); }
export function getOverride(materialName: string): MaterialOverride | undefined { return overrides.get(materialName); }
export function clearOverrides(): void {
  if (overrides.size === 0) return;
  undoStack.push(cloneOverrides());
  redoStack.length = 0;
  overrides.clear();
  notify();
}

/**
 * Recompute LCA results applying all current overrides.
 * Takes the original (base) LCA result and returns a new one.
 */
export function applyOverridesToResult(
  baseResult: LCAResult,
  groups: MaterialGroup[],
): LCAResult {
  if (overrides.size === 0) return baseResult;

  const groupMap = new Map(groups.map(g => [g.name, g]));
  const newMatches: EPDMatch[] = [];
  const unmatchedMaterials = [...baseResult.unmatchedMaterials];

  for (const match of baseResult.matches) {
    const override = overrides.get(match.materialName);
    if (override) {
      const newEpd = getEPDById(override.newEpdId);
      if (newEpd) {
        const group = groupMap.get(match.materialName);
        if (group) {
          // Create a virtual group with adjusted volume
          const adjustedGroup: MaterialGroup = {
            ...group,
            totalVolume: group.totalVolume * override.volumeFactor,
            totalArea: group.totalArea * override.volumeFactor,
          };
          const qty = computeQuantity(adjustedGroup, newEpd);
          const gwp = computeGWP(adjustedGroup, newEpd);

          newMatches.push({
            ...match,
            epd: newEpd,
            gwpTotal: gwp,
            quantity: qty,
            reason: override.reason,
            confidence: match.confidence,
          });
          continue;
        }
      }
    }
    newMatches.push(match);
  }

  const totalGWP = newMatches.reduce((sum, m) => sum + m.gwpTotal, 0);
  return {
    ...baseResult,
    matches: newMatches,
    totalGWP,
  };
}
