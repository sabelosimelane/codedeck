const SYSTEM_RESOURCES_URL = '/api/system/resources';
const DEFAULT_APP_TITLE = 'CodeDeck';
const RESOURCE_ALERT_THRESHOLD = 90;

export function formatResourcePercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return `${value.toLocaleString('en-US', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  })}%`;
}

export function formatSystemResourceTitle(resources) {
  const memory = formatResourcePercent(resources?.memory?.usage_percent);
  const cpu = resources?.cpu?.usage_display || formatResourcePercent(resources?.cpu?.usage_percent);
  const disk = formatResourcePercent(resources?.disk?.usage_percent);
  const parts = [
    memory ? `💻 ${memory}` : null,
    cpu ? `⚡ ${cpu}` : null,
    disk ? `💿 ${disk}` : null,
  ].filter(Boolean);

  if (parts.length === 0) return DEFAULT_APP_TITLE;
  return hasSystemResourceAlert(resources) ? `🚨 ${parts.join(' · ')}` : parts.join(' · ');
}

export function hasSystemResourceAlert(resources) {
  return [
    resources?.memory?.usage_percent,
    resources?.cpu?.usage_percent,
    resources?.disk?.usage_percent,
  ].some(value => typeof value === 'number' && Number.isFinite(value) && value >= RESOURCE_ALERT_THRESHOLD);
}

export function createResourceAlertFavicon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
    '<rect width="64" height="64" rx="14" fill="#dc2626"/>',
    '<path d="M32 10 58 54H6L32 10Z" fill="#fef2f2"/>',
    '<path d="M32 24v15" stroke="#dc2626" stroke-width="7" stroke-linecap="round"/>',
    '<circle cx="32" cy="48" r="4" fill="#dc2626"/>',
    '</svg>',
  ].join('');

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export { DEFAULT_APP_TITLE, RESOURCE_ALERT_THRESHOLD, SYSTEM_RESOURCES_URL };
