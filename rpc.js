function resolveHecatonMethod(method) {
  const parts = method.split('.');
  let ctx = hecaton;
  let parent = hecaton;
  for (let i = 0; i < parts.length; i++) {
    parent = ctx;
    ctx = ctx ? ctx[parts[i]] : undefined;
    if (ctx === undefined) return null;
  }
  if (typeof ctx !== 'function') return null;
  return ctx.bind(parent);
}

function sendRpc(method, params = {}) {
  const fn = resolveHecatonMethod(method);
  if (!fn) return Promise.resolve(null);
  return fn(params).then(r => r || null).catch(() => null);
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
  const fn = resolveHecatonMethod(method);
  if (!fn) return;
  fn(params).catch(() => {});
}

function handleRpcResponse() {
  // No longer needed — deno runner handles RPC responses internally
}

module.exports = { sendRpc, sendRpcBatch, sendRpcNotify, handleRpcResponse };
