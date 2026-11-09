/**
 * The program that runs a script, as the source of a worker thread (see runner.ts).
 *
 * The script runs in a fresh `vm` context that holds nothing but its own language built-ins:
 * no require, no process, no timers, no network. Everything it can do arrives as the `api` object,
 * whose functions were created INSIDE that context and talk to the main process through a bridge
 * that only ever carries JSON strings. The bridge itself is kept in a closure the script cannot
 * reach, and it never rejects, so no object of the outer realm ever gets into the script's hands.
 *
 * This is a boundary against mistakes and prompt-injected code, not against a determined attacker
 * with a V8 exploit: that is why a script also needs the person's approval before it runs.
 */

/** Runs inside the context: builds the API around the bridge. */
export const BOOT_SOURCE = `(function (bridge, stateJson, inputJson) {
  var store = JSON.parse(stateJson);
  if (!store.kv) store.kv = {};
  if (!store.seen) store.seen = [];
  var fires = [];
  var logs = [];
  var call = async function (op, args) {
    var raw = await bridge(op, JSON.stringify(args === undefined ? null : args));
    var reply = JSON.parse(raw);
    if (reply.error) throw new Error(String(reply.error));
    return reply.value;
  };
  var text = function (v) { return typeof v === 'string' ? v : JSON.stringify(v); };
  var api = {
    input: JSON.parse(inputJson),
    fetch: async function (url, init) {
      var r = await call('fetch', { url: String(url), headers: init && init.headers ? init.headers : undefined, auth: init && init.auth ? init.auth : undefined });
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async function () { return r.body; },
        json: async function () { return JSON.parse(r.body); }
      };
    },
    readFile: function (path) { return call('readFile', { path: String(path) }); },
    readSheet: function (path, sheet) { return call('readSheet', { path: String(path), sheet: sheet === undefined ? undefined : String(sheet) }); },
    listFiles: function (dir) { return call('listFiles', { dir: String(dir === undefined ? '.' : dir) }); },
    state: {
      get: function (key) { return store.kv[String(key)]; },
      set: function (key, value) { store.kv[String(key)] = JSON.parse(JSON.stringify(value === undefined ? null : value)); }
    },
    seen: function (id) {
      id = String(id);
      if (store.seen.indexOf(id) !== -1) return true;
      store.seen.push(id);
      if (store.seen.length > 500) store.seen.shift();
      return false;
    },
    fire: function (payload) {
      if (fires.length < 5) fires.push(String(JSON.stringify(payload === undefined ? null : payload)).slice(0, 20000));
    },
    log: function () {
      if (logs.length >= 50) return;
      logs.push(Array.prototype.map.call(arguments, text).join(' ').slice(0, 500));
    }
  };
  return {
    api: api,
    result: function (value) { return JSON.stringify(value === undefined ? null : value); },
    snapshot: function () { return JSON.stringify({ state: store, fires: fires, logs: logs }); }
  };
})`

/** The worker thread: wires the bridge to the main process and runs the script. */
export const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
let nextId = 1;
const waiting = new Map();
parentPort.on('message', (m) => {
  if (m.type !== 'reply') return;
  const resolve = waiting.get(m.id);
  waiting.delete(m.id);
  if (resolve) resolve(m.payload);
});
function bridge(op, args) {
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    parentPort.postMessage({ type: 'call', id, op, args });
  });
}
(async () => {
  // A null-prototype sandbox: with a plain {} the global's constructor would be the OUTER
  // Object, and from it a script could reach the outer Function and with it the process.
  const context = vm.createContext(Object.create(null));
  const boot = vm.runInContext(workerData.boot, context)(bridge, workerData.state, workerData.input);
  try {
    const main = vm.runInContext(
      '(async function (api) {\\n' +
        'const { fetch, readFile, readSheet, listFiles, state, seen, fire, log, input } = api;\\n' +
        workerData.code +
        '\\n})',
      context,
      { timeout: 5000 },
    );
    // The synchronous stretch of the script is timed by running the call itself inside the vm.
    context.__main = main;
    context.__api = boot.api;
    const pending = vm.runInContext('__main(__api)', context, { timeout: 5000 });
    const value = await pending;
    parentPort.postMessage({ type: 'done', ok: true, result: boot.result(value), snapshot: boot.snapshot() });
  } catch (error) {
    parentPort.postMessage({ type: 'done', ok: false, error: String((error && error.message) || error), snapshot: boot.snapshot() });
  }
})();
`
