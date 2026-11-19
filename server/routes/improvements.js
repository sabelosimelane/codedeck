import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { classifications } from '../../shared/workflow-improvements.mjs';
import { paginate } from './collection-query.js';

export function mountImprovements({
  router,
  service,
  route,
  parseCollectionQuery,
  fieldError,
  PipelineError,
}) {
  const base = '/api/pipelines/improvements';
  const requireId = (value) => {
    if (!isUuid(value)) throw fieldError('id', 'Use a UUID');
    return value;
  };
  function date(value, field) {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\d$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value
    )
      throw fieldError(field, 'Use a calendar date YYYY-MM-DD');
    return value;
  }
  const filters = [
    {
      name: 'workflowId',
      parse: (v) => {
        if (!isUuid(v)) throw fieldError('workflowId', 'Use a workflow UUID');
        return v;
      },
    },
    {
      name: 'revision',
      parse: (v) => {
        if (typeof v !== 'string' || !/^\d+$/.test(v) || !Number.isSafeInteger(+v) || +v < 1)
          throw fieldError('revision', 'Use a positive revision number');
        return +v;
      },
    },
    ...['from', 'to'].map((name) => ({ name, parse: (v) => date(v, name) })),
  ];
  for (const resource of ['outcomes', 'proposals', 'calls']) {
    router.get(
      base + '/' + resource,
      route((req, res) => {
        const query = parseCollectionQuery(req.query, {
          filters,
          sortFields: ['at'],
          defaultSort: 'at,desc',
        });
        const { workflowId, revision, from, to } = query.filters;
        if (from && to && from > to) throw fieldError('from', 'Start date must precede end date');
        const rows = service[resource]().filter(
          (r) =>
            (!workflowId || r.workflowId === workflowId) &&
            (!revision || r.revision === revision) &&
            (!from || r.at.slice(0, 10) >= from) &&
            (!to || r.at.slice(0, 10) <= to),
        );
        res.json(paginate(rows, query));
      }),
    );
  }
  const endpoint = (fn) =>
    route(async (req, res) => {
      try {
        if (Object.keys(req.query).length) throw fieldError('query', 'No query parameters expected');
        if (req.params.id) requireId(req.params.id);
        res.json(await fn(req));
      } catch (err) {
        if (err instanceof PipelineError) throw err;
        if (err.status === 400 && Array.isArray(err.errors))
          throw new PipelineError(err.message, 400, err.errors);
        if ([404, 409, 503].includes(err.status)) throw new PipelineError(err.message, err.status);
        throw err;
      }
    });
  router.put(
    base + '/model',
    endpoint((req) => {
      if (
        !req.body ||
        Object.keys(req.body).some((k) => !['provider', 'model', 'effort', 'revision'].includes(k))
      )
        throw fieldError('body', 'Send a model profile and revision');
      if (!Number.isSafeInteger(req.body.revision) || req.body.revision < 0)
        throw fieldError('revision', 'Use a nonnegative model revision');
      if (!['codex', 'claude'].includes(req.body.provider))
        throw fieldError('provider', 'Choose codex or claude');
      return service.configure(req.body);
    }),
  );
  router.get(
    base + '/status',
    endpoint(() => service.status()),
  );
  router.get(
    base + '/outcomes/:id',
    endpoint((req) => service.packet(req.params.id)),
  );
  router.post(
    base + '/outcomes/:id/label',
    endpoint((req) => {
      if (!req.body || Object.keys(req.body).length !== 1 || !classifications.includes(req.body.label))
        throw fieldError('label', 'Choose one benchmark classification');
      service.label(req.params.id, req.body.label);
      return { label: req.body.label };
    }),
  );
  router.post(
    base + '/proposals/:id/evaluation',
    endpoint((req) => {
      if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length)
        throw fieldError('body', 'Send an empty object');
      return service.evaluate(req.params.id);
    }),
  );
  router.post(
    base + '/proposals/:id/decision',
    endpoint((req) => {
      const body = req.body;
      if (
        !body ||
        Object.keys(body).some((k) => !['action', 'reason'].includes(k)) ||
        !['approve', 'dismiss', 'activate'].includes(body.action)
      )
        throw fieldError('action', 'Choose approve, dismiss or activate');
      if (
        body.action === 'dismiss'
          ? typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 1500
          : body.reason !== undefined
      )
        throw fieldError('reason', 'A dismissal requires a reason of 1 to 1500 characters');
      return service.decide(req.params.id, body);
    }),
  );
}
