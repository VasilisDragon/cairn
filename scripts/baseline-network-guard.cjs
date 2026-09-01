'use strict';

// Loaded into every Node child with NODE_OPTIONS. Baseline Node processes must
// remain offline even when a future test accidentally reaches a provider or
// live server. Loopback and local IPC remain available to test harnesses.
const deny = (operation) => {
  throw new Error(`baseline network guard blocked ${operation}`);
};

// Capture every mutable primordial used by a run-time authorization decision.
// Test code runs after this preload and may replace public prototype methods;
// those replacements must never weaken the guard.
const nativeReflectApply = Reflect.apply;
const NativeString = String;
const NativeNumber = Number;
const NativeSymbol = Symbol;
const nativeSymbolFor = Symbol.for;
const nativeStringSlice = String.prototype.slice;
const nativeStringStartsWith = String.prototype.startsWith;
const nativeStringToLowerCase = String.prototype.toLowerCase;
const nativeRegExpTest = RegExp.prototype.test;
const nativeNextTick = process.nextTick;
const runtimePlatform = process.platform;
const nativeObjectCreate = Object.create;
const nativeObjectDefineProperty = Object.defineProperty;
const nativeObjectFreeze = Object.freeze;
const nativeObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;

function applyNative(fn, receiver, args) {
  return nativeReflectApply(fn, receiver, args);
}

function stringSlice(value, start, end) {
  return applyNative(nativeStringSlice, value, [start, end]);
}

function stringStartsWith(value, prefix) {
  return applyNative(nativeStringStartsWith, value, [prefix]);
}

function lowercase(value) {
  return applyNative(nativeStringToLowerCase, NativeString(value), []);
}

function regexMatches(expression, value) {
  return applyNative(nativeRegExpTest, expression, [value]);
}

function snapshotOptions(value) {
  // Object spread invokes each enumerable own getter once and defines plain
  // data properties. A null prototype prevents later prototype pollution from
  // changing the destination seen by a native connector.
  return { __proto__: null, ...value };
}

function defineArrayValue(target, index, value) {
  nativeObjectDefineProperty(target, NativeString(index), {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
}

function prependAndTail(first, source, startIndex = 1) {
  const result = [first];
  for (let index = startIndex; index < source.length; index += 1) {
    defineArrayValue(result, result.length, source[index]);
  }
  return result;
}

const net = require('node:net');
const originalSocketConnect = net.Socket.prototype.connect;
const nativeNetIsIP = net.isIP;
const NativeBlockList = net.BlockList;
const nativeBlockListCheck = NativeBlockList.prototype.check;
const loopbackRanges = new NativeBlockList();
loopbackRanges.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackRanges.addAddress('::1', 'ipv6');
loopbackRanges.addSubnet('::ffff:7f00:0', 104, 'ipv6');

function classifyLoopbackHost(host) {
  if (host === undefined || host === null || host === '') {
    return { allowed: true, kind: 'localhost', host: 'localhost', family: 0 };
  }
  if (typeof host !== 'string') return { allowed: false };
  const unbracketed = host.length >= 2 && host[0] === '[' && host[host.length - 1] === ']'
    ? stringSlice(host, 1, -1)
    : host;
  if (lowercase(unbracketed) === 'localhost') {
    return { allowed: true, kind: 'localhost', host: 'localhost', family: 0 };
  }
  const family = nativeNetIsIP(unbracketed);
  if (family === 0) return { allowed: false };
  const type = family === 4 ? 'ipv4' : 'ipv6';
  return {
    allowed: applyNative(nativeBlockListCheck, loopbackRanges, [unbracketed, type]),
    kind: 'literal',
    host: unbracketed,
    family,
  };
}

function isLoopback(host) {
  return classifyLoopbackHost(host).allowed === true;
}

function normalizedLookupFamily(value, operation) {
  if (value === undefined || value === null || value === 0) return 0;
  if (value === 4 || value === 6) return value;
  deny(`${operation} with unsupported address family`);
}

function pinnedLoopbackResult(hostname, rawOptions, operation) {
  const target = classifyLoopbackHost(hostname);
  if (!target.allowed) deny(`${operation} for non-loopback host`);
  const options = typeof rawOptions === 'number'
    ? { __proto__: null, family: rawOptions }
    : snapshotOptions(rawOptions || {});
  const requestedFamily = normalizedLookupFamily(options.family, operation);
  if (target.kind === 'localhost') {
    const family = requestedFamily === 6 ? 6 : 4;
    return { address: family === 6 ? '::1' : '127.0.0.1', family, all: options.all === true };
  }
  if (requestedFamily !== 0 && requestedFamily !== target.family) {
    deny(`${operation} with mismatched address family`);
  }
  return { address: target.host, family: target.family, all: options.all === true };
}

function loopbackOnlyLookup(hostname, options, callback) {
  let lookupOptions = options;
  let done = callback;
  if (typeof options === 'function') {
    done = options;
    lookupOptions = {};
  }
  if (typeof done !== 'function') throw new TypeError('loopback lookup requires a callback');
  const result = pinnedLoopbackResult(hostname, lookupOptions, 'loopback lookup');
  nativeNextTick(() => {
    if (result.all) done(null, [{ address: result.address, family: result.family }]);
    else done(null, result.address, result.family);
  });
}

function isProvenLocalIpcPath(socketPath) {
  if (typeof socketPath !== 'string' || !socketPath
      || regexMatches(/[\u0000\r\n]/, socketPath)) return false;
  if (runtimePlatform !== 'win32') return true;
  // On Windows, arbitrary UNC paths may address a remote SMB named pipe.
  // Only the explicit local-machine pipe namespace is safe for the baseline.
  return regexMatches(/^\\\\\.\\pipe\\[^\u0000\r\n]+$/i, socketPath);
}

function socketTarget(args, operation) {
  const first = args.length > 0 ? args[0] : undefined;
  if (typeof first === 'string') {
    if (!isProvenLocalIpcPath(first)) deny(`${operation} to remote or ambiguous IPC path`);
    return { localIpc: true, host: null, shape: 'ipc' };
  }
  if (typeof first === 'number') {
    let optionIndex = -1;
    for (let index = 1; index < args.length; index += 1) {
      if (args[index] && typeof args[index] === 'object') {
        optionIndex = index;
        break;
      }
    }
    const options = optionIndex >= 0 ? args[optionIndex] : null;
    if (options?.host !== undefined && options?.hostname !== undefined
        && lowercase(options.host) !== lowercase(options.hostname)) {
      deny(`${operation} with ambiguous supplemental host and hostname`);
    }
    const positionalHost = args.length > 1 && typeof args[1] === 'string' ? args[1] : null;
    const supplementalHost = options?.host ?? options?.hostname ?? null;
    if (positionalHost !== null && supplementalHost !== null
        && lowercase(positionalHost) !== lowercase(supplementalHost)) {
      deny(`${operation} with conflicting positional and supplemental hosts`);
    }
    return {
      localIpc: false,
      host: positionalHost ?? supplementalHost ?? 'localhost',
      optionIndex,
      shape: 'port',
    };
  }
  if (first && typeof first === 'object') {
    if (typeof first.path === 'string') {
      if (!isProvenLocalIpcPath(first.path)) deny(`${operation} to remote or ambiguous IPC path`);
      return { localIpc: true, host: null, path: first.path, shape: 'options' };
    }
    if (first.host !== undefined && first.hostname !== undefined
        && lowercase(first.host) !== lowercase(first.hostname)) {
      deny('socket connection with ambiguous host and hostname');
    }
    return { localIpc: false, host: first.host ?? first.hostname ?? 'localhost', shape: 'options' };
  }
  return { localIpc: false, host: 'localhost', shape: 'unknown' };
}

function prepareSocketArgs(args, operation) {
  // Snapshot caller options once. Accessors and Proxies must not present one
  // target during validation and another when the native connector reads it.
  const preparedInput = [];
  let objectCount = 0;
  let containsTransportSocket = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const prepared = value && typeof value === 'object' ? snapshotOptions(value) : value;
    defineArrayValue(preparedInput, index, prepared);
    if (prepared && typeof prepared === 'object') {
      objectCount += 1;
      if (prepared.socket !== undefined) containsTransportSocket = true;
    }
  }
  const tlsOperation = operation === 'tls.connect';
  if (tlsOperation && containsTransportSocket) {
    deny(`${operation} with caller-supplied transport socket`);
  }
  if (tlsOperation && preparedInput.length > 0
      && preparedInput[0] && typeof preparedInput[0] === 'object'
      && objectCount > 1) {
    // tls.connect(options, callback) has no legitimate second options object;
    // Node's permissive normalizer would merge it after the validated target.
    deny(`${operation} with supplemental options after primary options`);
  }
  if (tlsOperation && typeof preparedInput[0] !== 'object' && objectCount > 1) {
    deny(`${operation} with multiple supplemental options objects`);
  }
  const target = socketTarget(preparedInput, operation);
  if (target.localIpc) {
    if (target.shape !== 'options') {
      for (let index = 1; index < preparedInput.length; index += 1) {
        const value = preparedInput[index];
        if (!value || typeof value !== 'object') continue;
        const destinationNames = ['path', 'host', 'hostname', 'port', 'lookup'];
        for (let nameIndex = 0; nameIndex < destinationNames.length; nameIndex += 1) {
          const name = destinationNames[nameIndex];
          if (value[name] !== undefined) deny(`${operation} with supplemental destination override`);
        }
      }
      return preparedInput;
    }
    const options = snapshotOptions(preparedInput[0]);
    options.path = target.path;
    delete options.host;
    delete options.hostname;
    delete options.port;
    return prependAndTail(options, preparedInput);
  }
  const classified = classifyLoopbackHost(target.host);
  if (!classified.allowed) deny(`${operation} to non-loopback host`);
  if (target.shape === 'options') {
    const supplied = preparedInput[0];
    if ('lookup' in supplied && supplied.lookup !== undefined) {
      deny(`${operation} with caller-supplied lookup`);
    }
    const options = snapshotOptions(supplied);
    normalizedLookupFamily(options.family, operation);
    options.host = classified.host;
    delete options.hostname;
    delete options.path;
    if (classified.kind === 'localhost') options.lookup = loopbackOnlyLookup;
    return prependAndTail(options, preparedInput);
  }
  if (target.shape === 'port') {
    let prepared = [];
    for (let index = 0; index < preparedInput.length; index += 1) {
      defineArrayValue(prepared, index, preparedInput[index]);
    }
    const pinnedHost = classified.kind === 'localhost' ? '127.0.0.1' : classified.host;
    let optionIndex = target.optionIndex;
    if (prepared.length > 1 && typeof prepared[1] === 'string') {
      defineArrayValue(prepared, 1, pinnedHost);
    }
    else {
      const expanded = [prepared[0], pinnedHost];
      for (let index = 1; index < prepared.length; index += 1) {
        defineArrayValue(expanded, expanded.length, prepared[index]);
      }
      prepared = expanded;
      if (optionIndex >= 1) optionIndex += 1;
    }
    if (optionIndex >= 0) {
      const supplied = prepared[optionIndex];
      if ('lookup' in supplied && supplied.lookup !== undefined) {
        deny(`${operation} with caller-supplied lookup`);
      }
      if (supplied.path !== undefined) {
        deny(`${operation} with supplemental IPC path`);
      }
      if (supplied.port !== undefined && NativeNumber(supplied.port) !== NativeNumber(preparedInput[0])) {
        deny(`${operation} with conflicting supplemental port`);
      }
      normalizedLookupFamily(supplied.family, operation);
      defineArrayValue(prepared, optionIndex, snapshotOptions(supplied));
      delete prepared[optionIndex].host;
      delete prepared[optionIndex].hostname;
      delete prepared[optionIndex].path;
      delete prepared[optionIndex].port;
      delete prepared[optionIndex].lookup;
    }
    return prepared;
  }
  deny(`${operation} with unsupported socket arguments`);
}

net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  return applyNative(originalSocketConnect, this, prepareSocketArgs(args, 'net.Socket.connect'));
};
net.connect = (...args) => {
  const socket = new net.Socket();
  return applyNative(originalSocketConnect, socket, prepareSocketArgs(args, 'net.connect'));
};
net.createConnection = net.connect;

const tls = require('node:tls');
const originalTlsConnect = tls.connect;
tls.connect = (...args) => {
  return applyNative(originalTlsConnect, tls, prepareSocketArgs(args, 'tls.connect'));
};

const dgram = require('node:dgram');
dgram.createSocket = (..._args) => deny('dgram.createSocket');
if (typeof dgram._createSocketHandle === 'function') {
  dgram._createSocketHandle = (..._args) => deny('dgram._createSocketHandle');
}
for (const name of ['connect', 'send']) {
  dgram.Socket.prototype[name] = (..._args) => deny(`dgram.Socket.${name}`);
}
function DisabledDatagramSocket() { return deny('dgram.Socket'); }
Object.defineProperty(DisabledDatagramSocket, 'prototype', {
  configurable: false,
  writable: false,
  value: Object.freeze(Object.create(null, {
    constructor: { configurable: false, enumerable: false, writable: false, value: DisabledDatagramSocket },
  })),
});
dgram.Socket = Object.freeze(DisabledDatagramSocket);

const dns = require('node:dns');
dns.lookup = loopbackOnlyLookup;
const isDnsEgressMethod = (name) => name === 'resolve'
  || stringStartsWith(name, 'resolve')
  || name === 'reverse'
  || name === 'lookupService'
  || name === 'setServers';

const guardedDnsMethod = Symbol('baselineGuardedDnsMethod');

function denyDnsEgressMethods(target, label) {
  for (let current = target; current && current !== Object.prototype; current = Object.getPrototypeOf(current)) {
    for (const name of Object.getOwnPropertyNames(current)) {
      if (!isDnsEgressMethod(name) || typeof current[name] !== 'function') continue;
      if (current[name][guardedDnsMethod] === true) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (!descriptor || (!descriptor.configurable && (!('value' in descriptor) || !descriptor.writable))) {
        throw new Error(`baseline network guard could not patch ${label}.${name}`);
      }
      const blocked = (..._args) => deny(`${label}.${name}`);
      Object.defineProperty(blocked, guardedDnsMethod, { value: true });
      try {
        Object.defineProperty(current, name, {
          configurable: false,
          enumerable: descriptor.enumerable === true,
          writable: false,
          value: blocked,
        });
      } catch {
        throw new Error(`baseline network guard could not patch ${label}.${name}`);
      }
    }
  }
}
denyDnsEgressMethods(dns, 'dns');
if (typeof dns.Resolver === 'function') denyDnsEgressMethods(dns.Resolver.prototype, 'dns.Resolver');
if (dns.promises) {
  dns.promises.lookup = async (hostname, options = {}) => {
    const result = pinnedLoopbackResult(hostname, options, 'dns.promises.lookup');
    return result.all
      ? [{ address: result.address, family: result.family }]
      : { address: result.address, family: result.family };
  };
  denyDnsEgressMethods(dns.promises, 'dns.promises');
  if (typeof dns.promises.Resolver === 'function') {
    denyDnsEgressMethods(dns.promises.Resolver.prototype, 'dns.promises.Resolver');
  }
}

if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  const NativeRequest = globalThis.Request;
  const NativeURL = globalThis.URL;
  const nativeRequestUrlGetter = typeof NativeRequest === 'function'
    ? nativeObjectGetOwnPropertyDescriptor(NativeRequest.prototype, 'url')?.get
    : null;
  const nativeRequestRedirectGetter = typeof NativeRequest === 'function'
    ? nativeObjectGetOwnPropertyDescriptor(NativeRequest.prototype, 'redirect')?.get
    : null;
  const nativeUrlHrefGetter = typeof NativeURL === 'function'
    ? nativeObjectGetOwnPropertyDescriptor(NativeURL.prototype, 'href')?.get
    : null;
  const nativeUrlProtocolGetter = typeof NativeURL === 'function'
    ? nativeObjectGetOwnPropertyDescriptor(NativeURL.prototype, 'protocol')?.get
    : null;
  const nativeUrlHostnameGetter = typeof NativeURL === 'function'
    ? nativeObjectGetOwnPropertyDescriptor(NativeURL.prototype, 'hostname')?.get
    : null;
  const nativeUrlPortGetter = typeof NativeURL === 'function'
    ? nativeObjectGetOwnPropertyDescriptor(NativeURL.prototype, 'port')?.get
    : null;

  function parseNativeNetworkUrl(rawUrl, operation) {
    if (typeof NativeURL !== 'function' || typeof nativeUrlHrefGetter !== 'function'
        || typeof nativeUrlProtocolGetter !== 'function'
        || typeof nativeUrlHostnameGetter !== 'function'
        || typeof nativeUrlPortGetter !== 'function') {
      deny(`${operation} without immutable native URL accessors`);
    }
    let serialized;
    if (typeof rawUrl === 'string') serialized = rawUrl;
    else {
      try {
        serialized = applyNative(nativeUrlHrefGetter, rawUrl, []);
      } catch {
        deny(`${operation} with an untrusted URL object`);
      }
    }
    let url;
    try {
      url = new NativeURL(serialized);
    } catch {
      deny(`${operation} with an invalid URL`);
    }
    const protocol = applyNative(nativeUrlProtocolGetter, url, []);
    const hostname = applyNative(nativeUrlHostnameGetter, url, []);
    const port = applyNative(nativeUrlPortGetter, url, []);
    if (protocol !== 'http:' && protocol !== 'https:') {
      deny(`${operation} with a non-HTTP protocol`);
    }
    const classified = classifyLoopbackHost(hostname);
    if (!classified.allowed) deny(`${operation} to non-loopback host`);
    return { classified, hostname, port, protocol, url };
  }

  function pinnedOrigin(parts) {
    let host = parts.classified.kind === 'localhost' ? '127.0.0.1' : parts.classified.host;
    if (parts.classified.family === 6) host = `[${host}]`;
    return `${parts.protocol}//${host}${parts.port ? `:${parts.port}` : ''}`;
  }

  const dispatcherSymbol = applyNative(nativeSymbolFor, NativeSymbol, ['undici.globalDispatcher.1']);
  const originalDispatcher = globalThis[dispatcherSymbol];
  const originalDispatch = originalDispatcher?.dispatch;
  if (!originalDispatcher || typeof originalDispatch !== 'function') {
    deny('fetch without a controllable native dispatcher');
  }
  const guardedDispatcher = nativeObjectCreate(null);
  nativeObjectDefineProperty(guardedDispatcher, 'dispatch', {
    configurable: false,
    enumerable: true,
    writable: false,
    value(options, handler) {
      if (!options || typeof options !== 'object') deny('dispatcher without request options');
      const guardedOptions = snapshotOptions(options);
      const origin = parseNativeNetworkUrl(guardedOptions.origin, 'dispatcher');
      guardedOptions.origin = pinnedOrigin(origin);
      delete guardedOptions.dispatcher;
      return applyNative(originalDispatch, originalDispatcher, [guardedOptions, handler]);
    },
  });
  nativeObjectFreeze(guardedDispatcher);
  const dispatcherDescriptor = nativeObjectGetOwnPropertyDescriptor(globalThis, dispatcherSymbol);
  if (dispatcherDescriptor && dispatcherDescriptor.configurable === false
      && (!('value' in dispatcherDescriptor) || dispatcherDescriptor.writable !== true)) {
    deny('fetch whose native dispatcher cannot be replaced');
  }
  nativeObjectDefineProperty(globalThis, dispatcherSymbol, {
    configurable: false,
    enumerable: dispatcherDescriptor?.enumerable === true,
    writable: false,
    value: guardedDispatcher,
  });
  if (globalThis[dispatcherSymbol] !== guardedDispatcher) {
    deny('fetch whose native dispatcher replacement did not stick');
  }

  globalThis.fetch = (input, init) => {
    if (typeof NativeRequest !== 'function' || typeof NativeURL !== 'function'
        || typeof nativeRequestUrlGetter !== 'function'
        || typeof nativeRequestRedirectGetter !== 'function'
        || typeof nativeUrlHrefGetter !== 'function'
        || typeof nativeUrlProtocolGetter !== 'function'
        || typeof nativeUrlHostnameGetter !== 'function'
        || typeof nativeUrlPortGetter !== 'function') {
      deny('fetch without immutable native URL accessors');
    }
    // Normalize through the captured native Request. Never trust an arbitrary
    // object's overridable `url` property, and drop non-standard dispatcher
    // hooks that are not represented by Request state.
    const request = new NativeRequest(input, init);
    const requestUrl = applyNative(nativeRequestUrlGetter, request, []);
    parseNativeNetworkUrl(requestUrl, 'fetch');
    // Native fetch follows redirects internally, beyond this wrapper. Force
    // manual mode so a loopback response can never redirect to another host,
    // and overwrite any caller-supplied Undici dispatcher.
    const redirect = applyNative(nativeRequestRedirectGetter, request, []);
    const guardedRequest = new NativeRequest(request, {
      __proto__: null,
      dispatcher: guardedDispatcher,
      redirect: redirect === 'follow' ? 'manual' : redirect,
    });
    if (applyNative(nativeRequestRedirectGetter, guardedRequest, []) === 'follow') {
      deny('fetch whose redirect policy could not be pinned');
    }
    return originalFetch(guardedRequest, { __proto__: null, dispatcher: guardedDispatcher });
  };
}

function disableGlobalNetworkTransport(name) {
  if (typeof globalThis[name] !== 'function') return;
  const DisabledTransport = function disabledNetworkTransport() { return deny(`${name} is disabled`); };
  Object.defineProperty(DisabledTransport, 'prototype', {
    configurable: false,
    writable: false,
    value: Object.freeze(Object.create(null, {
      constructor: { configurable: false, enumerable: false, writable: false, value: DisabledTransport },
    })),
  });
  globalThis[name] = Object.freeze(DisabledTransport);
}

disableGlobalNetworkTransport('WebSocket');
disableGlobalNetworkTransport('EventSource');

// NODE_OPTIONS preloads this CommonJS guard before either CommonJS or ESM test
// code. Synchronize mutated builtin exports so ESM named imports cannot retain
// the original unguarded socket and DNS functions.
require('node:module').syncBuiltinESMExports();
