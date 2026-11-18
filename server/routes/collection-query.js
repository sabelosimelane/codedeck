/**
 * The list contract shared by collection endpoints: `page` (from 0), `size` (1–100,
 * default 20), `sort=field,asc|desc` over an allow-list with the id as tiebreaker, and
 * exact-match filters. Unknown query fields are refused.
 */

export const DEFAULT_SIZE = 20;
export const MAX_SIZE = 100;

/** `fieldError(field, message)` builds the caller's own 400 error. */
export function parseCollectionQuery(query, { sortFields, defaultSort, filters = [] }, fieldError) {
  if (typeof fieldError !== 'function') throw new TypeError('fieldError must be a function');
  const allowed = ['page', 'size', 'sort', ...filters.map(f => f.name)];
  for (const key of Object.keys(query)) {
    if (!allowed.includes(key)) throw fieldError(key, 'Unknown query field');
  }

  const page = query.page === undefined ? 0 : Number(query.page);
  if (!Number.isSafeInteger(page) || page < 0 || page > 100000) {
    throw fieldError('page', 'Use an integer from 0 to 100000');
  }
  const size = query.size === undefined ? DEFAULT_SIZE : Number(query.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SIZE) {
    throw fieldError('size', `Use an integer from 1 to ${MAX_SIZE}`);
  }

  const sort = query.sort ?? defaultSort;
  if (typeof sort !== 'string') throw fieldError('sort', 'Use field,asc or field,desc');
  const [field, direction, extra] = sort.split(',');
  if (!sortFields.includes(field) || !['asc', 'desc'].includes(direction) || extra !== undefined) {
    throw fieldError('sort', `Sort by ${sortFields.join(' or ')} with asc or desc`);
  }

  const filterValues = {};
  for (const filter of filters) {
    const raw = query[filter.name];
    if (raw === undefined) continue;
    filterValues[filter.name] = filter.parse(raw);
  }

  return { page, size, field, direction, filters: filterValues };
}

export function paginate(records, { page, size, field, direction }) {
  const sorted = [...records].sort((a, b) => {
    const left = a[field] ?? '';
    const right = b[field] ?? '';
    const compared = String(left).localeCompare(String(right));
    return (direction === 'desc' ? -compared : compared)
      || String(a.id).localeCompare(String(b.id));
  });
  return {
    data: sorted.slice(page * size, (page + 1) * size),
    page: {
      currentPage: page,
      size,
      totalElements: records.length,
      totalPages: Math.ceil(records.length / size) || 0,
      hasNextPage: (page + 1) * size < records.length,
    },
  };
}
