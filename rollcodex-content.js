(() => {
  const PAGE_SOURCE = 'rollcodex-app';
  const BRIDGE_SOURCE = 'rollcodex-roll20-bridge';
  const MESSAGE_CONFIRM = 'ROLLCODEX_ROLL20_CONFIRM';
  const MESSAGE_CONFIRM_RESULT = 'ROLLCODEX_ROLL20_CONFIRM_RESULT';
  const MESSAGE_SYNC_CONNECTION = 'ROLLCODEX_ROLL20_SYNC_CONNECTION';
  const MESSAGE_SYNC_CONNECTION_RESULT = 'ROLLCODEX_ROLL20_SYNC_CONNECTION_RESULT';
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
      notifiedRoll20Tab: Boolean(response?.notifiedRoll20Tab),
    });
  }

  function replySyncConnectionResult(requestId, response) {
    postToPage({
      type: MESSAGE_SYNC_CONNECTION_RESULT,
      requestId,
      ok: Boolean(response?.ok),
      error: response?.error || '',
      notifiedRoll20Tab: Boolean(response?.notifiedRoll20Tab),
    });
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

  function sendRuntimeMessage(message, reply) {
    const runtime = getExtensionApi()?.runtime;
    if (!runtime?.sendMessage) {
      reply({ ok: false, error: 'Extension API unavailable.' });
      return;
    }
    callExtensionMethod(
      runtime.sendMessage.bind(runtime),
      [message],
      (response) => reply(response || { ok: false, error: 'Aucune reponse du bridge Roll20.' }),
      (error) => reply({ ok: false, error: error?.message || String(error || 'Extension API unavailable.') }),
    );
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data || {};
    if (message.source !== PAGE_SOURCE) return;

    if (message.type === MESSAGE_PING) {
      replyReady(message.requestId);
      return;
    }

    if (message.type === MESSAGE_SYNC_CONNECTION) {
      sendRuntimeMessage({
        type: MESSAGE_SYNC_CONNECTION,
        requestId: message.requestId,
        connection: message.connection || {},
      }, (response) => replySyncConnectionResult(message.requestId, response));
      return;
    }

    if (message.type !== MESSAGE_CONFIRM) return;
    sendRuntimeMessage({
      type: MESSAGE_CONFIRM,
      requestId: message.requestId,
      command: message.command,
      context: message.context || {},
    }, (response) => replyConfirmResult(message.requestId, response));
  });

  replyReady();
})();
