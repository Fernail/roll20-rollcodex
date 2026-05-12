(() => {
  const MESSAGE_CONFIRM = 'ROLLCODEX_ROLL20_CONFIRM';
  const MESSAGE_SEND_CHAT_COMMAND = 'ROLLCODEX_ROLL20_SEND_CHAT_COMMAND';
  const MESSAGE_SEND_SNAPSHOT = 'ROLLCODEX_ROLL20_SEND_SNAPSHOT';
  const MESSAGE_EXTENSION_CONNECTED = 'ROLLCODEX_ROLL20_EXTENSION_CONNECTED';
  const CONFIRM_PREFIX = '!rollcodex confirm ';
  const BRIDGE_CLIENT = 'roll20-extension/0.3.1';
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

  function buildExtensionConnection(payload, pendingPairing) {
    if (!pendingPairing || pendingPairing.connectionId !== payload.connectionId || pendingPairing.state !== payload.state) return null;
    if (!pendingPairing.connectionSecret) return null;
    return {
      provider: 'roll20',
      source_format: 'roll20_mod_json',
      connection_id: payload.connectionId,
      connection_secret: pendingPairing.connectionSecret,
      endpoint: payload.endpoint,
      mapping_profile_endpoint: payload.mappingProfileEndpoint || '',
      workspace_id: payload.workspaceId || '',
      workspace_label: payload.workspaceLabel || '',
      system_id: payload.systemId || '',
      system_label: payload.systemLabel || '',
      campaign_id: payload.campaignId || '',
      campaign_label: payload.campaignLabel || '',
      table_id: payload.tableId || '',
      table_label: payload.tableLabel || '',
      connected_at: new Date().toISOString(),
    };
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

  function sendConfirmationToRoll20(command, sendResponse) {
    if (!isAllowedRollCodexConfirmation(command)) {
      sendResponse({ ok: false, error: 'Validation Roll20 refusee par le bridge.' });
      return;
    }

    const payload = parseConfirmationCommand(command);

    getStorageValue(PENDING_PAIRING_KEY).then((pendingPairing) => {
      const extensionConnection = buildExtensionConnection(payload, pendingPairing);
      if (extensionConnection) {
        setStorageValues({ [CONNECTION_KEY]: extensionConnection }).then(() => removeStorageValue(PENDING_PAIRING_KEY)).then(() => {
          chrome.tabs.query({ url: 'https://app.roll20.net/*' }, (tabs) => {
            const targetTab = pickRoll20Tab(tabs || []);
            if (targetTab?.id) chrome.tabs.sendMessage(targetTab.id, { type: MESSAGE_EXTENSION_CONNECTED, connection: extensionConnection });
            sendResponse({ ok: true, mode: 'extension', connection: extensionConnection });
          });
        });
        return;
      }

      chrome.tabs.query({ url: 'https://app.roll20.net/*' }, (tabs) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }

        const targetTab = pickRoll20Tab(tabs);
        if (!targetTab?.id) {
          sendResponse({ ok: false, error: 'Onglet Roll20 introuvable. Ouvrez la table Roll20 puis reessayez.' });
          return;
        }

        chrome.tabs.sendMessage(targetTab.id, { type: MESSAGE_SEND_CHAT_COMMAND, command }, (response) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse(response || { ok: false, error: 'Aucune reponse de l onglet Roll20.' });
        });
      });
    });
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MESSAGE_CONFIRM) {
      sendConfirmationToRoll20(message.command, sendResponse);
      return true;
    }
    if (message?.type === MESSAGE_SEND_SNAPSHOT) {
      sendSnapshotToRollCodex(message.request, sendResponse);
      return true;
    }
    return false;
  });
})();
