import { describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_TITLE,
  RESOURCE_ALERT_THRESHOLD,
  createResourceAlertFavicon,
  formatResourcePercent,
  formatSystemResourceTitle,
  hasSystemResourceAlert,
} from '../systemResourceTitle';

describe('system resource title formatting', () => {
  it('formats memory, cpu, and disk usage for the browser tab title', () => {
    expect(formatSystemResourceTitle({
      cpu: { usage_percent: 9.79 },
      memory: { usage_percent: 81 },
      disk: { usage_percent: 89 },
    })).toBe('💻 81% · ⚡ 9.79% · 💿 89%');
  });

  it('prefers cpu usage_display when the API provides it', () => {
    expect(formatSystemResourceTitle({
      cpu: { usage_percent: 21.432, usage_display: '21.4%' },
      memory: { usage_percent: 84.8 },
      disk: { usage_percent: 89 },
    })).toBe('💻 84.8% · ⚡ 21.4% · 💿 89%');
  });

  it('adds an urgent marker when any resource crosses the alert threshold', () => {
    expect(formatSystemResourceTitle({
      cpu: { usage_percent: 12.5 },
      memory: { usage_percent: 82 },
      disk: { usage_percent: RESOURCE_ALERT_THRESHOLD },
    })).toBe('🚨 💻 82% · ⚡ 12.5% · 💿 90%');
  });

  it('detects alerting CPU, memory, or disk resources', () => {
    expect(hasSystemResourceAlert({ cpu: { usage_percent: 90 }, memory: { usage_percent: 10 }, disk: { usage_percent: 10 } })).toBe(true);
    expect(hasSystemResourceAlert({ cpu: { usage_percent: 10 }, memory: { usage_percent: 90 }, disk: { usage_percent: 10 } })).toBe(true);
    expect(hasSystemResourceAlert({ cpu: { usage_percent: 10 }, memory: { usage_percent: 10 }, disk: { usage_percent: 90 } })).toBe(true);
    expect(hasSystemResourceAlert({ cpu: { usage_percent: 89.99 }, memory: { usage_percent: 10 }, disk: { usage_percent: 10 } })).toBe(false);
  });

  it('creates a red warning favicon data url for alerting resources', () => {
    expect(createResourceAlertFavicon()).toContain('data:image/svg+xml,');
    expect(decodeURIComponent(createResourceAlertFavicon())).toContain('#dc2626');
  });

  it('falls back to the app title when no resource values are available', () => {
    expect(formatSystemResourceTitle({
      cpu: { usage_percent: null },
      memory: { usage_percent: null },
      disk: { usage_percent: null },
    })).toBe(DEFAULT_APP_TITLE);
  });

  it('ignores non-numeric percentages', () => {
    expect(formatResourcePercent('81')).toBeNull();
    expect(formatResourcePercent(Number.NaN)).toBeNull();
  });
});
