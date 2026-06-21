import { describe, expect, it } from 'vitest';
import memoryStatsService from '../memory-stats.js';

const {
  parseVmStatCounters,
  snapshotFromVmStat,
  parseMeminfo,
  snapshotFromMeminfo,
} = memoryStatsService._test;

describe('memory stats', () => {
  it('parses macOS vm_stat and reports Activity Monitor-style used memory', () => {
    const vmStat = `
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10.
Pages active:                             200.
Pages inactive:                           150.
Pages speculative:                        20.
Pages throttled:                          0.
Pages wired down:                         40.
Pages purgeable:                          5.
"Translation faults":                     12345.
Pages copy-on-write:                      0.
Pages zero filled:                        0.
Pages reactivated:                        0.
Pages purged:                             0.
File-backed pages:                        60.
Anonymous pages:                          100.
Pages stored in compressor:               0.
Pages occupied by compressor:             30.
`;

    expect(parseVmStatCounters(vmStat).pageSize).toBe(16384);

    expect(snapshotFromVmStat(vmStat, 4_096_000)).toEqual({
      memory_total_bytes: 4_096_000,
      memory_used_bytes: 2_785_280,
      memory_free_bytes: 491_520,
      memory_usage_percent: 68,
      memory_available_bytes: 1_310_720,
      memory_cached_bytes: 1_064_960,
      memory_stats_source: 'macos_vm_stat',
    });
  });

  it('parses Linux meminfo using MemAvailable for primary used memory', () => {
    const meminfo = `
MemTotal:       8000000 kB
MemFree:         500000 kB
MemAvailable:   3000000 kB
Buffers:         100000 kB
Cached:         2000000 kB
SwapCached:          0 kB
Shmem:           250000 kB
SReclaimable:    400000 kB
`;

    expect(parseMeminfo(meminfo).MemTotal).toBe(8_192_000_000);

    expect(snapshotFromMeminfo(meminfo)).toEqual({
      memory_total_bytes: 8_192_000_000,
      memory_used_bytes: 5_120_000_000,
      memory_free_bytes: 512_000_000,
      memory_usage_percent: 62.5,
      memory_available_bytes: 3_072_000_000,
      memory_cached_bytes: 2_201_600_000,
      memory_stats_source: 'linux_meminfo',
    });
  });
});
