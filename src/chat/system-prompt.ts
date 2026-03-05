/**
 * Build the LLM system prompt with full EPD catalog + model material context.
 */
import { epdCatalog } from '../data/epd-catalog.js';
import type { MaterialGroup } from '../material-panel.js';
import type { EPDMatch } from '../lca/types.js';

/**
 * Compact EPD catalog representation for the system prompt.
 */
function catalogToText(): string {
  const lines = epdCatalog.map(e => {
    const unit = e.declaredUnit;
    const gwpStr = e.gwp < 0 ? `${e.gwp} (carbon-storing)` : `${e.gwp}`;
    return `  [${e.id}] ${e.name} | ${gwpStr} kg CO₂e/${unit} | ${e.density} kg/m³ | ${e.category}`;
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
    const elems = `${g.elementCount} el`;

    if (match) {
      return `  "${g.name}" (${elems}, ${dims}) → [${match.epd.id}] ${match.epd.name} | GWP: ${match.gwpTotal.toFixed(0)} kg CO₂e (${match.quantity.toFixed(2)} ${match.epd.declaredUnit}) | conf: ${match.confidence}`;
    }
    return `  "${g.name}" (${elems}, ${dims}) → UNMATCHED`;
  });

  const totalGWP = matches.reduce((sum, m) => sum + m.gwpTotal, 0);
  return [
    `Total GWP: ${totalGWP.toFixed(0)} kg CO₂e | Matched: ${matches.length}/${groups.length}`,
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
  return `You are a concise LCA (Life Cycle Assessment) assistant for buildings. You analyze IFC building models matched against EPDs from Oekobaudat.

## EPD Catalog (${epdCatalog.length} entries)
${catalogToText()}

## Current Model
${materialContextToText(groups, matches)}

## Volume Factors for Material Switching
Steel beam → Glulam: 4×  |  Steel column → Timber: 5×
Concrete wall → CLT: 0.8×  |  Concrete slab → CLT: 0.6×
Concrete column → Steel: 0.15×  |  Same-category swap: 1× (drop-in)

## MATERIAL_SWITCH Action Format
When a user asks to switch a material, you MUST include a MATERIAL_SWITCH block in your response.
This block will be parsed by the app to update the table automatically. Format:

\`\`\`MATERIAL_SWITCH
[{"materialName":"exact name","newEpdId":"epd-id","volumeFactor":1.0,"reason":"brief reason"}]
\`\`\`

Include one entry per material being switched. Use exact materialName from the model.
The volumeFactor adjusts the original volume (1.0 = same size, 4.0 = 4× bigger, etc.).

## Response Rules
- Be SHORT. 2-4 sentences max for simple questions.
- Use plain numbers, no LaTeX or formulas.
- For material switches: state the switch, show before→after GWP, note the delta, add structural caveat in one line. The MATERIAL_SWITCH block handles the actual table update.
- Format large values: use "t CO₂e" for values ≥ 1000 kg.
- Never repeat the full material table — the user can see it.
- When multiple switches are requested, include all in one MATERIAL_SWITCH block.`;
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

  return `Match each material to the best EPD. Respond ONLY with JSON (no markdown fences, no text):
{"matches":[{"materialName":"exact name","epdId":"id","confidence":"high|medium|low","reason":"brief","alternativeIds":["id1","id2"]}],"unmatchedMaterials":["names"],"warnings":["notes"]}

Materials:
${materialList}`;
}
