export async function namingRequest(path, options = {}) {
  const response = await fetch(`/api/session-naming/${path}`, {
    ...options,
    ...(options.body !== undefined ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) } : {}),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || body.error || `Session naming request failed (${response.status})`);
  return body;
}

export async function namingPages(path, signal) {
  const result = [];
  for (let page = 0; ; page++) {
    const body = await namingRequest(`${path}${path.includes('?') ? '&' : '?'}page=${page}&size=100`, { signal });
    if (!Array.isArray(body.data) || typeof body.page?.hasNextPage !== 'boolean') throw new Error('Invalid session naming response');
    result.push(...body.data);
    if (!body.page.hasNextPage) return result;
  }
}
