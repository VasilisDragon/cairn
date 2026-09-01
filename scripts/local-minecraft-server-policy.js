import path from 'node:path';
import process from 'node:process';
import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';

const DEFAULT_LOCAL_MINECRAFT_PORTS = Object.freeze([25565, 25575]);
const DEFAULT_LINUX_TCP_TABLES = Object.freeze(['/proc/net/tcp', '/proc/net/tcp6']);

function normalizeEndpointHost(value) {
  let host = String(value ?? '').trim().toLowerCase();
  if (host.startsWith('[') || host.endsWith(']')) {
    if (!(host.startsWith('[') && host.endsWith(']'))) return '';
    host = host.slice(1, -1);
  }
  host = host.replace(/\.+$/, '');
  const zoneIndex = host.indexOf('%');
  if (zoneIndex !== -1) host = host.slice(0, zoneIndex);
  return host;
}

function ipv4Words(value) {
  return value.split('.').map((part) => Number(part));
}

function ipv6Words(value) {
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (half) => {
    if (!half) return [];
    const words = [];
    for (const part of half.split(':')) {
      if (part.includes('.')) {
        const octets = ipv4Words(part);
        if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        words.push(Number.parseInt(part, 16));
      }
    }
    return words;
  };
  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] || '');
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const omitted = 8 - left.length - right.length;
  if (omitted < 1) return null;
  return [...left, ...Array(omitted).fill(0), ...right];
}

function canonicalIp(value) {
  const host = normalizeEndpointHost(value);
  const version = isIP(host);
  if (version === 4) {
    const words = ipv4Words(host);
    return { host, version, words, key: `ipv4:${words.join('.')}` };
  }
  if (version === 6) {
    const words = ipv6Words(host);
    if (!words) return null;
    const embeddedIpv4 = words.slice(0, 5).every((word) => word === 0)
      && (words[5] === 0xffff
        || (words[5] === 0 && (words[6] !== 0 || words[7] > 1)));
    if (embeddedIpv4) {
      const ipv4 = [words[6] >>> 8, words[6] & 0xff, words[7] >>> 8, words[7] & 0xff];
      return { host, version: 4, words: ipv4, key: `ipv4:${ipv4.join('.')}` };
    }
    return { host, version, words, key: `ipv6:${words.map((word) => word.toString(16)).join(':')}` };
  }
  return null;
}

function isIntrinsicLocalIp(address) {
  if (address.version === 4) {
    return address.words[0] === 127 || address.words.every((word) => word === 0);
  }
  const words = address.words;
  if (words.every((word) => word === 0)) return true;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  return false;
}

function localIpKeys(options = {}) {
  const keys = new Set();
  const interfaces = options.networkInterfaces
    ? options.networkInterfaces()
    : os.networkInterfaces();
  for (const addresses of Object.values(interfaces || {})) {
    for (const address of addresses || []) {
      const parsed = canonicalIp(address?.address);
      if (parsed) keys.add(parsed.key);
    }
  }
  return keys;
}

function normalizePorts(values) {
  const ports = [...DEFAULT_LOCAL_MINECRAFT_PORTS, ...(values || [])]
    .map((value) => Number(value))
    .filter((value) => Number.isSafeInteger(value) && value >= 1 && value <= 65535);
  return [...new Set(ports)].sort((left, right) => left - right);
}

function powershellExecutable(env = process.env) {
  const systemRoot = env.SystemRoot || env.WINDIR || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function sleepSync(milliseconds) {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, milliseconds);
}

function parseLinuxTcpTable(contents, ports) {
  const lines = String(contents ?? '').split(/\r?\n/);
  const header = lines.shift() || '';
  if (!/\blocal_address\b/.test(header) || !/\bst\b/.test(header)) {
    throw new Error('malformed Linux TCP table header');
  }
  const listeners = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 10 || !/^[0-9a-f]+:$/i.test(fields[0])
        || !/^[0-9a-f]+:[0-9a-f]{4}$/i.test(fields[1])
        || !/^[0-9a-f]{2}$/i.test(fields[3]) || !/^\d+$/.test(fields[9])) {
      throw new Error('malformed Linux TCP table row');
    }
    if (fields[3].toUpperCase() !== '0A') continue;
    const port = Number.parseInt(fields[1].slice(-4), 16);
    if (!ports.includes(port)) continue;
    if (fields[9] === '0') throw new Error('Linux listening socket is missing an inode');
    listeners.push({ inode: fields[9], port });
  }
  return listeners;
}

function inspectLinuxLocalMinecraftListenersSync(options, ports) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  const wait = options.sleepSync || sleepSync;
  const tcpTables = options.linuxTcpTables || DEFAULT_LINUX_TCP_TABLES;
  if (!Array.isArray(tcpTables) || tcpTables.length !== 2
      || tcpTables.some((table) => typeof table !== 'string' || table.length === 0)) {
    return { state: 'unverifiable', reason: 'local_minecraft_linux_listener_tables_invalid' };
  }

  const snapshot = () => {
    const records = tcpTables.flatMap((table) => parseLinuxTcpTable(readFileSync(table, 'utf8'), ports));
    return records.sort((left, right) => left.port - right.port || left.inode.localeCompare(right.inode));
  };
  const fingerprint = (records) => records.map((record) => `${record.inode}:${record.port}`).join('|');

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = snapshot();
      wait(25);
      const second = snapshot();
      if (fingerprint(first) !== fingerprint(second)) continue;
      if (first.length === 0) return { state: 'clear', ports };

      const byInode = new Map();
      for (const record of first) {
        const listener = byInode.get(record.inode) || {
          processStartIdentity: `linux-socket-inode:${record.inode}`,
          ports: [],
        };
        listener.ports.push(record.port);
        byInode.set(record.inode, listener);
      }
      return {
        state: 'occupied',
        ports,
        listeners: [...byInode.values()].map((listener) => ({
          ...listener,
          ports: [...new Set(listener.ports)].sort((left, right) => left - right),
        })),
      };
    }
    return { state: 'unverifiable', reason: 'local_minecraft_linux_listener_identity_changed' };
  } catch {
    return { state: 'unverifiable', reason: 'local_minecraft_linux_listener_inspection_failed' };
  }
}

export function inspectLocalMinecraftListenersSync(options = {}) {
  const platform = options.platform || process.platform;
  const ports = normalizePorts(options.ports);
  if (platform === 'linux') return inspectLinuxLocalMinecraftListenersSync(options, ports);
  if (platform !== 'win32') {
    return { state: 'unverifiable', reason: 'local_minecraft_listener_policy_unsupported_platform' };
  }
  const portLiteral = ports.join(',');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ports = @(${portLiteral})
for ($attempt = 0; $attempt -lt 3; $attempt++) {
  $first = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
    Where-Object { $ports -contains [int]$_.LocalPort } |
    Sort-Object OwningProcess, LocalPort)
  if ($first.Count -eq 0) {
    Start-Sleep -Milliseconds 25
    $emptyConfirmation = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $ports -contains [int]$_.LocalPort } |
      Sort-Object OwningProcess, LocalPort)
    if ($emptyConfirmation.Count -eq 0) {
      [Console]::Out.Write(([pscustomobject]@{ state = 'clear'; listeners = @() } | ConvertTo-Json -Compress -Depth 4))
      exit 0
    }
    continue
  }
  $records = @()
  $valid = $true
  foreach ($group in @($first | Group-Object OwningProcess)) {
    $processId = [int]$group.Name
    try {
      $process = [Diagnostics.Process]::GetProcessById($processId)
      $startTicks = [int64]$process.StartTime.ToUniversalTime().Ticks
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
      if ($null -eq $cim -or [Math]::Abs([int64]$cim.CreationDate.ToUniversalTime().Ticks - $startTicks) -gt 10000) {
        $valid = $false
        break
      }
      $processAgain = [Diagnostics.Process]::GetProcessById($processId)
      if ([int64]$processAgain.StartTime.ToUniversalTime().Ticks -ne $startTicks) {
        $valid = $false
        break
      }
      $records += [pscustomobject]@{
        pid = $processId
        processStartIdentity = "windows-start-ticks:$startTicks"
        ports = @($group.Group | ForEach-Object { [int]$_.LocalPort } | Sort-Object -Unique)
      }
    } catch {
      $valid = $false
      break
    }
  }
  if ($valid) {
    $second = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $ports -contains [int]$_.LocalPort } |
      Sort-Object OwningProcess, LocalPort)
    $firstFingerprint = @($first | ForEach-Object { "$([int]$_.OwningProcess):$([int]$_.LocalPort)" }) -join '|'
    $secondFingerprint = @($second | ForEach-Object { "$([int]$_.OwningProcess):$([int]$_.LocalPort)" }) -join '|'
    if ($firstFingerprint -ceq $secondFingerprint) {
      [Console]::Out.Write(([pscustomobject]@{ state = 'occupied'; listeners = @($records) } | ConvertTo-Json -Compress -Depth 4))
      exit 0
    }
  }
  Start-Sleep -Milliseconds 25
}
[Console]::Error.Write('local Minecraft listener identity changed during validation')
exit 3
`;
  const result = (options.spawnSync || spawnSync)(powershellExecutable(options.env), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { state: 'unverifiable', reason: 'local_minecraft_listener_inspection_failed' };
  }
  try {
    const parsed = JSON.parse(String(result.stdout || ''));
    if (parsed?.state === 'clear' && Array.isArray(parsed.listeners) && parsed.listeners.length === 0) {
      return { state: 'clear', ports };
    }
    if (parsed?.state !== 'occupied' || !Array.isArray(parsed.listeners) || parsed.listeners.length === 0) {
      throw new Error('malformed listener result');
    }
    const listeners = parsed.listeners.map((listener) => {
      if (!Number.isSafeInteger(listener?.pid) || listener.pid <= 0
          || !/^windows-start-ticks:\d+$/.test(String(listener?.processStartIdentity || ''))
          || !Array.isArray(listener?.ports)
          || listener.ports.some((port) => !ports.includes(port))) {
        throw new Error('malformed listener identity');
      }
      return {
        pid: listener.pid,
        processStartIdentity: listener.processStartIdentity,
        ports: [...new Set(listener.ports)].sort((left, right) => left - right),
      };
    });
    return { state: 'occupied', ports, listeners };
  } catch {
    return { state: 'unverifiable', reason: 'local_minecraft_listener_output_malformed' };
  }
}

export function assertNoUncontrolledLocalMinecraftServerSync(options = {}) {
  const host = normalizeEndpointHost(options.host);
  if (options.denyLocalEndpoint === true) {
    const address = canonicalIp(host);
    if (!address) {
      throw new Error(`unable to prove Minecraft/RCON endpoint ${host || '<empty>'} is remote: Phase-1 live tests require a validated non-local IP literal`);
    }
    if (isIntrinsicLocalIp(address) || localIpKeys(options).has(address.key)) {
      throw new Error(`local Minecraft/RCON endpoint ${host} is disabled by the Phase-1 resource policy; use a remote private server or keep the live test off`);
    }
    return { applied: true, state: 'remote', policy: 'phase1_remote_server_only' };
  }
  if (host) {
    const address = canonicalIp(host);
    const localNames = new Set(['localhost', os.hostname().toLowerCase().replace(/\.+$/, '')]);
    if (address && !isIntrinsicLocalIp(address) && !localIpKeys(options).has(address.key)) {
      return { applied: true, state: 'remote', policy: 'phase1_remote_server_only' };
    }
    if (!address && !localNames.has(host)) {
      return { applied: true, state: 'remote', policy: 'phase1_remote_server_only' };
    }
  }
  const observation = (options.inspectListeners || inspectLocalMinecraftListenersSync)(options);
  if (observation?.state === 'clear') {
    return { applied: true, state: 'clear', policy: 'phase1_no_local_server' };
  }
  if (observation?.state === 'occupied') {
    const summary = observation.listeners
      .map((listener) => `${Number.isSafeInteger(listener.pid) ? `pid=${listener.pid}` : listener.processStartIdentity} ports=${listener.ports.join(',')}`)
      .join('; ');
    throw new Error(`local Minecraft/Paper server is outside Phase-1 resource control (${summary}); stop it and keep live/RCON tests disabled while interactive applications are active`);
  }
  throw new Error(`unable to prove that no uncontrolled local Minecraft/Paper server is running (${observation?.reason || 'unknown'})`);
}
