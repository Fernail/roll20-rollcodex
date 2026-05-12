(() => {
  const MESSAGE_SEND_CHAT_COMMAND = 'ROLLCODEX_ROLL20_SEND_CHAT_COMMAND';
  const MESSAGE_SEND_SNAPSHOT = 'ROLLCODEX_ROLL20_SEND_SNAPSHOT';
  const MESSAGE_EXTENSION_CONNECTED = 'ROLLCODEX_ROLL20_EXTENSION_CONNECTED';
  const CONFIRM_PREFIX = '!rollcodex confirm ';
  const BRIDGE_COMMAND_PREFIX = '!rollcodex bridge ';
  const BRIDGE_SNAPSHOT_MARKER = 'ROLLCODEX_BRIDGE_SNAPSHOT:';
  const BRIDGE_SNAPSHOT_TYPE = 'rollcodex:roll20-bridge-snapshot';
  const BRIDGE_VERSION = '0.3.1';
  const ROLLCODEX_APP_BASE_URL = 'http://localhost:5173';
  const ROLLCODEX_CONNECT_PATH = '/vtt/connect/roll20';
  const PENDING_PAIRING_KEY = 'rollcodexExtensionPendingPairing';
  const CONNECTION_KEY = 'rollcodexExtensionConnection';
  const LAST_SENT_KEY = 'rollcodexExtensionLastSentKey';
  const AUTO_SETTINGS_KEY = 'rollcodexExtensionAutoSettings';
  const PANEL_SETTINGS_KEY = 'rollcodexExtensionPanelSettings';
  const PANEL_ID = 'rollcodex-extension-panel';
  const PANEL_POSITIONS = ['bottom-left', 'top-left', 'bottom-right'];
  const MAX_EXTENSION_MESSAGES = 120;
  const LIVE_RECENT_EVENTS_LIMIT = 6;
  const DEFAULT_AUTO_IDLE_MS = 120000;
  const DEFAULT_AUTO_MIN_INTERVAL_MS = 120000;
  const processedBridgeSnapshots = new Set();
  let autoCaptureTimer = null;
  let autoCaptureObserver = null;
  let autoCaptureInFlight = false;

  const liveMetricsState = {
    messageKeys: new Set(),
    participants: new Map(),
    recentEvents: [],
    totals: createEmptyLiveMetricTotals(),
  };

  const INPUT_SELECTORS = [
    '#textchat-input textarea',
    '#textchat-input input[type="text"]',
    'textarea[aria-label*="chat" i]',
    'textarea[placeholder*="chat" i]',
    'textarea',
    'input[type="text"]',
  ];

  const SEND_BUTTON_SELECTORS = [
    '#textchat-input button[type="submit"]',
    '#textchat-input button',
    'button[aria-label*="send" i]',
    'button[aria-label*="envoyer" i]',
    'button[type="submit"]',
    'input[type="submit"]',
    'button',
  ];

  function isVisible(element) {
    return Boolean(element)
      && !element.disabled
      && !element.readOnly
      && element.getClientRects().length > 0;
  }

  function findVisible(selectors, predicate = () => true) {
    for (const selector of selectors) {
      const elements = Array.from(document.querySelectorAll(selector));
      const match = elements.find((element) => isVisible(element) && predicate(element));
      if (match) return match;
    }
    return null;
  }

  function normalizeCommand(command) {
    return String(command || '').trim();
  }

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function createEmptyLiveMetricTotals() {
    return {
      messages: 0,
      rolls: 0,
      criticals: 0,
      fumbles: 0,
      damage: 0,
      healing: 0,
    };
  }

  function toSafeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function inferAmountFromText(rawText, patterns) {
    const text = normalizeText(rawText);
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const amount = toSafeNumber(match?.[1]);
      if (amount != null) return amount;
    }
    return null;
  }

  function inferRollNatural(rawText) {
    const text = normalizeText(rawText).toLowerCase();
    const naturalMatch = text.match(/\b(?:nat|natural|naturel|critique|critical)\s*(20|1)\b/i);
    if (naturalMatch) return Number(naturalMatch[1]);
    const d20Match = text.match(/\bd20\D{0,24}(20|1)\b/i);
    return d20Match ? Number(d20Match[1]) : null;
  }

  function extractRollFigures(rawText) {
    const text = normalizeText(rawText);
    const lower = text.toLowerCase();
    const rollNatural = inferRollNatural(text);
    const totalMatch = text.match(/\b(?:total|result|resultat)\D{0,12}(\d{1,3})\b/i);
    const rollTotal = toSafeNumber(totalMatch?.[1]);
    const damageTotal = inferAmountFromText(text, [
      /\b(?:damage|dmg|degats)\D{0,16}(\d{1,4})\b/i,
      /\b(\d{1,4})\s*(?:damage|dmg|degats)\b/i,
    ]);
    const healTotal = inferAmountFromText(text, [
      /\b(?:heal|healing|soin|soins|soigne)\D{0,16}(\d{1,4})\b/i,
      /\b(\d{1,4})\s*(?:heal|healing|soin|soins)\b/i,
    ]);
    const hasRoll = /\b(?:d20|1d20|jet|roll|resultat|total)\b/i.test(text) || rollNatural != null || rollTotal != null;
    const actionType = damageTotal != null ? 'damage'
      : healTotal != null ? 'healing'
        : hasRoll ? 'roll'
          : lower.includes('spell') || lower.includes('sort') ? 'spell'
            : lower.includes('attack') || lower.includes('attaque') ? 'attack'
              : 'message';
    return {
      actionType,
      rollNatural,
      rollTotal,
      damageTotal,
      healTotal,
      isCritical: rollNatural === 20 || /\b(?:critical|critique)\b/i.test(text),
      isFumble: rollNatural === 1 || /\b(?:fumble|echec critique)\b/i.test(text),
      hasRoll,
    };
  }

  function getSpeakerFromText(rawText) {
    const text = normalizeText(rawText);
    const match = text.match(/^([^:]{2,48}):\s+(.+)$/);
    if (!match) return '';
    const speaker = normalizeText(match[1]);
    if (/^(rolling|roll|jet|result|total)$/i.test(speaker)) return '';
    return speaker;
  }

  function getChatSpeaker(node, rawText) {
    const selectors = [
      '[data-speaker]',
      '[data-sender]',
      '.speaker',
      '.by',
      '.avatarname',
      '[class*="speaker" i]',
      '[class*="sender" i]',
      '[class*="by" i]',
    ];
    for (const selector of selectors) {
      const match = node.querySelector?.(selector);
      const value = normalizeText(match?.getAttribute?.('data-speaker') || match?.getAttribute?.('data-sender') || match?.textContent);
      if (value && value.length <= 64) return value;
    }
    return getSpeakerFromText(rawText) || 'Roll20';
  }

  function getChatRowKey(node, index, rawText) {
    return node.getAttribute('data-messageid')
      || node.getAttribute('data-message-id')
      || node.id
      || `roll20-dom-${index}-${rawText.length}-${rawText.slice(0, 48)}`;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getStorageValue(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => resolve(result?.[key] || null));
    });
  }

  function setStorageValues(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function removeStorageValue(key) {
    return new Promise((resolve) => chrome.storage.local.remove(key, resolve));
  }

  async function getAutoSettings() {
    const stored = await getStorageValue(AUTO_SETTINGS_KEY);
    return {
      enabled: stored?.enabled !== false,
      idleMs: Number(stored?.idleMs) || DEFAULT_AUTO_IDLE_MS,
      minIntervalMs: Number(stored?.minIntervalMs) || DEFAULT_AUTO_MIN_INTERVAL_MS,
      lastAutoSentAt: Number(stored?.lastAutoSentAt) || 0,
    };
  }

  async function patchAutoSettings(patch) {
    const current = await getAutoSettings();
    const next = { ...current, ...(patch || {}) };
    await setStorageValues({ [AUTO_SETTINGS_KEY]: next });
    return next;
  }

  function normalizePanelPosition(position) {
    return PANEL_POSITIONS.includes(position) ? position : PANEL_POSITIONS[0];
  }

  async function getPanelSettings() {
    const stored = await getStorageValue(PANEL_SETTINGS_KEY);
    return {
      collapsed: stored?.collapsed === true,
      position: normalizePanelPosition(stored?.position),
    };
  }

  async function patchPanelSettings(patch) {
    const current = await getPanelSettings();
    const next = {
      ...current,
      ...(patch || {}),
      position: normalizePanelPosition(patch?.position || current.position),
    };
    await setStorageValues({ [PANEL_SETTINGS_KEY]: next });
    return next;
  }

  function getNextPanelPosition(position) {
    const currentIndex = PANEL_POSITIONS.indexOf(normalizePanelPosition(position));
    return PANEL_POSITIONS[(currentIndex + 1) % PANEL_POSITIONS.length];
  }

  function getPanelPositionStyles(position) {
    const normalized = normalizePanelPosition(position);
    if (normalized === 'top-left') return ['left:64px', 'top:76px'];
    if (normalized === 'bottom-right') return ['right:max(18px, min(340px, calc(100vw - 320px)))', 'bottom:18px'];
    return ['left:64px', 'bottom:18px'];
  }

  function getPanelCss(settings) {
    const collapsed = settings?.collapsed === true;
    return [
      'position:fixed',
      ...getPanelPositionStyles(settings?.position),
      'z-index:99999',
      `width:${collapsed ? '208px' : '292px'}`,
      'max-width:calc(100vw - 92px)',
      'max-height:min(58vh, 420px)',
      `padding:${collapsed ? '8px 10px' : '10px'}`,
      'box-sizing:border-box',
      'overflow:auto',
      'border:1px solid #a22d65',
      'border-radius:8px',
      'background:rgba(22,16,19,.96)',
      'color:#f7edf2',
      'font:12px/1.4 Arial,sans-serif',
      'box-shadow:0 12px 34px rgba(0,0,0,.38)',
    ].join(';');
  }

  function bytesToHex(bytes) {
    return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function randomHex(byteLength = 32) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
  }

  async function sha256Hex(value) {
    const encoded = new TextEncoder().encode(String(value || ''));
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return bytesToHex(new Uint8Array(digest));
  }

  function buildUuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytesToHex(bytes);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function buildPairingCode(state, secretHash) {
    return `${String(secretHash || '').slice(0, 4)}-${String(state || '').slice(-4)}`.toUpperCase();
  }

  function buildQueryString(params) {
    return Object.keys(params || {}).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] == null ? '' : String(params[key]))}`).join('&');
  }

  function getRoll20GameTitle() {
    const title = normalizeText(document.querySelector('.campaign-title, [class*="campaign"] h1, h1')?.textContent);
    return title || normalizeText(document.title).replace(/\s*\|\s*Roll20.*$/i, '') || 'Roll20';
  }

  function getRoll20GameId() {
    const match = String(window.location.href).match(/campaigns\/details\/(\d+)|\/editor\/(\d+)/i);
    return match?.[1] || match?.[2] || '';
  }

  function isAllowedRollCodexConfirmation(command) {
    const normalized = normalizeCommand(command);
    if (!normalized.startsWith(CONFIRM_PREFIX)) return false;
    try {
      const payload = JSON.parse(normalized.slice(CONFIRM_PREFIX.length));
      return payload?.type === 'rollcodex:vtt-connection-complete' && payload.provider === 'roll20';
    } catch (_error) {
      return false;
    }
  }

  function isAllowedBridgeCommand(command) {
    const normalized = normalizeCommand(command);
    if (!normalized.startsWith(BRIDGE_COMMAND_PREFIX)) return false;
    return /^!rollcodex bridge (ready|ack|fail)(\s|$)/i.test(normalized);
  }

  function isAllowedRollCodexChatCommand(command) {
    return isAllowedRollCodexConfirmation(command) || isAllowedBridgeCommand(command);
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findSendButton() {
    return findVisible(SEND_BUTTON_SELECTORS, (element) => {
      const text = String(element.textContent || element.value || element.getAttribute('aria-label') || '').trim().toLowerCase();
      if (!text) return element.matches('#textchat-input button, #textchat-input button[type="submit"]');
      return text.includes('send') || text.includes('envoyer');
    });
  }

  function pressEnter(element) {
    ['keydown', 'keypress', 'keyup'].forEach((type) => {
      element.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }));
    });
  }

  function sendChatCommand(command) {
    if (!isAllowedRollCodexChatCommand(command)) {
      return { ok: false, error: 'Commande refusee par le bridge Roll20.' };
    }

    const input = findVisible(INPUT_SELECTORS);
    if (!input) return { ok: false, error: 'Champ de chat Roll20 introuvable.' };

    input.focus();
    setNativeValue(input, command);

    const sendButton = findSendButton();
    if (sendButton) {
      sendButton.click();
      return { ok: true };
    }

    pressEnter(input);
    return { ok: true };
  }

  async function togglePanelCollapsed() {
    const settings = await getPanelSettings();
    await patchPanelSettings({ collapsed: !settings.collapsed });
    refreshPanel(settings.collapsed ? 'Panneau ouvert' : 'Panneau reduit');
  }

  async function cyclePanelPosition() {
    const settings = await getPanelSettings();
    await patchPanelSettings({ position: getNextPanelPosition(settings.position) });
    refreshPanel('Panneau deplace');
  }

  function renderPanel(state = {}) {
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }

    const connection = state.connection || null;
    const autoSettings = state.autoSettings || { enabled: true };
    const panelSettings = state.panelSettings || { collapsed: false, position: PANEL_POSITIONS[0] };
    const liveSummary = state.liveSummary || { totals: createEmptyLiveMetricTotals(), top_participants: [] };
    const liveTotals = liveSummary.totals || createEmptyLiveMetricTotals();
    const topSpeaker = liveSummary.top_participants?.[0]?.speaker || 'Table Roll20';
    const status = state.status || (connection ? 'Connecte' : 'Non connecte');
    const target = connection ? `${connection.campaign_label || 'Campagne'} / ${connection.table_label || 'Table'}` : 'Extension prete a connecter';
    panel.style.cssText = getPanelCss(panelSettings);

    if (panelSettings.collapsed) {
      panel.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          <span style="display:block;width:8px;height:8px;border-radius:999px;background:${connection ? '#71d493' : '#d9a72a'};box-shadow:0 0 0 3px rgba(255,255,255,.08)"></span>
          <div style="min-width:0;flex:1">
            <div style="font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">RollCodex</div>
            <div style="color:#b9a5ae;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(status)}</div>
          </div>
          <button type="button" data-rollcodex-toggle-panel title="Ouvrir" style="cursor:pointer;background:#d92a78;color:white;border:0;border-radius:4px;min-height:26px;padding:4px 7px">Ouvrir</button>
        </div>
      `;
      panel.querySelector('[data-rollcodex-toggle-panel]')?.addEventListener('click', togglePanelCollapsed);
      return;
    }

    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <div style="font-weight:700;min-width:0;flex:1">RollCodex</div>
        <button type="button" data-rollcodex-move-panel title="Deplacer" style="cursor:pointer;background:#2a2228;color:#f7edf2;border:1px solid rgba(255,255,255,.14);border-radius:4px;min-height:26px;padding:4px 7px">Placer</button>
        <button type="button" data-rollcodex-toggle-panel title="Reduire" style="cursor:pointer;background:#2a2228;color:#f7edf2;border:1px solid rgba(255,255,255,.14);border-radius:4px;min-height:26px;padding:4px 7px">Reduire</button>
      </div>
      <div style="margin-bottom:6px;color:#e9bfd0">${escapeHtml(target)}</div>
      <div style="margin-bottom:4px;color:#d7c1ca">Live: ${liveTotals.messages} msg - ${liveTotals.rolls} jets - ${liveTotals.criticals} crit - ${liveTotals.damage} degats - ${liveTotals.healing} soins</div>
      <div style="margin-bottom:6px;color:#b9a5ae">Actif: ${escapeHtml(topSpeaker)}</div>
      <div data-rollcodex-status style="margin-bottom:8px;color:#c8f0d0">${escapeHtml(status)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button type="button" data-rollcodex-connect style="cursor:pointer;background:#d92a78;color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px">Connecter</button>
        <button type="button" data-rollcodex-send style="cursor:pointer;background:#335f9f;color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px" ${connection ? '' : 'disabled'}>Envoyer</button>
        <button type="button" data-rollcodex-auto style="cursor:pointer;background:${autoSettings.enabled ? '#236347' : '#5c4230'};color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px">Auto ${autoSettings.enabled ? 'ON' : 'OFF'}</button>
        <button type="button" data-rollcodex-forget style="cursor:pointer;background:#3a2d34;color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px">Oublier</button>
      </div>
    `;
    panel.querySelector('[data-rollcodex-move-panel]')?.addEventListener('click', cyclePanelPosition);
    panel.querySelector('[data-rollcodex-toggle-panel]')?.addEventListener('click', togglePanelCollapsed);
    panel.querySelector('[data-rollcodex-connect]')?.addEventListener('click', startExtensionPairing);
    panel.querySelector('[data-rollcodex-send]')?.addEventListener('click', sendExtensionSnapshot);
    panel.querySelector('[data-rollcodex-auto]')?.addEventListener('click', toggleAutoCapture);
    panel.querySelector('[data-rollcodex-forget]')?.addEventListener('click', forgetExtensionConnection);
  }

  function updatePanelStatus(status) {
    const node = document.querySelector(`#${PANEL_ID} [data-rollcodex-status]`);
    if (node) node.textContent = status;
  }

  async function refreshPanel(status = '') {
    const connection = await getStorageValue(CONNECTION_KEY);
    const autoSettings = await getAutoSettings();
    const panelSettings = await getPanelSettings();
    const visibleMessages = getChatRows().map(normalizeChatRow).filter(Boolean);
    recordLiveMetricsFromMessages(visibleMessages);
    renderPanel({ connection, autoSettings, panelSettings, liveSummary: summarizeLiveMetrics(), status: status || (connection ? 'Connecte via extension' : 'Pret pour jumelage') });
  }

  async function toggleAutoCapture() {
    const settings = await getAutoSettings();
    const next = await patchAutoSettings({ enabled: !settings.enabled });
    if (!next.enabled) clearAutoCaptureTimer();
    else scheduleAutoSnapshot('roll20_auto_enabled');
    refreshPanel(next.enabled ? 'Auto-capture active' : 'Auto-capture suspendue');
  }

  async function startExtensionPairing() {
    updatePanelStatus('Preparation du jumelage...');
    const connectionId = buildUuid();
    const state = buildUuid();
    const connectionSecret = randomHex(32);
    const secretHash = await sha256Hex(connectionSecret);
    const pendingPairing = {
      connectionId,
      state,
      connectionSecret,
      secretHash,
      createdAt: new Date().toISOString(),
    };
    await setStorageValues({ [PENDING_PAIRING_KEY]: pendingPairing });

    const params = buildQueryString({
      connection_id: connectionId,
      state,
      source_origin: 'https://app.roll20.net',
      roll20_game_id: getRoll20GameId(),
      roll20_game_title: getRoll20GameTitle(),
      roll20_system_id: '',
      roll20_system_title: '',
      module_version: `roll20-extension/${BRIDGE_VERSION}`,
      local_secret_hash: secretHash,
      local_secret_prefix: connectionSecret.slice(0, 18),
      local_pairing_code: buildPairingCode(state, secretHash),
    });
    window.open(`${ROLLCODEX_APP_BASE_URL}${ROLLCODEX_CONNECT_PATH}?${params}`, '_blank', 'noopener,noreferrer');
    updatePanelStatus('Jumelage ouvert dans RollCodex');
  }

  function getChatRows() {
    const selectors = ['#textchat [data-messageid]', '#textchat [data-message-id]', '#textchat .message', '#textchat .textchatmessage', '#textchat [class*="message"]', '#textchat li', '#textchat div'];
    const rows = [];
    const seen = new Set();
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (rows.includes(node)) return;
        const text = normalizeText(node.textContent);
        if (!text || text.length < 2 || seen.has(text)) return;
        seen.add(text);
        rows.push(node);
      });
    });
    return rows.slice(-MAX_EXTENSION_MESSAGES);
  }

  function normalizeChatRow(node, index) {
    const rawText = normalizeText(node.textContent);
    if (!rawText || rawText.includes(BRIDGE_SNAPSHOT_MARKER) || rawText.includes('!rollcodex bridge')) return null;
    const key = getChatRowKey(node, index, rawText);
    const speaker = getChatSpeaker(node, rawText);
    const figures = extractRollFigures(rawText);
    return {
      key,
      timestamp: new Date().toISOString(),
      speaker,
      raw_text: rawText,
      action_type_hint: figures.actionType,
      roll_total_hint: figures.rollTotal,
      roll_natural_hint: figures.rollNatural,
      damage_total_hint: figures.damageTotal,
      heal_total_hint: figures.healTotal,
    };
  }

  async function collectExtensionMessages() {
    const lastSentKey = await getStorageValue(LAST_SENT_KEY);
    const messages = getChatRows().map(normalizeChatRow).filter(Boolean);
    recordLiveMetricsFromMessages(messages);
    if (!lastSentKey) return messages;
    const lastIndex = messages.findIndex((message) => message.key === lastSentKey);
    return lastIndex >= 0 ? messages.slice(lastIndex + 1) : messages;
  }

  function recordLiveMetricsFromMessages(messages) {
    (messages || []).forEach((message) => {
      if (!message?.key || liveMetricsState.messageKeys.has(message.key)) return;
      liveMetricsState.messageKeys.add(message.key);
      const speaker = normalizeText(message.speaker) || 'Roll20';
      if (!liveMetricsState.participants.has(speaker)) {
        liveMetricsState.participants.set(speaker, { speaker, messages: 0, rolls: 0, damage: 0, healing: 0 });
      }
      const participant = liveMetricsState.participants.get(speaker);
      participant.messages += 1;
      liveMetricsState.totals.messages += 1;
      if (message.roll_total_hint != null || message.roll_natural_hint != null || message.action_type_hint === 'roll') {
        participant.rolls += 1;
        liveMetricsState.totals.rolls += 1;
      }
      if (message.roll_natural_hint === 20) liveMetricsState.totals.criticals += 1;
      if (message.roll_natural_hint === 1) liveMetricsState.totals.fumbles += 1;
      if (message.damage_total_hint != null) {
        participant.damage += message.damage_total_hint;
        liveMetricsState.totals.damage += message.damage_total_hint;
      }
      if (message.heal_total_hint != null) {
        participant.healing += message.heal_total_hint;
        liveMetricsState.totals.healing += message.heal_total_hint;
      }
      if (message.action_type_hint !== 'message') {
        liveMetricsState.recentEvents.unshift({
          speaker,
          action_type: message.action_type_hint,
          roll_total: message.roll_total_hint,
          roll_natural: message.roll_natural_hint,
          damage_total: message.damage_total_hint,
          heal_total: message.heal_total_hint,
        });
        liveMetricsState.recentEvents = liveMetricsState.recentEvents.slice(0, LIVE_RECENT_EVENTS_LIMIT);
      }
    });
  }

  function summarizeLiveMetrics() {
    const topParticipants = Array.from(liveMetricsState.participants.values())
      .sort((a, b) => b.messages - a.messages || b.rolls - a.rolls)
      .slice(0, 5);
    return {
      totals: { ...liveMetricsState.totals },
      top_participants: topParticipants,
      recent_events: liveMetricsState.recentEvents.slice(0, LIVE_RECENT_EVENTS_LIMIT),
    };
  }

  function buildRoll20MappingSnapshot(messages) {
    const speakers = new Map();
    const actionHints = new Map();
    (messages || []).forEach((message) => {
      const speaker = normalizeText(message.speaker) || 'Roll20';
      speakers.set(speaker, (speakers.get(speaker) || 0) + 1);
      const actionType = message.action_type_hint || 'message';
      actionHints.set(actionType, (actionHints.get(actionType) || 0) + 1);
    });
    return {
      version: 1,
      source: 'roll20-dom-extension',
      speakers: Array.from(speakers.entries()).map(([speaker, count]) => ({ speaker, count })).slice(0, 64),
      action_hints: Array.from(actionHints.entries()).map(([action_type, count]) => ({ action_type, count })),
      limits: ['roll20_dom_only', 'visible_text_mapping_only'],
    };
  }

  function buildExtensionSnapshotPayload(connection, messages, { mode = 'manual', reason = 'extension_button' } = {}) {
    const lastMessage = messages[messages.length - 1];
    const liveMetrics = summarizeLiveMetrics();
    return {
      provider: 'roll20',
      connection_id: connection.connection_id,
      connection_secret: connection.connection_secret,
      client_request_id: `${connection.connection_id}:roll20-extension:${reason}:${lastMessage?.key || 'empty'}:${Date.now()}`,
      source_format: 'roll20_mod_json',
      metadata: {
        roll20_campaign_id: getRoll20GameId(),
        roll20_campaign_name: getRoll20GameTitle(),
        exported_at: new Date().toISOString(),
        rollcodex_client: `roll20-extension/${BRIDGE_VERSION}`,
        capture_mode: mode,
        capture_reason: reason,
        last_message_id: lastMessage?.key || '',
        message_count: messages.length,
        rollcodex_live_metrics: liveMetrics,
        rollcodex_mapping_snapshot: buildRoll20MappingSnapshot(messages),
      },
      messages: messages.map(({ key: _key, ...message }) => message),
    };
  }

  async function sendExtensionSnapshot(options = {}) {
    const mode = options.mode || 'manual';
    const reason = options.reason || (mode === 'auto' ? 'roll20_auto_idle' : 'extension_button');
    const skipIfEmpty = Boolean(options.skipIfEmpty);
    const silent = Boolean(options.silent);
    if (mode === 'auto' && autoCaptureInFlight) return;
    if (mode === 'auto') autoCaptureInFlight = true;
    const connection = await getStorageValue(CONNECTION_KEY);
    if (!connection?.endpoint) {
      if (!silent) updatePanelStatus('Connexion RollCodex manquante');
      if (mode === 'auto') autoCaptureInFlight = false;
      return;
    }
    if (mode === 'auto') {
      const settings = await getAutoSettings();
      if (!settings.enabled || Date.now() - settings.lastAutoSentAt < settings.minIntervalMs) {
        autoCaptureInFlight = false;
        return;
      }
    }
    const messages = await collectExtensionMessages();
    if (!messages.length) {
      if (!skipIfEmpty && !silent) updatePanelStatus('Aucun nouveau message visible');
      if (mode === 'auto') autoCaptureInFlight = false;
      return;
    }
    if (!silent) updatePanelStatus(mode === 'auto' ? 'Auto-capture vers RollCodex...' : 'Envoi vers RollCodex...');
    const request = {
      type: BRIDGE_SNAPSHOT_TYPE,
      ack_token: buildUuid(),
      endpoint: connection.endpoint,
      payload: buildExtensionSnapshotPayload(connection, messages, { mode, reason }),
    };
    chrome.runtime.sendMessage({ type: MESSAGE_SEND_SNAPSHOT, request }, async (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        if (!silent) updatePanelStatus(chrome.runtime.lastError?.message || response?.error || 'Capture refusee');
        if (mode === 'auto') autoCaptureInFlight = false;
        return;
      }
      await setStorageValues({ [LAST_SENT_KEY]: messages[messages.length - 1].key });
      if (mode === 'auto') {
        await patchAutoSettings({ lastAutoSentAt: Date.now() });
        autoCaptureInFlight = false;
      }
      if (!silent) updatePanelStatus(`${mode === 'auto' ? 'Auto-capture envoyee' : 'Capture envoyee'} (${messages.length} messages)`);
      refreshPanel();
    });
  }

  async function forgetExtensionConnection() {
    await removeStorageValue(CONNECTION_KEY);
    await removeStorageValue(PENDING_PAIRING_KEY);
    await removeStorageValue(LAST_SENT_KEY);
    refreshPanel('Connexion oubliee');
  }

  function clearAutoCaptureTimer() {
    if (!autoCaptureTimer) return;
    window.clearTimeout(autoCaptureTimer);
    autoCaptureTimer = null;
  }

  async function scheduleAutoSnapshot(reason = 'roll20_auto_idle') {
    const settings = await getAutoSettings();
    if (!settings.enabled) return;
    const connection = await getStorageValue(CONNECTION_KEY);
    if (!connection?.endpoint) return;
    clearAutoCaptureTimer();
    autoCaptureTimer = window.setTimeout(() => {
      sendExtensionSnapshot({ mode: 'auto', reason, skipIfEmpty: true, silent: true });
    }, settings.idleMs);
  }

  function startAutoCaptureObserver() {
    if (autoCaptureObserver) return;
    const root = document.querySelector('#textchat');
    if (!root) {
      window.setTimeout(startAutoCaptureObserver, 1500);
      return;
    }
    autoCaptureObserver = new MutationObserver((mutations) => {
      const hasChatChange = mutations.some((mutation) => {
        if (mutation.target?.closest?.(`#${PANEL_ID}`)) return false;
        return Array.from(mutation.addedNodes || []).some((node) => {
          if (node.id === PANEL_ID || node.closest?.(`#${PANEL_ID}`)) return false;
          return normalizeText(node.textContent).length >= 2;
        });
      });
      if (!hasChatChange) return;
      refreshPanel();
      scheduleAutoSnapshot('roll20_auto_chat_idle');
    });
    autoCaptureObserver.observe(root, { childList: true, subtree: true });
  }

  function sendVisibilitySnapshot() {
    if (document.visibilityState !== 'hidden') return;
    sendExtensionSnapshot({ mode: 'auto', reason: 'roll20_tab_hidden', skipIfEmpty: true, silent: true });
  }

  function parseBridgeSnapshot(encoded) {
    try {
      const request = JSON.parse(decodeURIComponent(String(encoded || '').trim()));
      if (request?.type !== BRIDGE_SNAPSHOT_TYPE || !request.ack_token || !request.endpoint || !request.payload) return null;
      return request;
    } catch (_error) {
      return null;
    }
  }

  function sendBridgeAck(request) {
    sendChatCommand(`!rollcodex bridge ack ${request.ack_token}`);
  }

  function sendBridgeFail(request, error) {
    const encodedError = encodeURIComponent(JSON.stringify({ error: String(error || 'Bridge Roll20 incapable d envoyer la capture.').slice(0, 500) }));
    sendChatCommand(`!rollcodex bridge fail ${request.ack_token} ${encodedError}`);
  }

  function sendSnapshotThroughBridge(request) {
    if (!request?.ack_token || processedBridgeSnapshots.has(request.ack_token)) return;
    processedBridgeSnapshots.add(request.ack_token);
    chrome.runtime.sendMessage({ type: MESSAGE_SEND_SNAPSHOT, request }, (response) => {
      if (chrome.runtime.lastError) {
        sendBridgeFail(request, chrome.runtime.lastError.message);
        return;
      }
      if (response?.ok) {
        sendBridgeAck(request);
        return;
      }
      sendBridgeFail(request, response?.error || 'Capture RollCodex refusee.');
    });
  }

  function scanBridgeSnapshots(root = document.body) {
    const text = String(root?.textContent || '');
    if (!text.includes(BRIDGE_SNAPSHOT_MARKER)) return;
    const pattern = new RegExp(`${BRIDGE_SNAPSHOT_MARKER}([^\\s<]+)`, 'g');
    let match = pattern.exec(text);
    while (match) {
      const request = parseBridgeSnapshot(match[1]);
      if (request) sendSnapshotThroughBridge(request);
      match = pattern.exec(text);
    }
  }

  function startBridgeSnapshotObserver() {
    scanBridgeSnapshots();
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => scanBridgeSnapshots(node));
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function announceBridgeReady(attempt = 1) {
    const result = sendChatCommand(`!rollcodex bridge ready ${BRIDGE_VERSION}`);
    if (result.ok || attempt >= 5) return;
    window.setTimeout(() => announceBridgeReady(attempt + 1), 1500);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MESSAGE_EXTENSION_CONNECTED) {
      refreshPanel('Connexion RollCodex active');
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type !== MESSAGE_SEND_CHAT_COMMAND) return false;
    sendResponse(sendChatCommand(message.command));
    return true;
  });

  window.setTimeout(announceBridgeReady, 1200);
  startBridgeSnapshotObserver();
  startAutoCaptureObserver();
  document.addEventListener('visibilitychange', sendVisibilitySnapshot);
  window.setTimeout(() => refreshPanel(), 800);
})();
