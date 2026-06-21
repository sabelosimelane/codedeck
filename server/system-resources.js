import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getMemoryStats } from './memory-stats.js';

const execAsync = promisify(exec);

function getCommandOutput(result) {
  if (typeof result === 'string') {
    return result.trim();
  }

  return result?.stdout?.trim() || '';
}

function roundNumber(value, decimals = 0) {
  if (!Number.isFinite(value)) {
    return value;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function parseDiskUsage(dfOutput, path = '.') {
  const dataLine = dfOutput
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.toLowerCase().startsWith('filesystem'));

  if (!dataLine) {
    return null;
  }

  const columns = dataLine.split(/\s+/);
  if (columns.length < 6) {
    return null;
  }

  const totalBlocks = Number.parseInt(columns[1], 10);
  const usedBlocks = Number.parseInt(columns[2], 10);
  const availableBlocks = Number.parseInt(columns[3], 10);
  const usagePercent = Number.parseFloat(columns[4].replace('%', ''));

  if (![totalBlocks, usedBlocks, availableBlocks, usagePercent].every(Number.isFinite)) {
    return null;
  }

  return {
    path,
    filesystem: columns[0],
    mount: columns.slice(5).join(' '),
    total_bytes: totalBlocks * 1024,
    used_bytes: usedBlocks * 1024,
    available_bytes: availableBlocks * 1024,
    usage_percent: roundNumber(usagePercent),
  };
}

function parseCpuUsagePercent(cpuOutput) {
  const trimmed = cpuOutput.trim();
  if (!trimmed) {
    return null;
  }

  const directValue = Number.parseFloat(trimmed.replace('%', ''));
  if (Number.isFinite(directValue)) {
    return roundNumber(directValue);
  }

  const idleMatch = trimmed.match(/([\d.]+)\s*%?\s*id/i);
  if (idleMatch) {
    const idlePercent = Number.parseFloat(idleMatch[1]);
    return Number.isFinite(idlePercent)
      ? roundNumber(100 - idlePercent)
      : null;
  }

  const usedMatch = trimmed.match(/([\d.]+)\s*%?\s*(?:user|us)/i);
  return usedMatch ? roundNumber(Number.parseFloat(usedMatch[1])) : null;
}

function getCpuCommand() {
  if (process.platform === 'darwin') {
    return "top -l 1 | grep \"CPU usage\" | awk '{print $3}' | sed 's/%//'";
  }

  if (process.platform === 'linux') {
    return "top -bn1 | grep \"Cpu(s)\"";
  }

  return '';
}

async function collectSystemResources({
  execCommand = execAsync,
  memoryStatsReader = getMemoryStats,
  now = () => new Date(),
} = {}) {
  const cpuCommand = getCpuCommand();
  const [cpuResult, diskResult, memoryStats] = await Promise.all([
    cpuCommand
      ? execCommand(cpuCommand).catch(() => null)
      : Promise.resolve(null),
    execCommand('df -Pk .').catch(() => null),
    memoryStatsReader(),
  ]);

  const cpuUsagePercent = cpuResult ? parseCpuUsagePercent(getCommandOutput(cpuResult)) : null;
  const disk = diskResult ? parseDiskUsage(getCommandOutput(diskResult)) : null;
  const cpus = os.cpus();

  return {
    timestamp: now().toISOString(),
    cpu: {
      usage_percent: cpuUsagePercent,
      usage_display: cpuUsagePercent === null ? 'Unknown' : `${cpuUsagePercent}%`,
      load_average: os.loadavg().map(value => roundNumber(value, 2)),
      cores: cpus.length,
      model: cpus[0]?.model || 'Unknown',
    },
    memory: {
      total_bytes: memoryStats.memory_total_bytes,
      used_bytes: memoryStats.memory_used_bytes,
      free_bytes: memoryStats.memory_free_bytes,
      available_bytes: memoryStats.memory_available_bytes,
      cached_bytes: memoryStats.memory_cached_bytes,
      usage_percent: roundNumber(memoryStats.memory_usage_percent),
      source: memoryStats.memory_stats_source,
    },
    disk: disk || {
      path: '.',
      filesystem: 'Unknown',
      mount: 'Unknown',
      total_bytes: null,
      used_bytes: null,
      available_bytes: null,
      usage_percent: null,
    },
  };
}

export {
  collectSystemResources,
  getCommandOutput,
  parseCpuUsagePercent,
  parseDiskUsage,
  roundNumber,
};
