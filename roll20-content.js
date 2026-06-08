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
  const BRIDGE_VERSION = '0.4.2';
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
  const VIEWER_BROADCAST_MARKER = 'ROLLCODEX_BRIDGE_VIEWER:';
  const VIEWER_BROADCAST_TYPE = 'rollcodex:roll20-viewer-broadcast';
  const VIEWER_REQUEST_TYPE = 'rollcodex:roll20-viewer-request';
  const VIEWER_BROADCAST_HEARTBEAT_MS = 5 * 60 * 1000;
  const VIEWER_BROADCAST_STALE_MS = VIEWER_BROADCAST_HEARTBEAT_MS * 2 + 30000;
  const VIEWER_BROADCAST_MAX_MARKER_LENGTH = 8800;
  const VIEWER_BROADCAST_CACHE_KEY = 'rollcodexExtensionViewerBroadcast';
  const VIEWER_REQUEST_RETRY_DELAYS_MS = [1500, 5000, 15000, 45000];
  const VIEWER_REQUEST_PERIODIC_MS = 60 * 1000;
  const VIEWER_REQUEST_MIN_INTERVAL_MS = 4000;
  const VIEWER_STARTUP_RESYNC_MS = 2500;
  const VIEWER_REQUEST_RESPONSE_DEBOUNCE_MS = 2000;
  const PANEL_COLORS = {
    bg: 'rgba(17,13,12,.96)',
    bgSoft: 'rgba(24,18,17,.72)',
    bgCollapsed: 'rgba(17,13,12,.52)',
    border: '#c79a4b',
    borderSoft: 'rgba(199,154,75,.24)',
    text: '#f4ede3',
    muted: '#b4a696',
    faint: '#7e7063',
    accent: '#d7ad5c',
    accentSoft: 'rgba(215,173,92,.2)',
    rose: '#9d3a68',
    roseSoft: 'rgba(157,58,104,.24)',
    ok: '#78c88f',
    danger: '#d96a6a',
  };
  const MAX_EXTENSION_MESSAGES = 120;
  const LIVE_RECENT_EVENTS_LIMIT = 6;
  const DEFAULT_AUTO_IDLE_MS = 45 * 60000;
  const DEFAULT_AUTO_MIN_INTERVAL_MS = 120000;
  const MAPPING_PROFILE_TTL_MS = 30000;
  const LIVE_ROLL_EVENT_TYPES = new Set(['roll', 'attack', 'spell_attack', 'saving_throw', 'initiative', 'skill_check']);
  const LIVE_DAMAGE_EVENT_TYPES = new Set(['damage', 'spell_damage']);
  const LIVE_HEALING_EVENT_TYPES = new Set(['healing', 'heal']);
  const processedBridgeSnapshots = new Set();
  const processedViewerBroadcasts = new Set();
  let autoCaptureTimer = null;
  let autoCaptureObserver = null;
  let bridgeSnapshotObserver = null;
  let viewerBroadcastObserver = null;
  let viewerChatObserver = null;
  let viewerHeartbeatTimer = null;
  let viewerRequestTimer = null;
  let viewerStartupResyncTimer = null;
  let lastViewerRequestSentAt = 0;
  let autoCaptureInFlight = false;
  let extensionContextInvalidated = false;
  let cachedTabScope = '';
  let cachedTabScopeUrlKey = '';
  let currentRuntimeMode = 'gm';
  let viewerModeLocked = false;
  let gmLifecycleListenersStarted = false;
  const viewerState = { broadcast: null, lastSeenAt: 0 };
  const knownViewerWhisperTargets = new Map();
  const lastViewerRequestRespondedAtByTarget = new Map();

  const liveMetricsState = {
    messageKeys: new Set(),
    messages: [],
    participants: new Map(),
    recentEvents: [],
    totals: createEmptyLiveMetricTotals(),
  };
  let lastResolvedChatSpeaker = '';
  let currentMappingProfile = null;

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

  function isRoll20TablePage() {
    return /^\/editor(?:\/|$)/i.test(window.location.pathname || '');
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function normalizeStorageScopePart(value) {
    return normalizeMappingKey(value).slice(0, 80);
  }

  function getRoll20TableStorageScope() {
    return getRoll20TableStorageScopes()[0] || '';
  }
  function getRoll20DurableStorageScope() {
    return getRoll20DurableStorageScopes()[0] || '';
  }

  function getTabScope() {
    const urlKey = `${window.location.pathname || ''}${window.location.search || ''}`;
    if (cachedTabScope && cachedTabScopeUrlKey === urlKey) return cachedTabScope;
    const generated = normalizeStorageScopePart(`tab_${randomHex(8)}`)
      || normalizeStorageScopePart(`tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    if (generated) {
      cachedTabScope = generated;
      cachedTabScopeUrlKey = urlKey;
    }
    return cachedTabScope;
  }

  function getRoll20TableStorageScopes() {
    const scopes = [];
    const gameId = normalizeText(getRoll20GameId()).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    if (gameId) scopes.push(`game:${gameId}`);
    const gameTitle = getRoll20GameTitle();
    const titleKey = normalizeStorageScopePart(gameTitle);
    if (titleKey && titleKey !== 'roll20' && !isPlaceholderGameTitle(gameTitle)) scopes.push(`title:${titleKey}`);
    const tabScope = getTabScope();
    if (tabScope) scopes.push(`tab:${tabScope}`);
    return Array.from(new Set(scopes));
  }
  function getRoll20DurableStorageScopes() {
    const scopes = [];
    const gameId = normalizeText(getRoll20GameId()).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    if (gameId) scopes.push(`game:${gameId}`);
    const gameTitle = getRoll20GameTitle();
    const titleKey = normalizeStorageScopePart(gameTitle);
    if (titleKey && titleKey !== 'roll20' && !isPlaceholderGameTitle(gameTitle)) scopes.push(`title:${titleKey}`);
    return Array.from(new Set(scopes));
  }

  function getScopedStorageKey(baseKey) {
    const scope = getRoll20TableStorageScope();
    return scope ? `${baseKey}:${scope}` : baseKey;
  }

  function getScopedStorageKeys(baseKey) {
    const scopes = getRoll20TableStorageScopes();
    return scopes.length ? scopes.map((scope) => `${baseKey}:${scope}`) : [baseKey];
  }

  function getScopedStorageKeysStrict(baseKey) {
    const scopes = getRoll20TableStorageScopes();
    return scopes.map((scope) => `${baseKey}:${scope}`);
  }

  function getConnectionStorageKeyForConnection(connection) {
    const scope = normalizeText(connection?.roll20_scope_key);
    if (scope.startsWith('tab:')) return getConnectionStorageKey();
    if (scope) return `${CONNECTION_KEY}:${scope}`;
    return getConnectionStorageKey();
  }

  function getConnectionStorageKey() {
    const scope = getRoll20DurableStorageScope();
    return scope ? `${CONNECTION_KEY}:${scope}` : '';
  }

  function getPendingPairingStorageKey() {
    return getScopedStorageKey(PENDING_PAIRING_KEY);
  }

  function getLastSentStorageKey() {
    return getScopedStorageKey(LAST_SENT_KEY);
  }

  function getMappingProfileStorageKey() {
    return getScopedStorageKey(MAPPING_PROFILE_KEY);
  }

  function enrichConnectionWithCurrentTableScope(connection) {
    if (!connection) return connection;
    const existingScope = normalizeText(connection.roll20_scope_key);
    const durableScope = getRoll20DurableStorageScope();
    return {
      ...connection,
      roll20_game_id: connection.roll20_game_id || getRoll20GameId(),
      roll20_game_title: connection.roll20_game_title || getRoll20GameTitle(),
      roll20_scope_key: existingScope && !existingScope.startsWith('tab:')
        ? existingScope
        : (durableScope || ''),
    };
  }

  function connectionMatchesCurrentTable(connection) {
    if (!connection) return true;
    const currentScopes = getRoll20DurableStorageScopes();
    const connectionScope = normalizeText(connection.roll20_scope_key);
    if (!currentScopes.length && connectionScope) return false;
    if (connectionScope && currentScopes.includes(connectionScope)) return true;
    const currentGameId = normalizeText(getRoll20GameId());
    const connectionGameId = normalizeText(connection.roll20_game_id || connection.roll20GameId);
    if (currentGameId && connectionGameId) return currentGameId === connectionGameId;
    const currentTitle = normalizeStorageScopePart(getRoll20GameTitle());
    const connectionTitle = normalizeStorageScopePart(connection.roll20_game_title || connection.roll20GameTitle);
    if (!currentTitle || currentTitle === 'roll20') return false;
    return Boolean(currentTitle && connectionTitle && currentTitle === connectionTitle);
  }

  async function getCurrentConnection() {
    const scopedKeys = getRoll20DurableStorageScopes().map((scope) => `${CONNECTION_KEY}:${scope}`);
    if (!scopedKeys.length) return null;
    for (const key of scopedKeys) {
      const connection = await getStorageValue(key);
      if (connectionMatchesCurrentTable(connection)) return connection;
    }
    return null;
  }

  async function getFirstScopedStorageValue(baseKey) {
    const scopedKeys = getScopedStorageKeysStrict(baseKey);
    if (!scopedKeys.length) return null;
    for (const key of scopedKeys) {
      const value = await getStorageValue(key);
      if (value != null) return value;
    }
    return null;
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
    lastResolvedChatSpeaker = '';
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

  function inferAmountAfterKeyword(rawText, keywordPattern) {
    const text = normalizeText(rawText);
    const matches = Array.from(text.matchAll(keywordPattern));
    for (let index = 0; index < matches.length; ++index) {
      const start = matches[index].index ?? 0;
      const end = Math.min(matches[index + 1]?.index ?? text.length, start + 96);
      const windowText = text.slice(start, end);
      const numbers = Array.from(windowText.matchAll(/\b(\d{1,4})\b/g))
        .map((match) => toSafeNumber(match[1]))
        .filter((amount) => amount != null);
      if (numbers.length) return numbers[numbers.length - 1];
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

  function hasRoll20AttackBreakdown(rawText) {
    return /\battack\s+breakdown\b/i.test(normalizeText(rawText));
  }

  function hasRoll20DamageBreakdown(rawText) {
    return /\bdamage\s+breakdown\b/i.test(normalizeText(rawText));
  }

  function inferRoll20BreakdownTotal(rawText, sectionPattern) {
    const text = normalizeText(rawText);
    const section = text.search(sectionPattern);
    if (section < 0) return null;
    const windowText = text.slice(section, section + 260);
    const match = windowText.match(/\btotal\s+(\d{1,4})\b/i);
    return toSafeNumber(match?.[1]);
  }

  function isExplicitDamageText(rawText) {
    const text = normalizeText(rawText);
    if (hasRoll20DamageBreakdown(text)) return true;
    if (hasRoll20AttackBreakdown(text)) return false;
    const damageTypes = 'acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder|acide|contondant|froid|feu|foudre|necrotique|nécrotique|perforant|psychique|tranchant|tonnerre';
    return new RegExp(`\\b(?:critical\\s+damage|crit\\s+damage|damage\\s*(?:plus|:|\\d+d\\d+|${damageTypes})|(?:${damageTypes})\\s+damage|\\d{1,4}\\s*(?:damage|dmg|degats|dégâts))\\b`, 'i').test(text);
  }

  function isLikelyAttackActionText(rawText) {
    const text = normalizeText(rawText);
    return /\b(?:attack|attaque|to\s*hit|toucher|hit\s*roll|jet\s*d\s*attaque|shortbow|longbow|crossbow|bow|longsword|shortsword|greataxe|rapier|dagger|sword|axe|mace)\b/i.test(text);
  }

  function inferRoll20AttackCardTotal(rawText) {
    const text = normalizeText(rawText);
    const breakdownTotal = inferRoll20BreakdownTotal(text, /\battack\s+breakdown\b/i);
    if (breakdownTotal != null && breakdownTotal >= 1 && breakdownTotal <= 60) return breakdownTotal;
    if (isExplicitDamageText(text)) return null;
    const match = text.match(/\bdamage\b\s+(?:(?:vex|nick|sap|slow|topple|cleave|graze|push|flex|hew)\s+)?((?:\d{1,3}\s*){1,2})(?:details?|détails?|\b|$)/i);
    const totals = Array.from(String(match?.[1] || '').matchAll(/\d{1,3}/g))
      .map((item) => toSafeNumber(item[0]))
      .filter((item) => item != null && item >= 1 && item <= 60);
    const total = totals.length ? totals[totals.length - 1] : null;
    return total != null && total >= 1 && total <= 60 ? total : null;
  }

  function inferLiveActionType(rawText, { damageTotal = null, healTotal = null, hasRoll = false, attackCardTotal = null } = {}) {
    const text = normalizeText(rawText);
    const hasSpell = /\b(?:spell|sort|sortilege|cantrip)\b/i.test(text);
    const hasDamage = damageTotal != null || /\b(?:damage|dmg|degats)\b/i.test(text);
    const hasHealing = healTotal != null || /\b(?:heal|healing|soin|soins|soigne)\b/i.test(text);
    const hasInitiative = /\binitiative\b/i.test(text);
    const hasSavingThrow = /\b(?:saving\s*throw|sauvegarde|save|dex\s*save|str\s*save|con\s*save|int\s*save|wis\s*save|cha\s*save|fortitude|reflex|will)\b/i.test(text);
    const hasSkillCheck = /\b(?:skill\s*check|ability\s*check|competence|acrobatics|athletics|arcana|history|investigation|nature|religion|insight|medicine|perception|survival|deception|intimidation|performance|persuasion|stealth|sleight\s*of\s*hand)\b/i.test(text);
    const hasAttackCue = attackCardTotal != null || /\b(?:attack|attaque|to\s*hit|toucher|hit\s*roll|jet\s*d\s*attaque)\b/i.test(text);

    // Certaines cartes Roll20 combinent "attaque" et "degats" dans le meme bloc.
    // Pour le kikimeter, on privilegie le type attaque quand un jet d20 d'attaque est present.
    if (hasAttackCue && hasRoll) return hasSpell ? 'spell_attack' : 'attack';
    if (hasDamage) return hasSpell ? 'spell_damage' : 'damage';
    if (hasHealing) return 'healing';
    if (hasInitiative) return 'initiative';
    if (hasSavingThrow) return 'saving_throw';
    if (hasSkillCheck) return 'skill_check';
    if (hasAttackCue) return hasSpell ? 'spell_attack' : 'attack';
    if (hasRoll) return 'roll';
    return hasSpell ? 'spell' : 'message';
  }

  function inferStandaloneRollTotal(rawText, actionType) {
    if (!LIVE_ROLL_EVENT_TYPES.has(actionType) && actionType !== 'roll') return null;
    const numbers = Array.from(String(rawText || '').matchAll(/\b(\d{1,3})\b/g))
      .map((match) => Number(match[1]))
      .filter((number) => number >= 1 && number <= 60);
    return numbers.length ? numbers[numbers.length - 1] : null;
  }

  function inferActionNameHint(rawText, actionType) {
    const text = normalizeText(rawText);
    const patterns = [
      ['Shortbow', /\bshortbow\b/i],
      ['Longbow', /\blongbow\b/i],
      ['Crossbow', /\bcrossbow\b/i],
      ['Longsword', /\blongsword\b/i],
      ['Shortsword', /\bshortsword\b/i],
      ['Greataxe', /\bgreataxe\b/i],
      ['Shield Bash', /\bshield\s*bash\b/i],
      ['Rapier', /\brapier\b/i],
      ['Dagger', /\bdagger\b/i],
      ['Sword', /\bsword\b/i],
      ['Axe', /\baxe\b/i],
      ['Mace', /\bmace\b/i],
      ['Initiative', /\binitiative\b/i],
      ['Perception', /\bperception\b/i],
      ['Stealth', /\bstealth\b/i],
      ['Dex Save', /\b(?:dex\s*save|dexterity\s*save)\b/i],
      ['Con Save', /\b(?:con\s*save|constitution\s*save)\b/i],
      ['Wis Save', /\b(?:wis\s*save|wisdom\s*save)\b/i],
    ];
    const match = patterns.find(([, pattern]) => pattern.test(text));
    if (match) return match[0];
    if (actionType === 'attack' || actionType === 'spell_attack') return 'Attack';
    if (actionType === 'damage' || actionType === 'spell_damage') return 'Damage';
    if (actionType === 'healing') return 'Healing';
    return '';
  }

  function inferSubTypeHint(rawText, actionType) {
    const text = normalizeText(rawText);
    if (actionType === 'attack') {
      if (/\b(?:shortbow|longbow|crossbow|bow|ranged|distance)\b/i.test(text)) return 'ranged';
      if (/\b(?:dagger|rapier|sword|axe|mace|greataxe|longsword|shortsword|melee|contact)\b/i.test(text)) return 'melee';
    }
    if (actionType === 'saving_throw') {
      const match = text.match(/\b(dexterity|strength|constitution|intelligence|wisdom|charisma|fortitude|reflex|will|dex|str|con|int|wis|cha)\b/i);
      return match ? match[1].toLowerCase() : '';
    }
    return '';
  }

  function inferSkillNameHint(rawText, actionType) {
    if (actionType !== 'skill_check') return '';
    const text = normalizeText(rawText);
    const match = text.match(/\b(acrobatics|athletics|arcana|history|investigation|nature|religion|insight|medicine|perception|survival|deception|intimidation|performance|persuasion|stealth|sleight\s*of\s*hand)\b/i);
    return match ? normalizeText(match[1]) : '';
  }

  function inferStackedRoll20AttackDamage(rawText) {
    const damageTypes = /^(?:acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder|acide|contondant|froid|feu|foudre|necrotique|nécrotique|perforant|psychique|tranchant|tonnerre)$/i;
    const lines = String(rawText || '')
      .split(/\r?\n/)
      .map((line) => normalizeText(line))
      .filter(Boolean);
    if (lines.length < 4) return null;
    const actionIndex = lines.findIndex((line, index) => (
      index > 0
      && /[a-zÀ-ÿ]/i.test(line)
      && /\([+-]\s*\d+\)/.test(line)
    ));
    if (actionIndex < 1) return null;
    const damageTypeIndex = lines.findIndex((line, index) => index > actionIndex && damageTypes.test(line));
    if (damageTypeIndex < 0) return null;
    const damageValues = lines
      .slice(actionIndex + 1, damageTypeIndex)
      .map((line) => (/^\d+$/.test(line) ? Number(line) : null))
      .filter((value) => Number.isFinite(value));
    if (!damageValues.length) return null;
    return {
      actionName: lines[actionIndex].replace(/\s*\([+-]\s*\d+\)\s*$/g, ''),
      damageTotal: damageValues.reduce((sum, value) => sum + value, 0),
    };
  }

  function parseVisualRollColor(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!text) return null;
    if (text === 'white') return { red: 255, green: 255, blue: 255 };
    const rgb = text.match(/rgba?\s*\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgb) return { red: Number(rgb[1]), green: Number(rgb[2]), blue: Number(rgb[3]) };
    const hex = text.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/i);
    if (!hex) return null;
    const valueText = hex[1].length === 3
      ? hex[1].split('').map((part) => `${part}${part}`).join('')
      : hex[1];
    return {
      red: Number.parseInt(valueText.slice(0, 2), 16),
      green: Number.parseInt(valueText.slice(2, 4), 16),
      blue: Number.parseInt(valueText.slice(4, 6), 16),
    };
  }

  function parseStackedRollElementTotal(element) {
    const text = normalizeText(element?.textContent || '').replace(/\s+/g, ' ');
    const match = text.match(/^(\d{1,3})(?:\s*[+-]\s*\d{1,2})?$/);
    if (!match) return null;
    const total = toSafeNumber(match[1]);
    return total != null && total >= 1 && total <= 60 ? total : null;
  }

  function hasRoll20ClassTokenInAncestry(element, root, tokenPattern) {
    let current = element;
    while (current) {
      const classTokens = String(current.className || '').toLowerCase().split(/\s+/).filter(Boolean);
      if (classTokens.some((token) => tokenPattern.test(token))) return true;
      if (current === root) break;
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function isRoll20EffectRollElement(element, root) {
    return hasRoll20ClassTokenInAncestry(
      element,
      root,
      /^(?:sheet-damagetemplate|sheet-rolltemplate-dmg|sheet-damage|damage|dmg|healing|heal)$/,
    );
  }

  function getVisualRollTone(element) {
    if (!element) return null;
    const className = String(element.className || '').toLowerCase();
    if (/\b(?:discarded?|ignored?|inactive|muted|dim|grey|gray|secondary)\b/.test(className)) return 'muted';
    if (/\b(?:selected|retained|kept|active|white|foreground)\b/.test(className)) return 'selected';
    const style = typeof window !== 'undefined' && window.getComputedStyle ? window.getComputedStyle(element) : null;
    const opacity = Number(style?.opacity);
    if (Number.isFinite(opacity) && opacity > 0 && opacity <= 0.75) return 'muted';
    const color = parseVisualRollColor(style?.color || element.getAttribute?.('color') || '');
    if (!color) return null;
    const max = Math.max(color.red, color.green, color.blue);
    const min = Math.min(color.red, color.green, color.blue);
    const average = (color.red + color.green + color.blue) / 3;
    if (max - min > 45) return null;
    if (average >= 215) return 'selected';
    if (average <= 190) return 'muted';
    return null;
  }

  function inferVisualRollSelection(node) {
    if (!node || typeof node.querySelectorAll !== 'function') return null;
    const selectors = '.inlinerollresult, [class*="roll"], [class*="Roll"], [class*="ROLL"]';
    const candidates = [];
    if (typeof node.matches === 'function' && node.matches(selectors)) candidates.push(node);
    candidates.push(...Array.from(node.querySelectorAll(selectors)));

    const entries = candidates
      .map((element) => ({ element, total: parseStackedRollElementTotal(element), tone: getVisualRollTone(element) }))
      .filter((entry) => entry.total != null)
      .filter((entry) => !isRoll20EffectRollElement(entry.element, node))
      .filter((entry, index, all) => !all.some((other, otherIndex) => (
        otherIndex !== index
        && other.element !== entry.element
        && entry.element.contains(other.element)
        && other.total === entry.total
      )))
      .slice(0, 2);
    if (entries.length < 2) return null;

    const selectedIndexes = entries
      .map((entry, index) => (entry.tone === 'selected' ? index : null))
      .filter((index) => index != null);
    let selectedIndex = selectedIndexes.length === 1 ? selectedIndexes[0] : null;
    if (selectedIndex == null) {
      const mutedIndexes = entries
        .map((entry, index) => (entry.tone === 'muted' ? index : null))
        .filter((index) => index != null);
      if (mutedIndexes.length === 1) selectedIndex = mutedIndexes[0] === 0 ? 1 : 0;
    }
    if (selectedIndex == null) return null;

    const selectedTotal = entries[selectedIndex].total;
    const discardedTotal = entries.find((_, index) => index !== selectedIndex)?.total;
    const rollMode = selectedTotal > discardedTotal
      ? 'advantage'
      : selectedTotal < discardedTotal
        ? 'disadvantage'
        : '';
    return {
      selectedTotal,
      selectedIndex,
      rollMode,
      rollTotals: entries.map((entry) => entry.total),
    };
  }

  function extractRollFigures(rawText, node = null) {
    const text = normalizeText(rawText);
    const visualRoll = inferVisualRollSelection(node);
    const rollMode = /\b(?:disadvantage|disadv|desavantage|désavantage)\b/i.test(text)
      ? 'disadvantage'
      : /\b(?:advantage|adv|avantage)\b/i.test(text)
        ? 'advantage'
        : visualRoll?.rollMode || '';
    const rollNatural = inferRollNatural(text);
    const totalMatch = text.match(/\b(?:total|result|resultat)\D{0,12}(\d{1,3})\b/i);
    const attackCardTotal = inferRoll20AttackCardTotal(text);
    const stackedAttackDamage = inferStackedRoll20AttackDamage(rawText);
    const damageTotal = attackCardTotal == null
      ? stackedAttackDamage?.damageTotal
        ?? inferAmountAfterKeyword(text, /\b(?:critical\s+damage|crit\s+damage|damage|dmg|degats)(?![a-z])/gi)
        ?? inferAmountFromText(text, [
          /\b(?:damage|dmg|degats)\D{0,24}(\d{1,4})\b/i,
          /\b(\d{1,4})\s*(?:damage|dmg|degats)\b/i,
        ])
      : null;
    const healTotal = inferAmountAfterKeyword(text, /\b(?:heal|healing|soin|soins|soigne)(?![a-z])/gi)
      ?? inferAmountFromText(text, [
        /\b(?:heal|healing|soin|soins|soigne)\D{0,24}(\d{1,4})\b/i,
        /\b(\d{1,4})\s*(?:heal|healing|soin|soins)\b/i,
      ]);
    const explicitRollTotal = toSafeNumber(totalMatch?.[1]);
    const hasRoll = /\b(?:d20|1d20|jet|roll|resultat|total)\b/i.test(text) || rollNatural != null || explicitRollTotal != null || attackCardTotal != null || visualRoll?.selectedTotal != null;
    const attackCueTotal = attackCardTotal ?? (stackedAttackDamage && visualRoll?.selectedTotal != null ? visualRoll.selectedTotal : null);
    const actionType = inferLiveActionType(text, { damageTotal, healTotal, hasRoll, attackCardTotal: attackCueTotal });
    let rollTotal = visualRoll?.selectedTotal ?? explicitRollTotal ?? attackCardTotal ?? inferStandaloneRollTotal(text, actionType);
    if (rollMode && explicitRollTotal == null && attackCardTotal == null && damageTotal == null && healTotal == null) {
      const numbers = Array.from(text.matchAll(/\b(\d{1,3})\b/g))
        .map((match) => toSafeNumber(match[1]))
        .filter((value) => value != null && value >= 1 && value <= 40);
      if (numbers.length >= 2) {
        rollTotal = rollMode === 'advantage' ? Math.max(...numbers.slice(0, 2)) : Math.min(...numbers.slice(0, 2));
      }
    }
    return {
      actionType,
      rollNatural,
      rollTotal,
      rollMode,
      rollTotals: visualRoll?.rollTotals || [],
      selectedRollIndex: visualRoll?.selectedIndex ?? null,
      damageTotal,
      healTotal,
      actionName: stackedAttackDamage?.actionName || inferActionNameHint(text, actionType),
      subType: inferSubTypeHint(text, actionType),
      skillName: inferSkillNameHint(text, actionType),
      isCritical: rollNatural === 20 || /\b(?:critical|critique|crit\s+(?:damage|dmg|degats|hit|touche))\b/i.test(text),
      isFumble: rollNatural === 1 || /\b(?:fumble|echec\s+critique|critical\s+fail)\b/i.test(text),
      hasRoll,
    };
  }

  function buildRollPayloadForSnapshot(figures, { rollTotal = null, rollNatural = null } = {}) {
    const rollTotals = Array.isArray(figures?.rollTotals)
      ? figures.rollTotals.filter((value) => Number.isFinite(Number(value))).map(Number)
      : [];
    const rollMode = normalizeText(figures?.rollMode);
    const selectedRollIndex = figures?.selectedRollIndex;
    const hasSelectedIndex = Number.isInteger(selectedRollIndex) && selectedRollIndex >= 0;
    const hasRollData = rollTotal != null
      || rollNatural != null
      || rollMode
      || rollTotals.length
      || hasSelectedIndex;
    if (!hasRollData) return null;

    return {
      ...(rollTotal != null ? {
        selected_total: rollTotal,
        roll_total: rollTotal,
      } : {}),
      ...(rollNatural != null ? {
        selected_natural: rollNatural,
        roll_natural: rollNatural,
      } : {}),
      ...(rollMode ? { roll_mode: rollMode } : {}),
      ...(rollTotals.length ? {
        roll_totals: rollTotals,
        totals: rollTotals,
      } : {}),
      ...(hasSelectedIndex ? { selected_index: selectedRollIndex } : {}),
      roll20: {
        source: rollTotals.length > 1 ? 'roll20_extension_visual_pair' : 'roll20_extension_snapshot',
        ...(rollMode ? { roll_mode: rollMode } : {}),
        ...(rollTotals.length ? { roll_totals: rollTotals } : {}),
        ...(hasSelectedIndex ? { selected_index: selectedRollIndex } : {}),
        ...(rollTotal != null ? { selected_total: rollTotal } : {}),
      },
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

  function normalizeSpeakerLabel(value) {
    return normalizeText(value).replace(/\s*:\s*$/g, '');
  }

  function isRoll20SpeakerCandidate(value) {
    const label = normalizeSpeakerLabel(value);
    if (!label || label.length < 2 || label.length > 64) return false;
    if (/^[+\-]?\d+(?:[.,]\d+)?$/.test(label)) return false;
    if (/\b(?:d\d+|\d+d\d+|roll|rolling|jet|total|result|resultat|damage|dmg|degats|heal|healing|soin|soins|details?|advantage|disadvantage|normal|vex|attack|attaque|shortbow|longbow|crossbow|dagger|rapier|sword|axe|mace|spell|sort|initiative|saving|save|skill)\b/i.test(label)) return false;
    return true;
  }

  function getTextSegments(node) {
    return String(node?.innerText || node?.textContent || '')
      .split(/\n+/)
      .map(normalizeSpeakerLabel)
      .filter(Boolean);
  }

  function getNodeReadableText(node) {
    const visibleText = normalizeText(node?.innerText);
    const domText = normalizeText(node?.textContent);
    if (visibleText && domText && visibleText !== domText) return `${visibleText} ${domText}`;
    return visibleText || domText;
  }

  function isGmSpeakerLabel(value) {
    return /\b(?:gm|mj|game\s*master|maitre\s*du\s*jeu|maître\s*du\s*jeu|dungeon\s*master|dm)\b/i.test(normalizeSpeakerLabel(value));
  }

  function findCurrentRoll20PlayerNode() {
    return document.querySelector(
      '.player.me, .player[data-current="true"], .player[data-is-self="true"], .player[data-mine="true"], .player[data-is_self="true"]'
    );
  }

  function getOwnSpeakingAsLabel() {
    // Le dropdown "En tant que" / "Speaking as" expose toujours une option
    // value="player|<monUserId>" text="<mon nom>". Roll20 suffixe ce texte par
    // "(GM)" (ou "(MJ)" en FR) si le user connecte est le MJ. C'est le signal
    // le plus stable pour distinguer MJ et joueur sans dependre du chat ni des
    // tuiles video (dont le textContent inclut le label "Rejoindre le chat audio
    // et video" qui pollue la lecture).
    const options = document.querySelectorAll('#speakingas option');
    for (const opt of options) {
      if (String(opt.value || '').startsWith('player|')) {
        return normalizeText(opt.textContent);
      }
    }
    return '';
  }

  function normalizeRoll20PlayerLabel(value) {
    return normalizeText(value).replace(/\s*\((?:gm|mj)\)\s*$/i, '').trim();
  }

  function getCurrentRoll20PlayerLabel() {
    const speakingAs = normalizeRoll20PlayerLabel(getOwnSpeakingAsLabel());
    if (speakingAs) return speakingAs;
    const meNode = findCurrentRoll20PlayerNode();
    const ownName = normalizeRoll20PlayerLabel(
      meNode?.querySelector?.('.player-name')?.textContent
        || meNode?.querySelector?.('.display-name')?.textContent
        || meNode?.textContent
        || ''
    );
    if (ownName && ownName.length < 80) return ownName;
    return '';
  }

  function normalizeViewerWhisperTarget(value) {
    const label = normalizeRoll20PlayerLabel(value)
      .replace(/[<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!label || label.length > 80) return '';
    if (label.includes(VIEWER_BROADCAST_MARKER) || label.includes(BRIDGE_SNAPSHOT_MARKER)) return '';
    return label;
  }

  function normalizeViewerRequesterLabel(value) {
    const label = normalizeViewerWhisperTarget(value)
      .replace(/^\(?\s*(?:from|de)\s+/i, '')
      .replace(/\s+\(?\s*(?:to|pour|a|à)\s+(?:gm|mj|dm|md)\s*\)?$/i, '')
      .replace(/\s*\)\s*$/g, '')
      .trim();
    if (!label || isGmSpeakerLabel(label) || /^(?:gm|mj|dm|md)$/i.test(label)) return '';
    return normalizeViewerWhisperTarget(label);
  }

  function rememberViewerWhisperTarget(value) {
    const label = normalizeViewerRequesterLabel(value);
    if (!label) return '';
    knownViewerWhisperTargets.set(label.toLowerCase(), label);
    return label;
  }

  function getKnownViewerWhisperTargets() {
    return Array.from(knownViewerWhisperTargets.values());
  }

  function buildRoll20WhisperCommand(targetLabel, message) {
    const target = normalizeViewerWhisperTarget(targetLabel);
    const body = normalizeText(message);
    if (!target || !body) return '';
    if (/^gm$/i.test(target)) return `/w gm ${body}`;
    return `/w "${target.replace(/"/g, '')}" ${body}`;
  }

  function isCurrentUserRoll20Gm() {
    return getCurrentRoll20ModeInfo().mode === 'gm';
  }

  function getCurrentRoll20ModeInfo() {
    // 1. Marker legacy si Roll20 le re-expose un jour.
    const meLegacy = findCurrentRoll20PlayerNode();
    if (meLegacy?.matches?.('[data-is_gm="true"]')) return { mode: 'gm', confidence: 'strong', source: 'player-marker' };
    if (meLegacy?.matches?.('[data-is_gm="false"]')) return { mode: 'viewer', confidence: 'strong', source: 'player-marker' };

    // 2. Signal principal : nom du user dans le dropdown speakingas, suffixe (GM)/(MJ) si MJ.
    const mySpeakingAsLabel = getOwnSpeakingAsLabel();
    if (mySpeakingAsLabel) {
      return /\((?:gm|mj)\)/i.test(mySpeakingAsLabel)
        ? { mode: 'gm', confidence: 'strong', source: 'speakingas' }
        : { mode: 'viewer', confidence: 'strong', source: 'speakingas' };
    }

    // 3. Fallback : presence d'outils MJ exclusifs (decks).
    if (document.querySelector('#deck-toolbox, #decks, [data-tab="decks"]')) return { mode: 'gm', confidence: 'weak', source: 'gm-tools' };

    // 4. Aucune piste : on garde le comportement historique MJ par defaut
    // pour ne jamais retirer le panneau complet a un MJ legitime sur DOM atypique.
    return { mode: 'gm', confidence: 'fallback', source: 'default' };
  }

  function getCurrentRoll20Mode() {
    return getCurrentRoll20ModeInfo().mode;
  }

  function getCurrentGmName() {
    // .player-name reste stable meme quand le MJ "parle en tant que" un PNJ ;
    // .display-name suit l'impersonification et ne peut pas servir de nom canonique.
    const gmAccountNode = document.querySelector('.player[data-is_gm="true"] .player-name');
    const accountName = gmAccountNode ? normalizeText(gmAccountNode.textContent) : '';
    if (accountName && accountName.length > 1 && accountName.length < 40) return accountName;
    const userNode = document.querySelector('#user-menu .user-name, .user-menu .user-name');
    const name = userNode ? normalizeText(userNode.textContent) : '';
    if (name && name.length > 1 && name.length < 40) return name;
    const gmNode = document.querySelector('.player[data-is_gm="true"] .display-name');
    const gmName = gmNode ? normalizeText(gmNode.textContent) : '';
    if (gmName && gmName.length > 1 && gmName.length < 40) return gmName;
    return 'GM';
  }

  function isNpcOrMonsterSpeakerLabel(speaker) {
    const s = normalizeText(speaker).toLowerCase();
    if (!s || isGmSpeakerLabel(s) || /to gm/i.test(s)) return false;
    if (s === 'roll20' || s === 'system' || s === 'api') return false;
    if (/npc|monstre|monster|ennemi|enemy|creature|bestiol|hostile/.test(s)) return true;
    if (/gobelin|orc|dragon|zombie|squelette|bandit|cultiste|rat|chien|wolf|golem|demon|sorciere|witch|beholder|troll|ogre|vampire|lich|spectre|wraith|slime|gelee|blob|elemental|geant|giant|spider|araignee|kobold|gnoll|worg|wight|mimic|basilic|chimere|hydre|hydra|griffon|griffin|wyverne|wyvern|harpie|harpy|goule|ghoul|sahuagin|aboleth|myconide|myconid|drow|elfe noir|hobgobelin|hobgoblin|gnome|nain|dwarf|elfe|elf|humain|human|tarrasque|rakshasa|rakshaza/.test(s)) return true;
    return false;
  }

  function isSpeakerRoutedToGm(value) {
    const label = normalizeSpeakerLabel(value).toLowerCase();
    if (!label) return false;
    if (isGmSpeakerLabel(label) || /to\s*gm/i.test(label)) return true;
    const gmName = normalizeSpeakerLabel(getCurrentGmName()).toLowerCase();
    return Boolean(gmName && label === gmName);
  }

  function getVisibleHumanSpeakerLabels() {
    const labels = new Set();
    // Pour les joueurs (non-MJ), on accepte player-name ET display-name (le display peut etre le nom du PJ).
    document.querySelectorAll('.player:not([data-is_gm="true"]) .player-name, .player:not([data-is_gm="true"]) .display-name').forEach((node) => {
      const label = normalizeSpeakerLabel(node?.textContent).toLowerCase();
      if (label && !isGmSpeakerLabel(label)) labels.add(label);
    });
    // Pour le MJ, on n'accepte que player-name : .display-name suit l'impersonification et polluerait le set.
    document.querySelectorAll('.player[data-is_gm="true"] .player-name').forEach((node) => {
      const label = normalizeSpeakerLabel(node?.textContent).toLowerCase();
      if (label) labels.add(label);
    });
    const gmName = normalizeSpeakerLabel(getCurrentGmName()).toLowerCase();
    if (gmName) labels.add(gmName);
    return labels;
  }

  function isKnownHumanSpeakerLabel(value) {
    const label = normalizeSpeakerLabel(value).toLowerCase();
    if (!label) return false;
    return getVisibleHumanSpeakerLabels().has(label);
  }

  function getProfileSpeakerRole(profile, speaker) {
    const speakerKey = normalizeMappingKey(speaker);
    if (!speakerKey || !profile?.speaker_roles) return null;
    return (Array.isArray(profile.speaker_roles) ? profile.speaker_roles : []).find((entry) => {
      const entryKey = normalizeMappingKey(entry?.speaker_key || entry?.source_key || entry?.speaker_label);
      return entryKey && entryKey === speakerKey;
    }) || null;
  }

  function shouldRouteSpeakerToGm(profile, speaker) {
    const role = getProfileSpeakerRole(profile, speaker);
    if (!role) return false;
    return role.role === 'npc' || role.force_gm === true;
  }

  function shouldKeepSpeakerAsHuman(profile, speaker) {
    const label = normalizeSpeakerLabel(speaker);
    if (!label || isSpeakerRoutedToGm(label)) return false;
    const role = getProfileSpeakerRole(profile, label);
    return role?.role === 'human' || isKnownHumanSpeakerLabel(label);
  }

  function routeDetectedSpeaker(profile, speaker) {
    const label = normalizeSpeakerLabel(speaker);
    if (!label || isGmSpeakerLabel(label) || /to\s*gm/i.test(label)) return getCurrentGmName();
    if (shouldKeepSpeakerAsHuman(profile, label)) return label;
    if (shouldRouteSpeakerToGm(profile, label) || isNpcOrMonsterSpeakerLabel(label)) return getCurrentGmName();
    return getCurrentGmName();
  }

  function getChatSender(node) {
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
      const value = normalizeSpeakerLabel(match?.getAttribute?.('data-speaker') || match?.getAttribute?.('data-sender') || match?.textContent);
      if (value && value.length <= 64) return value;
    }
    return '';
  }

  function getRollCardSpeaker(node, rawText) {
    const selectors = [
      '[data-character-name]',
      '[data-actor-name]',
      '[data-roll-character]',
      '.sheet-character-name',
      '.sheet-charname',
      '.rolltemplate-character-name',
      '[class*="character-name" i]',
      '[class*="charname" i]',
      '[class*="actor-name" i]',
      '[class*="rolltemplate" i] [class*="character" i]',
      '[class*="rolltemplate" i] [class*="name" i]',
    ];
    for (const selector of selectors) {
      const match = node.querySelector?.(selector);
      const value = normalizeSpeakerLabel(match?.getAttribute?.('data-character-name')
        || match?.getAttribute?.('data-actor-name')
        || match?.getAttribute?.('data-roll-character')
        || match?.textContent);
      if (isRoll20SpeakerCandidate(value)) return value;
    }

    const segments = getTextSegments(node);
    const firstSegmentSpeaker = getSpeakerFromText(segments[0] || rawText);
    const candidates = firstSegmentSpeaker ? segments.slice(1, 5) : segments.slice(0, 4);
    return candidates.find(isRoll20SpeakerCandidate) || '';
  }

  function getChatSpeaker(node, rawText, mappingProfile = currentMappingProfile) {
    const sender = getChatSender(node);
    const rollCardSpeaker = getRollCardSpeaker(node, rawText);
    // Cas clef: message whisper/to GM.
    // - Si la carte identifie un speaker human cote RollCodex ou joueur Roll20 connecte: garder ce speaker.
    // - Sinon, router vers GM pour fusionner PNJ/monstres et inconnus sur la ligne GM.
    if (isGmSpeakerLabel(sender) || /to\s*gm/i.test(sender || '')) {
      if (rollCardSpeaker && !isGmSpeakerLabel(rollCardSpeaker) && !/to\s*gm/i.test(rollCardSpeaker)) {
        return routeDetectedSpeaker(mappingProfile, rollCardSpeaker);
      }
      return getCurrentGmName();
    }

    if (sender) {
      return routeDetectedSpeaker(mappingProfile, sender);
    }

    if (rollCardSpeaker) {
      return routeDetectedSpeaker(mappingProfile, rollCardSpeaker);
    }

    return normalizeSpeakerLabel(getSpeakerFromText(rawText)) || 'Roll20';
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

  function refreshActivePanel(status = '') {
    if (currentRuntimeMode === 'viewer') return refreshViewerPanel(status);
    return refreshPanel(status);
  }

  async function setKikimeterMetric(metricId) {
    const nextMetricId = normalizeKikimeterMetricId(metricId);
    await setStorageValues({ [KIKIMETER_SETTINGS_KEY]: { metric_id: nextMetricId } });
    refreshActivePanel(nextMetricId ? 'Kikimeter mis a jour' : 'Kikimeter sans mesure');
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
      const rawLeft = Number(settings.manualLeft);
      const rawTop = Number(settings.manualTop);
      const left = Number.isFinite(rawLeft) ? rawLeft : 64;
      const top = Number.isFinite(rawTop) ? rawTop : 76;
      const maxLeft = Math.max(8, (window.innerWidth || 1280) - 120);
      const maxTop = Math.max(8, (window.innerHeight || 720) - 48);
      const safeLeft = Math.min(Math.max(8, Math.round(left)), maxLeft);
      const safeTop = Math.min(Math.max(8, Math.round(top)), maxTop);
      return [`left:${safeLeft}px`, `top:${safeTop}px`];
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
      `width:${collapsed ? '330px' : '560px'}`,
      'max-width:calc(100vw - 92px)',
      `max-height:${collapsed ? 'min(36vh, 210px)' : 'min(52vh, 300px)'}`,
      `padding:${collapsed ? '9px 10px' : '9px'}`,
      'box-sizing:border-box',
      'overflow:auto',
      `border:1px solid ${PANEL_COLORS.border}`,
      'border-radius:8px',
      `background:${collapsed ? PANEL_COLORS.bgCollapsed : PANEL_COLORS.bg}`,
      `color:${PANEL_COLORS.text}`,
      'font:12px/1.4 Arial,sans-serif',
      'letter-spacing:0',
      'text-shadow:none',
      'text-decoration:none',
      'isolation:isolate',
      `box-shadow:${collapsed ? '0 8px 22px rgba(0,0,0,.2)' : '0 12px 34px rgba(0,0,0,.38)'}`,
      collapsed ? 'backdrop-filter:saturate(120%) blur(2px)' : '',
      collapsed ? 'cursor:grab' : '',
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

  function buildConnectionSecret() {
    return `rcx_roll20_${randomHex(32)}`;
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
    const normalized = normalizeText(value).toLowerCase();
    if (!normalized) return true;
    if (/^(roll20|loading|chargement|campagne|campaign)$/.test(normalized)) return true;
    if (/\b(virtual tabletop|online tabletop|play d&d|play dnd|character sheet|lfg)\b/.test(normalized)) return true;
    if (/\bapp\.roll20\.net\b/.test(normalized)) return true;
    return false;
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
        <span style="color:${PANEL_COLORS.muted};flex:0 0 auto">${escapeHtml(row.label)}:</span>
        <span style="color:${PANEL_COLORS.accent};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(row.value)}</span>
      </div>
    `).join('');
  }

  function renderCompactConnectionTarget(connection) {
    const rows = connection ? getConnectionTargetRows(connection) : [];
    if (!rows.length) return escapeHtml('Pret pour jumelage');
    const table = rows.find((row) => row.label === 'Table')?.value;
    const campaign = rows.find((row) => row.label === 'Campagne')?.value;
    return escapeHtml([table, campaign].filter(Boolean).join(' / ') || rows[0].value);
  }

  function panelButtonStyle(variant = 'secondary') {
    const variants = {
      primary: {
        bg: `linear-gradient(180deg,${PANEL_COLORS.accent},#a97832)`,
        color: '#160f0d',
        border: 'rgba(255,255,255,.16)',
      },
      purple: {
        bg: 'linear-gradient(180deg,#6e5587,#4a3a62)',
        color: PANEL_COLORS.text,
        border: 'rgba(255,255,255,.14)',
      },
      green: {
        bg: 'linear-gradient(180deg,#3f7a58,#245f43)',
        color: PANEL_COLORS.text,
        border: 'rgba(255,255,255,.14)',
      },
      brown: {
        bg: 'linear-gradient(180deg,#6d4a32,#4a3326)',
        color: PANEL_COLORS.text,
        border: PANEL_COLORS.borderSoft,
      },
      secondary: {
        bg: `linear-gradient(180deg,${PANEL_COLORS.bgSoft},rgba(255,255,255,.035))`,
        color: PANEL_COLORS.text,
        border: PANEL_COLORS.borderSoft,
      },
    };
    const style = variants[variant] || variants.secondary;
    return [
      'cursor:pointer',
      `background:${style.bg}`,
      `color:${style.color}`,
      `border:1px solid ${style.border}`,
      'border-radius:7px',
      'min-height:22px',
      'padding:2px 7px',
      'font-weight:700',
      'font-size:10px',
      'line-height:1.1',
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.06),0 3px 8px rgba(0,0,0,.14)',
    ].join(';');
  }

  function panelBrandStyle() {
    return [
      'display:block',
      'min-width:0',
      'flex:1 1 auto',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
      `color:${PANEL_COLORS.text}`,
      'background:transparent',
      'border:0',
      'padding:0',
      'margin:0',
      'font:700 12px/1 Arial,sans-serif',
      'letter-spacing:0',
      'text-shadow:none',
      'text-decoration:none',
      '-webkit-text-stroke:0',
      'filter:none',
      'box-shadow:none',
    ].join(';');
  }

  function panelReaderBadgeStyle() {
    return [
      `color:${PANEL_COLORS.muted}`,
      'font:700 9px/1 Arial,sans-serif',
      'padding:2px 5px',
      `border:1px solid ${PANEL_COLORS.borderSoft}`,
      'border-radius:4px',
      'letter-spacing:.04em',
      'text-transform:uppercase',
      'white-space:nowrap',
      'flex:0 0 auto',
    ].join(';');
  }

  function panelStatusBadgeStyle(connection) {
    return [
      `color:${connection ? PANEL_COLORS.ok : PANEL_COLORS.muted}`,
      'font:700 10px/1 Arial,sans-serif',
      'min-width:0',
      'max-width:112px',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'white-space:nowrap',
    ].join(';');
  }

  function compactPanelStatus(status, connection) {
    const text = normalizeText(status);
    if (!connection) return text || 'Non connecte';
    if (!text || /^panneau\b/i.test(text) || /^connecte via extension$/i.test(text)) return 'Connecte';
    if (/kikimeter|profil|mapping/i.test(text)) return 'Synchro';
    return text;
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

  function buildMetricTargetKey(targetKind, targetId) {
    const normalizedId = normalizeText(targetId);
    if (!normalizedId) return '';
    const normalizedKind = normalizeText(targetKind || 'target').toLowerCase() || 'target';
    return `${normalizedKind}:${normalizedId}`;
  }

  function normalizeProfileMetricRankingEntry(entry, index) {
    if (!entry || typeof entry !== 'object') return null;
    const value = toSafeNumber(entry.value);
    const label = normalizeText(entry.label || entry.target_label || entry.name);
    if (value == null || !label) return null;
    const valueLabel = normalizeText(entry.value_label || entry.valueLabel || entry.label_value);
    const targetKind = normalizeText(entry.target_kind || entry.targetKind || entry.type || 'character').toLowerCase();
    const targetId = normalizeText(entry.target_id || entry.targetId || entry.id);
    return {
      key: targetId ? buildMetricTargetKey(targetKind, targetId) : normalizeText(entry.key || `ranking-${index}`),
      label,
      sourceLabel: normalizeText(entry.source_label || entry.sourceLabel || entry.detail || label),
      mapped: true,
      target_kind: targetKind,
      target_id: targetId,
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
      filterSubType: normalizeText(metric?.filter_sub_type).toLowerCase(),
      filterSkillName: normalizeText(metric?.filter_skill_name).toLowerCase(),
      filterActionName: normalizeText(metric?.filter_action_name).toLowerCase(),
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
    if (!connection.mapping_profile_endpoint && !connection.is_viewer) return 'Profil RollCodex non synchronise';
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
    const actionType = normalizeText(message?.event_type_hint || message?.action_type_hint).toLowerCase();
    return message?.roll_total_hint != null
      || message?.roll_natural_hint != null
      || LIVE_ROLL_EVENT_TYPES.has(actionType);
  }

  function messageMatchesMetricFilter(message, metric) {
    const filters = metric.filterEventType || [];
    const actionType = normalizeText(message?.event_type_hint || message?.action_type_hint || 'message').toLowerCase();
    const matchesEventType = !filters.length || filters.some((filter) => {
      if (filter === actionType) return true;
      if (LIVE_DAMAGE_EVENT_TYPES.has(filter)) {
        // Evite qu'une attaque avec bloc "damage" soit comptee aussi en degats.
        // On accepte le fallback par hint seulement pour les lignes non typables.
        return LIVE_DAMAGE_EVENT_TYPES.has(actionType)
          || ((actionType === 'message' || actionType === 'roll') && message?.damage_total_hint != null);
      }
      if (LIVE_HEALING_EVENT_TYPES.has(filter)) {
        return LIVE_HEALING_EVENT_TYPES.has(actionType)
          || ((actionType === 'message' || actionType === 'roll') && message?.heal_total_hint != null);
      }
      if (filter === 'roll') return isRollLikeMessage(message);
      return false;
    });
    if (!matchesEventType) return false;

    const metricSubType = normalizeText(metric.filterSubType).toLowerCase();
    if (metricSubType) {
      const messageSubType = normalizeText(message?.sub_type_hint).toLowerCase();
      if (messageSubType !== metricSubType) return false;
    }

    const metricSkillName = normalizeText(metric.filterSkillName).toLowerCase();
    if (metricSkillName) {
      const messageSkillName = normalizeText(message?.skill_name_hint).toLowerCase();
      if (messageSkillName !== metricSkillName) return false;
    }

    const metricActionName = normalizeText(metric.filterActionName).toLowerCase();
    if (metricActionName) {
      const actionName = normalizeText(message?.action_name_hint).toLowerCase();
      if (!actionName || !actionName.includes(metricActionName)) return false;
    }

    return true;
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

  function getSpeakerLookupKeys(speaker) {
    const normalized = normalizeSpeakerLabel(speaker);
    const withoutGmSuffix = normalized.replace(/\s*\((?:gm|mj)\)\s*$/i, '');
    return Array.from(new Set([normalized, withoutGmSuffix].map(normalizeMappingKey).filter(Boolean)));
  }

  function resolveSpeakerMapping(profile, speaker) {
    const sourceKeys = new Set(getSpeakerLookupKeys(speaker));
    const mappings = Array.isArray(profile?.mappings) ? profile.mappings : [];
    return mappings.find((mapping) => {
      if (mapping?.source_kind !== 'speaker') return false;
      return sourceKeys.has(normalizeMappingKey(mapping.source_key || mapping.source_label))
        || sourceKeys.has(normalizeMappingKey(mapping.target_label));
    }) || null;
  }

  function resolveSpeakerMappingFromText(profile, rawText) {
    const textKey = normalizeMappingKey(String(rawText || '').slice(0, 180));
    if (!textKey) return null;
    const mappings = Array.isArray(profile?.mappings) ? profile.mappings : [];
    const candidates = mappings
      .filter((mapping) => mapping?.source_kind === 'speaker')
      .flatMap((mapping) => [mapping.source_label, mapping.target_label]
        .map((label) => ({ mapping, labelKey: normalizeMappingKey(label) }))
        .filter((candidate) => candidate.labelKey && candidate.labelKey.length >= 3)
        .map((candidate) => ({
          ...candidate,
          index: textKey.indexOf(candidate.labelKey),
          isCharacter: normalizeText(mapping.target_kind).toLowerCase() === 'character',
        })))
      .filter((candidate) => candidate.index >= 0 && candidate.index <= 90)
      .sort((left, right) => left.index - right.index
        || Number(right.isCharacter) - Number(left.isCharacter)
        || right.labelKey.length - left.labelKey.length);
    return candidates[0]?.mapping || null;
  }

  function normalizeScopedPatternKey(value) {
    return normalizeText(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function getScopedPatternScopeRank(scopeKey) {
    const key = normalizeText(scopeKey).toLowerCase();
    if (key.startsWith('character:')) return 0;
    if (key.startsWith('player:')) return 1;
    if (key.startsWith('table:')) return 2;
    if (key.startsWith('campaign:')) return 3;
    if (key === 'workspace') return 4;
    return 9;
  }

  function getMessageScopedScopeKeys(profile, message) {
    const scopeKeys = new Set(['workspace']);
    const context = profile?.context && typeof profile.context === 'object' ? profile.context : {};
    const tableId = normalizeText(context.table_id);
    const campaignId = normalizeText(context.campaign_id);
    if (tableId) scopeKeys.add(`table:${tableId}`);
    if (campaignId) scopeKeys.add(`campaign:${campaignId}`);

    const speaker = normalizeSpeakerLabel(message?.speaker);
    const mapping = resolveSpeakerMapping(profile, speaker)
      || (speaker === 'Roll20' ? resolveSpeakerMappingFromText(profile, message?.raw_text) : null);
    const targetKind = normalizeText(mapping?.target_kind).toLowerCase();
    const targetId = normalizeText(mapping?.target_id);
    if (targetId && targetKind === 'character') scopeKeys.add(`character:${targetId}`);
    if (targetId && targetKind === 'player') scopeKeys.add(`player:${targetId}`);
    return scopeKeys;
  }

  function resolveScopedActionEventTypeHint(profile, message) {
    const scopedPatterns = Array.isArray(profile?.scoped_patterns) ? profile.scoped_patterns : [];
    if (!scopedPatterns.length) return null;

    const actionKey = normalizeScopedPatternKey(message?.action_name_hint || message?.action_name);
    const rawKey = normalizeScopedPatternKey(message?.raw_text);
    if (!actionKey && !rawKey) return null;

    const allowedScopes = getMessageScopedScopeKeys(profile, message);
    const candidates = scopedPatterns
      .filter((pattern) => {
        if (pattern?.pattern_kind !== 'action_event_type') return false;
        if (pattern?.target_kind !== 'event_type') return false;
        if (!allowedScopes.has(normalizeText(pattern.scope_key))) return false;
        const reviewState = normalizeText(pattern.review_state || 'accepted').toLowerCase();
        if (reviewState && reviewState !== 'accepted' && reviewState !== 'corrected') return false;
        const patternKey = normalizeScopedPatternKey(pattern.pattern_key || pattern.pattern_label);
        if (!patternKey) return false;
        return (actionKey && patternKey === actionKey)
          || (rawKey && patternKey.length >= 3 && rawKey.includes(patternKey));
      })
      .sort((left, right) => {
        const scopeDelta = getScopedPatternScopeRank(left.scope_key) - getScopedPatternScopeRank(right.scope_key);
        if (scopeDelta !== 0) return scopeDelta;
        return Number(right.confidence || 0) - Number(left.confidence || 0);
      });
    const selected = candidates[0];
    const eventType = normalizeText(selected?.target_value);
    if (!eventType) return null;
    return {
      eventType,
      pattern: {
        scope_key: selected.scope_key || null,
        pattern_key: selected.pattern_key || null,
        target_value: eventType,
        confidence: Number(selected.confidence || 0),
      },
    };
  }

  function getMetricBucket(profile, message) {
    const speaker = normalizeSpeakerLabel(message?.speaker) || 'Roll20';
    // Evite les faux positifs de speaker quand le texte contient des labels d'autres joueurs.
    // Le fallback texte est reserve aux lignes generiques non attribuees.
    const mapping = resolveSpeakerMapping(profile, speaker)
      || (speaker === 'Roll20' ? resolveSpeakerMappingFromText(profile, message?.raw_text) : null);
    const gmName = normalizeSpeakerLabel(getCurrentGmName());
    const gmMapping = gmName ? resolveSpeakerMapping(profile, gmName) : null;
    const forceGmByProfile = shouldRouteSpeakerToGm(profile, speaker);

    // On ne route vers le bucket GM que sur signal positif :
    //   - le profil RollCodex marque le speaker comme 'npc' (PNJ enregistre cote backend)
    //   - le speaker correspond deja au GM (isSpeakerRoutedToGm)
    // Un speaker inconnu (jamais mappe, pas dans le profil) garde son propre bucket : c'est ce qui
    // permet au MJ de jouer "as Aline" sans que ses jets ne soient absorbes par la ligne GM.
    if (forceGmByProfile && (gmMapping?.target_id || gmName)) {
      return {
        key: gmMapping?.target_id
          ? buildMetricTargetKey(normalizeText(gmMapping.target_kind || 'target') || 'target', gmMapping.target_id)
          : `speaker:${normalizeMappingKey(gmName || 'GM')}`,
        label: normalizeText(gmMapping?.target_label) || gmName || 'GM',
        sourceLabel: speaker,
        mapped: true,
      };
    }
    const targetId = normalizeText(mapping?.target_id);
    const targetKind = normalizeText(mapping?.target_kind);
    const label = normalizeText(mapping?.target_label) || speaker;
    return {
      key: targetId ? buildMetricTargetKey(targetKind || 'target', targetId) : `speaker:${normalizeMappingKey(speaker)}`,
      label,
      sourceLabel: speaker,
      mapped: Boolean(targetId),
    };
  }

  function addMetricContribution(bucket, metric, message) {
    const aggregation = metric.aggregation || 'count';
    if (aggregation === 'percent_critical') {
      const hasCritFlag = message.is_critical_hint === true;
      // On accepte les cartes "Crit Damage" (degats uniquement, sans d20) comme preuves de critique.
      if (!isRollLikeMessage(message) && !hasCritFlag) return false;
      bucket.denominator += 1;
      if (hasCritFlag) bucket.numerator += 1;
      return true;
    }
    if (aggregation === 'percent_fumble') {
      const hasFumbleFlag = message.is_fumble_hint === true;
      if (!isRollLikeMessage(message) && !hasFumbleFlag) return false;
      bucket.denominator += 1;
      if (hasFumbleFlag) bucket.numerator += 1;
      return true;
    }
    if (aggregation === 'percent') {
      const value = getMetricFieldValue(message, metric.percentField || metric.field);
      if (value == null) return false;
      bucket.denominator += 1;
      if (compareMetricPercent(value, metric)) bucket.numerator += 1;
      return true;
    }
    if (aggregation === 'avg' || aggregation === 'average' || aggregation === 'mean') {
      const value = getMetricFieldValue(message, metric.field);
      if (value == null) return false;
      bucket.sum += value;
      bucket.count += 1;
      return true;
    }
    if (aggregation === 'sum') {
      const value = getMetricFieldValue(message, metric.field);
      if (value == null) return false;
      bucket.sum += value;
      bucket.count += 1;
      return true;
    }
    bucket.count += 1;
    return true;
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

  function mergeBaselineAndLiveMetric(metric, family, baselineValue, baselineCount, liveStats) {
    const safeBaselineValue = Number(baselineValue) || 0;
    const safeBaselineCount = Number(baselineCount) || 0;
    if (family.isAdditive) {
      const liveValue = bucketValueForMetric(liveStats, metric);
      return {
        value: safeBaselineValue + liveValue,
        delta: liveValue,
        count: safeBaselineCount + (Number(liveStats?.messages) || Number(liveStats?.count) || 0),
      };
    }

    if (family.isAverage) {
      const liveCount = Number(liveStats?.count) || 0;
      if (liveCount <= 0) {
        return { value: safeBaselineValue, delta: 0, count: safeBaselineCount };
      }
      const totalCount = safeBaselineCount + liveCount;
      const value = totalCount > 0
        ? ((safeBaselineValue * safeBaselineCount) + (Number(liveStats?.sum) || 0)) / totalCount
        : bucketValueForMetric(liveStats, metric);
      return { value, delta: value - safeBaselineValue, count: totalCount };
    }

    if (family.isPercent) {
      const liveDenominator = Number(liveStats?.denominator) || 0;
      if (liveDenominator <= 0) {
        return { value: safeBaselineValue, delta: 0, count: safeBaselineCount };
      }
      const totalDenominator = safeBaselineCount + liveDenominator;
      const baselineNumerator = safeBaselineCount > 0 ? (safeBaselineValue / 100) * safeBaselineCount : 0;
      const value = totalDenominator > 0
        ? ((baselineNumerator + (Number(liveStats?.numerator) || 0)) / totalDenominator) * 100
        : bucketValueForMetric(liveStats, metric);
      return { value, delta: value - safeBaselineValue, count: totalDenominator };
    }

    const liveValue = bucketValueForMetric(liveStats, metric);
    return {
      value: safeBaselineValue + liveValue,
      delta: liveValue,
      count: safeBaselineCount + (Number(liveStats?.messages) || Number(liveStats?.count) || 0),
    };
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
      const contributed = addMetricContribution(bucket, metric, message);
      if (!contributed) return;
      bucket.messages += 1;
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

    const baselineValue = Number(baselineResult?.value) || 0;
    const baselineCount = Number(baselineResult?.count) || 0;
    const mergedGlobal = mergeBaselineAndLiveMetric(metric, family, baselineValue, baselineCount, totals);
    const totalDelta = mergedGlobal.delta;
    const mergedValue = mergedGlobal.value;
    const hasDelta = Math.abs(totalDelta) > 0.01 || totals.messages > 0;
    const deltaLabel = Math.abs(totalDelta) > 0.01
      ? `${totalDelta > 0 ? '+' : '-'}${formatMetricValue(Math.abs(totalDelta), metric)}`
      : '';
    const metricResult = baselineResult || hasDelta ? {
      value: mergedValue,
      label: family.isAdditive
        ? formatMetricValue(mergedValue, metric)
        : formatMetricValue(mergedValue, metric),
      count: mergedGlobal.count,
      delta_value: totalDelta,
      delta_label: deltaLabel,
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
        baseline_count: Number(entry.count) || 0,
        baseline_label: entry.value_label || formatMetricValue(Number(entry.value) || 0, metric),
        delta_value: 0,
        delta_messages: 0,
        merged_count: Number(entry.count) || 0,
      });
    });

    for (const [bucketKey, bucket] of buckets.entries()) {
      let entry = merged.get(bucketKey);
      if (!entry) {
        const matched = findBaselineEntryForBucket(Array.from(merged.values()), bucket);
        if (matched) entry = matched;
      }
      if (entry) {
        const mergedEntry = mergeBaselineAndLiveMetric(metric, family, entry.baseline_value, entry.baseline_count, bucket);
        entry.delta_value = mergedEntry.delta;
        entry.delta_messages = bucket.messages;
        entry.merged_count = mergedEntry.count;
      } else {
        const mergedBucket = mergeBaselineAndLiveMetric(metric, family, 0, 0, bucket);
        merged.set(bucketKey, {
          key: bucketKey,
          label: bucket.label,
          sourceLabel: bucket.sourceLabel,
          mapped: bucket.mapped,
          baseline_value: 0,
          baseline_count: 0,
          baseline_label: '',
          delta_value: mergedBucket.value,
          delta_messages: bucket.messages,
          merged_count: mergedBucket.count,
        });
      }
    }

    const leaderboard = Array.from(merged.values()).map((entry) => {
      const finalValue = entry.baseline_value + entry.delta_value;
      const entryHasDelta = Math.abs(entry.delta_value) > 0.01 || entry.delta_messages > 0;
      const entryDeltaLabel = Math.abs(entry.delta_value) > 0.01
        ? `${entry.delta_value > 0 ? '+' : '-'}${formatMetricValue(Math.abs(entry.delta_value), metric)}`
        : '';
      return {
        key: entry.key,
        label: entry.label,
        sourceLabel: entry.sourceLabel,
        mapped: entry.mapped,
        baseline_value: entry.baseline_value,
        value: finalValue,
        value_label: formatMetricValue(finalValue, metric),
        delta_value: entry.delta_value,
        delta_label: entryDeltaLabel,
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

  function renderKikimeterRows(leaderboard, metric, { compact = false, limit = 5 } = {}) {
    const entries = (Array.isArray(leaderboard) ? leaderboard : []).slice(0, limit);
    if (!entries.length) {
      return `<div style="color:${PANEL_COLORS.faint};font-size:${compact ? '10px' : '11px'};text-align:center;padding:${compact ? '3px' : '6px'} 0">Pas de classement disponible</div>`;
    }

    const maxValue = Math.max(...entries.map((entry) => Number(entry.value) || 0), 1);
    const podiumColors = [PANEL_COLORS.accent, '#c7b8a1', '#b87b4b'];
    return entries.map((entry, index) => {
      const value = Number(entry.value) || 0;
      const width = Math.max(compact ? 10 : 8, Math.round((value / maxValue) * 100));
      const title = entry.mapped && entry.sourceLabel !== entry.label ? `${entry.label} (${entry.sourceLabel})` : entry.label;
      const rankColor = podiumColors[index] || '#7a6770';
      const deltaBadge = entry.delta_label
        ? `<span title="Delta session live" style="display:inline-block;padding:0 4px;margin-left:4px;border-radius:6px;background:rgba(120,200,143,.18);color:${PANEL_COLORS.ok};font-weight:700;font-size:${compact ? '9px' : '10px'}">${escapeHtml(entry.delta_label)}</span>`
        : '';
      return `
        <div style="display:grid;grid-template-columns:${compact ? '12px' : '14px'} minmax(0,1fr) auto;align-items:center;gap:${compact ? '4px' : '6px'};min-width:0">
          <span style="color:${rankColor};font-weight:700;font-size:${compact ? '10px' : '11px'};text-align:center">${index + 1}</span>
          <span title="${escapeHtml(title)}" style="position:relative;min-width:0;overflow:hidden;border-radius:3px;background:rgba(255,255,255,.045);height:${compact ? '15px' : '18px'}">
            <span style="display:block;width:${width}%;height:100%;background:linear-gradient(90deg,rgba(199,154,75,.46),rgba(157,58,104,.22));border-radius:3px"></span>
            <span style="position:absolute;inset:0 ${compact ? '4px' : '6px'};display:flex;align-items:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${PANEL_COLORS.text};font-size:${compact ? '10px' : '11px'}">${escapeHtml(entry.label)}</span>
          </span>
          <span style="color:${PANEL_COLORS.accent};font-weight:700;font-size:${compact ? '10px' : '11px'};min-width:${compact ? '24px' : '28px'};text-align:right">${escapeHtml(entry.value_label || value)}${deltaBadge}</span>
        </div>
      `;
    }).join('');
  }

  function renderKikimeter(liveSummary, selectedMetricId) {
    const metrics = Array.isArray(liveSummary.profile_metrics) ? liveSummary.profile_metrics : [];
    const metric = liveSummary.selected_metric || getSelectedProfileMetric(metrics, selectedMetricId);
    const leaderboard = Array.isArray(liveSummary.leaderboard) ? liveSummary.leaderboard : [];
    const profileStatus = liveSummary.metric_status || '';
    const mergedResult = liveSummary.metric_result || metric?.result || null;

    if (!metric) {
      return `
        <div style="margin:0;padding:8px;border:1px solid ${PANEL_COLORS.borderSoft};border-radius:6px;background:rgba(255,255,255,.035)">
          <div style="font-weight:700;color:${PANEL_COLORS.text};margin-bottom:4px">Kikimeter</div>
          <div style="color:${PANEL_COLORS.muted};font-size:11px">${escapeHtml(profileStatus || 'Aucune mesure live disponible')}</div>
        </div>
      `;
    }

    const resultDeltaBadge = mergedResult?.delta_label
      ? `<span style="display:inline-block;padding:1px 6px;border-radius:10px;background:rgba(120,200,143,.18);color:${PANEL_COLORS.ok};font-weight:700;font-size:10px">${escapeHtml(mergedResult.delta_label)}</span>`
      : '';
    const resultTitle = mergedResult?.count != null
      ? ` title="${escapeHtml(`${mergedResult.count} evenement(s) RollCodex utilises pour cette mesure`)}"`
      : '';
    const resultSummary = mergedResult
      ? `
        <span${resultTitle} style="display:inline-flex;align-items:baseline;gap:5px;margin-left:auto;padding:1px 6px;border-left:1px solid ${PANEL_COLORS.borderSoft};background:rgba(255,255,255,.025);border-radius:5px">
          <span style="color:${PANEL_COLORS.muted};font-size:9px;letter-spacing:.04em;text-transform:uppercase">Global</span>
          <b style="color:${PANEL_COLORS.accent};font-size:15px;line-height:1">${escapeHtml(mergedResult.label)}</b>
          ${resultDeltaBadge}
        </span>
      `
      : '';
    const options = metrics.map((item) => {
      return `
        <option value="${escapeHtml(item.id)}" ${item.id === metric.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>
      `;
    }).join('');
    const rows = renderKikimeterRows(leaderboard, metric, { limit: 5 });

    return `
      <div style="margin:0;padding:7px;border:1px solid ${PANEL_COLORS.borderSoft};border-radius:7px;background:rgba(255,255,255,.035)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:5px">
          <span style="font-weight:700;color:${PANEL_COLORS.text};font-size:12px">Kikimeter</span>
          ${resultSummary}
        </div>
        <div style="display:grid;grid-template-columns:minmax(118px,145px) minmax(0,1fr);gap:7px;align-items:start">
          <div style="display:grid;gap:5px;min-width:0">
            <select data-rollcodex-kiki-select title="Mesure active" style="width:100%;min-height:26px;background:${PANEL_COLORS.bgSoft};color:${PANEL_COLORS.text};border:1px solid ${PANEL_COLORS.borderSoft};border-radius:5px;padding:3px 6px;font:11px Arial,sans-serif">${options}</select>
          </div>
          <div style="display:grid;gap:4px;min-width:0">${rows}</div>
        </div>
      </div>
    `;
  }

  function renderCollapsedKikimeter(liveSummary, selectedMetricId) {
    const metrics = Array.isArray(liveSummary.profile_metrics) ? liveSummary.profile_metrics : [];
    const metric = liveSummary.selected_metric || getSelectedProfileMetric(metrics, selectedMetricId);
    if (!metric) {
      return `<div data-rollcodex-collapsed-ranking style="margin-top:6px;color:${PANEL_COLORS.muted};font-size:10px">Aucune mesure active</div>`;
    }
    const leaderboard = Array.isArray(liveSummary.leaderboard) ? liveSummary.leaderboard : [];
    const mergedResult = liveSummary.metric_result || metric.result || null;
    const rows = renderKikimeterRows(leaderboard, metric, { compact: true, limit: 3 });
    return `
      <div data-rollcodex-collapsed-ranking style="display:grid;gap:7px;opacity:.9">
        <div style="display:flex;align-items:baseline;gap:8px;min-width:0">
          <div title="${escapeHtml(metric.label)}" style="color:${PANEL_COLORS.text};font-weight:700;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1">${escapeHtml(metric.label)}</div>
          <div style="color:${PANEL_COLORS.accent};font-weight:800;font-size:18px;line-height:1;text-align:right">${escapeHtml(mergedResult?.label || '-')}</div>
        </div>
        <div style="display:grid;gap:3px;min-width:0">${rows}</div>
      </div>
    `;
  }

  function getRoll20GameTitle() {
    const title = normalizeText(document.querySelector('.campaign-title, [class*="campaign"] h1, h1')?.textContent);
    if (title && !isPlaceholderGameTitle(title)) return title;
    const pageTitle = normalizeText(document.title).replace(/\s*\|\s*Roll20.*$/i, '');
    return pageTitle && !isPlaceholderGameTitle(pageTitle) ? pageTitle : 'Roll20';
  }

  function extractRoll20CampaignIdFromUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const detailsMatch = text.match(/\/campaigns\/details\/(\d{4,})/i);
    if (detailsMatch?.[1]) return detailsMatch[1];
    const editorMatch = text.match(/\/editor\/(\d{4,})/i);
    if (editorMatch?.[1]) return editorMatch[1];
    const queryMatch = text.match(/[?&](?:campaign_id|campaignId|game_id|gameId)=(\d{4,})/i);
    return queryMatch?.[1] || '';
  }

  function getRoll20GameId() {
    const directLocationId = extractRoll20CampaignIdFromUrl(window.location.href);
    if (directLocationId) return directLocationId;

    const referrerId = extractRoll20CampaignIdFromUrl(document.referrer);
    if (referrerId) return referrerId;

    const selectors = [
      '[data-campaign-id]',
      '[data-campaignid]',
      '[data-campaign_id]',
      '[data-game-id]',
      '[data-gameid]',
      '[data-game_id]',
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const value = normalizeText(node?.getAttribute('data-campaign-id')
        || node?.getAttribute('data-campaignid')
        || node?.getAttribute('data-campaign_id')
        || node?.getAttribute('data-game-id')
        || node?.getAttribute('data-gameid')
        || node?.getAttribute('data-game_id'));
      if (/^\d{3,}$/.test(value)) return value;
    }

    const linkSelectors = [
      'a[href*="/campaigns/details/"]',
      'link[rel="canonical"]',
      'meta[property="og:url"]',
    ];
    for (const selector of linkSelectors) {
      const node = document.querySelector(selector);
      const candidate = normalizeText(node?.getAttribute('href') || node?.getAttribute('content'));
      const candidateId = extractRoll20CampaignIdFromUrl(candidate);
      if (candidateId) return candidateId;
    }

    return '';
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
    return /^!rollcodex bridge (ready|ack|fail|viewer)(\s|$)/i.test(normalized);
  }

  function isAllowedRollCodexViewerWhisper(command) {
    const normalized = normalizeCommand(command);
    if (!normalized.includes(VIEWER_BROADCAST_MARKER)) return false;
    return /^\/w\s+(?:gm|"[^"\r\n]{1,80}"|[^\s\r\n]{1,80})\s+ROLLCODEX_BRIDGE_VIEWER:/i.test(normalized);
  }

  function isAllowedRollCodexActionCommand(command) {
    const normalized = normalizeCommand(command);
    if (!normalized.startsWith('!rollcodex ')) return false;
    return /^!rollcodex (idle|auto|send|end|status|profile|live|top|connect|complete)(\s|$)/i.test(normalized);
  }

  function isAllowedRollCodexChatCommand(command) {
    return isAllowedRollCodexConfirmation(command)
      || isAllowedBridgeCommand(command)
      || isAllowedRollCodexViewerWhisper(command)
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
    refreshActivePanel(settings.collapsed ? 'Panneau ouvert' : 'Panneau reduit');
  }

  async function cyclePanelPosition() {
    const settings = await getPanelSettings();
    await patchPanelSettings({ position: getNextPanelPosition(settings.position) });
    refreshActivePanel('Panneau deplace');
  }

  function renderPanel(state = {}) {
    if (!isRoll20TablePage()) {
      removePanel();
      return;
    }

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
    const status = state.status || (connection ? 'Connecte' : 'Non connecte');
    const statusLabel = compactPanelStatus(status, connection);
    const target = connection ? renderCompactConnectionTarget(connection) : escapeHtml('Pret pour jumelage');
    const kikimeter = renderKikimeter(liveSummary, kikimeterSettings.metric_id);
    const collapsedKikimeter = renderCollapsedKikimeter(liveSummary, kikimeterSettings.metric_id);
    const connectButton = connection ? '' : `<button type="button" data-rollcodex-connect title="Connecter RollCodex" style="${panelButtonStyle('primary')}">Lier</button>`;
    panel.style.cssText = getPanelCss(panelSettings);
    panel.removeAttribute('title');
    panel.onpointerdown = null;

    if (panelSettings.collapsed) {
      panel.innerHTML = `
        ${collapsedKikimeter}
      `;
      panel.title = 'Cliquer pour ouvrir, glisser pour deplacer';
      panel.onpointerdown = (event) => beginPanelDrag(event, { onClick: togglePanelCollapsed, ignoreInteractive: false });
      return;
    }

    panel.innerHTML = `
      <div style="display:grid;grid-template-columns:minmax(154px,170px) minmax(300px,1fr);gap:8px;align-items:start">
        <div style="min-width:0">
          <div data-rollcodex-panel-grip title="Glisser pour deplacer" style="display:flex;align-items:center;gap:6px;margin-bottom:5px;cursor:grab">
            <div data-rollcodex-panel-brand style="${panelBrandStyle()}">RollCodex</div>
            <span data-rollcodex-status title="${escapeHtml(status)}" style="color:${PANEL_COLORS.ok};font-size:10px;max-width:58px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(statusLabel)}</span>
            <button type="button" data-rollcodex-toggle-panel title="Reduire" style="${panelButtonStyle('secondary')};min-height:20px;min-width:22px;padding:1px 6px;font-size:12px;line-height:1">-</button>
          </div>
          <div title="${target}" style="margin-bottom:4px;color:${PANEL_COLORS.accent};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${target}</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px;color:${PANEL_COLORS.muted};font-size:10px">
            <span>${liveTotals.messages} msg</span>
            <span>${liveTotals.rolls} jets</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px">
            ${connectButton}
            <button type="button" data-rollcodex-chat-send title="Envoyer vers RollCodex" style="${panelButtonStyle('primary')}" ${connection ? '' : 'disabled'}>Env.</button>
            <button type="button" data-rollcodex-auto title="Capture auto ${autoSettings.enabled ? 'active' : 'inactive'}" style="${panelButtonStyle(autoSettings.enabled ? 'green' : 'brown')}">Auto</button>
            <button type="button" data-rollcodex-end-session title="Fin de session" style="${panelButtonStyle('purple')}" ${connection ? '' : 'disabled'}>Fin</button>
            <button type="button" data-rollcodex-forget title="Oublier la connexion" style="${panelButtonStyle('secondary')}">Oub.</button>
          </div>
          <div style="display:flex;align-items:center;gap:4px;margin-top:5px;color:${PANEL_COLORS.muted};font-size:10px">
            <button type="button" data-rollcodex-auto-minus title="Reduire l'intervalle auto" style="${panelButtonStyle('secondary')};min-height:19px;min-width:22px;padding:1px 5px">-</button>
            <span data-rollcodex-auto-minutes>Auto ${Math.round((autoSettings.idleMs || DEFAULT_AUTO_IDLE_MS) / 60000)} min</span>
            <button type="button" data-rollcodex-auto-plus title="Augmenter l'intervalle auto" style="${panelButtonStyle('secondary')};min-height:19px;min-width:22px;padding:1px 5px">+</button>
          </div>
        </div>
        <div style="min-width:0">${kikimeter}</div>
      </div>
    `;
    panel.querySelector('[data-rollcodex-panel-grip]')?.addEventListener('pointerdown', beginPanelDrag);
    panel.querySelector('[data-rollcodex-toggle-panel]')?.addEventListener('click', togglePanelCollapsed);
    panel.querySelector('[data-rollcodex-connect]')?.addEventListener('click', startExtensionPairing);
    panel.querySelector('[data-rollcodex-chat-send]')?.addEventListener('click', sendExtensionSnapshot);
    panel.querySelector('[data-rollcodex-end-session]')?.addEventListener('click', endExtensionSession);
    panel.querySelector('[data-rollcodex-auto]')?.addEventListener('click', toggleAutoCapture);
    panel.querySelector('[data-rollcodex-auto-minus]')?.addEventListener('click', () => adjustAutoIdle(-5));
    panel.querySelector('[data-rollcodex-auto-plus]')?.addEventListener('click', () => adjustAutoIdle(5));
    panel.querySelector('[data-rollcodex-forget]')?.addEventListener('click', forgetExtensionConnection);
    panel.querySelector('[data-rollcodex-kiki-select]')?.addEventListener('change', (event) => setKikimeterMetric(event.target.value));
  }

  function renderViewerPanel(state = {}) {
    if (!isRoll20TablePage()) {
      removePanel();
      return;
    }

    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }

    const connection = state.connection || null;
    const panelSettings = state.panelSettings || { collapsed: false, position: PANEL_POSITIONS[0] };
    const kikimeterSettings = state.kikimeterSettings || { metric_id: '' };
    const liveSummary = state.liveSummary || { totals: createEmptyLiveMetricTotals(), top_participants: [] };
    const liveTotals = liveSummary.totals || createEmptyLiveMetricTotals();
    const status = state.status || (connection ? 'Lecture session MJ' : 'Aucune session MJ');
    const statusLabel = compactPanelStatus(status, connection);
    const target = connection ? renderCompactConnectionTarget(connection) : escapeHtml('En attente du MJ');
    const kikimeter = renderKikimeter(liveSummary, kikimeterSettings.metric_id);
    const collapsedKikimeter = renderCollapsedKikimeter(liveSummary, kikimeterSettings.metric_id);
    panel.style.cssText = getPanelCss(panelSettings);
    panel.removeAttribute('title');
    panel.onpointerdown = null;

    if (panelSettings.collapsed) {
      panel.innerHTML = `${collapsedKikimeter}`;
      panel.title = 'Cliquer pour ouvrir, glisser pour deplacer';
      panel.onpointerdown = (event) => beginPanelDrag(event, { onClick: togglePanelCollapsed, ignoreInteractive: false });
      return;
    }

    panel.innerHTML = `
      <div style="display:grid;grid-template-columns:minmax(154px,170px) minmax(300px,1fr);gap:8px;align-items:start">
        <div style="min-width:0">
          <div data-rollcodex-panel-grip title="Glisser pour deplacer" style="display:grid;grid-template-columns:minmax(0,1fr) 24px;gap:6px;align-items:center;margin-bottom:4px;cursor:grab">
            <div data-rollcodex-panel-brand style="${panelBrandStyle()}">RollCodex</div>
            <button type="button" data-rollcodex-toggle-panel title="Reduire" style="${panelButtonStyle('secondary')};min-height:20px;min-width:22px;padding:1px 6px;font-size:12px;line-height:1">-</button>
          </div>
          <div data-rollcodex-viewer-state-row style="display:flex;align-items:center;gap:6px;min-width:0;margin-bottom:5px;overflow:hidden">
            <span title="Lecture seule - le MJ controle la session" style="${panelReaderBadgeStyle()}">Lecteur</span>
            <span data-rollcodex-status title="${escapeHtml(status)}" style="${panelStatusBadgeStyle(connection)}">${escapeHtml(statusLabel)}</span>
          </div>
          <div title="${target}" style="margin-bottom:4px;color:${PANEL_COLORS.accent};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${target}</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px;color:${PANEL_COLORS.muted};font-size:10px">
            <span>${liveTotals.messages} msg</span>
            <span>${liveTotals.rolls} jets</span>
          </div>
          <div style="color:${PANEL_COLORS.faint};font-size:10px;line-height:1.35">Session pilotee par le MJ. Aucune donnee n'est envoyee depuis votre navigateur.</div>
        </div>
        <div style="min-width:0">${kikimeter}</div>
      </div>
    `;
    panel.querySelector('[data-rollcodex-panel-grip]')?.addEventListener('pointerdown', beginPanelDrag);
    panel.querySelector('[data-rollcodex-toggle-panel]')?.addEventListener('click', togglePanelCollapsed);
    panel.querySelector('[data-rollcodex-kiki-select]')?.addEventListener('change', (event) => setKikimeterMetric(event.target.value));
  }

  async function refreshViewerPanel(status = '') {
    if (!isRoll20TablePage()) {
      cleanupNonTablePage();
      return;
    }
    const panelSettings = await getPanelSettings();
    const kikimeterSettings = await getKikimeterSettings();
    const broadcast = viewerState.broadcast;
    const profile = broadcast?.profile || null;
    const connection = broadcast?.connection ? { ...broadcast.connection, is_viewer: true } : null;
    currentMappingProfile = profile;
    const visibleMessages = getChatRows().map((node, index) => normalizeChatRow(node, index, profile)).filter(Boolean);
    rebuildLiveMetricsFromMessages(dedupeNormalizedMessages(visibleMessages));
    renderViewerPanel({
      panelSettings,
      kikimeterSettings,
      connection,
      profile,
      liveSummary: summarizeLiveMetrics(profile, kikimeterSettings.metric_id, connection),
      status: status || (broadcast ? 'Lecture session MJ' : 'En attente du MJ...'),
    });
  }

  function updatePanelStatus(status) {
    const node = document.querySelector(`#${PANEL_ID} [data-rollcodex-status]`);
    if (node) {
      node.title = status;
      const connected = !/non connecte|jumelage/i.test(normalizeText(status));
      node.textContent = compactPanelStatus(status, connected);
    }
  }

  function isPanelInteractiveTarget(target) {
    return Boolean(target?.closest?.('button,select,input,textarea,a,[data-rollcodex-no-drag]'));
  }

  function beginPanelDrag(event, options = {}) {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    if (event.button != null && event.button !== 0) return;
    if (options.ignoreInteractive !== false && isPanelInteractiveTarget(event.target)) return;
    const rect = panel.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    const dragThreshold = 4;
    let dragging = false;
    event.preventDefault();
    panel.style.cursor = 'grabbing';

    const onMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      if (!dragging) {
        if (Math.abs(deltaX) + Math.abs(deltaY) < dragThreshold) return;
        dragging = true;
      }
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
      panel.style.cursor = '';
      if (!dragging) {
        if (typeof options.onClick === 'function') await options.onClick();
        return;
      }
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
    if (!isRoll20TablePage()) {
      cleanupNonTablePage();
      return;
    }
    const connection = await getCurrentConnection();
    const autoSettings = await getAutoSettings();
    const panelSettings = await getPanelSettings();
    const kikimeterSettings = await getKikimeterSettings();
    const profile = connection ? await getMappingProfile(connection).catch(() => null) : null;
    currentMappingProfile = profile;
    const visibleMessages = getChatRows().map((node, index) => normalizeChatRow(node, index, profile)).filter(Boolean);
    rebuildLiveMetricsFromMessages(dedupeNormalizedMessages(visibleMessages));
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
    const connectionSecret = buildConnectionSecret();
    const secretHash = await sha256Hex(connectionSecret);
    const pendingPairing = {
      connectionId,
      state,
      connectionSecret,
      secretHash,
      roll20GameId: getRoll20GameId(),
      roll20GameTitle: getRoll20GameTitle(),
      roll20ScopeKey: getRoll20DurableStorageScope(),
      createdAt: new Date().toISOString(),
    };
    await setStorageValues({ [getPendingPairingStorageKey()]: pendingPairing });

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
    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        if (rows.some((row) => row === node || row.contains(node))) return;
        const text = normalizeText(node.textContent);
        if (!text || text.length < 2 || isIgnoredChatText(text, '')) return;
        rows.push(node);
      });
    });
    return rows.slice(-MAX_EXTENSION_MESSAGES);
  }

  function isIgnoredChatText(rawText, speaker = '') {
    const text = normalizeText(rawText);
    if (!text) return true;
    if (text.includes(BRIDGE_SNAPSHOT_MARKER) || text.includes('!rollcodex bridge')) return true;
    if (text.includes(VIEWER_BROADCAST_MARKER)) return true;

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

  function isSystemSpeakerLabel(value) {
    const label = normalizeSpeakerLabel(value).toLowerCase();
    return !label || label === 'roll20' || label === 'system' || label === 'api';
  }

  function isSystemChatMessage(rawText, speaker = '') {
    const text = normalizeText(rawText).toLowerCase();
    if (!text) return true;
    if (isSystemSpeakerLabel(speaker)) return true;
    if (/\b(astuces de chat|jets de des|jet de des|inviter des joueurs|voici le lien joueur|chuchoter a un joueur|whisper to)\b/i.test(text)) return true;
    return false;
  }

  function normalizeChatRow(node, index, mappingProfile = currentMappingProfile) {
    const rawText = getNodeReadableText(node);
    const key = getChatRowKey(node, index, rawText);
    const sender = getChatSender(node);
    let speaker = getChatSpeaker(node, rawText, mappingProfile);
    if (isIgnoredChatText(rawText, speaker)) return null;
    if (isSystemChatMessage(rawText, speaker)) return null;
    const original_speaker = speaker;
    const gmName = getCurrentGmName();
    const rollCardSpeaker = getRollCardSpeaker(node, rawText);
    const hadExplicitSpeaker = Boolean(sender || rollCardSpeaker || getSpeakerFromText(rawText));
    const figures = extractRollFigures(rawText, node);
    const isFollowUpAmount = (figures.damageTotal != null || figures.healTotal != null)
      && figures.rollTotal == null
      && figures.rollNatural == null;
    // Carry-over speaker generique avant d'evaluer le routage.
    const shouldCarryPreviousSpeaker = (!speaker || speaker === 'Roll20')
      || (isSpeakerRoutedToGm(speaker) && !rollCardSpeaker && isFollowUpAmount);
    if (shouldCarryPreviousSpeaker && lastResolvedChatSpeaker) {
      speaker = lastResolvedChatSpeaker;
    }
    // Regle :
    //   1) profil RollCodex le marque 'human' (character avec player_id) -> PJ ;
    //   2) sinon, s'il apparait dans la liste Roll20 des joueurs connectes hors MJ -> PJ aussi
    //      (le MJ a juste oublie de le creer dans RollCodex) ;
    //   3) sinon, on assume MJ -> bucket GM.
    const routedRole = getProfileSpeakerRole(mappingProfile, speaker);
    const isProfileHuman = routedRole?.role === 'human';
    const isConnectedRoll20Player = !isSpeakerRoutedToGm(speaker) && isKnownHumanSpeakerLabel(speaker);
    if (!isProfileHuman && !isConnectedRoll20Player) {
      speaker = gmName;
    }
    if (!speaker || speaker === 'Roll20') {
      speaker = gmName;
    }
    const scopedActionHint = resolveScopedActionEventTypeHint(mappingProfile, {
      speaker,
      raw_text: rawText,
      action_name_hint: figures.actionName,
      action_name: figures.actionName,
    });
    // Séparation stricte attaque/dégâts :
    let actionType = figures.actionType;
    const eventType = scopedActionHint?.eventType || actionType;
    let rollTotal = figures.rollTotal;
    let rollNatural = figures.rollNatural;
    let damageTotal = figures.damageTotal;
    let healTotal = figures.healTotal;
    // Renforce la séparation : un message ne peut pas être à la fois attaque ET dégâts
    if (eventType === 'attack' || eventType === 'spell_attack') {
      damageTotal = null;
      healTotal = null;
      // Si le texte contient aussi un mot-clé "damage" mais c'est une attaque, on ignore le champ dégâts
    } else if (eventType === 'damage' || eventType === 'spell_damage') {
      rollTotal = null;
      rollNatural = null;
      // Si le texte contient aussi un mot-clé "attack" mais c'est un dégât, on ignore le roll
    } else if (eventType === 'healing' || eventType === 'heal') {
      rollTotal = null;
      rollNatural = null;
      damageTotal = null;
    } else if (!LIVE_ROLL_EVENT_TYPES.has(eventType)) {
      // Si le type n'est ni attaque ni dégâts, on neutralise tout
      rollTotal = null;
      rollNatural = null;
      damageTotal = null;
      healTotal = null;
    }
    const rollPayload = (rollTotal != null || rollNatural != null || LIVE_ROLL_EVENT_TYPES.has(eventType))
      ? buildRollPayloadForSnapshot(figures, { rollTotal, rollNatural })
      : null;
    const msg = {
      key,
      timestamp: new Date().toISOString(),
      speaker,
      sender: normalizeSpeakerLabel(sender),
      original_speaker,
      raw_text: rawText,
      action_type_hint: actionType,
      ...(scopedActionHint ? { event_type_hint: eventType } : {}),
      action_name_hint: figures.actionName,
      sub_type_hint: figures.subType,
      skill_name_hint: figures.skillName,
      ...(rollPayload ? { roll: rollPayload } : {}),
      roll_total_hint: rollTotal,
      roll_natural_hint: rollNatural,
      roll_mode_hint: figures.rollMode,
      damage_total_hint: damageTotal,
      heal_total_hint: healTotal,
      is_critical_hint: figures.isCritical === true,
      is_fumble_hint: figures.isFumble === true,
      is_advantage_hint: figures.rollMode === 'advantage',
      is_disadvantage_hint: figures.rollMode === 'disadvantage',
    };
    if (scopedActionHint) {
      msg.scoped_pattern_hint = scopedActionHint.pattern;
    }
    if (speaker && speaker !== 'Roll20' && (hadExplicitSpeaker || lastResolvedChatSpeaker)) {
      lastResolvedChatSpeaker = speaker;
    }
    return msg;
  }

  function getPendingMessagesSlice(messages, lastSentKey) {
    if (!lastSentKey) return messages;
    const lastIndex = messages.findIndex((message) => message.key === lastSentKey);
    return lastIndex >= 0 ? messages.slice(lastIndex + 1) : messages;
  }

  function dedupeNormalizedMessages(messages) {
    const deduped = [];
    for (let i = 0; i < (messages || []).length; ++i) {
      const curr = messages[i];
      const prev = deduped[deduped.length - 1];
      const currIsGm = isSpeakerRoutedToGm(curr?.speaker);
      const prevIsGm = prev && isSpeakerRoutedToGm(prev.speaker);
      if (
        prev &&
        curr.raw_text === prev.raw_text &&
        curr.roll_total_hint === prev.roll_total_hint &&
        curr.damage_total_hint === prev.damage_total_hint &&
        curr.heal_total_hint === prev.heal_total_hint &&
        curr.action_type_hint === prev.action_type_hint &&
        curr.key !== prev.key &&
        currIsGm && prevIsGm
      ) {
        if (isSpeakerRoutedToGm(curr.speaker)) {
          deduped[deduped.length - 1] = curr;
        }
        continue;
      }
      deduped.push(curr);
    }
    return deduped;
  }

  // Déduplication GM/To GM et fusion des messages identiques (priorité GM)
  async function collectExtensionMessages(connectionOverride = null) {
    const lastSentKey = await getFirstScopedStorageValue(LAST_SENT_KEY);
    const connection = connectionOverride || await getCurrentConnection();
    const profile = connection ? await getMappingProfile(connection).catch(() => currentMappingProfile) : currentMappingProfile;
    const messages = getChatRows().map((node, index) => normalizeChatRow(node, index, profile)).filter(Boolean);
    const deduped = dedupeNormalizedMessages(messages);
    const pending = getPendingMessagesSlice(deduped, lastSentKey);
    // L'affichage live reste base sur les messages visibles, pas uniquement les pending.
    // Cela évite le reset du panneau après un envoi auto (onglet caché, changement de fenêtre).
    rebuildLiveMetricsFromMessages(deduped);
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
      const eventType = message.event_type_hint || message.action_type_hint || 'message';
      if (message.roll_total_hint != null || message.roll_natural_hint != null || eventType === 'roll') {
        participant.rolls += 1;
        liveMetricsState.totals.rolls += 1;
      }
      if (message.roll_natural_hint === 20 || message.is_critical_hint === true) {
        participant.criticals += 1;
        liveMetricsState.totals.criticals += 1;
      }
      if (message.roll_natural_hint === 1 || message.is_fumble_hint === true) {
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
      if (eventType !== 'message') {
        liveMetricsState.recentEvents.unshift({
          speaker,
          action_type: eventType,
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
    // Doit etre strictement identique a normalizeMetricKey cote backend
    // (supabase/functions/vtt-mapping-profile/index.ts) sinon les lookups
    // speaker_roles / mappings echouent silencieusement.
    return normalizeText(value)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
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

    const mappingProfileKey = getMappingProfileStorageKey();
    const stored = await getStorageValue(mappingProfileKey);
    if (!options.force && isFreshMappingProfileCache(stored, connection.connection_id)) {
      currentMappingProfile = stored.profile;
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
      currentMappingProfile = stored?.connection_id === connection.connection_id && stored?.profile?.schema_version ? stored.profile : null;
      return stored?.connection_id === connection.connection_id && stored?.profile?.schema_version ? stored.profile : null;
    }

    const profile = response.payload?.profile || null;
    if (profile) {
      const previousLastUpdate = stored?.profile?.last_updated_at || null;
      const nextLastUpdate = profile.last_updated_at || null;
      await setStorageValues({
        [mappingProfileKey]: {
          connection_id: connection.connection_id,
          fetched_at: new Date().toISOString(),
          profile,
        },
      });
      currentMappingProfile = profile;
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
    const connection = await getCurrentConnection();
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
    const messages = await collectExtensionMessages(connection);
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
      const refreshedProfile = await getMappingProfile(connection, { force: true }).catch(() => null);
      await setStorageValues({ [getLastSentStorageKey()]: messages[messages.length - 1].key });
      if (mode === 'auto') {
        await patchAutoSettings({ lastAutoSentAt: Date.now() });
        autoCaptureInFlight = false;
      }
      broadcastViewerSession(connection, refreshedProfile, `capture_${mode}`);
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
    const previousConnection = await getCurrentConnection();
    if (previousConnection) broadcastViewerSessionCleared(previousConnection, 'gm_forget');
    await Promise.all(getScopedStorageKeys(CONNECTION_KEY).map((key) => removeStorageValue(key).catch(() => null)));
    await Promise.all(getScopedStorageKeys(PENDING_PAIRING_KEY).map((key) => removeStorageValue(key).catch(() => null)));
    await Promise.all(getScopedStorageKeys(LAST_SENT_KEY).map((key) => removeStorageValue(key).catch(() => null)));
    await Promise.all(getScopedStorageKeys(MAPPING_PROFILE_KEY).map((key) => removeStorageValue(key).catch(() => null)));
    if (viewerHeartbeatTimer) {
      window.clearInterval(viewerHeartbeatTimer);
      viewerHeartbeatTimer = null;
    }
    refreshPanel('Connexion oubliee');
  }

  function clearAutoCaptureTimer() {
    if (!autoCaptureTimer) return;
    window.clearTimeout(autoCaptureTimer);
    autoCaptureTimer = null;
  }

  function stopAutoCaptureObserver() {
    if (!autoCaptureObserver) return;
    autoCaptureObserver.disconnect();
    autoCaptureObserver = null;
  }

  function stopBridgeSnapshotObserver() {
    if (!bridgeSnapshotObserver) return;
    bridgeSnapshotObserver.disconnect();
    bridgeSnapshotObserver = null;
  }

  function stopViewerObservers() {
    clearViewerRequestTimer();
    if (viewerStartupResyncTimer) {
      window.clearTimeout(viewerStartupResyncTimer);
      viewerStartupResyncTimer = null;
    }
    if (viewerBroadcastObserver) {
      viewerBroadcastObserver.disconnect();
      viewerBroadcastObserver = null;
    }
    if (viewerChatObserver) {
      viewerChatObserver.disconnect();
      viewerChatObserver = null;
    }
    if (viewerHeartbeatTimer) {
      window.clearInterval(viewerHeartbeatTimer);
      viewerHeartbeatTimer = null;
    }
  }

  function cleanupNonTablePage() {
    document.removeEventListener('visibilitychange', handleVisibilityModeRecheck);
    window.removeEventListener('focus', handleVisibilityModeRecheck);
    clearAutoCaptureTimer();
    stopGmLifecycleListeners();
    stopAutoCaptureObserver();
    stopBridgeSnapshotObserver();
    stopViewerObservers();
    removePanel();
  }

  async function scheduleAutoSnapshot(reason = 'roll20_auto_idle') {
    if (!isRoll20TablePage()) {
      cleanupNonTablePage();
      return;
    }
    const settings = await getAutoSettings();
    if (!settings.enabled) return;
    const connection = await getCurrentConnection();
    if (!connection?.endpoint) return;
    clearAutoCaptureTimer();
    autoCaptureTimer = window.setTimeout(() => {
      sendExtensionSnapshot({ mode: 'auto', reason, skipIfEmpty: true, silent: true });
    }, settings.idleMs);
  }

  function startAutoCaptureObserver() {
    if (!isRoll20TablePage()) return;
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
    if (!isRoll20TablePage()) {
      cleanupNonTablePage();
      return;
    }
    // Ne pas envoyer au simple changement de fenetre/onglet.
    // L'envoi auto doit rester pilote par l'inactivite (timer),
    // ou par les evenements de fermeture (pagehide/beforeunload),
    // ou par le bouton "Fin".
    if (document.visibilityState === 'visible') {
      refreshPanel();
    }
  }

  function sendPagehideSnapshot() {
    if (!isRoll20TablePage()) return;
    sendExtensionSnapshot({ mode: 'auto', reason: 'roll20_pagehide', skipIfEmpty: true, silent: true });
  }

  function sendBeforeUnloadSnapshot() {
    if (!isRoll20TablePage()) return;
    sendExtensionSnapshot({ mode: 'auto', reason: 'roll20_beforeunload', skipIfEmpty: true, silent: true });
  }

  function startGmLifecycleListeners() {
    if (gmLifecycleListenersStarted) return;
    gmLifecycleListenersStarted = true;
    document.addEventListener('visibilitychange', sendVisibilitySnapshot);
    window.addEventListener('pagehide', sendPagehideSnapshot);
    window.addEventListener('beforeunload', sendBeforeUnloadSnapshot);
  }

  function stopGmLifecycleListeners() {
    if (!gmLifecycleListenersStarted) return;
    gmLifecycleListenersStarted = false;
    document.removeEventListener('visibilitychange', sendVisibilitySnapshot);
    window.removeEventListener('pagehide', sendPagehideSnapshot);
    window.removeEventListener('beforeunload', sendBeforeUnloadSnapshot);
  }

  function handleVisibilityModeRecheck() {
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    window.setTimeout(() => reevaluateRuntimeMode('visibility'), 250);
    window.setTimeout(() => reevaluateRuntimeMode('visibility-stable'), 1500);
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
    if (!isRoll20TablePage()) return;
    if (bridgeSnapshotObserver) return;
    scanBridgeSnapshots();
    bridgeSnapshotObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => scanBridgeSnapshots(node));
      });
    });
    bridgeSnapshotObserver.observe(document.body, { childList: true, subtree: true });
  }

  function sanitizeBroadcastProfile(profile) {
    if (!profile) return null;
    return {
      schema_version: profile.schema_version || null,
      last_updated_at: profile.last_updated_at || null,
      metrics: Array.isArray(profile.metrics) ? profile.metrics : [],
      mappings: Array.isArray(profile.mappings) ? profile.mappings : [],
      speaker_roles: Array.isArray(profile.speaker_roles) ? profile.speaker_roles : [],
    };
  }

  function buildViewerBroadcastPayload(connection, profile, extra = {}) {
    if (!connection) return null;
    return {
      type: VIEWER_BROADCAST_TYPE,
      version: 1,
      emitted_at: new Date().toISOString(),
      bridge_version: BRIDGE_VERSION,
      connection: {
        provider: 'roll20',
        connection_id: connection.connection_id || '',
        workspace_label: connection.workspace_label || '',
        system_label: connection.system_label || '',
        campaign_label: connection.campaign_label || '',
        table_label: connection.table_label || '',
        roll20_game_id: connection.roll20_game_id || '',
        roll20_game_title: connection.roll20_game_title || '',
        roll20_scope_key: connection.roll20_scope_key || '',
      },
      profile: sanitizeBroadcastProfile(profile),
      ...extra,
    };
  }

  function encodeViewerBroadcast(payload) {
    return encodeURIComponent(JSON.stringify(payload));
  }

  function buildViewerBridgeMarker(payload) {
    const buildMarker = (candidate) => `${VIEWER_BROADCAST_MARKER}${encodeViewerBroadcast(candidate)}`;
    const marker = buildMarker(payload);
    if (marker.length <= VIEWER_BROADCAST_MAX_MARKER_LENGTH) {
      return marker;
    }
    // Profil trop volumineux pour le chat Roll20 : on tronque metriques/mappings
    // pour rester sous la limite. Le lecteur n'aura qu'une vue partielle mais
    // utilisable (les premieres entrees sont les plus pertinentes par sort_order).
    const trimAttempts = [
      { metrics: 24, mappings: 48, speakerRoles: 48 },
      { metrics: 12, mappings: 24, speakerRoles: 24 },
      { metrics: 6, mappings: 12, speakerRoles: 12 },
      { metrics: 3, mappings: 6, speakerRoles: 6 },
      { metrics: 0, mappings: 0, speakerRoles: 0 },
    ];

    for (const attempt of trimAttempts) {
      const trimmedProfile = payload.profile ? {
        schema_version: payload.profile.schema_version || null,
        last_updated_at: payload.profile.last_updated_at || null,
        metrics: (payload.profile.metrics || []).slice(0, attempt.metrics),
        mappings: (payload.profile.mappings || []).slice(0, attempt.mappings),
        speaker_roles: (payload.profile.speaker_roles || []).slice(0, attempt.speakerRoles),
      } : null;
      const trimmed = { ...payload, profile: trimmedProfile, truncated: true };
      const trimmedMarker = buildMarker(trimmed);
      if (trimmedMarker.length <= VIEWER_BROADCAST_MAX_MARKER_LENGTH) return trimmedMarker;
    }

    return buildMarker({
      ...payload,
      profile: null,
      truncated: true,
      truncation_reason: 'viewer_marker_limit',
    });
  }

  function sendViewerBridgePayloadToTarget(payload, targetLabel) {
    const marker = buildViewerBridgeMarker(payload);
    const command = buildRoll20WhisperCommand(targetLabel, marker);
    if (!command) return false;
    const result = sendChatCommand(command);
    return Boolean(result?.ok);
  }

  function broadcastViewerSession(connection, profile, reason = 'connection_update', options = {}) {
    if (!isCurrentUserRoll20Gm()) return false;
    if (!isRoll20TablePage()) return false;
    const payload = buildViewerBroadcastPayload(connection, profile, { reason });
    if (!payload) return false;
    const explicitTarget = normalizeViewerWhisperTarget(options.targetLabel || '');
    const targets = explicitTarget ? [explicitTarget] : getKnownViewerWhisperTargets();
    if (!targets.length) return false;
    return targets.some((target) => sendViewerBridgePayloadToTarget(payload, target));
  }

  function broadcastViewerSessionCleared(connection, reason = 'gm_disconnected', options = {}) {
    if (!isCurrentUserRoll20Gm()) return false;
    if (!connection) return false;
    const payload = {
      type: VIEWER_BROADCAST_TYPE,
      version: 1,
      emitted_at: new Date().toISOString(),
      cleared: true,
      reason,
      connection: {
        provider: 'roll20',
        connection_id: connection.connection_id || '',
        roll20_game_id: connection.roll20_game_id || '',
        roll20_game_title: connection.roll20_game_title || '',
        roll20_scope_key: connection.roll20_scope_key || '',
      },
    };
    const explicitTarget = normalizeViewerWhisperTarget(options.targetLabel || '');
    const targets = explicitTarget ? [explicitTarget] : getKnownViewerWhisperTargets();
    knownViewerWhisperTargets.clear();
    lastViewerRequestRespondedAtByTarget.clear();
    if (!targets.length) return false;
    return targets.some((target) => sendViewerBridgePayloadToTarget(payload, target));
  }

  function scheduleViewerHeartbeat() {
    if (!isCurrentUserRoll20Gm()) return;
    if (viewerHeartbeatTimer) window.clearInterval(viewerHeartbeatTimer);
    viewerHeartbeatTimer = window.setInterval(async () => {
      if (!isRoll20TablePage()) return;
      const connection = await getCurrentConnection();
      if (!connection) return;
      const profile = await getMappingProfile(connection).catch(() => null);
      broadcastViewerSession(connection, profile, 'heartbeat');
    }, VIEWER_BROADCAST_HEARTBEAT_MS);
  }

  function decodeViewerBroadcast(encoded) {
    try {
      const payload = JSON.parse(decodeURIComponent(String(encoded || '').trim()));
      if (payload?.type !== VIEWER_BROADCAST_TYPE && payload?.type !== VIEWER_REQUEST_TYPE) return null;
      return payload;
    } catch (_error) {
      return null;
    }
  }

  function getViewerBroadcastStamp(payload, fallback = '') {
    const emittedAt = Date.parse(payload?.emitted_at || '');
    if (Number.isFinite(emittedAt)) return emittedAt;
    const fallbackAt = Date.parse(fallback || '');
    return Number.isFinite(fallbackAt) ? fallbackAt : 0;
  }

  function hasRecentViewerBroadcast() {
    const stamp = getViewerBroadcastStamp(viewerState.broadcast);
    return Boolean(stamp && Date.now() - stamp <= VIEWER_BROADCAST_STALE_MS);
  }

  function buildViewerRequestPayload() {
    return {
      type: VIEWER_REQUEST_TYPE,
      version: 1,
      requested_at: new Date().toISOString(),
      token: randomHex(8),
      requester_label: getCurrentRoll20PlayerLabel(),
      roll20_scope_key: getRoll20DurableStorageScope(),
      roll20_game_id: getRoll20GameId(),
      roll20_game_title: getRoll20GameTitle(),
    };
  }

  function sendViewerBroadcastRequest() {
    if (isCurrentUserRoll20Gm()) return false;
    if (!isRoll20TablePage()) return false;
    const now = Date.now();
    if (now - lastViewerRequestSentAt < VIEWER_REQUEST_MIN_INTERVAL_MS) return false;
    const payload = buildViewerRequestPayload();
    const marker = `${VIEWER_BROADCAST_MARKER}${encodeViewerBroadcast(payload)}`;
    const result = sendChatCommand(buildRoll20WhisperCommand('gm', marker));
    const sent = Boolean(result?.ok);
    if (sent) lastViewerRequestSentAt = now;
    return sent;
  }

  function clearViewerRequestTimer() {
    if (!viewerRequestTimer) return;
    window.clearInterval(viewerRequestTimer);
    viewerRequestTimer = null;
  }

  function scheduleViewerBroadcastRequests() {
    if (viewerRequestTimer) return;
    VIEWER_REQUEST_RETRY_DELAYS_MS.forEach((delay) => {
      window.setTimeout(() => {
        if (!isRoll20TablePage()) return;
        if (currentRuntimeMode !== 'viewer') return;
        if (hasRecentViewerBroadcast()) return;
        sendViewerBroadcastRequest();
      }, delay);
    });
    viewerRequestTimer = window.setInterval(() => {
      if (!isRoll20TablePage() || currentRuntimeMode !== 'viewer') {
        clearViewerRequestTimer();
        return;
      }
      if (hasRecentViewerBroadcast()) return;
      sendViewerBroadcastRequest();
    }, VIEWER_REQUEST_PERIODIC_MS);
  }

  function scheduleViewerStartupResync() {
    if (viewerStartupResyncTimer) window.clearTimeout(viewerStartupResyncTimer);
    viewerStartupResyncTimer = window.setTimeout(() => {
      viewerStartupResyncTimer = null;
      if (!isRoll20TablePage()) return;
      if (currentRuntimeMode !== 'viewer') return;
      sendViewerBroadcastRequest();
    }, VIEWER_STARTUP_RESYNC_MS);
  }

  async function handleViewerRequest(payload) {
    if (!isCurrentUserRoll20Gm()) return;
    // Le MJ ne repond qu'aux requetes scopees sur sa propre table active.
    const requestScope = String(payload?.roll20_scope_key || '').trim();
    const currentScopes = getRoll20DurableStorageScopes();
    if (requestScope && currentScopes.length && !currentScopes.includes(requestScope)) return;

    // Debounce : evite une rafale de re-broadcasts si plusieurs joueurs ouvrent en meme temps.
    const now = Date.now();
    const requesterLabel = rememberViewerWhisperTarget(payload?.requester_label);
    if (!requesterLabel) return;
    const requesterKey = requesterLabel.toLowerCase();
    const lastRespondedAt = lastViewerRequestRespondedAtByTarget.get(requesterKey) || 0;
    if (now - lastRespondedAt < VIEWER_REQUEST_RESPONSE_DEBOUNCE_MS) return;
    lastViewerRequestRespondedAtByTarget.set(requesterKey, now);

    const connection = await getCurrentConnection();
    if (!connection) return;
    const profile = await getMappingProfile(connection).catch(() => null);
    broadcastViewerSession(connection, profile, 'viewer_request', { targetLabel: requesterLabel });
  }

  function viewerBroadcastMatchesCurrentTable(payload, options = {}) {
    const conn = payload?.connection;
    if (!conn) return false;
    const candidate = {
      roll20_game_id: conn.roll20_game_id,
      roll20_game_title: conn.roll20_game_title,
      roll20_scope_key: conn.roll20_scope_key,
    };
    if (connectionMatchesCurrentTable(candidate)) return true;
    if (!options.allowWeakChatRelay) return false;

    // Le broadcast lecteur arrive via le chat Roll20 de cette table. Si Roll20
    // masque l'id de campagne ou donne un titre divergent entre MJ et joueur,
    // on accepte ce relais live tant qu'aucun identifiant fort ne contredit.
    const currentGameId = normalizeText(getRoll20GameId());
    const candidateGameId = normalizeText(candidate.roll20_game_id);
    if (currentGameId && candidateGameId && currentGameId !== candidateGameId) return false;

    const currentTitle = normalizeStorageScopePart(getRoll20GameTitle());
    const candidateTitle = normalizeStorageScopePart(candidate.roll20_game_title);
    if (currentTitle && candidateTitle && currentTitle !== 'roll20' && candidateTitle !== 'roll20' && currentTitle !== candidateTitle) {
      return false;
    }

    return true;
  }

  function applyViewerBroadcast(payload, options = {}) {
    if (!viewerBroadcastMatchesCurrentTable(payload, options)) return;
    const emittedAt = Date.parse(payload?.emitted_at || '');
    const stamp = Number.isFinite(emittedAt) ? emittedAt : Date.now();
    if (stamp <= viewerState.lastSeenAt) return;
    if (payload?.cleared === true) {
      viewerState.broadcast = null;
      viewerState.lastSeenAt = stamp;
      removeStorageValue(VIEWER_BROADCAST_CACHE_KEY).catch(() => null);
      refreshViewerPanel('Session MJ terminee');
      scheduleViewerBroadcastRequests();
      return;
    }
    viewerState.broadcast = payload;
    viewerState.lastSeenAt = stamp;
    scheduleViewerBroadcastRequests();
    setStorageValues({
      [VIEWER_BROADCAST_CACHE_KEY]: {
        roll20_scope_key: payload.connection?.roll20_scope_key || '',
        payload,
        cached_at: new Date().toISOString(),
      },
    }).catch(() => null);
    refreshViewerPanel(payload?.reason === 'heartbeat' ? 'Heartbeat MJ' : 'Mise a jour MJ');
  }

  function findViewerBridgeChatRow(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return null;
    return element.closest?.(
      '#textchat [data-messageid], #textchat [data-message-id], #textchat .message, #textchat .textchatmessage, #textchat .chat-message'
    );
  }

  function getViewerRequestSenderLabel(root) {
    const row = findViewerBridgeChatRow(root);
    if (!row) return '';
    const sender = getChatSender(row);
    const textSpeaker = getSpeakerFromText(getNodeReadableText(row));
    return normalizeViewerRequesterLabel(sender || textSpeaker);
  }

  function hideViewerBridgeChatRows(root = document.body) {
    const element = root?.nodeType === Node.ELEMENT_NODE ? root : root?.parentElement;
    if (!element) return;
    const directRow = normalizeText(element.textContent).includes(VIEWER_BROADCAST_MARKER)
      ? findViewerBridgeChatRow(element)
      : null;
    const rows = new Set(directRow ? [directRow] : []);
    element.querySelectorAll?.(
      '#textchat [data-messageid], #textchat [data-message-id], #textchat .message, #textchat .textchatmessage, #textchat .chat-message'
    ).forEach((row) => {
      if (normalizeText(row.textContent).includes(VIEWER_BROADCAST_MARKER)) rows.add(row);
    });
    rows.forEach((row) => {
      row.dataset.rollcodexHiddenViewerBridge = 'true';
      row.setAttribute('aria-hidden', 'true');
      row.style.display = 'none';
    });
  }

  function scanViewerBroadcasts(root = document.body) {
    const text = String(root?.textContent || '');
    if (!text.includes(VIEWER_BROADCAST_MARKER)) return;
    const pattern = new RegExp(`${VIEWER_BROADCAST_MARKER}([^\\s<]+)`, 'g');
    let match = pattern.exec(text);
    while (match) {
      const token = match[1];
      if (!processedViewerBroadcasts.has(token)) {
        const payload = decodeViewerBroadcast(token);
        const requestPayload = payload?.type === VIEWER_REQUEST_TYPE && !normalizeViewerRequesterLabel(payload.requester_label)
          ? { ...payload, requester_label: getViewerRequestSenderLabel(root) }
          : payload;
        const shouldApplyBroadcast = requestPayload?.type === VIEWER_BROADCAST_TYPE && currentRuntimeMode === 'viewer';
        const shouldHandleRequest = requestPayload?.type === VIEWER_REQUEST_TYPE && currentRuntimeMode === 'gm';
        if (shouldApplyBroadcast || shouldHandleRequest) {
          processedViewerBroadcasts.add(token);
          if (shouldApplyBroadcast) applyViewerBroadcast(requestPayload, { allowWeakChatRelay: true });
          else handleViewerRequest(requestPayload);
        }
      }
      match = pattern.exec(text);
    }
    hideViewerBridgeChatRows(root);
  }

  function startViewerBroadcastObserver() {
    if (!isRoll20TablePage()) return;
    if (viewerBroadcastObserver) return;
    scanViewerBroadcasts();
    viewerBroadcastObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => scanViewerBroadcasts(node));
      });
    });
    viewerBroadcastObserver.observe(document.body, { childList: true, subtree: true });
  }

  function startViewerChatObserver() {
    if (!isRoll20TablePage()) return;
    if (viewerChatObserver) return;
    const root = document.querySelector('#textchat');
    if (!root) {
      window.setTimeout(startViewerChatObserver, 1500);
      return;
    }
    viewerChatObserver = new MutationObserver((mutations) => {
      const hasChatChange = mutations.some((mutation) => {
        if (mutation.target?.closest?.(`#${PANEL_ID}`)) return false;
        return Array.from(mutation.addedNodes || []).some((node) => {
          if (node.id === PANEL_ID || node.closest?.(`#${PANEL_ID}`)) return false;
          return normalizeText(node.textContent).length >= 2;
        });
      });
      if (!hasChatChange) return;
      refreshViewerPanel();
    });
    viewerChatObserver.observe(root, { childList: true, subtree: true });
  }

  async function loadCachedViewerBroadcast() {
    const stored = await getStorageValue(VIEWER_BROADCAST_CACHE_KEY);
    if (!stored?.payload) return;
    if (!viewerBroadcastMatchesCurrentTable(stored.payload)) return;
    const stamp = getViewerBroadcastStamp(stored.payload, stored.cached_at);
    if (!stamp || Date.now() - stamp > VIEWER_BROADCAST_STALE_MS) {
      removeStorageValue(VIEWER_BROADCAST_CACHE_KEY).catch(() => null);
      return;
    }
    if (stamp > viewerState.lastSeenAt) {
      viewerState.broadcast = stored.payload;
      viewerState.lastSeenAt = stamp;
    }
  }

  getExtensionApi()?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (!isRoll20TablePage()) {
      cleanupNonTablePage();
      return false;
    }
    if (message?.type === MESSAGE_EXTENSION_CONNECTED) {
      if (currentRuntimeMode === 'viewer') {
        // Le mode lecteur ne stocke pas de connexion locale : tout vient du broadcast MJ.
        sendResponse({ ok: false, ignored: true, reason: 'viewer_mode' });
        return true;
      }
      if (message.connection && !connectionMatchesCurrentTable(message.connection)) {
        sendResponse({ ok: false, ignored: true });
        return true;
      }
      refreshPanel('Connexion RollCodex active');
      if (message.connection) {
        const scopedConnection = enrichConnectionWithCurrentTableScope(message.connection);
        const connectionStorageKey = getConnectionStorageKeyForConnection(scopedConnection);
        if (connectionStorageKey) {
          setStorageValues({ [connectionStorageKey]: scopedConnection }).catch(() => null);
        }
        getMappingProfile(scopedConnection, { force: true })
          .then((profile) => {
            broadcastViewerSession(scopedConnection, profile, 'extension_connected');
            scheduleViewerHeartbeat();
            refreshPanel('Profil RollCodex recharge');
          })
          .catch(() => null);
      }
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type !== MESSAGE_SEND_CHAT_COMMAND) return false;
    sendResponse(sendChatCommand(message.command));
    return true;
  });

  if (!isRoll20TablePage()) {
    cleanupNonTablePage();
    return;
  }

  function reevaluateRuntimeMode(reason = 'recheck') {
    const detected = getCurrentRoll20ModeInfo();
    const detectedMode = detected.mode;
    if (detectedMode === 'viewer' && detected.confidence === 'strong') viewerModeLocked = true;
    if (currentRuntimeMode === 'viewer' && viewerModeLocked && detectedMode === 'gm' && detected.confidence !== 'strong') {
      refreshViewerPanel();
      return false;
    }
    if (detectedMode === currentRuntimeMode) return false;
    currentRuntimeMode = detectedMode;
    if (detectedMode === 'viewer') {
      // Le DOM a finalement marque ce navigateur comme joueur : on bascule en lecteur,
      // on nettoie tout artefact MJ et on demarre les observateurs lecteur.
      clearAutoCaptureTimer();
      stopGmLifecycleListeners();
      stopAutoCaptureObserver();
      stopBridgeSnapshotObserver();
      if (viewerHeartbeatTimer) {
        window.clearInterval(viewerHeartbeatTimer);
        viewerHeartbeatTimer = null;
      }
      startViewerBroadcastObserver();
      startViewerChatObserver();
      loadCachedViewerBroadcast().then(() => {
        refreshViewerPanel(`Mode lecteur (${reason})`);
        scheduleViewerBroadcastRequests();
        scheduleViewerStartupResync();
      });
    } else {
      // Bascule lecteur -> MJ (rare : reconnexion du MJ apres incertitude DOM).
      clearViewerRequestTimer();
      startViewerBroadcastObserver();
      startBridgeSnapshotObserver();
      startAutoCaptureObserver();
      startGmLifecycleListeners();
      refreshPanel('Mode MJ detecte');
    }
    return true;
  }

  function scheduleRuntimeModeRetries(reason = 'startup') {
    // Le DOM Roll20 se peuple progressivement (chat, players panel, speakingas).
    // Sans message chat MJ encore visible, le fallback retourne 'gm'. On retente
    // a intervalles croissants pour basculer en 'viewer' des qu'un signal arrive.
    [2000, 5000, 10000, 20000, 45000].forEach((delay) => {
      window.setTimeout(() => {
        if (!isRoll20TablePage()) return;
        reevaluateRuntimeMode(`${reason}+${delay}ms`);
      }, delay);
    });
  }

  const initialRuntimeMode = getCurrentRoll20ModeInfo();
  currentRuntimeMode = initialRuntimeMode.mode;
  viewerModeLocked = initialRuntimeMode.mode === 'viewer' && initialRuntimeMode.confidence === 'strong';

  document.addEventListener('visibilitychange', handleVisibilityModeRecheck);
  window.addEventListener('focus', handleVisibilityModeRecheck);

  if (currentRuntimeMode === 'viewer') {
    startViewerBroadcastObserver();
    startViewerChatObserver();
    window.setTimeout(async () => {
      if (reevaluateRuntimeMode('post-idle')) return;
      await loadCachedViewerBroadcast();
      refreshViewerPanel();
      scheduleViewerBroadcastRequests();
      scheduleViewerStartupResync();
    }, 800);
    scheduleRuntimeModeRetries('post-startup');
  } else {
    startViewerBroadcastObserver();
    startBridgeSnapshotObserver();
    startAutoCaptureObserver();
    startGmLifecycleListeners();
    window.setTimeout(async () => {
      if (reevaluateRuntimeMode('post-idle')) return;
      await refreshPanel();
      const connection = await getCurrentConnection();
      if (connection) {
        const profile = await getMappingProfile(connection).catch(() => null);
        broadcastViewerSession(connection, profile, 'gm_startup');
        scheduleViewerHeartbeat();
      }
    }, 800);
    scheduleRuntimeModeRetries('post-startup');
  }
})();
