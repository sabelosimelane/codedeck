import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFICATION_ICON,
  createNotificationAudioContext,
  playCompletionDing,
  requestNotificationPermissionFromGesture,
  showBrowserNotification,
  shouldQueueNotificationPermissionRequest,
  warmNotificationAudioContext,
} from '../browserNotifications';

describe('browserNotifications', () => {
  it('creates an audio context from the browser constructor', () => {
    const mockContext = { kind: 'audio' };
    class AudioContext {
      constructor() {
        return mockContext;
      }
    }

    expect(createNotificationAudioContext({ AudioContext })).toBe(mockContext);
  });

  it('resumes suspended audio contexts', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const audioContext = { state: 'suspended', resume };

    await expect(warmNotificationAudioContext(audioContext)).resolves.toBe(true);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('schedules a short ding envelope when audio is available', async () => {
    const oscillator = {
      type: 'triangle',
      frequency: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const gainNode = {
      gain: {
        setValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
      connect: vi.fn(),
    };
    const audioContext = {
      state: 'running',
      currentTime: 12,
      destination: { node: 'destination' },
      createOscillator: vi.fn(() => oscillator),
      createGain: vi.fn(() => gainNode),
    };

    await expect(playCompletionDing(audioContext)).resolves.toBe(true);
    expect(audioContext.createOscillator).toHaveBeenCalledTimes(1);
    expect(audioContext.createGain).toHaveBeenCalledTimes(1);
    expect(oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(880, 12);
    expect(oscillator.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(1320, 12.18);
    expect(gainNode.gain.setValueAtTime).toHaveBeenCalledWith(0.0001, 12);
    expect(gainNode.gain.exponentialRampToValueAtTime).toHaveBeenNthCalledWith(2, 0.0001, 12.26);
    expect(oscillator.start).toHaveBeenCalledWith(12);
    expect(oscillator.stop).toHaveBeenCalledWith(12.28);
  });

  it('fails closed when the browser has no audio support', async () => {
    await expect(playCompletionDing(null)).resolves.toBe(false);
  });

  it('queues notification permission when a busy session is detected but permission is still default', () => {
    expect(shouldQueueNotificationPermissionRequest({
      status: 'busy',
      alreadyRequested: false,
      permission: 'default',
      hasNotificationSupport: true,
    })).toBe(true);
  });

  it('only requests notification permission from an explicit user-gesture path', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted');
    const win = {
      Notification: {
        permission: 'default',
        requestPermission,
      },
    };

    await expect(requestNotificationPermissionFromGesture(win, {
      pendingRequest: false,
      alreadyRequested: false,
    })).resolves.toBe(false);
    expect(requestPermission).not.toHaveBeenCalled();

    await expect(requestNotificationPermissionFromGesture(win, {
      pendingRequest: true,
      alreadyRequested: false,
    })).resolves.toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('uses a service worker notification when a registration is ready', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    const ready = Promise.resolve({ showNotification });
    const win = {
      Notification: function Notification() {},
      navigator: {
        serviceWorker: {
          ready,
        },
      },
    };
    win.Notification.permission = 'granted';

    await expect(showBrowserNotification(win, {
      title: 'CodeDeck — Gamma-1 finished',
      body: 'Tests passed',
      tag: 'Gamma-1-finished',
      data: { sessionId: 'Gamma-1' },
    })).resolves.toBe('serviceWorker');

    expect(showNotification).toHaveBeenCalledWith('CodeDeck — Gamma-1 finished', {
      body: 'Tests passed',
      icon: DEFAULT_NOTIFICATION_ICON,
      tag: 'Gamma-1-finished',
      data: { sessionId: 'Gamma-1' },
      requireInteraction: true,
    });
  });

  it('falls back to the window Notification constructor when no service worker is available', async () => {
    const notificationInstance = { onclick: null };
    const construct = vi.fn();
    class NotificationCtor {
      constructor(title, options) {
        construct(title, options);
        return notificationInstance;
      }
    }
    NotificationCtor.permission = 'granted';
    const focus = vi.fn();
    const win = {
      Notification: NotificationCtor,
      navigator: {},
      focus,
    };

    await expect(showBrowserNotification(win, {
      title: 'CodeDeck — Gamma-1 finished',
      body: 'Tests passed',
      tag: 'Gamma-1-finished',
      data: { sessionId: 'Gamma-1' },
    })).resolves.toBe('window');

    expect(construct).toHaveBeenCalledWith('CodeDeck — Gamma-1 finished', {
      body: 'Tests passed',
      icon: DEFAULT_NOTIFICATION_ICON,
      tag: 'Gamma-1-finished',
      data: { sessionId: 'Gamma-1' },
      requireInteraction: true,
    });
  });
});
