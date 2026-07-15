import { runInContext } from "node:vm";

const NOW_UNAVAILABLE_MESSAGE =
  "Date.now() / new Date() are unavailable in workflow scripts (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.";
const RANDOM_UNAVAILABLE_MESSAGE =
  "Math.random() is unavailable in workflow scripts (breaks resume). For N independent samples, include the index in the agent label or prompt.";

export function applyWorkflowSandbox(context: object): void {
  runInContext(buildSandboxBootstrap(), context);
}

function buildSandboxBootstrap(): string {
  return `(() => {
    const NOW_ERR = ${JSON.stringify(NOW_UNAVAILABLE_MESSAGE)};
    const RANDOM_ERR = ${JSON.stringify(RANDOM_UNAVAILABLE_MESSAGE)};
    Math.random = function random() { throw new Error(RANDOM_ERR); };
    const RealDate = Date;
    function ShimDate(...args) {
      if (!new.target) throw new Error(NOW_ERR);
      if (args.length === 0) throw new Error(NOW_ERR);
      return Reflect.construct(RealDate, args, new.target);
    }
    ShimDate.now = function now() { throw new Error(NOW_ERR); };
    ShimDate.parse = RealDate.parse;
    ShimDate.UTC = RealDate.UTC;
    ShimDate.prototype = Object.create(RealDate.prototype);
    ShimDate.prototype.constructor = ShimDate;
    globalThis.Date = ShimDate;
    Object.defineProperty(Error, 'prepareStackTrace', {
      value: (err, sites) => String(err.stack ?? err),
      writable: false, configurable: false,
    });
    function enableOverride(proto, key) {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (!d || 'get' in d) return;
      const v = d.value;
      Object.defineProperty(proto, key, {
        get() { return v; },
        set(nv) {
          if (this === proto) return;
          Object.defineProperty(this, key, { value: nv, writable: true, enumerable: true, configurable: true });
        },
        enumerable: d.enumerable, configurable: true,
      });
    }
    const errorCtors = [Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError, AggregateError, globalThis.SuppressedError].filter(Boolean);
    const errorProtos = errorCtors.map((C) => C.prototype);
    for (const [proto, keys] of [
      [Object.prototype, Object.getOwnPropertyNames(Object.prototype)],
      [Function.prototype, ['toString', 'constructor', 'name', 'length']],
      [Array.prototype, ['toString', 'constructor']],
      [Date.prototype, ['toString', 'toLocaleString', 'valueOf', 'constructor']],
      ...errorProtos.map((p) => [p, ['name', 'message', 'toString', 'constructor']]),
    ]) for (const k of keys) enableOverride(proto, k);
    for (const C of [Promise, Object, Array, Function, globalThis.Iterator,
                     Map, Set, WeakMap, WeakSet, String, Number, Boolean, Symbol, BigInt,
                     Date, RegExp, ArrayBuffer, DataView, ...errorCtors,
                     typeof URL !== 'undefined' ? URL : undefined].filter(Boolean)) {
      Object.freeze(C);
      Object.freeze(C.prototype);
    }
    for (const C of [Object.getPrototypeOf(Int8Array),
                     Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
                     Int32Array, Uint32Array, globalThis.Float16Array, Float32Array, Float64Array,
                     BigInt64Array, BigUint64Array].filter(Boolean)) {
      Object.freeze(C);
      Object.freeze(C.prototype);
    }
    for (const f of [async () => {}, function* () {}, async function* () {}]) {
      Object.freeze(f.constructor);
      Object.freeze(f.constructor.prototype);
    }
    for (const C of [globalThis.DisposableStack, globalThis.AsyncDisposableStack, globalThis.Intl].filter(Boolean)) {
      Object.freeze(C);
      if (C.prototype) Object.freeze(C.prototype);
    }
    if (typeof Intl !== 'undefined') {
      for (const k of Object.getOwnPropertyNames(Intl)) {
        const C = Intl[k];
        if (typeof C === 'function') { Object.freeze(C); if (C.prototype) Object.freeze(C.prototype); }
      }
    }
    for (const it of [
      [][Symbol.iterator](), ''[Symbol.iterator](),
      new Map()[Symbol.iterator](), new Set()[Symbol.iterator](),
      'a'.matchAll(/a/g),
      ...(typeof Iterator !== 'undefined' && Iterator.from ? [
        [].values().map((x) => x),
        Iterator.from({ next: () => ({ done: true }) }),
      ] : []),
      (function* () {})(),
      (async function* () {})(),
      ...(typeof Intl !== 'undefined' && Intl.Segmenter ? ((s) => [s, s[Symbol.iterator]()])(new Intl.Segmenter().segment('a')) : []),
    ]) {
      for (let p = Object.getPrototypeOf(it); p; p = Object.getPrototypeOf(p)) Object.freeze(p);
    }
    for (const namespace of [JSON, Math, Reflect, Proxy]) Object.freeze(namespace);
    for (const dangerousGlobal of ['ShadowRealm', 'WebAssembly', 'FinalizationRegistry',
                     'WeakRef', 'Atomics', 'SharedArrayBuffer', 'queueMicrotask',
                     '$vm', 'gc', 'edenGC', 'fullGC', 'print', 'readFile', 'Loader']) {
      delete globalThis[dangerousGlobal];
    }
    globalThis.process = undefined;
    globalThis.require = undefined;
    globalThis.module = undefined;
    globalThis.exports = undefined;
    globalThis.Bun = undefined;
    globalThis.eval = undefined;
    globalThis.Function = undefined;
    Object.defineProperty(globalThis, 'then', {
      value: undefined, writable: false, configurable: false,
    });
  })()`;
}
