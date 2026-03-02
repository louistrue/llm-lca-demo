/**
 * Chat panel UI component.
 * Renders a side panel with chat interface for LCA analysis.
 */
import type { MaterialGroup } from '../material-panel.js';
import type { EPDMatch } from '../lca/types.js';
import {
  sendChatMessage,
  hasApiKey,
  getStoredApiKey,
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

  // Enable chat if we have materials
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

  // Show suggested prompts if no messages yet
  if (chatHistory.length === 0 && groups.length > 0) {
    showSuggestedPrompts();
  }
}

function buildChatHTML(): string {
  return `
    <div class="chat-header">
      <div class="chat-header-row">
        <h2>LCA Chat</h2>
        <button id="chat-settings-toggle" title="API Settings">⚙</button>
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
        <div class="chat-empty-icon">💬</div>
        <p>Load an IFC file and run LCA matching to start chatting</p>
      </div>
    </div>
    <div id="chat-suggested" class="chat-suggested hidden"></div>
    <form id="chat-form" class="chat-input-area">
      <textarea id="chat-input" placeholder="Load a model first..." disabled rows="1"></textarea>
      <button id="chat-send" type="submit" disabled>→</button>
    </form>
  `;
}

function attachEventListeners(): void {
  // Settings toggle
  document.getElementById('chat-settings-toggle')!.addEventListener('click', () => {
    document.getElementById('chat-settings')!.classList.toggle('hidden');
  });

  // Save API key
  document.getElementById('chat-save-key')!.addEventListener('click', () => {
    const keyInput = document.getElementById('chat-api-key') as HTMLInputElement;
    const providerSelect = document.getElementById('chat-provider') as HTMLSelectElement;
    storeApiKey(keyInput.value.trim());
    storeProvider(providerSelect.value as LLMProvider);
    keyInput.value = '';
    updateApiKeyUI();
  });

  // Form submit
  document.getElementById('chat-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    handleSend();
  });

  // Enter to send (shift+enter for newline)
  document.getElementById('chat-input')!.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // Auto-resize textarea
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
    statusEl.textContent = `✓ ${label} API key configured`;
    statusEl.className = 'key-status key-status-ok';
  } else {
    statusEl.textContent = 'No API key — using keyword matching';
    statusEl.className = 'key-status key-status-warn';
  }
}

function showSuggestedPrompts(): void {
  const container = document.getElementById('chat-suggested')!;
  const prompts = [
    { icon: '📊', text: 'Which material has the highest impact?' },
    { icon: '🌱', text: 'Suggest lower-carbon alternatives' },
    { icon: '🔄', text: 'What if we switch steel to timber?' },
    { icon: '⚖️', text: 'How confident are the matches?' },
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

async function handleSend(): Promise<void> {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text || isStreaming) return;

  // Hide suggested prompts
  document.getElementById('chat-suggested')!.classList.add('hidden');

  // Add user message
  chatHistory.push({ role: 'user', content: text });
  appendMessage('user', text);
  input.value = '';
  input.style.height = 'auto';

  if (!hasApiKey()) {
    chatHistory.push({ role: 'assistant', content: 'Please configure an API key in the settings (⚙) to use the chat. Keyword matching is available for auto-match, but chat requires an LLM.' });
    appendMessage('assistant', chatHistory[chatHistory.length - 1].content);
    return;
  }

  // Stream assistant response
  isStreaming = true;
  const msgEl = appendMessage('assistant', '');
  const contentEl = msgEl.querySelector('.msg-content')!;
  let fullResponse = '';

  try {
    fullResponse = await sendChatMessage(
      currentGroups,
      currentMatches,
      chatHistory.slice(0, -1), // exclude the user message we just added (it's passed separately)
      text,
      (chunk) => {
        fullResponse = fullResponse; // closure reference
        contentEl.textContent += chunk;
        scrollToBottom();
      },
    );
    chatHistory.push({ role: 'assistant', content: fullResponse });
  } catch (err: any) {
    const errMsg = `Error: ${err.message}`;
    contentEl.textContent = errMsg;
    chatHistory.push({ role: 'assistant', content: errMsg });
  }

  isStreaming = false;
}

function appendMessage(role: 'user' | 'assistant', content: string): HTMLElement {
  const messagesEl = document.getElementById('chat-messages')!;

  // Remove empty state if present
  const emptyState = messagesEl.querySelector('.chat-empty-state');
  if (emptyState) emptyState.remove();

  const msgEl = document.createElement('div');
  msgEl.className = `chat-msg chat-msg-${role}`;

  const icon = role === 'user' ? '👤' : '🤖';
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
