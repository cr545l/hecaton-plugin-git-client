function sendRpc(method, params = {}) {
  return hecaton[method](params).then(r => r || null).catch(() => null);
}

function sendRpcBatch(calls, timeout) {
  const promises = calls.map(c => sendRpc(c.method, c.params || {}));
  const timeoutMs = timeout || 5000;
  return Promise.race([
    Promise.all(promises),
    new Promise(resolve => setTimeout(() => resolve(calls.map(() => null)), timeoutMs)),
  ]);
}

function sendRpcNotify(method, params = {}) {
  hecaton[method](params).catch(() => {});
}

function handleRpcResponse() {
  // No longer needed — deno runner handles RPC responses internally
}

module.exports = { sendRpc, sendRpcBatch, sendRpcNotify, handleRpcResponse };
