let rpcIdCounter = 0;
const pendingRpc = new Map();

function sendRpc(method, params = {}) {
  const id = ++rpcIdCounter;
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
  return new Promise((resolve) => {
    pendingRpc.set(id, resolve);
    setTimeout(() => {
      if (pendingRpc.has(id)) {
        pendingRpc.delete(id);
        resolve(null);
      }
    }, 3000);
  });
}

function sendRpcBatch(calls, timeout) {
  const batch = calls.map(c => {
    const id = ++rpcIdCounter;
    return { jsonrpc: '2.0', method: c.method, params: c.params || {}, id };
  });
  const ids = batch.map(b => b.id);
  process.stderr.write('__HECA_RPC__' + JSON.stringify(batch) + '\n');
  const timeoutMs = timeout || 5000;
  return new Promise((resolve) => {
    const results = new Array(ids.length).fill(null);
    let remaining = ids.length;
    let resolved = false;
    const timer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      for (const id of ids) pendingRpc.delete(id);
      resolve(results);
    }, timeoutMs);
    for (let i = 0; i < ids.length; i++) {
      pendingRpc.set(ids[i], (result) => {
        results[i] = result;
        remaining--;
        if (remaining <= 0 && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(results);
        }
      });
    }
  });
}

function sendRpcNotify(method, params = {}) {
  const id = ++rpcIdCounter;
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
}

function handleRpcResponse(json) {
  if (Array.isArray(json)) {
    for (const item of json) {
      if (item && item.id != null && pendingRpc.has(item.id)) {
        const resolve = pendingRpc.get(item.id);
        pendingRpc.delete(item.id);
        resolve(item.result || null);
      }
    }
    return;
  }
  if (json.id != null && pendingRpc.has(json.id)) {
    const resolve = pendingRpc.get(json.id);
    pendingRpc.delete(json.id);
    resolve(json.result || null);
  }
}

module.exports = { sendRpc, sendRpcBatch, sendRpcNotify, handleRpcResponse };
