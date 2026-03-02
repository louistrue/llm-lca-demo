# LCA Chat Demo — Architecture Plan

## Analysis of Prior Repos

### ifc-ai-lca (TypeScript, React)
- **EPD data**: Static array of ~20 hardcoded EPDs in `database.ts` with GWP/ODP/AP/EP per declared unit
- **Matching**: Pure keyword scoring (category 25pts + name similarity 30pts + keyword matches 25pts + quality 10pts + subcategory 10pts). No LLM.
- **Chat**: Express server + Vercel AI SDK streaming to React. Sends full LCA context (all materials, GWP, confidence, alternatives, quantities) as system prompt context to GPT-4o-mini
- **Oekobaudat**: None. Fully static.
- **Density table**: Hardcoded per-category densities for unit conversion (concrete 2400, steel 7850, wood 500, etc.)

### llm-lca-material-match (Python, research-grade)
- **Oekobaudat**: Full ILCD/ServiceAPI client — `GET /datastocks/{uuid}/processes?search=true&name=...&format=json`
- **Matching**: 2-stage Retrieve & Rerank:
  - Stage 1: Embedding retrieval (BAAI/bge-m3, multilingual) with token-level cosine similarity
  - Stage 2: LLM reranker (GPT-4o or Claude) with tool-calling to search Oekobaudat for more candidates
- **Scoring**: 0.3 × embedding + 0.7 × rerank. True confidence scores.
- **No chat**, no quantities, no LCA calculation — pure material-to-EPD matching research.

---

## The Key Insight

Both repos solve **half the problem**:
- `ifc-ai-lca` has the chat UX + LCA calculation but dumb matching and no real EPD data
- `llm-lca-material-match` has smart matching but no chat, no quantities, no what-if

For the demo, we want the **LLM itself to BE the matching engine AND the chat interface**. One unified brain that holds the EPD catalog, the model's materials, and reasons about all of it.

---

## EPD Subset Strategy: ~40 Curated EPDs

200 is too many for a demo. 20 (as in ifc-ai-lca) is too few — you can't show meaningful alternatives. **~40 is the sweet spot**:

- Fits in ~4KB of structured JSON — trivially fits LLM context
- 3-5 per category covers standard + low-carbon + premium alternatives
- The LLM can reason about ALL of them simultaneously
- Users see real choices with real trade-offs

### Proposed Categories (with EPD count):

| Category | Count | Coverage |
|----------|-------|----------|
| Concrete | 5 | C25/C30 standard, low-carbon CEM III, precast, fiber-reinforced, UHPC |
| Steel | 4 | Hot-rolled structural, rebar (high recycled), cold-formed, stainless |
| Wood/Timber | 4 | CLT, glulam, softwood lumber, hardwood |
| Insulation | 5 | Stone wool, glass wool, EPS, XPS, cellulose/wood fiber |
| Glass | 3 | Double IGU, triple IGU low-E, single pane |
| Masonry | 3 | Clay brick, concrete block, limestone |
| Gypsum | 2 | Standard plasterboard, fire-rated board |
| Aluminum | 3 | Primary extrusion, recycled extrusion, sheet |
| Waterproofing | 2 | Bituminous membrane, PVC membrane |
| Plaster/Render | 2 | Cement render, lime render |
| Flooring | 3 | Ceramic tile, natural stone, vinyl |
| Roofing | 2 | Concrete roof tile, clay roof tile |
| Coatings | 2 | Interior paint, exterior coating |
| **Total** | **~40** | |

### EPD Data Structure:

```typescript
interface EPD {
  id: string;
  name: string;                    // Display name
  nameDE: string;                  // German name (for Oekobaudat matching)
  category: string;                // CONCRETE, STEEL, WOOD, etc.
  gwp: number;                     // kg CO₂e per declared unit (A1-A3)
  declaredUnit: 'm3' | 'm2' | 'kg';
  density: number;                 // kg/m³ (for unit conversions)
  source: string;                  // "Oekobaudat 2023" or manufacturer
  keywords: string[];              // For matching
}
```

We **don't need full ILCD data** for the demo. GWP (A1-A3) is the star metric. Store source Oekobaudat UUIDs for traceability but don't need the full API at runtime.

### How to Build the Subset:

Pre-fetch from Oekobaudat API (offline script or manual) → curate → embed as static JSON. The values should be real Oekobaudat values so the demo is credible.

---

## Architecture: LLM-as-Matching-Engine + Chat

### Why Not a Separate Matching Algorithm?

The keyword matcher in ifc-ai-lca gives mediocre results. The hybrid embedding+reranker in llm-lca-material-match is excellent but requires Python + a large embedding model + multiple API calls per material. For a browser demo:

**Just give the LLM the full EPD catalog in the system prompt.** At ~40 EPDs × ~100 tokens each = ~4K tokens. Trivial.

The LLM then:
1. Matches materials to EPDs with confidence reasoning
2. Explains WHY it matched (not just a score)
3. Knows alternatives immediately (they're all in context)
4. Can do what-if analysis on the spot

### System Prompt Structure:

```
You are an LCA expert for buildings. You help users understand
embodied carbon by matching building materials to EPDs.

## EPD Catalog
[Full 40-entry catalog as structured data]

## Density & Structural Equivalency Rules
- When switching concrete → timber: volume factor ~1.0 (CLT walls similar thickness)
- When switching steel beams → glulam: volume factor ~3-5× (timber needs larger cross-sections)
- When switching steel columns → timber: volume factor ~4-6×
- Insulation: switching types changes density but similar thickness

## Material Data from Current Model
[Injected per-session: material groups with quantities, volumes, areas]

## Your Capabilities
1. AUTO-MATCH: Match each material to best EPD, provide confidence (high/medium/low) and reasoning
2. ALTERNATIVES: For each match, identify 2-3 alternatives with GWP comparison
3. WHAT-IF: When user asks about switching materials, recalculate with adjusted quantities
4. SENSITIVITY: Flag which materials contribute most to total GWP
```

### Chat Flow:

1. **User loads IFC** → geometry renders + materials extracted with volumes
2. **Auto-match request** → Send materials to LLM → LLM returns structured JSON with matches, confidence, GWP calculations
3. **Panel updates** → Show matched materials with GWP, confidence badges, alternatives
4. **User chats** → "What if we switch from steel to timber?"
   - LLM knows steel beam quantity is 12.5 m³ at 7850 kg/m³
   - Timber equivalent: ~50 m³ at 470 kg/m³ (larger cross-sections)
   - Steel GWP: 12.5 × 7850 × 1.85 = 181,406 kg CO₂e
   - CLT GWP: 50 × (-680) = -34,000 kg CO₂e
   - Delta: -215,406 kg CO₂e (massive reduction!)
   - But flags: "structural engineer review needed for timber sizing"

### LLM Response Format (for auto-matching):

```json
{
  "matches": [
    {
      "material": "Concrete C30/37",
      "epd": "epd-concrete-001",
      "confidence": "high",
      "reason": "Direct match - standard structural concrete",
      "gwp": 14400,
      "quantity": 60,
      "unit": "m³",
      "alternatives": ["epd-concrete-002", "epd-concrete-004"]
    }
  ],
  "totalGWP": 285000,
  "warnings": ["2 materials unmatched", "Steel quantity estimated from volume × density"]
}
```

---

## Implementation Plan

### Phase 1: EPD Catalog + Enhanced Material Panel
- Create `src/data/epd-catalog.ts` with ~40 curated EPDs (real Oekobaudat values)
- Add density lookup table
- Enhance material-panel.ts to show: material → matched EPD → GWP → confidence → alternatives

### Phase 2: LLM Chat Integration
- Add chat panel UI (right side or bottom tab)
- LLM integration via Anthropic API (Claude) — can switch to any provider
- System prompt with full EPD catalog + model materials
- Structured output for auto-matching (first message)
- Free-form chat for follow-up questions

### Phase 3: What-If Engine
- Structural equivalency rules embedded in system prompt
- LLM computes adjusted quantities when switching materials
- Show before/after comparison in the UI
- Sensitivity analysis: "which material swap gives biggest reduction?"

### File Structure:
```
src/
  data/
    epd-catalog.ts          # ~40 curated EPDs with GWP values
    densities.ts            # Material density lookup
    structural-rules.ts     # Equivalency factors for material switching
  lca/
    matcher.ts              # Simple keyword pre-filter (optional, LLM does the real work)
    calculator.ts           # GWP calculation helpers
    types.ts                # EPD, Match, LCAResult types
  chat/
    chat-panel.ts           # Chat UI component
    llm-client.ts           # Anthropic/OpenAI API client
    system-prompt.ts        # Build system prompt with EPD catalog + model data
    response-parser.ts      # Parse structured LLM responses
  main.ts                   # Existing Three.js viewer
  material-panel.ts         # Enhanced with EPD matches + GWP
  ifc-to-threejs.ts         # Existing
```

### API Key Strategy for Demo:
- User provides their own API key via UI input (stored in localStorage)
- Or: thin proxy server that adds the key (for live demos)
- Support both Anthropic Claude and OpenAI GPT-4o

---

## Why This Design Works for a Demo

1. **No heavy dependencies** — no Python, no embedding models, no vector DB
2. **Everything in the browser** — just API calls to Claude/GPT
3. **Real EPD values** — credible numbers from Oekobaudat
4. **Interactive** — user literally talks to the model about LCA
5. **Smart** — LLM reasons about material equivalencies, not just keyword matching
6. **40 EPDs is perfect** — small enough to fit in context, large enough to show alternatives
7. **What-if is the killer feature** — "switch steel to timber" with automatic quantity adjustment is something no static tool can do
