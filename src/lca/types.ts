export interface EPD {
  id: string;
  name: string;
  category: MaterialCategory;
  gwp: number;             // kg CO₂e per declared unit (A1-A3)
  declaredUnit: 'm3' | 'm2' | 'kg';
  density: number;         // kg/m³
  source: string;
  keywords: string[];
}

export type MaterialCategory =
  | 'CONCRETE'
  | 'STEEL'
  | 'WOOD'
  | 'INSULATION'
  | 'GLASS'
  | 'MASONRY'
  | 'ALUMINUM'
  | 'GYPSUM'
  | 'MEMBRANE'
  | 'PLASTER'
  | 'FLOORING'
  | 'OTHER';

export interface EPDMatch {
  materialName: string;
  epd: EPD;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  gwpTotal: number;        // total kg CO₂e for this material group
  quantity: number;         // amount in declared unit
  alternatives: EPD[];
}

export interface LCAResult {
  matches: EPDMatch[];
  unmatchedMaterials: string[];
  totalGWP: number;
  warnings: string[];
}
