export const DEFAULT_NOTIFICATION_ICON = '/favicon.svg';

export function createNotificationAudioContext(win = typeof window === 'undefined' ? undefined : window) {
  const AudioContextCtor = win?.AudioContext || win?.webkitAudioContext;
  if (!AudioContextCtor) return null;

  try {
    return new AudioContextCtor();
  } catch {
    return null;
  }
}

async function getServiceWorkerRegistration(serviceWorker, readyTimeoutMs = 150) {
  if (!serviceWorker) return null;

  if (typeof serviceWorker.getRegistration === 'function') {
    try {
      const registration = await serviceWorker.getRegistration();
      if (registration?.showNotification) return registration;
    } catch {
      // Fall through to the ready-based path.
    }
  }

  if (serviceWorker.ready && typeof serviceWorker.ready.then === 'function') {
    try {
      const registration = await Promise.race([
        serviceWorker.ready,
        new Promise(resolve => setTimeout(() => resolve(null), readyTimeoutMs)),
      ]);
      if (registration?.showNotification) return registration;
    } catch {
      return null;
    }
  }

  return null;
}

export function shouldQueueNotificationPermissionRequest({
  status,
  alreadyRequested,
  permission,
  hasNotificationSupport,
}) {
  return (
    status === 'busy' &&
    !alreadyRequested &&
    hasNotificationSupport &&
    permission === 'default'
  );
}

export async function requestNotificationPermissionFromGesture(
  win = typeof window === 'undefined' ? undefined : window,
  { pendingRequest, alreadyRequested } = {}
) {
  if (alreadyRequested || !pendingRequest) return false;
  if (!win?.Notification || win.Notification.permission !== 'default' || typeof win.Notification.requestPermission !== 'function') {
    return false;
  }

  try {
    await win.Notification.requestPermission();
    return true;
  } catch {
    return false;
  }
}

export async function showBrowserNotification(
  win = typeof window === 'undefined' ? undefined : window,
  {
    title,
    body = '',
    tag = '',
    data = null,
    icon = DEFAULT_NOTIFICATION_ICON,
    requireInteraction = true,
  } = {}
) {
  if (!win?.Notification || win.Notification.permission !== 'granted' || !title) {
    return 'none';
  }

  const options = {
    body,
    icon,
    tag,
    data,
    requireInteraction,
  };

  const registration = await getServiceWorkerRegistration(win.navigator?.serviceWorker);
  if (registration?.showNotification) {
    try {
      await registration.showNotification(title, options);
      return 'serviceWorker';
    } catch {
      // Fall back to the window constructor if the SW path fails.
    }
  }

  try {
    const notification = new win.Notification(title, options);
    if (notification && typeof notification === 'object') {
      notification.onclick = () => {
        if (typeof win.focus === 'function') win.focus();
        if (typeof notification.close === 'function') notification.close();
      };
    }
    return 'window';
  } catch {
    return 'none';
  }
}

export async function warmNotificationAudioContext(audioContext) {
  if (!audioContext || audioContext.state !== 'suspended' || typeof audioContext.resume !== 'function') {
    return false;
  }

  try {
    await audioContext.resume();
    return true;
  } catch {
    return false;
  }
}

export async function playCompletionDing(audioContext) {
  if (!audioContext || typeof audioContext.createOscillator !== 'function' || typeof audioContext.createGain !== 'function') {
    return false;
  }

  try {
    await warmNotificationAudioContext(audioContext);

    const now = typeof audioContext.currentTime === 'number' ? audioContext.currentTime : 0;
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, now);
    oscillator.frequency.exponentialRampToValueAtTime(1320, now + 0.18);

    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.start(now);
    oscillator.stop(now + 0.28);
    return true;
  } catch {
    return false;
  }
}
