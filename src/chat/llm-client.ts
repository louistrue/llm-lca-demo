/**
 * LLM client for Anthropic Claude API.
 * Handles both auto-matching (structured JSON) and chat (streaming text).
 * Falls back to a simple keyword matcher when no API key is available.
 */
import type { MaterialGroup } from '../material-panel.js';
import type { EPDMatch, LCAResult } from '../lca/types.js';
import { epdCatalog, getEPDById } from '../data/epd-catalog.js';
import { computeQuantity, computeGWP } from '../lca/calculator.js';
import { buildSystemPrompt, buildAutoMatchPrompt } from './system-prompt.js';

const STORAGE_KEY = 'llm-lca-api-key';
const STORAGE_PROVIDER = 'llm-lca-provider';

export type LLMProvider = 'anthropic' | 'openai';

export function getStoredApiKey(): string {
  return localStorage.getItem(STORAGE_KEY) ?? '';
}

export function storeApiKey(key: string): void {
  localStorage.setItem(STORAGE_KEY, key);
}

export function getStoredProvider(): LLMProvider {
  return (localStorage.getItem(STORAGE_PROVIDER) as LLMProvider) || 'anthropic';
}

export function storeProvider(provider: LLMProvider): void {
  localStorage.setItem(STORAGE_PROVIDER, provider);
}

export function hasApiKey(): boolean {
  return getStoredApiKey().length > 0;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Call Anthropic Claude API directly from browser.
 * Uses the Messages API with streaming.
 */
async function callAnthropic(
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const apiKey = getStoredApiKey();
  if (!apiKey) throw new Error('No API key configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          if (event.type === 'content_block_delta' && event.delta?.text) {
            fullText += event.delta.text;
            onChunk(event.delta.text);
          }
        } catch { /* skip non-JSON lines */ }
      }
    }
  }

  return fullText;
}

/**
 * Call OpenAI API directly from browser.
 */
async function callOpenAI(
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const apiKey = getStoredApiKey();
  if (!apiKey) throw new Error('No API key configured');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
      ],
      stream: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const event = JSON.parse(data);
          const delta = event.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onChunk(delta);
          }
        } catch { /* skip */ }
      }
    }
  }

  return fullText;
}

/**
 * Unified LLM call that routes to the selected provider.
 */
async function callLLM(
  systemPrompt: string,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<string> {
  const provider = getStoredProvider();
  if (provider === 'openai') {
    return callOpenAI(systemPrompt, messages, onChunk);
  }
  return callAnthropic(systemPrompt, messages, onChunk);
}

/**
 * Run auto-matching: send material list to LLM, get structured matches back.
 * Non-streaming (we need the full JSON).
 */
export async function autoMatch(groups: MaterialGroup[]): Promise<LCAResult> {
  if (!hasApiKey()) {
    // Fall back to keyword matching
    return keywordMatch(groups);
  }

  const systemPrompt = buildSystemPrompt(groups, []);
  const userMessage = buildAutoMatchPrompt(groups);

  let fullText = '';
  try {
    fullText = await callLLM(systemPrompt, [{ role: 'user', content: userMessage }], () => {});
  } catch (err) {
    console.warn('LLM auto-match failed, falling back to keyword matching:', err);
    return keywordMatch(groups);
  }

  // Parse the JSON response
  try {
    // Strip markdown code fences if present
    let json = fullText.trim();
    if (json.startsWith('```')) {
      json = json.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(json);
    return buildLCAResult(groups, parsed);
  } catch (err) {
    console.warn('Failed to parse LLM response, falling back to keyword match:', err);
    return keywordMatch(groups);
  }
}

/**
 * Send a chat message with full LCA context.
 * Streams the response via onChunk callback.
 */
export async function sendChatMessage(
  groups: MaterialGroup[],
  matches: EPDMatch[],
  history: ChatMessage[],
  userMessage: string,
  onChunk: (text: string) => void,
): Promise<string> {
  const systemPrompt = buildSystemPrompt(groups, matches);
  const messages: ChatMessage[] = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  return callLLM(systemPrompt, messages, onChunk);
}

// ─── Fallback keyword matcher ────────────────────────────────────────────

/**
 * Simple keyword-based matching when no API key is available.
 * Matches material names against EPD keywords.
 */
function keywordMatch(groups: MaterialGroup[]): LCAResult {
  const matches: EPDMatch[] = [];
  const unmatchedMaterials: string[] = [];

  for (const group of groups) {
    const nameLower = group.name.toLowerCase();
    let bestEpd = epdCatalog[0];
    let bestScore = 0;

    for (const epd of epdCatalog) {
      let score = 0;
      for (const keyword of epd.keywords) {
        if (nameLower.includes(keyword)) {
          score += keyword.length; // longer keyword matches are better
        }
      }
      // Also check if EPD name words appear in material name
      for (const word of epd.name.toLowerCase().split(/\s+/)) {
        if (word.length > 2 && nameLower.includes(word)) {
          score += word.length;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestEpd = epd;
      }
    }

    if (bestScore > 3) {
      const qty = computeQuantity(group, bestEpd);
      const gwp = computeGWP(group, bestEpd);

      // Find alternatives in the same category
      const alternatives = epdCatalog
        .filter(e => e.category === bestEpd.category && e.id !== bestEpd.id)
        .slice(0, 2);

      let confidence: 'high' | 'medium' | 'low' = 'low';
      if (bestScore > 15) confidence = 'high';
      else if (bestScore > 8) confidence = 'medium';

      matches.push({
        materialName: group.name,
        epd: bestEpd,
        confidence,
        reason: 'Keyword match',
        gwpTotal: gwp,
        quantity: qty,
        alternatives,
      });
    } else {
      unmatchedMaterials.push(group.name);
    }
  }

  const totalGWP = matches.reduce((sum, m) => sum + m.gwpTotal, 0);
  return { matches, unmatchedMaterials, totalGWP, warnings: hasApiKey() ? [] : ['Using keyword matching (no API key). Add an API key for LLM-powered matching.'] };
}

/**
 * Convert LLM JSON response into a proper LCAResult with computed GWP.
 */
function buildLCAResult(
  groups: MaterialGroup[],
  parsed: { matches: Array<{ materialName: string; epdId: string; confidence: string; reason: string; alternativeIds?: string[] }>; unmatchedMaterials?: string[]; warnings?: string[] },
): LCAResult {
  const matches: EPDMatch[] = [];
  const unmatchedMaterials: string[] = parsed.unmatchedMaterials ?? [];
  const groupMap = new Map(groups.map(g => [g.name, g]));

  for (const m of parsed.matches) {
    const epd = getEPDById(m.epdId);
    const group = groupMap.get(m.materialName);
    if (!epd || !group) {
      unmatchedMaterials.push(m.materialName);
      continue;
    }

    const qty = computeQuantity(group, epd);
    const gwp = computeGWP(group, epd);
    const alternatives = (m.alternativeIds ?? [])
      .map(id => getEPDById(id))
      .filter((e): e is NonNullable<typeof e> => e != null);

    matches.push({
      materialName: m.materialName,
      epd,
      confidence: m.confidence as 'high' | 'medium' | 'low',
      reason: m.reason,
      gwpTotal: gwp,
      quantity: qty,
      alternatives,
    });
  }

  const totalGWP = matches.reduce((sum, m) => sum + m.gwpTotal, 0);
  return {
    matches,
    unmatchedMaterials,
    totalGWP,
    warnings: parsed.warnings ?? [],
  };
}
