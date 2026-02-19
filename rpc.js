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

function sendRpcNotify(method, params = {}) {
  const id = ++rpcIdCounter;
  const rpc = JSON.stringify({ jsonrpc: '2.0', method, params, id });
  process.stderr.write('__HECA_RPC__' + rpc + '\n');
}

function handleRpcResponse(json) {
  if (json.id != null && pendingRpc.has(json.id)) {
    const resolve = pendingRpc.get(json.id);
    pendingRpc.delete(json.id);
    resolve(json.result || null);
  }
}

module.exports = { sendRpc, sendRpcNotify, handleRpcResponse };
