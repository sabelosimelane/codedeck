import { describe, expect, it } from 'vitest';
import {
  collectSystemResources,
  parseCpuUsagePercent,
  parseDiskUsage,
} from '../system-resources.js';

function makeMemoryStats() {
  return {
    memory_total_bytes: 16_000,
    memory_used_bytes: 10_000,
    memory_free_bytes: 2_000,
    memory_usage_percent: 62.5,
    memory_available_bytes: 6_000,
    memory_cached_bytes: 4_000,
    memory_stats_source: 'macos_vm_stat',
  };
}

describe('system resources', () => {
  it('parses direct and top-style CPU usage output', () => {
    expect(parseCpuUsagePercent('15.2')).toBe(15);
    expect(parseCpuUsagePercent('Cpu(s): 12.5%us, 3.0%sy, 84.5%id')).toBe(16);
    expect(parseCpuUsagePercent('')).toBeNull();
  });

  it('parses df output into byte-oriented disk fields', () => {
    expect(parseDiskUsage([
      'Filesystem 1024-blocks Used Available Capacity Mounted on',
      '/dev/disk3s5 482674688 424673280 8912896 98% /System/Volumes/Data',
    ].join('\n'))).toEqual({
      path: '.',
      filesystem: '/dev/disk3s5',
      mount: '/System/Volumes/Data',
      total_bytes: 482674688 * 1024,
      used_bytes: 424673280 * 1024,
      available_bytes: 8912896 * 1024,
      usage_percent: 98,
    });
  });

  it('returns structured CPU, memory, and disk resources', async () => {
    const execResults = [
      { stdout: '15.2' },
      {
        stdout: [
          'Filesystem 1024-blocks Used Available Capacity Mounted on',
          '/dev/disk3s5 482674688 424673280 8912896 98% /System/Volumes/Data',
        ].join('\n'),
      },
    ];

    const resources = await collectSystemResources({
      execCommand: async () => execResults.shift(),
      memoryStatsReader: async () => makeMemoryStats(),
      now: () => new Date('2026-06-21T13:10:59.309Z'),
    });

    expect(resources.timestamp).toBe('2026-06-21T13:10:59.309Z');
    expect(resources.cpu.usage_percent).toBe(15);
    expect(resources.cpu.usage_display).toBe('15%');
    expect(resources.cpu.cores).toBeGreaterThan(0);
    expect(resources.cpu.load_average).toHaveLength(3);
    expect(resources.memory).toEqual({
      total_bytes: 16_000,
      used_bytes: 10_000,
      free_bytes: 2_000,
      available_bytes: 6_000,
      cached_bytes: 4_000,
      usage_percent: 63,
      source: 'macos_vm_stat',
    });
    expect(resources.disk.usage_percent).toBe(98);
  });

  it('returns fallback fields when CPU and disk commands fail', async () => {
    const resources = await collectSystemResources({
      execCommand: async () => {
        throw new Error('Command failed');
      },
      memoryStatsReader: async () => makeMemoryStats(),
    });

    expect(resources.cpu.usage_percent).toBeNull();
    expect(resources.cpu.usage_display).toBe('Unknown');
    expect(resources.disk).toMatchObject({
      path: '.',
      filesystem: 'Unknown',
      mount: 'Unknown',
      total_bytes: null,
      used_bytes: null,
      available_bytes: null,
      usage_percent: null,
    });
    expect(resources.memory.total_bytes).toBe(16_000);
  });
});
