(() => {
  const MESSAGE_SEND_CHAT_COMMAND = 'ROLLCODEX_ROLL20_SEND_CHAT_COMMAND';
  const MESSAGE_SEND_SNAPSHOT = 'ROLLCODEX_ROLL20_SEND_SNAPSHOT';
  const MESSAGE_FETCH_MAPPING_PROFILE = 'ROLLCODEX_ROLL20_FETCH_MAPPING_PROFILE';
  const MESSAGE_EXTENSION_CONNECTED = 'ROLLCODEX_ROLL20_EXTENSION_CONNECTED';
  const MESSAGE_OPEN_CONNECT_PAGE = 'ROLLCODEX_ROLL20_OPEN_CONNECT_PAGE';
  const CONFIRM_PREFIX = '!rollcodex confirm ';
  const BRIDGE_COMMAND_PREFIX = '!rollcodex bridge ';
  const BRIDGE_SNAPSHOT_MARKER = 'ROLLCODEX_BRIDGE_SNAPSHOT:';
  const BRIDGE_SNAPSHOT_TYPE = 'rollcodex:roll20-bridge-snapshot';
  const BRIDGE_VERSION = '0.3.3';
  const ROLLCODEX_APP_BASE_URL = 'http://localhost:5173';
  const ROLLCODEX_CONNECT_PATH = '/vtt/connect/roll20';
  const PENDING_PAIRING_KEY = 'rollcodexExtensionPendingPairing';
  const CONNECTION_KEY = 'rollcodexExtensionConnection';
  const LAST_SENT_KEY = 'rollcodexExtensionLastSentKey';
  const MAPPING_PROFILE_KEY = 'rollcodexExtensionMappingProfile';
  const AUTO_SETTINGS_KEY = 'rollcodexExtensionAutoSettings';
  const PANEL_SETTINGS_KEY = 'rollcodexExtensionPanelSettings';
  const KIKIMETER_SETTINGS_KEY = 'rollcodexExtensionKikimeterSettings';
  const PANEL_ID = 'rollcodex-extension-panel';
  const PANEL_POSITIONS = ['bottom-left', 'top-left', 'bottom-right', 'manual'];
  const MAX_EXTENSION_MESSAGES = 120;
  const LIVE_RECENT_EVENTS_LIMIT = 6;
  const DEFAULT_AUTO_IDLE_MS = 45 * 60000;
  const DEFAULT_AUTO_MIN_INTERVAL_MS = 120000;
  const MAPPING_PROFILE_TTL_MS = 30000;
  const LIVE_ROLL_EVENT_TYPES = new Set(['roll', 'attack', 'spell_attack', 'saving_throw', 'initiative', 'skill_check']);
  const LIVE_DAMAGE_EVENT_TYPES = new Set(['damage', 'spell_damage']);
  const LIVE_HEALING_EVENT_TYPES = new Set(['healing', 'heal']);
  const processedBridgeSnapshots = new Set();
  let autoCaptureTimer = null;
  let autoCaptureObserver = null;
  let autoCaptureInFlight = false;
  let extensionContextInvalidated = false;

  const liveMetricsState = {
    messageKeys: new Set(),
    messages: [],
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

  function resetLiveMetricsState() {
    liveMetricsState.messageKeys = new Set();
    liveMetricsState.messages = [];
    liveMetricsState.participants = new Map();
    liveMetricsState.recentEvents = [];
    liveMetricsState.totals = createEmptyLiveMetricTotals();
  }

  function rebuildLiveMetricsFromMessages(messages) {
    resetLiveMetricsState();
    recordLiveMetricsFromMessages(messages);
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

  function getExtensionApi() {
    return globalThis.chrome || globalThis.browser || null;
  }

  function readRuntimeLastError() {
    return getExtensionApi()?.runtime?.lastError || null;
  }

  function callExtensionMethod(method, args, onSuccess, onError) {
    let settled = false;
    const resolveOnce = (handler, ...handlerArgs) => {
      if (settled) return;
      settled = true;
      handler(...handlerArgs);
    };
    const callback = (...callbackArgs) => {
      const runtimeError = readRuntimeLastError();
      if (runtimeError) resolveOnce(onError, runtimeError);
      else resolveOnce(onSuccess, ...callbackArgs);
    };

    try {
      const maybePromise = method(...args, callback);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((result) => resolveOnce(onSuccess, result)).catch((error) => resolveOnce(onError, error));
      }
    } catch (callbackError) {
      try {
        const maybePromise = method(...args);
        if (maybePromise && typeof maybePromise.then === 'function') {
          maybePromise.then((result) => resolveOnce(onSuccess, result)).catch((error) => resolveOnce(onError, error));
          return;
        }
      } catch (promiseError) {
        resolveOnce(onError, promiseError);
        return;
      }
      resolveOnce(onError, callbackError);
    }
  }

  function getStorageValue(key) {
    return new Promise((resolve) => {
      const storage = getExtensionApi()?.storage?.local;
      if (!storage?.get) {
        resolve(null);
        return;
      }
      callExtensionMethod(storage.get.bind(storage), [key], (result) => resolve(result?.[key] || null), () => resolve(null));
    });
  }

  function setStorageValues(values) {
    return new Promise((resolve, reject) => {
      const storage = getExtensionApi()?.storage?.local;
      if (!storage?.set) {
        reject(new Error('Extension storage unavailable.'));
        return;
      }
      callExtensionMethod(storage.set.bind(storage), [values], () => resolve(true), reject);
    });
  }

  function removeStorageValue(key) {
    return new Promise((resolve, reject) => {
      const storage = getExtensionApi()?.storage?.local;
      if (!storage?.remove) {
        reject(new Error('Extension storage unavailable.'));
        return;
      }
      callExtensionMethod(storage.remove.bind(storage), [key], () => resolve(true), reject);
    });
  }

  function isExtensionContextInvalidatedError(error) {
    return /Extension context invalidated|context invalidated|Receiving end does not exist/i.test(String(error?.message || error || ''));
  }

  function stringifyExtensionError(error) {
    if (!error) return 'Erreur extension Roll20 inconnue.';
    return String(error.message || error).trim() || 'Erreur extension Roll20 inconnue.';
  }

  function markExtensionContextInvalidated(error) {
    if (!isExtensionContextInvalidatedError(error)) return false;
    extensionContextInvalidated = true;
    return true;
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      const runtime = getExtensionApi()?.runtime;
      if (extensionContextInvalidated || !runtime?.id || !runtime?.sendMessage) {
        resolve({ ok: false, error: 'Extension Roll20 rechargee. Rechargez la page Roll20.' });
        return;
      }
      callExtensionMethod(
        runtime.sendMessage.bind(runtime),
        [message],
        (response) => resolve(response || { ok: false, error: 'Aucune reponse du bridge Roll20.' }),
        (error) => {
          markExtensionContextInvalidated(error);
          resolve({ ok: false, error: stringifyExtensionError(error) });
        },
      );
    });
  }

  async function openRollCodexPairingUrl(url) {
    const response = await sendRuntimeMessage({ type: MESSAGE_OPEN_CONNECT_PAGE, url });
    if (response?.ok) return true;
    window.open(url, '_blank', 'noopener,noreferrer');
    return false;
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
      manualLeft: Number(stored?.manualLeft) || 64,
      manualTop: Number(stored?.manualTop) || 76,
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

  function normalizeKikimeterMetricId(metricId) {
    const normalized = normalizeText(metricId);
    return normalized || '';
  }

  async function getKikimeterSettings() {
    const stored = await getStorageValue(KIKIMETER_SETTINGS_KEY);
    return {
      metric_id: normalizeKikimeterMetricId(stored?.metric_id || stored?.metric),
    };
  }

  async function setKikimeterMetric(metricId) {
    const nextMetricId = normalizeKikimeterMetricId(metricId);
    await setStorageValues({ [KIKIMETER_SETTINGS_KEY]: { metric_id: nextMetricId } });
    refreshPanel(nextMetricId ? 'Kikimeter mis a jour' : 'Kikimeter sans mesure');
  }

  function getNextPanelPosition(position) {
    const currentIndex = PANEL_POSITIONS.indexOf(normalizePanelPosition(position));
    const cycle = PANEL_POSITIONS.filter((item) => item !== 'manual');
    const cycleIndex = cycle.indexOf(PANEL_POSITIONS[currentIndex]);
    return cycle[(cycleIndex + 1) % cycle.length];
  }

  function getPanelPositionStyles(settings) {
    const normalized = normalizePanelPosition(settings?.position);
    if (normalized === 'manual') {
      return [`left:${Number(settings.manualLeft) || 64}px`, `top:${Number(settings.manualTop) || 76}px`];
    }
    if (normalized === 'top-left') return ['left:64px', 'top:76px'];
    if (normalized === 'bottom-right') return ['right:max(18px, min(340px, calc(100vw - 320px)))', 'bottom:18px'];
    return ['left:64px', 'bottom:18px'];
  }

  function getPanelCss(settings) {
    const collapsed = settings?.collapsed === true;
    return [
      'position:fixed',
      ...getPanelPositionStyles(settings),
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

  function isPlaceholderGameTitle(value) {
    return /^(roll20|loading|chargement|campagne|campaign)$/i.test(normalizeText(value));
  }

  function isPlaceholderConnectionLabel(value) {
    const normalized = normalizeText(value).replace(/[.\u2026]+$/g, '');
    return /^(roll20\s*[-:/]\s*)?(loading|chargement|campagne|campaign|table)(\s*[-:/]\s*roll20)?$/i.test(normalized)
      || /^(roll20|campagne|campaign|table)$/i.test(normalized);
  }

  function getConnectionDisplayLabel(value) {
    const label = normalizeText(value);
    return label && !isPlaceholderConnectionLabel(label) ? label : '';
  }

  function getConnectionTargetRows(connection) {
    const campaignLabel = getConnectionDisplayLabel(connection?.campaign_label);
    const tableLabel = getConnectionDisplayLabel(connection?.table_label);

    if (campaignLabel || tableLabel) {
      return [
        campaignLabel ? { label: 'Campagne', value: campaignLabel } : null,
        tableLabel ? { label: 'Table', value: tableLabel } : null,
      ].filter(Boolean);
    }

    const gameTitle = getRoll20GameTitle();
    return [{ label: 'Table', value: gameTitle && gameTitle !== 'Roll20' ? gameTitle : 'Table Roll20' }];
  }

  function renderConnectionTarget(connection) {
    return getConnectionTargetRows(connection).map((row) => `
      <div style="display:flex;gap:5px;min-width:0;line-height:1.35">
        <span style="color:#b9a5ae;flex:0 0 auto">${escapeHtml(row.label)}:</span>
        <span style="color:#e9bfd0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(row.value)}</span>
      </div>
    `).join('');
  }

  function normalizeProfileMetricResult(result) {
    if (!result || typeof result !== 'object') return null;
    const value = toSafeNumber(result.value);
    const label = normalizeText(result.label || result.value_label || result.valueLabel);
    const count = toSafeNumber(result.count);
    if (value == null && !label) return null;
    return {
      value: value ?? 0,
      label: label || String(value ?? 0),
      count,
    };
  }

  function normalizeProfileMetricRankingEntry(entry, index) {
    if (!entry || typeof entry !== 'object') return null;
    const value = toSafeNumber(entry.value);
    const label = normalizeText(entry.label || entry.target_label || entry.name);
    if (value == null || !label) return null;
    const valueLabel = normalizeText(entry.value_label || entry.valueLabel || entry.label_value);
    return {
      key: normalizeText(entry.id || entry.key || `ranking-${index}`),
      label,
      sourceLabel: normalizeText(entry.source_label || entry.sourceLabel || entry.detail || label),
      mapped: true,
      value,
      value_label: valueLabel || String(value),
      count: toSafeNumber(entry.count),
    };
  }

  function normalizeProfileMetric(metric) {
    const id = normalizeText(metric?.id || metric?.key || metric?.name);
    if (!id || metric?.live_supported === false) return null;
    const ranking = Array.isArray(metric?.ranking)
      ? metric.ranking.map(normalizeProfileMetricRankingEntry).filter(Boolean)
      : [];
    return {
      id,
      label: normalizeText(metric?.name || metric?.label || id),
      aggregation: normalizeText(metric?.aggregation || 'count').toLowerCase(),
      field: normalizeText(metric?.field || '').toLowerCase(),
      percentField: normalizeText(metric?.percent_field || metric?.field || '').toLowerCase(),
      percentOperator: normalizeText(metric?.percent_operator || 'eq').toLowerCase(),
      percentValue: metric?.percent_value ?? null,
      filterEventType: Array.isArray(metric?.filter_event_type)
        ? metric.filter_event_type.map((item) => normalizeText(item).toLowerCase()).filter(Boolean)
        : [],
      sortOrder: Number(metric?.sort_order) || 0,
      result: normalizeProfileMetricResult(metric?.result),
      ranking,
      rankingDimension: normalizeText(metric?.ranking_dimension || metric?.rankingDimension),
      scopeHint: normalizeText(metric?.scope_hint || metric?.scopeHint),
    };
  }

  function getProfileMetrics(profile) {
    const rawMetrics = Array.isArray(profile?.metrics)
      ? profile.metrics
      : Array.isArray(profile?.measures)
        ? profile.measures
        : [];
    return rawMetrics
      .map(normalizeProfileMetric)
      .filter(Boolean)
      .sort((left, right) => left.sortOrder - right.sortOrder || left.label.localeCompare(right.label));
  }

  function getSelectedProfileMetric(metrics, selectedMetricId) {
    const normalizedId = normalizeKikimeterMetricId(selectedMetricId);
    return metrics.find((metric) => metric.id === normalizedId) || metrics[0] || null;
  }

  function getMetricProfileStatus(profile, connection) {
    if (!connection) return 'Connexion RollCodex requise';
    if (!connection.mapping_profile_endpoint) return 'Profil RollCodex non synchronise';
    if (!profile?.schema_version) return 'Profil RollCodex indisponible';
    const metricCount = Array.isArray(profile.metrics)
      ? profile.metrics.length
      : Array.isArray(profile.measures)
        ? profile.measures.length
        : 0;
    if (!metricCount) return 'Aucune mesure dans le registre cible';
    if (!getProfileMetrics(profile).length) return 'Aucune mesure compatible live dans le registre';
    return '';
  }

  function isRollLikeMessage(message) {
    const actionType = normalizeText(message?.action_type_hint).toLowerCase();
    return message?.roll_total_hint != null
      || message?.roll_natural_hint != null
      || LIVE_ROLL_EVENT_TYPES.has(actionType);
  }

  function messageMatchesMetricFilter(message, metric) {
    const filters = metric.filterEventType || [];
    if (!filters.length) return true;
    const actionType = normalizeText(message?.action_type_hint || 'message').toLowerCase();
    return filters.some((filter) => {
      if (filter === actionType) return true;
      if (LIVE_DAMAGE_EVENT_TYPES.has(filter)) return message?.damage_total_hint != null || LIVE_DAMAGE_EVENT_TYPES.has(actionType);
      if (LIVE_HEALING_EVENT_TYPES.has(filter)) return message?.heal_total_hint != null || LIVE_HEALING_EVENT_TYPES.has(actionType);
      if (LIVE_ROLL_EVENT_TYPES.has(filter)) return isRollLikeMessage(message);
      return false;
    });
  }

  function getMetricFieldValue(message, field) {
    if (field === 'damage_total') return toSafeNumber(message?.damage_total_hint);
    if (field === 'heal_total') return toSafeNumber(message?.heal_total_hint);
    if (field === 'roll_natural') return toSafeNumber(message?.roll_natural_hint);
    if (field === 'modifier') return null;
    return toSafeNumber(message?.roll_total_hint);
  }

  function compareMetricPercent(value, metric) {
    const expected = toSafeNumber(metric.percentValue);
    if (value == null || expected == null) return false;
    if (metric.percentOperator === 'gt') return value > expected;
    if (metric.percentOperator === 'gte') return value >= expected;
    if (metric.percentOperator === 'lt') return value < expected;
    if (metric.percentOperator === 'lte') return value <= expected;
    if (metric.percentOperator === 'ne') return value !== expected;
    return value === expected;
  }

  function resolveSpeakerMapping(profile, speaker) {
    const sourceKey = normalizeMappingKey(speaker);
    const mappings = Array.isArray(profile?.mappings) ? profile.mappings : [];
    return mappings.find((mapping) => mapping?.source_kind === 'speaker' && normalizeMappingKey(mapping.source_key || mapping.source_label) === sourceKey) || null;
  }

  function getMetricBucket(profile, message) {
    const speaker = normalizeText(message?.speaker) || 'Roll20';
    const mapping = resolveSpeakerMapping(profile, speaker);
    const targetId = normalizeText(mapping?.target_id);
    const targetKind = normalizeText(mapping?.target_kind);
    const label = normalizeText(mapping?.target_label) || speaker;
    return {
      key: targetId ? `${targetKind || 'target'}:${targetId}` : `speaker:${normalizeMappingKey(speaker)}`,
      label,
      sourceLabel: speaker,
      mapped: Boolean(targetId),
    };
  }

  function addMetricContribution(bucket, metric, message) {
    const aggregation = metric.aggregation || 'count';
    if (aggregation === 'percent_critical') {
      if (!isRollLikeMessage(message)) return;
      bucket.denominator += 1;
      if (message.roll_natural_hint === 20) bucket.numerator += 1;
      return;
    }
    if (aggregation === 'percent_fumble') {
      if (!isRollLikeMessage(message)) return;
      bucket.denominator += 1;
      if (message.roll_natural_hint === 1) bucket.numerator += 1;
      return;
    }
    if (aggregation === 'percent') {
      const value = getMetricFieldValue(message, metric.percentField || metric.field);
      if (value == null) return;
      bucket.denominator += 1;
      if (compareMetricPercent(value, metric)) bucket.numerator += 1;
      return;
    }
    if (aggregation === 'avg' || aggregation === 'average' || aggregation === 'mean') {
      const value = getMetricFieldValue(message, metric.field);
      if (value == null) return;
      bucket.sum += value;
      bucket.count += 1;
      return;
    }
    if (aggregation === 'sum') {
      const value = getMetricFieldValue(message, metric.field);
      if (value == null) return;
      bucket.sum += value;
      bucket.count += 1;
      return;
    }
    bucket.count += 1;
  }

  function formatMetricValue(value, metric) {
    if (['percent', 'percent_critical', 'percent_fumble'].includes(metric?.aggregation)) {
      return `${Math.round(value * 10) / 10}%`;
    }
    if (['avg', 'average', 'mean'].includes(metric?.aggregation)) {
      return String(Math.round(value * 10) / 10);
    }
    return String(Math.round(value));
  }

  function metricAggregationFamily(metric) {
    const aggregation = metric?.aggregation || 'count';
    const isPercent = ['percent', 'percent_critical', 'percent_fumble'].includes(aggregation);
    const isAverage = ['avg', 'average', 'mean'].includes(aggregation);
    return {
      aggregation,
      isPercent,
      isAverage,
      isAdditive: !isPercent && !isAverage,
    };
  }

  function bucketValueForMetric(bucket, metric) {
    const family = metricAggregationFamily(metric);
    if (family.isPercent) return bucket.denominator ? (bucket.numerator / bucket.denominator) * 100 : 0;
    if (family.isAverage) return bucket.count ? bucket.sum / bucket.count : 0;
    if (family.aggregation === 'sum') return bucket.sum;
    return bucket.count;
  }

  function computeLiveDeltaForMetric(profile, metric) {
    const buckets = new Map();
    const totals = { count: 0, sum: 0, numerator: 0, denominator: 0, messages: 0 };
    if (!metric) return { buckets, totals };

    liveMetricsState.messages.forEach((message) => {
      if (!messageMatchesMetricFilter(message, metric)) return;
      const bucketInfo = getMetricBucket(profile, message);
      const bucket = buckets.get(bucketInfo.key) || {
        ...bucketInfo,
        count: 0,
        sum: 0,
        numerator: 0,
        denominator: 0,
        messages: 0,
      };
      const before = { count: bucket.count, sum: bucket.sum, numerator: bucket.numerator, denominator: bucket.denominator };
      bucket.messages += 1;
      addMetricContribution(bucket, metric, message);
      totals.messages += 1;
      totals.count += bucket.count - before.count;
      totals.sum += bucket.sum - before.sum;
      totals.numerator += bucket.numerator - before.numerator;
      totals.denominator += bucket.denominator - before.denominator;
      buckets.set(bucketInfo.key, bucket);
    });

    return { buckets, totals };
  }

  function findBaselineEntryForBucket(baselineRanking, bucket) {
    const bucketSource = normalizeMappingKey(bucket.sourceLabel);
    const bucketLabel = normalizeMappingKey(bucket.label);
    return baselineRanking.find((entry) => {
      const entrySource = normalizeMappingKey(entry.sourceLabel);
      const entryLabel = normalizeMappingKey(entry.label);
      return (bucketSource && entrySource === bucketSource)
        || (bucketLabel && entryLabel === bucketLabel);
    }) || null;
  }

  function computeBaselinePlusLive(profile, metric) {
    if (!metric) return { metricResult: null, leaderboard: [] };

    const baselineResult = metric.result || null;
    const baselineRanking = Array.isArray(metric.ranking) ? metric.ranking : [];
    const { buckets, totals } = computeLiveDeltaForMetric(profile, metric);
    const family = metricAggregationFamily(metric);

    const totalDelta = bucketValueForMetric(totals, metric);
    const baselineValue = Number(baselineResult?.value) || 0;
    const mergedValue = family.isAdditive ? baselineValue + totalDelta : baselineValue;
    const hasDelta = totalDelta > 0 || totals.messages > 0;
    const metricResult = baselineResult || hasDelta ? {
      value: mergedValue,
      label: family.isAdditive
        ? formatMetricValue(mergedValue, metric)
        : (baselineResult?.label || formatMetricValue(baselineValue, metric)),
      count: (Number(baselineResult?.count) || 0) + totals.messages,
      delta_value: totalDelta,
      delta_label: hasDelta && totalDelta > 0 ? `+${formatMetricValue(totalDelta, metric)}` : '',
      delta_count: totals.messages,
      has_delta: hasDelta,
    } : null;

    const merged = new Map();
    baselineRanking.forEach((entry) => {
      const key = entry.key || `baseline-${merged.size}`;
      merged.set(key, {
        key,
        label: entry.label,
        sourceLabel: entry.sourceLabel || entry.label,
        mapped: entry.mapped !== false,
        baseline_value: Number(entry.value) || 0,
        baseline_label: entry.value_label || formatMetricValue(Number(entry.value) || 0, metric),
        delta_value: 0,
        delta_messages: 0,
      });
    });

    for (const [bucketKey, bucket] of buckets.entries()) {
      const deltaValue = bucketValueForMetric(bucket, metric);
      if (deltaValue <= 0 && bucket.messages === 0) continue;

      let entry = merged.get(bucketKey);
      if (!entry) {
        const matched = findBaselineEntryForBucket(Array.from(merged.values()), bucket);
        if (matched) entry = matched;
      }
      if (entry) {
        entry.delta_value = deltaValue;
        entry.delta_messages = bucket.messages;
      } else {
        merged.set(bucketKey, {
          key: bucketKey,
          label: bucket.label,
          sourceLabel: bucket.sourceLabel,
          mapped: bucket.mapped,
          baseline_value: 0,
          baseline_label: '',
          delta_value: deltaValue,
          delta_messages: bucket.messages,
        });
      }
    }

    const leaderboard = Array.from(merged.values()).map((entry) => {
      const finalValue = family.isAdditive
        ? entry.baseline_value + entry.delta_value
        : entry.baseline_value || entry.delta_value;
      const entryHasDelta = entry.delta_value > 0 || entry.delta_messages > 0;
      return {
        key: entry.key,
        label: entry.label,
        sourceLabel: entry.sourceLabel,
        mapped: entry.mapped,
        baseline_value: entry.baseline_value,
        value: finalValue,
        value_label: formatMetricValue(finalValue, metric),
        delta_value: entry.delta_value,
        delta_label: entryHasDelta && entry.delta_value > 0 ? `+${formatMetricValue(entry.delta_value, metric)}` : '',
        delta_messages: entry.delta_messages,
        has_delta: entryHasDelta,
      };
    });

    return {
      metricResult,
      leaderboard: leaderboard
        .filter((entry) => Number(entry.value) > 0 || entry.has_delta)
        .sort((left, right) => (right.value - left.value)
          || (right.delta_value - left.delta_value)
          || left.label.localeCompare(right.label))
        .slice(0, 5),
    };
  }

  function computeKikimeterLeaderboard(profile, metric) {
    return computeBaselinePlusLive(profile, metric).leaderboard;
  }

  function renderKikimeter(liveSummary, selectedMetricId) {
    const metrics = Array.isArray(liveSummary.profile_metrics) ? liveSummary.profile_metrics : [];
    const metric = liveSummary.selected_metric || getSelectedProfileMetric(metrics, selectedMetricId);
    const leaderboard = Array.isArray(liveSummary.leaderboard) ? liveSummary.leaderboard : [];
    const profileStatus = liveSummary.metric_status || '';
    const mergedResult = liveSummary.metric_result || metric?.result || null;

    if (!metric) {
      return `
        <div style="margin:7px 0 8px;padding:7px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:rgba(255,255,255,.04)">
          <div style="font-weight:700;color:#f7edf2;margin-bottom:4px">Kikimeter live</div>
          <div style="color:#b9a5ae;font-size:11px">${escapeHtml(profileStatus || 'Aucune mesure live disponible')}</div>
        </div>
      `;
    }

    const maxValue = Math.max(...leaderboard.map((entry) => Number(entry.value) || 0), 1);
    const resultDeltaBadge = mergedResult?.delta_label
      ? ` <span style="display:inline-block;padding:0 5px;border-radius:8px;background:rgba(113,212,147,.18);color:#71d493;font-weight:700;font-size:10px">${escapeHtml(mergedResult.delta_label)}</span>`
      : '';
    const resultLine = mergedResult
      ? `<div style="margin-bottom:6px;color:#b9a5ae;font-size:11px">RollCodex: <b style="color:#f7edf2">${escapeHtml(mergedResult.label)}</b>${resultDeltaBadge}${mergedResult.count != null ? ` - ${mergedResult.count} ev.` : ''}</div>`
      : '';
    const buttons = metrics.map((item) => {
      const isSelected = item.id === metric.id;
      return `
        <button type="button" data-rollcodex-kiki-metric="${escapeHtml(item.id)}" title="${escapeHtml(item.label)}" style="cursor:pointer;background:${isSelected ? '#d92a78' : '#2a2228'};color:#f7edf2;border:1px solid ${isSelected ? 'rgba(255,255,255,.25)' : 'rgba(255,255,255,.14)'};border-radius:4px;min-height:24px;padding:3px 6px;font-size:11px;max-width:126px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.label)}</button>
      `;
    }).join('');
    const rows = leaderboard.length ? leaderboard.map((entry, index) => {
      const value = Number(entry.value) || 0;
      const width = Math.max(8, Math.round((value / maxValue) * 100));
      const title = entry.mapped && entry.sourceLabel !== entry.label ? `${entry.label} (${entry.sourceLabel})` : entry.label;
      const deltaBadge = entry.delta_label
        ? ` <span title="Delta session live" style="display:inline-block;padding:0 4px;margin-left:4px;border-radius:6px;background:rgba(113,212,147,.18);color:#71d493;font-weight:700;font-size:10px">${escapeHtml(entry.delta_label)}</span>`
        : '';
      return `
        <div style="display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:center;gap:5px;min-width:0">
          <span style="color:#b9a5ae">#${index + 1}</span>
          <span title="${escapeHtml(title)}" style="position:relative;min-width:0;overflow:hidden;border-radius:4px;background:rgba(255,255,255,.06)">
            <span style="display:block;width:${width}%;height:100%;min-height:18px;background:rgba(217,42,120,.22)"></span>
            <span style="position:absolute;inset:1px 5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#f7edf2">${escapeHtml(entry.label)}</span>
          </span>
          <span style="color:#e9bfd0;font-weight:700">${escapeHtml(entry.value_label || value)}${deltaBadge}</span>
        </div>
      `;
    }).join('') : '<div style="color:#b9a5ae">Aucun score visible</div>';

    return `
      <div style="margin:7px 0 8px;padding:7px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:rgba(255,255,255,.04)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px">
          <span style="font-weight:700;color:#f7edf2">Kikimeter live</span>
          <span style="color:#e9bfd0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(metric.label)}</span>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px">${buttons}</div>
        ${resultLine}
        <div style="display:grid;gap:4px;font-size:11px">${rows}</div>
      </div>
    `;
  }

  function getRoll20GameTitle() {
    const title = normalizeText(document.querySelector('.campaign-title, [class*="campaign"] h1, h1')?.textContent);
    if (title && !isPlaceholderGameTitle(title)) return title;
    const pageTitle = normalizeText(document.title).replace(/\s*\|\s*Roll20.*$/i, '');
    return pageTitle && !isPlaceholderGameTitle(pageTitle) ? pageTitle : 'Roll20';
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

  function isAllowedRollCodexActionCommand(command) {
    const normalized = normalizeCommand(command);
    if (!normalized.startsWith('!rollcodex ')) return false;
    return /^!rollcodex (idle|auto|send|end|status|profile|live|top|connect|complete)(\s|$)/i.test(normalized);
  }

  function isAllowedRollCodexChatCommand(command) {
    return isAllowedRollCodexConfirmation(command)
      || isAllowedBridgeCommand(command)
      || isAllowedRollCodexActionCommand(command);
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
    const kikimeterSettings = state.kikimeterSettings || { metric_id: '' };
    const liveSummary = state.liveSummary || { totals: createEmptyLiveMetricTotals(), top_participants: [] };
    const liveTotals = liveSummary.totals || createEmptyLiveMetricTotals();
    const topSpeaker = liveSummary.top_participants?.[0]?.speaker || 'Table Roll20';
    const status = state.status || (connection ? 'Connecte' : 'Non connecte');
    const target = connection ? renderConnectionTarget(connection) : escapeHtml('Extension prete a connecter');
    const kikimeter = renderKikimeter(liveSummary, kikimeterSettings.metric_id);
    const connectButton = connection ? '' : '<button type="button" data-rollcodex-connect style="cursor:pointer;background:#d92a78;color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px">Connecter</button>';
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
        <button type="button" data-rollcodex-drag-handle title="Deplacer" style="cursor:grab;background:#2a2228;color:#f7edf2;border:1px solid rgba(255,255,255,.14);border-radius:4px;min-height:26px;padding:4px 7px">Deplacer</button>
        <button type="button" data-rollcodex-toggle-panel title="Reduire" style="cursor:pointer;background:#2a2228;color:#f7edf2;border:1px solid rgba(255,255,255,.14);border-radius:4px;min-height:26px;padding:4px 7px">Reduire</button>
      </div>
      <div style="margin-bottom:6px;min-width:0">${target}</div>
      <div style="margin-bottom:4px;color:#d7c1ca">Live: ${liveTotals.messages} msg - ${liveTotals.rolls} jets - ${liveTotals.criticals} crit - ${liveTotals.damage} degats - ${liveTotals.healing} soins</div>
      <div style="margin-bottom:6px;color:#b9a5ae">Actif: ${escapeHtml(topSpeaker)}</div>
      ${kikimeter}
      <div data-rollcodex-status style="margin-bottom:8px;color:#c8f0d0">${escapeHtml(status)}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${connectButton}
        <button type="button" data-rollcodex-chat-send style="cursor:pointer;background:#335f9f;color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px" ${connection ? '' : 'disabled'}>Envoyer</button>
        <button type="button" data-rollcodex-end-session style="cursor:pointer;background:#4d426f;color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px" ${connection ? '' : 'disabled'}>Fin</button>
        <button type="button" data-rollcodex-auto style="cursor:pointer;background:${autoSettings.enabled ? '#236347' : '#5c4230'};color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px">Auto ${autoSettings.enabled ? 'ON' : 'OFF'}</button>
        <button type="button" data-rollcodex-forget style="cursor:pointer;background:#3a2d34;color:white;border:0;border-radius:4px;min-height:28px;padding:5px 8px">Oublier</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:7px;color:#b9a5ae">
        <button type="button" data-rollcodex-auto-minus style="cursor:pointer;background:#2a2228;color:#f7edf2;border:1px solid rgba(255,255,255,.14);border-radius:4px;min-height:24px;min-width:26px">-</button>
        <span data-rollcodex-auto-minutes>Auto ${Math.round((autoSettings.idleMs || DEFAULT_AUTO_IDLE_MS) / 60000)} min</span>
        <button type="button" data-rollcodex-auto-plus style="cursor:pointer;background:#2a2228;color:#f7edf2;border:1px solid rgba(255,255,255,.14);border-radius:4px;min-height:24px;min-width:26px">+</button>
      </div>
    `;
    panel.querySelector('[data-rollcodex-drag-handle]')?.addEventListener('pointerdown', beginPanelDrag);
    panel.querySelector('[data-rollcodex-drag-handle]')?.addEventListener('dblclick', cyclePanelPosition);
    panel.querySelector('[data-rollcodex-toggle-panel]')?.addEventListener('click', togglePanelCollapsed);
    panel.querySelector('[data-rollcodex-connect]')?.addEventListener('click', startExtensionPairing);
    panel.querySelector('[data-rollcodex-chat-send]')?.addEventListener('click', sendExtensionSnapshot);
    panel.querySelector('[data-rollcodex-end-session]')?.addEventListener('click', endExtensionSession);
    panel.querySelector('[data-rollcodex-auto]')?.addEventListener('click', toggleAutoCapture);
    panel.querySelector('[data-rollcodex-auto-minus]')?.addEventListener('click', () => adjustAutoIdle(-5));
    panel.querySelector('[data-rollcodex-auto-plus]')?.addEventListener('click', () => adjustAutoIdle(5));
    panel.querySelector('[data-rollcodex-forget]')?.addEventListener('click', forgetExtensionConnection);
    panel.querySelectorAll('[data-rollcodex-kiki-metric]').forEach((button) => {
      button.addEventListener('click', () => setKikimeterMetric(button.getAttribute('data-rollcodex-kiki-metric')));
    });
  }

  function updatePanelStatus(status) {
    const node = document.querySelector(`#${PANEL_ID} [data-rollcodex-status]`);
    if (node) node.textContent = status;
  }

  function beginPanelDrag(event) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    event.preventDefault();
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;

    const onMove = (moveEvent) => {
      const manualLeft = Math.max(8, Math.round(startLeft + moveEvent.clientX - startX));
      const manualTop = Math.max(8, Math.round(startTop + moveEvent.clientY - startY));
      panel.style.left = `${manualLeft}px`;
      panel.style.top = `${manualTop}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    };

    const onUp = async () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      const nextRect = panel.getBoundingClientRect();
      await patchPanelSettings({
        position: 'manual',
        manualLeft: Math.round(nextRect.left),
        manualTop: Math.round(nextRect.top),
      });
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  async function refreshPanel(status = '') {
    const connection = await getStorageValue(CONNECTION_KEY);
    const autoSettings = await getAutoSettings();
    const panelSettings = await getPanelSettings();
    const kikimeterSettings = await getKikimeterSettings();
    const lastSentKey = await getStorageValue(LAST_SENT_KEY);
    const visibleMessages = getChatRows().map(normalizeChatRow).filter(Boolean);
    rebuildLiveMetricsFromMessages(getPendingMessagesSlice(visibleMessages, lastSentKey));
    const profile = connection ? await getMappingProfile(connection).catch(() => null) : null;
    renderPanel({
      connection,
      autoSettings,
      panelSettings,
      kikimeterSettings,
      liveSummary: summarizeLiveMetrics(profile, kikimeterSettings.metric_id, connection),
      status: status || (connection ? 'Connecte via extension' : 'Pret pour jumelage extension'),
    });
  }

  async function toggleAutoCapture() {
    const settings = await getAutoSettings();
    const next = await patchAutoSettings({ enabled: !settings.enabled });
    if (!next.enabled) clearAutoCaptureTimer();
    else scheduleAutoSnapshot('roll20_auto_enabled');
    refreshPanel(next.enabled ? 'Auto-capture active' : 'Auto-capture suspendue');
  }

  async function setAutoIdleMinutes(minutes) {
    const safeMinutes = Math.max(5, Math.min(180, Number(minutes) || 45));
    const next = await patchAutoSettings({ idleMs: safeMinutes * 60000 });
    scheduleAutoSnapshot('roll20_auto_idle_changed');
    refreshPanel(`Auto ${Math.round(next.idleMs / 60000)} min`);
  }

  async function adjustAutoIdle(deltaMinutes) {
    const settings = await getAutoSettings();
    const currentMinutes = Math.round((settings.idleMs || DEFAULT_AUTO_IDLE_MS) / 60000);
    await setAutoIdleMinutes(currentMinutes + deltaMinutes);
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
    const pairingUrl = `${ROLLCODEX_APP_BASE_URL}${ROLLCODEX_CONNECT_PATH}?${params}`;
    await openRollCodexPairingUrl(pairingUrl);
    updatePanelStatus('Jumelage ouvert dans RollCodex');
  }

  function getChatRows() {
    const selectors = [
      '#textchat [data-messageid]',
      '#textchat [data-message-id]',
      '#textchat .message',
      '#textchat .textchatmessage',
      '#textchat .chat-message',
      '#textchat [class*="message"]',
    ];
    const rows = [];
    const seen = new Set();
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (rows.some((row) => row === node || row.contains(node))) return;
        const text = normalizeText(node.textContent);
        if (!text || text.length < 2 || seen.has(text) || isIgnoredChatText(text, '')) return;
        seen.add(text);
        rows.push(node);
      });
    });
    return rows.slice(-MAX_EXTENSION_MESSAGES);
  }

  function isIgnoredChatText(rawText, speaker = '') {
    const text = normalizeText(rawText);
    if (!text) return true;
    if (text.includes(BRIDGE_SNAPSHOT_MARKER) || text.includes('!rollcodex bridge')) return true;

    const lowerText = text.toLowerCase();
    const lowerSpeaker = normalizeText(speaker).toLowerCase();
    if (lowerSpeaker.includes('from rollcodex') || lowerSpeaker === 'rollcodex') return true;
    if (/\(?from rollcodex\)?\s*:/i.test(text)) return true;
    if (/\b(etat rollcodex|adresse rollcodex|transport http|relancer la liaison|code local|capture auto|jumelage en attente|messages en attente|connexion rollcodex|jumelage rollcodex)\b/i.test(text)) return true;
    if (/\brollcodex\s*(?:[.!:]\s*)?(?:send|end|status|profile|auto|idle|disconnect|complete|connect|live|top)\b/i.test(text)) return true;
    if (lowerText.includes('rollcodex') && /\b(mod|api|adresse|transport http|connexion|cible|capture|jumelage|relancer|pre-mapping|profil|inactivite|autorisez la connexion|oubliee|oubliée)\b/i.test(text)) return true;
    if (lowerText.includes('rollcodex') && /\b(?:127\.0\.0\.1|local(?:test)?\.me|local\s*host)\b/i.test(text)) return true;
    if (lowerText.includes('rollcodex') && /\b(envoie une capture|capture manuelle|fin de session|etat local|recharge le profil|coupe la capture|regle le delai|connexion locale)\b/i.test(text)) return true;
    if (/\b(astuces de chat|jets de d[eé]s|chuchoter a un joueur|chuchoter à un joueur|inviter des joueurs|voici le lien joueur)\b/i.test(text)) return true;
    return false;
  }

  function normalizeChatRow(node, index) {
    const rawText = normalizeText(node.textContent);
    const key = getChatRowKey(node, index, rawText);
    const speaker = getChatSpeaker(node, rawText);
    if (isIgnoredChatText(rawText, speaker)) return null;
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

  function getPendingMessagesSlice(messages, lastSentKey) {
    if (!lastSentKey) return messages;
    const lastIndex = messages.findIndex((message) => message.key === lastSentKey);
    return lastIndex >= 0 ? messages.slice(lastIndex + 1) : messages;
  }

  async function collectExtensionMessages() {
    const lastSentKey = await getStorageValue(LAST_SENT_KEY);
    const messages = getChatRows().map(normalizeChatRow).filter(Boolean);
    const pending = getPendingMessagesSlice(messages, lastSentKey);
    rebuildLiveMetricsFromMessages(pending);
    return pending;
  }

  function recordLiveMetricsFromMessages(messages) {
    (messages || []).forEach((message) => {
      if (!message?.key || liveMetricsState.messageKeys.has(message.key)) return;
      liveMetricsState.messageKeys.add(message.key);
      liveMetricsState.messages.push(message);
      const speaker = normalizeText(message.speaker) || 'Roll20';
      if (!liveMetricsState.participants.has(speaker)) {
        liveMetricsState.participants.set(speaker, { speaker, messages: 0, rolls: 0, criticals: 0, fumbles: 0, damage: 0, healing: 0 });
      }
      const participant = liveMetricsState.participants.get(speaker);
      participant.messages += 1;
      liveMetricsState.totals.messages += 1;
      if (message.roll_total_hint != null || message.roll_natural_hint != null || message.action_type_hint === 'roll') {
        participant.rolls += 1;
        liveMetricsState.totals.rolls += 1;
      }
      if (message.roll_natural_hint === 20) {
        participant.criticals += 1;
        liveMetricsState.totals.criticals += 1;
      }
      if (message.roll_natural_hint === 1) {
        participant.fumbles += 1;
        liveMetricsState.totals.fumbles += 1;
      }
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

  function summarizeLiveMetrics(profile = null, selectedMetricId = '', connection = null) {
    const participants = Array.from(liveMetricsState.participants.values());
    const topParticipants = participants
      .sort((a, b) => b.messages - a.messages || b.rolls - a.rolls)
      .slice(0, 5);
    const profileMetrics = getProfileMetrics(profile);
    const selectedMetric = getSelectedProfileMetric(profileMetrics, selectedMetricId);
    const merged = computeBaselinePlusLive(profile, selectedMetric);
    return {
      totals: { ...liveMetricsState.totals },
      top_participants: topParticipants,
      profile_metrics: profileMetrics,
      selected_metric: selectedMetric,
      leaderboard: merged.leaderboard,
      metric_result: merged.metricResult,
      metric_status: getMetricProfileStatus(profile, connection),
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

  function normalizeMappingKey(value) {
    return normalizeText(value).toLowerCase();
  }

  function isFreshMappingProfileCache(stored, connectionId) {
    if (stored?.connection_id !== connectionId || !stored?.profile?.schema_version) return false;
    const fetchedAt = Date.parse(stored.fetched_at || '');
    return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < MAPPING_PROFILE_TTL_MS;
  }

  async function getMappingProfile(connection, options = {}) {
    if (!connection?.mapping_profile_endpoint || !connection.connection_id || !connection.connection_secret) {
      return null;
    }

    const stored = await getStorageValue(MAPPING_PROFILE_KEY);
    if (!options.force && isFreshMappingProfileCache(stored, connection.connection_id)) {
      return stored.profile;
    }

    const response = await sendRuntimeMessage({
      type: MESSAGE_FETCH_MAPPING_PROFILE,
      request: {
        type: 'rollcodex:roll20-bridge-mapping-profile',
        endpoint: connection.mapping_profile_endpoint,
        payload: {
          provider: 'roll20',
          connection_id: connection.connection_id,
          connection_secret: connection.connection_secret,
        },
      },
    });

    if (!response?.ok) {
      return stored?.connection_id === connection.connection_id && stored?.profile?.schema_version ? stored.profile : null;
    }

    const profile = response.payload?.profile || null;
    if (profile) {
      const previousLastUpdate = stored?.profile?.last_updated_at || null;
      const nextLastUpdate = profile.last_updated_at || null;
      await setStorageValues({
        [MAPPING_PROFILE_KEY]: {
          connection_id: connection.connection_id,
          fetched_at: new Date().toISOString(),
          profile,
        },
      });
      if (previousLastUpdate && nextLastUpdate && previousLastUpdate !== nextLastUpdate) {
        // RollCodex a absorbe / l'utilisateur a re-mappe : la baseline englobe maintenant
        // une partie de ce qui etait en live. Le filtrage par LAST_SENT_KEY assure
        // qu'on ne double-compte pas, mais on reconstruit l'etat live pour eviter
        // de garder des contributions obsoletes.
        resetLiveMetricsState();
      }
    }
    return profile;
  }

  function buildMappingHintsFromProfile(profile, messages) {
    const mappings = Array.isArray(profile?.mappings) ? profile.mappings : [];
    const mappingsBySpeaker = new Map();
    mappings.forEach((mapping) => {
      if (mapping?.source_kind !== 'speaker') return;
      const key = normalizeMappingKey(mapping.source_key || mapping.source_label);
      if (key && !mappingsBySpeaker.has(key)) mappingsBySpeaker.set(key, mapping);
    });

    const speakers = new Map();
    (messages || []).forEach((message) => {
      const speaker = normalizeText(message.speaker) || 'Roll20';
      const key = normalizeMappingKey(speaker);
      if (!key || speakers.has(key)) return;
      speakers.set(key, speaker);
    });

    return Array.from(speakers.entries()).slice(0, 128).map(([sourceKey, sourceLabel]) => {
      const mapping = mappingsBySpeaker.get(sourceKey);
      return {
        provider: 'roll20',
        source_kind: 'speaker',
        source_key: sourceKey,
        source_label: sourceLabel,
        target_kind: mapping?.target_kind || null,
        target_id: mapping?.target_id || null,
        target_label: mapping?.target_label || null,
        confidence: Number(mapping?.confidence ?? 0),
      };
    });
  }

  function buildExtensionClientRequestId(connection, reason, lastMessage) {
    const stablePart = [
      connection.connection_id,
      'roll20-extension',
      reason,
      lastMessage?.key || 'empty',
    ].join(':');
    return `${stablePart}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  }

  async function buildExtensionSnapshotPayload(connection, messages, { mode = 'manual', reason = 'extension_button' } = {}) {
    const lastMessage = messages[messages.length - 1];
    const profile = await getMappingProfile(connection);
    const kikimeterSettings = await getKikimeterSettings();
    const liveMetrics = summarizeLiveMetrics(profile, kikimeterSettings.metric_id, connection);
    const mappingHints = buildMappingHintsFromProfile(profile, messages);
    return {
      provider: 'roll20',
      connection_id: connection.connection_id,
      connection_secret: connection.connection_secret,
      client_request_id: buildExtensionClientRequestId(connection, reason, lastMessage),
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
        mapping_hint_count: mappingHints.length,
      },
      messages: messages.map(({ key: _key, ...message }) => message),
      mapping_hints: mappingHints,
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
      payload: await buildExtensionSnapshotPayload(connection, messages, { mode, reason }),
    };
    const response = await sendRuntimeMessage({ type: MESSAGE_SEND_SNAPSHOT, request });
    if (!response?.ok) {
      if (!silent) updatePanelStatus(response?.error || 'Capture refusee');
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
  }

  async function getPendingMessagesCount() {
    return (await collectExtensionMessages()).length;
  }

  async function endExtensionSession() {
    const pending = await getPendingMessagesCount();
    await sendExtensionSnapshot({
      mode: 'manual',
      reason: 'roll20_session_end',
      skipIfEmpty: true,
    });
    refreshPanel(pending ? `Fin de session envoyee (${pending} messages)` : 'Fin de session sans nouveau message');
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

  function sendPagehideSnapshot() {
    sendExtensionSnapshot({ mode: 'auto', reason: 'roll20_pagehide', skipIfEmpty: true, silent: true });
  }

  function sendBeforeUnloadSnapshot() {
    sendExtensionSnapshot({ mode: 'auto', reason: 'roll20_beforeunload', skipIfEmpty: true, silent: true });
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
    sendRuntimeMessage({ type: MESSAGE_SEND_SNAPSHOT, request }).then((response) => {
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

  getExtensionApi()?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type === MESSAGE_EXTENSION_CONNECTED) {
      refreshPanel('Connexion RollCodex active');
      if (message.connection) {
        getMappingProfile(message.connection, { force: true })
          .then(() => refreshPanel('Profil RollCodex recharge'))
          .catch(() => null);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type !== MESSAGE_SEND_CHAT_COMMAND) return false;
    sendResponse(sendChatCommand(message.command));
    return true;
  });

  startBridgeSnapshotObserver();
  startAutoCaptureObserver();
  document.addEventListener('visibilitychange', sendVisibilitySnapshot);
  window.addEventListener('pagehide', sendPagehideSnapshot);
  window.addEventListener('beforeunload', sendBeforeUnloadSnapshot);
  window.setTimeout(() => refreshPanel(), 800);
})();
