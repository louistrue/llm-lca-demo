/**
 * Build the LLM system prompt with full EPD catalog + model material context.
 */
import { epdCatalog } from '../data/epd-catalog.js';
import type { MaterialGroup } from '../material-panel.js';
import type { EPDMatch } from '../lca/types.js';
import { computeQuantity, computeGWP } from '../lca/calculator.js';

/**
 * Compact EPD catalog representation for the system prompt.
 */
function catalogToText(): string {
  const lines = epdCatalog.map(e => {
    const unit = e.declaredUnit;
    const gwpStr = e.gwp < 0 ? `${e.gwp} (carbon-storing)` : `${e.gwp}`;
    return `  - [${e.id}] ${e.name} | GWP: ${gwpStr} kg CO₂e/${unit} | density: ${e.density} kg/m³ | cat: ${e.category}`;
  });
  return lines.join('\n');
}

/**
 * Build the material context section from the model's material groups
 * and any existing matches.
 */
function materialContextToText(
  groups: MaterialGroup[],
  matches: EPDMatch[],
): string {
  if (groups.length === 0) return 'No materials loaded yet.';

  const matchMap = new Map(matches.map(m => [m.materialName, m]));

  const lines = groups.map(g => {
    const match = matchMap.get(g.name);
    const vol = g.totalVolume > 0 ? `vol: ${g.totalVolume.toFixed(3)} m³` : '';
    const area = g.totalArea > 0 ? `area: ${g.totalArea.toFixed(2)} m²` : '';
    const dims = [vol, area].filter(Boolean).join(', ');
    const elems = `${g.elementCount} elements`;

    if (match) {
      return `  - "${g.name}" (${elems}, ${dims}) → matched to [${match.epd.id}] ${match.epd.name} (${match.confidence} confidence, ${match.reason}) → GWP: ${match.gwpTotal.toFixed(0)} kg CO₂e (${match.quantity.toFixed(2)} ${match.epd.declaredUnit})`;
    }
    return `  - "${g.name}" (${elems}, ${dims}) → NOT MATCHED`;
  });

  const totalGWP = matches.reduce((sum, m) => sum + m.gwpTotal, 0);
  return [
    `Total GWP: ${totalGWP.toFixed(0)} kg CO₂e`,
    `Matched: ${matches.length}/${groups.length} materials`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * Build the full system prompt.
 */
export function buildSystemPrompt(
  groups: MaterialGroup[],
  matches: EPDMatch[],
): string {
  return `You are an expert Life Cycle Assessment (LCA) assistant for buildings. You help users understand embodied carbon by analyzing their IFC building model's materials matched against Environmental Product Declarations (EPDs) from the Oekobaudat database.

## Your EPD Catalog (${epdCatalog.length} entries from Oekobaudat)
${catalogToText()}

## Current Building Model Materials
${materialContextToText(groups, matches)}

## Key Rules
- GWP = Global Warming Potential in kg CO₂-equivalent, production stage A1-A3
- Negative GWP means the material stores carbon (wood products)
- When quantities are in m³ and EPD unit is kg, convert via density: mass = volume × density
- When quantities are in m³ and EPD unit is m², estimate area = volume / typical thickness
- Always cite specific EPD IDs when recommending matches or alternatives

## Structural Equivalency Rules (for what-if material switching)
When a user asks "what if we switch material X to Y", adjust quantities:
- Steel beam → Timber (glulam) beam: multiply volume by ~4× (timber needs larger cross-sections for same structural capacity)
- Steel column → Timber column: multiply volume by ~5×
- Concrete wall → CLT wall: volume factor ~0.8× (CLT walls typically thinner)
- Concrete slab → CLT slab: volume factor ~0.6× (CLT lighter, needs less depth but wider)
- Concrete column → Steel column: volume factor ~0.15× (steel is much stronger per unit)
- EPS insulation → Stone wool: similar volume (same thermal target, adjust for different lambda)
- Primary aluminum → Recycled aluminum: same volume (drop-in replacement)
- Standard concrete → Low-carbon concrete: same volume (drop-in replacement)
ALWAYS mention these adjustments and that a structural engineer should verify actual sizing.

## Response Style
- Be concise but precise. Use numbers.
- Format GWP values with units (kg CO₂e or t CO₂e for large values)
- When showing comparisons, use a clear before/after format
- If the user asks about a material switch, show: current GWP → new GWP → delta (savings or increase)
- Proactively flag the biggest impact contributors
- When confidence is low, suggest what additional info would help`;
}

/**
 * Build the initial auto-match prompt to get structured matches.
 */
export function buildAutoMatchPrompt(groups: MaterialGroup[]): string {
  const materialList = groups.map(g => {
    const vol = g.totalVolume > 0 ? `vol: ${g.totalVolume.toFixed(3)} m³` : '';
    const area = g.totalArea > 0 ? `area: ${g.totalArea.toFixed(2)} m²` : '';
    const dims = [vol, area].filter(Boolean).join(', ');
    return `  - "${g.name}" (${g.elementCount} elements, ${dims})`;
  }).join('\n');

  return `Please match each of these building materials from the IFC model to the best EPD from the catalog. For each material, return:
- The best matching EPD ID
- Confidence level (high/medium/low)
- A brief reason for the match
- Up to 2 alternative EPD IDs that could also work

Materials to match:
${materialList}

Respond ONLY with valid JSON in this exact format (no markdown, no explanation outside the JSON):
{
  "matches": [
    {
      "materialName": "exact material name from above",
      "epdId": "epd-id from catalog",
      "confidence": "high|medium|low",
      "reason": "brief reason",
      "alternativeIds": ["alt-id-1", "alt-id-2"]
    }
  ],
  "unmatchedMaterials": ["names of materials you cannot confidently match"],
  "warnings": ["any notes about quantity issues or assumptions"]
}`;
}
