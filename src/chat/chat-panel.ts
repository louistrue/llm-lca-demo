/**
 * Chat panel UI component.
 * Renders a side panel with chat interface for LCA analysis.
 * Parses MATERIAL_SWITCH blocks from LLM responses to apply overrides.
 */
import type { MaterialGroup } from '../material-panel.js';
import type { EPDMatch } from '../lca/types.js';
import type { MaterialOverride } from '../lca/overrides.js';
import { applyOverrides } from '../lca/overrides.js';
import {
  sendChatMessage,
  hasApiKey,
  storeApiKey,
  getStoredProvider,
  storeProvider,
  type LLMProvider,
} from './llm-client.js';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

let chatHistory: ChatMessage[] = [];
let currentGroups: MaterialGroup[] = [];
let currentMatches: EPDMatch[] = [];
let isStreaming = false;

/**
 * Initialize the chat panel. Called once on app start.
 */
export function initChatPanel(): void {
  const panel = document.getElementById('chat-panel')!;
  panel.innerHTML = buildChatHTML();
  attachEventListeners();
  updateApiKeyUI();
}

/**
 * Update the chat context when materials/matches change.
 */
export function updateChatContext(groups: MaterialGroup[], matches: EPDMatch[]): void {
  currentGroups = groups;
  currentMatches = matches;

  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const sendBtn = document.getElementById('chat-send') as HTMLButtonElement;
  if (input && sendBtn) {
    const enabled = groups.length > 0;
    input.disabled = !enabled;
    sendBtn.disabled = !enabled;
    if (enabled) {
      input.placeholder = 'Ask about environmental impact...';
    }
  }

  if (chatHistory.length === 0 && groups.length > 0) {
    showSuggestedPrompts();
  }
}

function buildChatHTML(): string {
  return `
    <div class="chat-header">
      <div class="chat-header-row">
        <h2>LCA Chat</h2>
        <button id="chat-settings-toggle" title="API Settings">&#9881;</button>
      </div>
      <div id="chat-settings" class="chat-settings hidden">
        <div class="settings-row">
          <select id="chat-provider">
            <option value="anthropic">Anthropic Claude</option>
            <option value="openai">OpenAI GPT-4o</option>
          </select>
        </div>
        <div class="settings-row">
          <input type="password" id="chat-api-key" placeholder="API key..." />
          <button id="chat-save-key">Save</button>
        </div>
        <div id="chat-key-status" class="key-status"></div>
      </div>
    </div>
    <div id="chat-messages" class="chat-messages">
      <div class="chat-empty-state">
        <div class="chat-empty-icon">&#128172;</div>
        <p>Load an IFC file and run LCA matching to start chatting</p>
      </div>
    </div>
    <div id="chat-suggested" class="chat-suggested hidden"></div>
    <form id="chat-form" class="chat-input-area">
      <textarea id="chat-input" placeholder="Load a model first..." disabled rows="1"></textarea>
      <button id="chat-send" type="submit" disabled>&#8594;</button>
    </form>
  `;
}

function attachEventListeners(): void {
  document.getElementById('chat-settings-toggle')!.addEventListener('click', () => {
    document.getElementById('chat-settings')!.classList.toggle('hidden');
  });

  document.getElementById('chat-save-key')!.addEventListener('click', () => {
    const keyInput = document.getElementById('chat-api-key') as HTMLInputElement;
    const providerSelect = document.getElementById('chat-provider') as HTMLSelectElement;
    storeApiKey(keyInput.value.trim());
    storeProvider(providerSelect.value as LLMProvider);
    keyInput.value = '';
    updateApiKeyUI();
  });

  document.getElementById('chat-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSend();
  });

  document.getElementById('chat-input')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  document.getElementById('chat-input')!.addEventListener('input', () => {
    const textarea = document.getElementById('chat-input') as HTMLTextAreaElement;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';
  });
}

function updateApiKeyUI(): void {
  const statusEl = document.getElementById('chat-key-status')!;
  const providerSelect = document.getElementById('chat-provider') as HTMLSelectElement;
  providerSelect.value = getStoredProvider();

  if (hasApiKey()) {
    const provider = getStoredProvider();
    const label = provider === 'anthropic' ? 'Claude' : 'GPT-4o';
    statusEl.textContent = `\u2713 ${label} API key configured`;
    statusEl.className = 'key-status key-status-ok';
  } else {
    statusEl.textContent = 'No API key \u2014 using keyword matching';
    statusEl.className = 'key-status key-status-warn';
  }
}

function showSuggestedPrompts(): void {
  const container = document.getElementById('chat-suggested')!;
  const prompts = [
    { icon: '\u{1F4CA}', text: 'Which material has the highest impact?' },
    { icon: '\u{1F331}', text: 'Suggest lower-carbon alternatives' },
    { icon: '\u{1F504}', text: 'What if we switch steel to timber?' },
    { icon: '\u2696\uFE0F', text: 'How confident are the matches?' },
  ];

  container.innerHTML = prompts.map(p =>
    `<button class="suggested-prompt" data-prompt="${escapeAttr(p.text)}">${p.icon} ${escapeHtml(p.text)}</button>`
  ).join('');
  container.classList.remove('hidden');

  container.querySelectorAll('.suggested-prompt').forEach(btn => {
    btn.addEventListener('click', () => {
      const prompt = (btn as HTMLElement).dataset.prompt!;
      (document.getElementById('chat-input') as HTMLTextAreaElement).value = prompt;
      handleSend();
    });
  });
}

// ─── MATERIAL_SWITCH parsing ─────────────────────────────────────────

const SWITCH_REGEX = /```MATERIAL_SWITCH\s*\n([\s\S]*?)\n```/g;

/**
 * Extract MATERIAL_SWITCH blocks from the LLM response,
 * apply them as overrides, and return the display text (blocks stripped).
 */
function processResponse(fullText: string): { displayText: string; switchCount: number } {
  let switchCount = 0;
  const allOverrides: MaterialOverride[] = [];

  const displayText = fullText.replace(SWITCH_REGEX, (_match, jsonStr: string) => {
    try {
      const switches = JSON.parse(jsonStr.trim());
      if (Array.isArray(switches)) {
        for (const s of switches) {
          if (s.materialName && s.newEpdId) {
            allOverrides.push({
              materialName: s.materialName,
              originalEpdId: '', // filled by override system from current match
              newEpdId: s.newEpdId,
              volumeFactor: s.volumeFactor ?? 1.0,
              reason: s.reason ?? 'LLM suggestion',
            });
            switchCount++;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to parse MATERIAL_SWITCH block:', e);
    }
    return ''; // strip the block from display
  }).trim();

  // Fill in originalEpdId from current matches
  const matchMap = new Map(currentMatches.map(m => [m.materialName, m]));
  for (const o of allOverrides) {
    const match = matchMap.get(o.materialName);
    if (match) o.originalEpdId = match.epd.id;
  }

  if (allOverrides.length > 0) {
    applyOverrides(allOverrides);
  }

  return { displayText, switchCount };
}

// ─── Send / display ──────────────────────────────────────────────────

async function handleSend(): Promise<void> {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text || isStreaming) return;

  document.getElementById('chat-suggested')!.classList.add('hidden');

  chatHistory.push({ role: 'user', content: text });
  appendMessage('user', text);
  input.value = '';
  input.style.height = 'auto';

  if (!hasApiKey()) {
    const msg = 'Configure an API key in settings (\u2699) to use chat.';
    chatHistory.push({ role: 'assistant', content: msg });
    appendMessage('assistant', msg);
    return;
  }

  isStreaming = true;
  const msgEl = appendMessage('assistant', '');
  const contentEl = msgEl.querySelector('.msg-content')!;
  let fullResponse = '';

  try {
    fullResponse = await sendChatMessage(
      currentGroups,
      currentMatches,
      chatHistory.slice(0, -1),
      text,
      (chunk) => {
        contentEl.textContent += chunk;
        scrollToBottom();
      },
    );

    // Process response: extract MATERIAL_SWITCH blocks, apply overrides
    const { displayText, switchCount } = processResponse(fullResponse);

    // Update displayed message (strip MATERIAL_SWITCH blocks)
    contentEl.textContent = displayText;

    // Show a small badge if switches were applied
    if (switchCount > 0) {
      const badge = document.createElement('div');
      badge.className = 'switch-applied-badge';
      badge.textContent = `\u2713 ${switchCount} material${switchCount > 1 ? 's' : ''} updated in table`;
      contentEl.parentElement!.appendChild(badge);
    }

    chatHistory.push({ role: 'assistant', content: fullResponse });
  } catch (err: any) {
    const errMsg = `Error: ${err.message}`;
    contentEl.textContent = errMsg;
    chatHistory.push({ role: 'assistant', content: errMsg });
  }

  isStreaming = false;
  scrollToBottom();
}

function appendMessage(role: 'user' | 'assistant', content: string): HTMLElement {
  const messagesEl = document.getElementById('chat-messages')!;

  const emptyState = messagesEl.querySelector('.chat-empty-state');
  if (emptyState) emptyState.remove();

  const msgEl = document.createElement('div');
  msgEl.className = `chat-msg chat-msg-${role}`;

  const icon = role === 'user' ? '\u{1F464}' : '\u{1F916}';
  msgEl.innerHTML = `
    <div class="msg-icon">${icon}</div>
    <div class="msg-content">${escapeHtml(content)}</div>
  `;

  messagesEl.appendChild(msgEl);
  scrollToBottom();
  return msgEl;
}

function scrollToBottom(): void {
  const messagesEl = document.getElementById('chat-messages')!;
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
