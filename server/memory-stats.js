import fs from 'fs/promises';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function roundPercent(usedBytes, totalBytes) {
  return totalBytes > 0
    ? Number(((usedBytes / totalBytes) * 100).toFixed(1))
    : 0;
}

function clampBytes(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function buildSnapshot({
  totalBytes,
  usedBytes,
  freeBytes,
  availableBytes,
  cachedBytes = 0,
  source,
}) {
  const total = Math.max(Math.trunc(totalBytes || 0), 0);
  const used = clampBytes(Math.trunc(usedBytes || 0), 0, total);
  const free = clampBytes(Math.trunc(freeBytes || 0), 0, total);
  const cached = clampBytes(Math.trunc(cachedBytes || 0), 0, total);
  const available = clampBytes(
    Math.trunc(Number.isFinite(availableBytes) ? availableBytes : total - used),
    0,
    total,
  );

  return {
    memory_total_bytes: total,
    memory_used_bytes: used,
    memory_free_bytes: free,
    memory_usage_percent: roundPercent(used, total),
    memory_available_bytes: available,
    memory_cached_bytes: cached,
    memory_stats_source: source,
  };
}

function parseVmStatCounters(output) {
  const pageSizeMatch = output.match(/page size of\s+(\d+)\s+bytes/i);
  const pageSize = pageSizeMatch ? Number.parseInt(pageSizeMatch[1], 10) : 4096;
  const counters = {};

  for (const line of output.split('\n')) {
    const match = line.match(/^\s*([^:]+):\s+([0-9.]+)\.?/);
    if (!match) continue;
    const key = match[1].trim();
    const value = Number.parseInt(match[2].replace(/\./g, ''), 10);
    if (Number.isFinite(value)) counters[key] = value;
  }

  return { pageSize, counters };
}

function counterBytes(counters, pageSize, names) {
  return names.reduce((total, name) => total + ((counters[name] || 0) * pageSize), 0);
}

function snapshotFromVmStat(output, totalBytes = os.totalmem()) {
  const { pageSize, counters } = parseVmStatCounters(output);
  const anonymousBytes = counterBytes(counters, pageSize, ['Anonymous pages']);
  const wiredBytes = counterBytes(counters, pageSize, ['Pages wired down']);
  const compressedBytes = counterBytes(counters, pageSize, ['Pages occupied by compressor']);
  const cachedBytes = counterBytes(counters, pageSize, ['File-backed pages', 'Pages purgeable']);
  const freeBytes = counterBytes(counters, pageSize, ['Pages free', 'Pages speculative']);

  return buildSnapshot({
    totalBytes,
    usedBytes: anonymousBytes + wiredBytes + compressedBytes,
    freeBytes,
    cachedBytes,
    availableBytes: totalBytes - (anonymousBytes + wiredBytes + compressedBytes),
    source: 'macos_vm_stat',
  });
}

function parseMeminfo(output) {
  const values = {};
  for (const line of output.split('\n')) {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB/i);
    if (!match) continue;
    values[match[1]] = Number.parseInt(match[2], 10) * 1024;
  }
  return values;
}

function snapshotFromMeminfo(output) {
  const values = parseMeminfo(output);
  const totalBytes = values.MemTotal || os.totalmem();
  const freeBytes = values.MemFree || 0;
  const availableBytes = Number.isFinite(values.MemAvailable)
    ? values.MemAvailable
    : freeBytes + (values.Buffers || 0) + (values.Cached || 0) + (values.SReclaimable || 0) - (values.Shmem || 0);
  const cachedBytes = Math.max((values.Cached || 0) + (values.SReclaimable || 0) - (values.Shmem || 0), 0);

  return buildSnapshot({
    totalBytes,
    usedBytes: totalBytes - availableBytes,
    freeBytes,
    availableBytes,
    cachedBytes,
    source: 'linux_meminfo',
  });
}

function fallbackSnapshot() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();

  return buildSnapshot({
    totalBytes,
    usedBytes: totalBytes - freeBytes,
    freeBytes,
    availableBytes: freeBytes,
    cachedBytes: 0,
    source: 'node_os_fallback',
  });
}

async function getMemoryStats() {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('vm_stat');
      return snapshotFromVmStat(stdout, os.totalmem());
    } catch {
      return fallbackSnapshot();
    }
  }

  if (process.platform === 'linux') {
    try {
      const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
      return snapshotFromMeminfo(meminfo);
    } catch {
      return fallbackSnapshot();
    }
  }

  return fallbackSnapshot();
}

export {
  getMemoryStats,
  snapshotFromVmStat,
  snapshotFromMeminfo,
  fallbackSnapshot,
};

export default {
  getMemoryStats,
  _test: {
    parseVmStatCounters,
    snapshotFromVmStat,
    parseMeminfo,
    snapshotFromMeminfo,
    fallbackSnapshot,
  },
};
