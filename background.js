(() => {
  const MESSAGE_CONFIRM = 'ROLLCODEX_ROLL20_CONFIRM';
  const MESSAGE_SEND_SNAPSHOT = 'ROLLCODEX_ROLL20_SEND_SNAPSHOT';
  const MESSAGE_FETCH_MAPPING_PROFILE = 'ROLLCODEX_ROLL20_FETCH_MAPPING_PROFILE';
  const MESSAGE_FETCH_IMPORT_BOUNDARY = 'ROLLCODEX_ROLL20_FETCH_IMPORT_BOUNDARY';
  const MESSAGE_EXTENSION_CONNECTED = 'ROLLCODEX_ROLL20_EXTENSION_CONNECTED';
  const MESSAGE_SYNC_CONNECTION = 'ROLLCODEX_ROLL20_SYNC_CONNECTION';
  const MESSAGE_OPEN_CONNECT_PAGE = 'ROLLCODEX_ROLL20_OPEN_CONNECT_PAGE';
  const CONFIRM_PREFIX = '!rollcodex confirm ';
  const BRIDGE_CLIENT = 'roll20-extension/0.4.7';
  const PENDING_PAIRING_KEY = 'rollcodexExtensionPendingPairing';
  const CONNECTION_KEY = 'rollcodexExtensionConnection';

  function normalizeCommand(command) {
    return String(command || '').trim();
  }

  function isAllowedRollCodexConfirmation(command) {
    const normalized = normalizeCommand(command);
    if (!normalized.startsWith(CONFIRM_PREFIX)) return false;
    try {
      const payload = JSON.parse(normalized.slice(CONFIRM_PREFIX.length));
      return payload?.type === 'rollcodex:vtt-connection-complete'
        && payload.provider === 'roll20'
        && typeof payload.connectionId === 'string'
        && typeof payload.state === 'string'
        && typeof payload.endpoint === 'string';
    } catch (_error) {
      return false;
    }
  }

  function parseConfirmationCommand(command) {
    const normalized = normalizeCommand(command);
    if (!normalized.startsWith(CONFIRM_PREFIX)) return null;
    try {
      return JSON.parse(normalized.slice(CONFIRM_PREFIX.length));
    } catch (_error) {
      return null;
    }
  }

  function pickRoll20Tab(tabs) {
    return (tabs || []).find((tab) => /\/editor(?:\/|$|\?)/.test(tab.url || ''))
      || (tabs || []).find((tab) => tab.active)
      || (tabs || [])[0]
      || null;
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

  function getAllStorageValues() {
    return new Promise((resolve) => {
      const storage = getExtensionApi()?.storage?.local;
      if (!storage?.get) {
        resolve({});
        return;
      }
      callExtensionMethod(storage.get.bind(storage), [null], (result) => resolve(result || {}), () => resolve({}));
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

  function normalizeScopePart(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }

  function getConnectionScope(payload = {}) {
    const gameId = String(payload.roll20_game_id || payload.roll20GameId || '').trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    if (gameId) return `game:${gameId}`;
    const titleKey = normalizeScopePart(payload.roll20_game_title || payload.roll20GameTitle);
    return titleKey && titleKey !== 'roll20' ? `title:${titleKey}` : '';
  }

  function getConnectionStorageKey(connection = {}) {
    const scope = connection.roll20_scope_key || connection.roll20ScopeKey || getConnectionScope(connection);
    return scope ? `${CONNECTION_KEY}:${scope}` : CONNECTION_KEY;
  }

  function enrichConnectionScope(connection, scopeSource = {}) {
    if (!connection) return connection;
    const roll20GameId = connection.roll20_game_id || scopeSource.roll20GameId || scopeSource.roll20_game_id || '';
    const roll20GameTitle = connection.roll20_game_title || scopeSource.roll20GameTitle || scopeSource.roll20_game_title || '';
    const roll20ScopeKey = connection.roll20_scope_key || scopeSource.roll20ScopeKey || scopeSource.roll20_scope_key || getConnectionScope({
      roll20_game_id: roll20GameId,
      roll20_game_title: roll20GameTitle,
    });
    return {
      ...connection,
      roll20_game_id: roll20GameId,
      roll20_game_title: roll20GameTitle,
      roll20_scope_key: roll20ScopeKey,
    };
  }

  function getStoredRoll20Connections() {
    return getAllStorageValues().then((values) => Object.entries(values || {})
      .filter(([key, value]) => (key === CONNECTION_KEY || key.startsWith(`${CONNECTION_KEY}:`)) && isValidStoredRoll20Connection(value))
      .map(([key, value]) => ({ key, connection: value })));
  }

  function isValidPendingPairing(pending) {
    return typeof pending?.connectionId === 'string'
      && typeof pending?.state === 'string'
      && typeof pending?.connectionSecret === 'string';
  }

  function getStoredPendingPairings() {
    return getAllStorageValues().then((values) => Object.entries(values || {})
      .filter(([key, value]) => (key === PENDING_PAIRING_KEY || key.startsWith(`${PENDING_PAIRING_KEY}:`)) && isValidPendingPairing(value))
      .map(([key, pending]) => ({ key, pending })));
  }

  function removePendingPairingsByConnectionId(connectionId) {
    const expected = String(connectionId || '').trim();
    if (!expected) return Promise.resolve(true);
    return getStoredPendingPairings().then((entries) => {
      const targets = (entries || []).filter(({ pending }) => String(pending?.connectionId || '').trim() === expected);
      if (!targets.length) return true;
      return Promise.all(targets.map(({ key }) => removeStorageValue(key).catch(() => false))).then(() => true);
    });
  }

  function queryTabs(queryInfo) {
    return new Promise((resolve) => {
      const tabs = getExtensionApi()?.tabs;
      if (!tabs?.query) {
        resolve([]);
        return;
      }
      callExtensionMethod(tabs.query.bind(tabs), [queryInfo], (result) => resolve(result || []), () => resolve([]));
    });
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      const tabs = getExtensionApi()?.tabs;
      if (!tabs?.sendMessage || !tabId) {
        resolve(false);
        return;
      }
      callExtensionMethod(tabs.sendMessage.bind(tabs), [tabId, message], () => resolve(true), () => resolve(false));
    });
  }

  function executeScriptInTab(tabId, files) {
    return new Promise((resolve) => {
      const scripting = getExtensionApi()?.scripting;
      if (!scripting?.executeScript || !tabId) {
        resolve(false);
        return;
      }
      callExtensionMethod(
        scripting.executeScript.bind(scripting),
        [{ target: { tabId }, files }],
        () => resolve(true),
        () => resolve(false),
      );
    });
  }

  function createTab(url) {
    return new Promise((resolve, reject) => {
      const tabs = getExtensionApi()?.tabs;
      if (!tabs?.create) {
        reject(new Error('Extension tabs API unavailable.'));
        return;
      }
      callExtensionMethod(tabs.create.bind(tabs), [{ url }], (tab) => resolve(tab || null), reject);
    });
  }

  function buildExtensionConnection(payload, pendingPairing) {
    if (!pendingPairing || pendingPairing.connectionId !== payload.connectionId || pendingPairing.state !== payload.state) return null;
    if (!pendingPairing.connectionSecret) return null;
    const mappingProfileEndpoint = String(payload.mappingProfileEndpoint || payload.mapping_profile_endpoint || '').trim();
    if (mappingProfileEndpoint && !isAllowedMappingProfileEndpoint(mappingProfileEndpoint)) return null;
    const importBoundaryEndpoint = String(payload.importBoundaryEndpoint || payload.import_boundary_endpoint || '').trim();
    if (importBoundaryEndpoint && !isAllowedImportBoundaryEndpoint(importBoundaryEndpoint)) return null;
    return enrichConnectionScope({
      provider: 'roll20',
      source_format: 'roll20_mod_json',
      connection_id: payload.connectionId,
      connection_secret: pendingPairing.connectionSecret,
      endpoint: payload.endpoint,
      mapping_profile_endpoint: mappingProfileEndpoint,
      import_boundary_endpoint: importBoundaryEndpoint,
      workspace_id: payload.workspaceId || payload.workspace_id || '',
      workspace_label: payload.workspaceLabel || payload.workspace_label || '',
      system_id: payload.systemId || payload.system_id || '',
      system_label: payload.systemLabel || payload.system_label || '',
      campaign_id: payload.campaignId || payload.campaign_id || '',
      campaign_label: payload.campaignLabel || payload.campaign_label || '',
      table_id: payload.tableId || payload.table_id || '',
      table_label: payload.tableLabel || payload.table_label || '',
      connected_at: new Date().toISOString(),
    }, pendingPairing);
  }

  function buildSyncedExtensionConnection(payload) {
    const connectionId = String(payload?.connectionId || payload?.connection_id || '').trim();
    const connectionSecret = String(payload?.connectionSecret || payload?.connection_secret || '').trim();
    const endpoint = String(payload?.endpoint || '').trim();
    const mappingProfileEndpoint = String(payload?.mappingProfileEndpoint || payload?.mapping_profile_endpoint || '').trim();
    const importBoundaryEndpoint = String(payload?.importBoundaryEndpoint || payload?.import_boundary_endpoint || '').trim();
    if (payload?.provider !== 'roll20' || !connectionId || !connectionSecret || !isAllowedSnapshotEndpoint(endpoint)) return null;
    if (mappingProfileEndpoint && !isAllowedMappingProfileEndpoint(mappingProfileEndpoint)) return null;
    if (importBoundaryEndpoint && !isAllowedImportBoundaryEndpoint(importBoundaryEndpoint)) return null;

    return enrichConnectionScope({
      provider: 'roll20',
      source_format: 'roll20_mod_json',
      connection_id: connectionId,
      connection_secret: connectionSecret,
      endpoint,
      mapping_profile_endpoint: mappingProfileEndpoint,
      import_boundary_endpoint: importBoundaryEndpoint,
      workspace_id: payload.workspaceId || payload.workspace_id || '',
      workspace_label: payload.workspaceLabel || payload.workspace_label || '',
      system_id: payload.systemId || payload.system_id || '',
      system_label: payload.systemLabel || payload.system_label || '',
      campaign_id: payload.campaignId || payload.campaign_id || '',
      campaign_label: payload.campaignLabel || payload.campaign_label || '',
      table_id: payload.tableId || payload.table_id || '',
      table_label: payload.tableLabel || payload.table_label || '',
      connected_at: new Date().toISOString(),
      synced_from_rollcodex_at: new Date().toISOString(),
    }, payload);
  }

  function buildSyncedConnectionContext(payload) {
    const connectionId = String(payload?.connectionId || payload?.connection_id || '').trim();
    const endpoint = String(payload?.endpoint || '').trim();
    const mappingProfileEndpoint = String(payload?.mappingProfileEndpoint || payload?.mapping_profile_endpoint || '').trim();
    const importBoundaryEndpoint = String(payload?.importBoundaryEndpoint || payload?.import_boundary_endpoint || '').trim();
    if (payload?.provider !== 'roll20' || !connectionId) return null;
    if (endpoint && !isAllowedSnapshotEndpoint(endpoint)) return null;
    if (mappingProfileEndpoint && !isAllowedMappingProfileEndpoint(mappingProfileEndpoint)) return null;
    if (importBoundaryEndpoint && !isAllowedImportBoundaryEndpoint(importBoundaryEndpoint)) return null;

    return enrichConnectionScope({
      provider: 'roll20',
      source_format: 'roll20_mod_json',
      connection_id: connectionId,
      endpoint,
      mapping_profile_endpoint: mappingProfileEndpoint,
      import_boundary_endpoint: importBoundaryEndpoint,
      workspace_id: payload.workspaceId || payload.workspace_id || '',
      workspace_label: payload.workspaceLabel || payload.workspace_label || '',
      system_id: payload.systemId || payload.system_id || '',
      system_label: payload.systemLabel || payload.system_label || '',
      campaign_id: payload.campaignId || payload.campaign_id || '',
      campaign_label: payload.campaignLabel || payload.campaign_label || '',
      table_id: payload.tableId || payload.table_id || '',
      table_label: payload.tableLabel || payload.table_label || '',
      synced_from_rollcodex_at: new Date().toISOString(),
    }, payload);
  }

  function mergeSyncedConnectionContext(existingConnection, contextPatch) {
    if (!existingConnection || existingConnection.provider !== 'roll20') return null;
    if (existingConnection.connection_id !== contextPatch.connection_id) return null;

    return {
      ...existingConnection,
      endpoint: contextPatch.endpoint || existingConnection.endpoint,
      mapping_profile_endpoint: contextPatch.mapping_profile_endpoint || existingConnection.mapping_profile_endpoint || '',
      import_boundary_endpoint: contextPatch.import_boundary_endpoint || existingConnection.import_boundary_endpoint || '',
      workspace_id: contextPatch.workspace_id || existingConnection.workspace_id || '',
      workspace_label: contextPatch.workspace_label || existingConnection.workspace_label || '',
      system_id: contextPatch.system_id || existingConnection.system_id || '',
      system_label: contextPatch.system_label || existingConnection.system_label || '',
      campaign_id: contextPatch.campaign_id || existingConnection.campaign_id || '',
      campaign_label: contextPatch.campaign_label || existingConnection.campaign_label || '',
      table_id: contextPatch.table_id || existingConnection.table_id || '',
      table_label: contextPatch.table_label || existingConnection.table_label || '',
      roll20_game_id: contextPatch.roll20_game_id || existingConnection.roll20_game_id || '',
      roll20_game_title: contextPatch.roll20_game_title || existingConnection.roll20_game_title || '',
      roll20_scope_key: contextPatch.roll20_scope_key || existingConnection.roll20_scope_key || '',
      synced_from_rollcodex_at: contextPatch.synced_from_rollcodex_at,
    };
  }

  function notifyRoll20Tab(extensionConnection) {
    return queryTabs({ url: 'https://app.roll20.net/editor*' }).then((tabs) => {
      const jobs = (tabs || [])
        .filter((tab) => tab?.id)
        .map((tab) => sendTabMessage(tab.id, { type: MESSAGE_EXTENSION_CONNECTED, connection: extensionConnection }));
      if (!jobs.length) return false;
      return Promise.all(jobs).then((results) => results.some(Boolean));
    });
  }

  function ensureRoll20ContentScriptInjected() {
    return queryTabs({ url: 'https://app.roll20.net/editor*' }).then((tabs) => {
      const jobs = (tabs || []).map((tab) => {
        if (!tab?.id) return Promise.resolve(false);
        return sendTabMessage(tab.id, { type: MESSAGE_EXTENSION_CONNECTED, connection: null })
          .then((ok) => (ok ? true : executeScriptInTab(tab.id, ['roll20-content.js'])));
      });
      return Promise.all(jobs).then(() => true);
    }).catch(() => false);
  }

  function isValidStoredRoll20Connection(connection) {
    return connection?.provider === 'roll20'
      && typeof connection.connection_id === 'string'
      && typeof connection.connection_secret === 'string'
      && isAllowedSnapshotEndpoint(connection.endpoint);
  }

  function rehydrateRoll20ConnectionFromStorage() {
    return ensureRoll20ContentScriptInjected()
      .then(() => getStoredRoll20Connections())
      .then((connections) => {
        if (!connections.length) return false;
        return Promise.all(connections.map(({ connection }) => notifyRoll20Tab(connection).catch(() => false)))
          .then((results) => results.some(Boolean));
      })
      .catch(() => false);
  }

  function parseJsonText(text) {
    try {
      return JSON.parse(text || '{}');
    } catch (_error) {
      return {};
    }
  }

  function isAllowedSnapshotEndpoint(endpoint) {
    try {
      const url = new URL(String(endpoint || ''));
      const host = url.hostname.toLowerCase();
      const isLocal = host === 'localhost' || host === '127.0.0.1';
      const isSupabase = host.endsWith('.supabase.co');
      return ['http:', 'https:'].includes(url.protocol)
        && (isLocal || isSupabase)
        && url.pathname.includes('/functions/v1/receive-vtt-snapshot');
    } catch (_error) {
      return false;
    }
  }

  function isAllowedMappingProfileEndpoint(endpoint) {
    try {
      const url = new URL(String(endpoint || ''));
      const host = url.hostname.toLowerCase();
      const isLocal = host === 'localhost' || host === '127.0.0.1';
      const isSupabase = host.endsWith('.supabase.co');
      return ['http:', 'https:'].includes(url.protocol)
        && (isLocal || isSupabase)
        && url.pathname.includes('/functions/v1/vtt-mapping-profile');
    } catch (_error) {
      return false;
    }
  }

  function isAllowedImportBoundaryEndpoint(endpoint) {
    try {
      const url = new URL(String(endpoint || ''));
      const host = url.hostname.toLowerCase();
      const isLocal = host === 'localhost' || host === '127.0.0.1';
      const isSupabase = host.endsWith('.supabase.co');
      return ['http:', 'https:'].includes(url.protocol)
        && (isLocal || isSupabase)
        && url.pathname.includes('/functions/v1/get-vtt-import-boundary');
    } catch (_error) {
      return false;
    }
  }

  function isAllowedRollCodexConnectUrl(connectUrl) {
    try {
      const url = new URL(String(connectUrl || ''));
      const host = url.hostname.toLowerCase();
      const isLocal = host === 'localhost' || host === '127.0.0.1' || host === 'localtest.me';
      const isRollCodex = host === 'rollcodex.app' || host === 'rollledger.vercel.app';
      return ['http:', 'https:'].includes(url.protocol)
        && (isLocal || isRollCodex)
        && url.pathname === '/vtt/connect/roll20'
        && url.searchParams.has('connection_id')
        && url.searchParams.has('state');
    } catch (_error) {
      return false;
    }
  }

  function isAllowedSnapshotRequest(request) {
    const payload = request?.payload;
    return request?.type === 'rollcodex:roll20-bridge-snapshot'
      && typeof request.ack_token === 'string'
      && request.ack_token.length >= 16
      && isAllowedSnapshotEndpoint(request.endpoint)
      && payload?.provider === 'roll20'
      && payload?.source_format === 'roll20_mod_json'
      && typeof payload.connection_id === 'string'
      && typeof payload.connection_secret === 'string'
      && Array.isArray(payload.messages);
  }

  function isAllowedMappingProfileRequest(request) {
    const payload = request?.payload;
    return request?.type === 'rollcodex:roll20-bridge-mapping-profile'
      && isAllowedMappingProfileEndpoint(request.endpoint)
      && payload?.provider === 'roll20'
      && typeof payload.connection_id === 'string'
      && typeof payload.connection_secret === 'string';
  }

  function isAllowedImportBoundaryRequest(request) {
    const payload = request?.payload;
    return request?.type === 'rollcodex:roll20-bridge-import-boundary'
      && isAllowedImportBoundaryEndpoint(request.endpoint)
      && payload?.provider === 'roll20'
      && typeof payload.connection_id === 'string'
      && typeof payload.connection_secret === 'string';
  }

  function sendConfirmationToRoll20(command, sendResponse) {
    if (!isAllowedRollCodexConfirmation(command)) {
      sendResponse({ ok: false, error: 'Validation Roll20 refusee par le bridge.' });
      return;
    }

    const payload = parseConfirmationCommand(command);

    getStoredPendingPairings().then((pendingEntries) => {
      const pendingEntry = (pendingEntries || []).find(({ pending }) => pending?.connectionId === payload?.connectionId && pending?.state === payload?.state) || null;
      const pendingPairing = pendingEntry?.pending || null;
      const extensionConnection = buildExtensionConnection(payload, pendingPairing);
      if (extensionConnection) {
        setStorageValues({ [getConnectionStorageKey(extensionConnection)]: extensionConnection })
          .then(() => (pendingEntry?.key ? removeStorageValue(pendingEntry.key) : true))
          .then(() => notifyRoll20Tab(extensionConnection))
          .then((notifiedRoll20Tab) => sendResponse({ ok: true, mode: 'extension', notifiedRoll20Tab, connection: extensionConnection }));
        return;
      }

      sendResponse({ ok: false, error: 'Jumelage extension introuvable. Relancez la liaison depuis le panneau RollCodex dans Roll20.' });
    });
  }

  function syncExtensionConnection(payload, sendResponse) {
    const extensionConnection = buildSyncedExtensionConnection(payload);
    if (!extensionConnection) {
      const contextPatch = buildSyncedConnectionContext(payload);
      if (!contextPatch) {
        sendResponse({ ok: false, error: 'Connexion Roll20 invalide ou endpoint refuse.' });
        return;
      }

      getStoredRoll20Connections()
        .then((storedConnections) => {
          const contextScope = contextPatch.roll20_scope_key || getConnectionScope(contextPatch);
          const stored = storedConnections.find(({ connection }) => {
            if (connection.connection_id !== contextPatch.connection_id) return false;
            if (!contextScope) return true;
            return (connection.roll20_scope_key || getConnectionScope(connection)) === contextScope;
          }) || storedConnections.find(({ connection }) => connection.connection_id === contextPatch.connection_id);
          const mergedConnection = mergeSyncedConnectionContext(stored?.connection, contextPatch);
          if (!mergedConnection) {
            sendResponse({ ok: false, error: 'Connexion Roll20 existante introuvable pour ce contexte.' });
            return null;
          }
          return setStorageValues({ [stored?.key || getConnectionStorageKey(mergedConnection)]: mergedConnection })
            .then(() => notifyRoll20Tab(mergedConnection))
            .then((notifiedRoll20Tab) => sendResponse({ ok: true, mode: 'context', notifiedRoll20Tab, connection: mergedConnection }));
        })
        .catch((error) => sendResponse({ ok: false, error: error?.message || 'Synchronisation Roll20 impossible.' }));
      return;
    }

    setStorageValues({ [getConnectionStorageKey(extensionConnection)]: extensionConnection })
      .then(() => removePendingPairingsByConnectionId(extensionConnection.connection_id))
      .then(() => notifyRoll20Tab(extensionConnection))
      .then((notifiedRoll20Tab) => sendResponse({ ok: true, notifiedRoll20Tab, connection: extensionConnection }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || 'Synchronisation Roll20 impossible.' }));
  }

  async function sendSnapshotToRollCodex(request, sendResponse) {
    if (!isAllowedSnapshotRequest(request)) {
      sendResponse({ ok: false, error: 'Capture refusee par le bridge.' });
      return;
    }

    try {
      const response = await fetch(request.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'X-RollCodex-Client': BRIDGE_CLIENT,
        },
        body: JSON.stringify(request.payload),
      });
      const text = await response.text();
      const payload = parseJsonText(text);
      if (!response.ok) {
        sendResponse({ ok: false, error: payload?.message || payload?.error || 'Capture RollCodex refusee.' });
        return;
      }
      sendResponse({ ok: true, payload });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || 'Capture RollCodex impossible.' });
    }
  }

  async function fetchMappingProfileFromRollCodex(request, sendResponse) {
    if (!isAllowedMappingProfileRequest(request)) {
      sendResponse({ ok: false, error: 'Profil de mapping refuse par le bridge.' });
      return;
    }

    try {
      const response = await fetch(request.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'X-RollCodex-Client': BRIDGE_CLIENT,
        },
        body: JSON.stringify(request.payload),
      });
      const text = await response.text();
      const payload = parseJsonText(text);
      if (!response.ok) {
        sendResponse({ ok: false, error: payload?.message || payload?.error || 'Profil RollCodex refuse.' });
        return;
      }
      sendResponse({ ok: true, payload });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || 'Profil RollCodex inaccessible.' });
    }
  }

  async function fetchImportBoundaryFromRollCodex(request, sendResponse) {
    if (!isAllowedImportBoundaryRequest(request)) {
      sendResponse({ ok: false, error: 'Borne d import refusee par le bridge.' });
      return;
    }

    try {
      const response = await fetch(request.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain;charset=UTF-8',
          'X-RollCodex-Client': BRIDGE_CLIENT,
        },
        body: JSON.stringify(request.payload),
      });
      const text = await response.text();
      const payload = parseJsonText(text);
      if (!response.ok) {
        sendResponse({ ok: false, error: payload?.message || payload?.error || 'Borne RollCodex refusee.' });
        return;
      }
      sendResponse({ ok: true, payload });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || 'Borne RollCodex inaccessible.' });
    }
  }

  function openRollCodexConnectPage(url, sendResponse) {
    if (!isAllowedRollCodexConnectUrl(url)) {
      sendResponse({ ok: false, error: 'URL de jumelage RollCodex refusee.' });
      return;
    }

    createTab(url)
      .then((tab) => sendResponse({ ok: Boolean(tab?.id), tabId: tab?.id || null }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || 'Ouverture RollCodex impossible.' }));
  }

  getExtensionApi()?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
    if (message?.type === MESSAGE_OPEN_CONNECT_PAGE) {
      openRollCodexConnectPage(message.url, sendResponse);
      return true;
    }
    if (message?.type === MESSAGE_CONFIRM) {
      sendConfirmationToRoll20(message.command, sendResponse);
      return true;
    }
    if (message?.type === MESSAGE_SYNC_CONNECTION) {
      syncExtensionConnection(message.connection, sendResponse);
      return true;
    }
    if (message?.type === MESSAGE_SEND_SNAPSHOT) {
      sendSnapshotToRollCodex(message.request, sendResponse);
      return true;
    }
    if (message?.type === MESSAGE_FETCH_MAPPING_PROFILE) {
      fetchMappingProfileFromRollCodex(message.request, sendResponse);
      return true;
    }
    if (message?.type === MESSAGE_FETCH_IMPORT_BOUNDARY) {
      fetchImportBoundaryFromRollCodex(message.request, sendResponse);
      return true;
    }
    return false;
  });

  // Rehydrate automatiquement la connexion apres refresh/restart de l'extension.
  rehydrateRoll20ConnectionFromStorage().catch(() => false);
  getExtensionApi()?.runtime?.onStartup?.addListener(() => {
    rehydrateRoll20ConnectionFromStorage().catch(() => false);
  });
  getExtensionApi()?.runtime?.onInstalled?.addListener(() => {
    rehydrateRoll20ConnectionFromStorage().catch(() => false);
  });
})();
