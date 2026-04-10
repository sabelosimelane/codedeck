export function openFilePreviewTab(filePath) {
  const previewUrl = new URL(window.location.href);
  previewUrl.search = '';
  previewUrl.hash = '';
  previewUrl.searchParams.set('preview', filePath);
  window.open(previewUrl.toString(), '_blank', 'noopener');
}
