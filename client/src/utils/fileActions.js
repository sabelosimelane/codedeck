export function openFilePreviewTab(filePath, host = 'local') {
  const previewUrl = new URL(window.location.href);
  previewUrl.search = '';
  previewUrl.hash = '';
  previewUrl.searchParams.set('preview', filePath);
  previewUrl.searchParams.set('host', host);
  window.open(previewUrl.toString(), '_blank', 'noopener');
}
