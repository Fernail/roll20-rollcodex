(() => {
  const PAGE_SOURCE = 'rollcodex-app';
  const BRIDGE_SOURCE = 'rollcodex-roll20-bridge';
  const MESSAGE_CONFIRM = 'ROLLCODEX_ROLL20_CONFIRM';
  const MESSAGE_CONFIRM_RESULT = 'ROLLCODEX_ROLL20_CONFIRM_RESULT';
  const MESSAGE_PING = 'ROLLCODEX_ROLL20_BRIDGE_PING';
  const MESSAGE_READY = 'ROLLCODEX_ROLL20_BRIDGE_READY';

  function postToPage(message) {
    window.postMessage({ source: BRIDGE_SOURCE, ...message }, window.location.origin);
  }

  function replyReady(requestId = '') {
    postToPage({ type: MESSAGE_READY, requestId, ok: true });
  }

  function replyConfirmResult(requestId, response) {
    postToPage({
      type: MESSAGE_CONFIRM_RESULT,
      requestId,
      ok: Boolean(response?.ok),
      error: response?.error || '',
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== PAGE_SOURCE) return;

    if (message.type === MESSAGE_PING) {
      replyReady(message.requestId);
      return;
    }

    if (message.type !== MESSAGE_CONFIRM) return;
    chrome.runtime.sendMessage({
      type: MESSAGE_CONFIRM,
      requestId: message.requestId,
      command: message.command,
      context: message.context || {},
    }, (response) => {
      if (chrome.runtime.lastError) {
        replyConfirmResult(message.requestId, { ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      replyConfirmResult(message.requestId, response);
    });
  });

  replyReady();
})();
