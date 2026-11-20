import { isUuid } from '../../shared/pipeline-definitions.mjs';
import { paginate } from './collection-query.js';

export function mountTeamScoring({
  router,
  service,
  route,
  parseCollectionQuery,
  fieldError,
  PipelineError,
}) {
  const base = '/api/pipelines/improvements/teams';
  const uuid = (field, value) => {
    if (!isUuid(value)) throw fieldError(field, 'Use a UUID');
    return value;
  };
  const endpoint = (fn, { collection = false } = {}) =>
    route((req, res) => {
      try {
        if (req.params.id) uuid('id', req.params.id);
        if (!collection && Object.keys(req.query).length)
          throw fieldError('query', 'Unexpected query parameters');
        res.json(fn(req));
      } catch (err) {
        if (err instanceof PipelineError) throw err;
        if (err.status === 400) {
          if (Array.isArray(err.errors)) throw new PipelineError(err.message, 400, err.errors);
          throw fieldError(err.field ?? 'body', err.message);
        }
        if ([404, 409, 503].includes(err.status)) throw new PipelineError(err.message, err.status);
        throw err;
      }
    });
  const team = { name: 'teamId', parse: (v) => uuid('teamId', v) };
  const card = {
    name: 'cardId',
    parse: (v) => {
      if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v))
        throw fieldError('cardId', 'Use a scorecard identity');
      return v;
    },
  };
  function collection(path, read, sort, filters) {
    router.get(
      base + path,
      endpoint(
        (req) => {
          const query = parseCollectionQuery(req.query, {
            sortFields: [sort],
            defaultSort: sort + (sort === 'at' ? ',desc' : ',asc'),
            filters,
          });
          const rows = read(req).filter((row) =>
            Object.entries(query.filters).every(([k, v]) => row[k] === v),
          );
          return paginate(rows, query);
        },
        { collection: true },
      ),
    );
  }
  collection('/scorecards', () => service.cards(), 'name', [team]);
  collection('/runs', () => service.runs(), 'at', [team, card]);
  collection('/trials', () => service.trials.list(), 'at', [team]);
  collection('/runs/:id/history', (req) => service.history(req.params.id), 'at', []);
  router.get(
    base + '/runs/:id',
    endpoint((req) => service.detail(req.params.id)),
  );
  function fields(body, names) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== names.length ||
      names.some((k) => !Object.hasOwn(body, k))
    )
      throw fieldError('body', 'Supply ' + names.join(', '));
    if (!Number.isSafeInteger(body.revision) || body.revision < 0)
      throw fieldError('revision', 'Use a nonnegative integer');
  }
  router.post(
    base + '/trials/:id/decision',
    endpoint((req) => {
      fields(req.body, ['action', 'revision']);
      if (!['start', 'dismiss', 'adopt', 'stop'].includes(req.body.action))
        throw fieldError('action', 'Choose a valid trial decision');
      if (req.body.revision < 1) throw fieldError('revision', 'Use a positive trial revision');
      return service.trials.decide(req.params.id, req.body);
    }),
  );
  router.post(
    base + '/runs/:id/corrections',
    endpoint((req) => {
      fields(req.body, ['revision', 'signature', 'text', 'verdict', 'reason']);
      if (typeof req.body.signature !== 'string' || !/^[a-f0-9]{64}$/.test(req.body.signature))
        throw fieldError('signature', 'Use the reviewed evidence signature');
      const { signature, ...correction } = req.body;
      return service.correct(req.params.id, signature, correction);
    }),
  );
}
