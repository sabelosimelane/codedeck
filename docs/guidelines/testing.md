# Testing Guidelines — CodeDeck

## Testing Philosophy

Focus test effort where bugs cause the most damage:
- **Required**: API contracts (correct status codes, response shapes), data integrity (DB state after mutations), error handling (failure paths return proper errors to the frontend).
- **Recommended**: Input validation boundaries, WebSocket reconnection behavior, edge cases in file tree traversal.
- **Skip**: Don't test framework behavior (Express routing basics, React rendering internals). Focus on YOUR logic and YOUR integration boundaries.

## Test Stack

| Layer | Tool | What it tests |
|-------|------|--------------|
| Service unit tests | Vitest | Pure service functions — business logic in isolation |
| API integration tests | Vitest + supertest | Express routes end-to-end (HTTP → DB → response) |
| Frontend component tests | Vitest + React Testing Library | Component behavior with mocked API |
| E2E tests (optional) | Playwright | Full browser flow if needed |

## Test Structure

```
server/
  __tests__/
    services/           — Unit tests for service functions
    api/                — Integration tests for Express routes
client/
  src/
    __tests__/          — Component and hook tests
```

## API Integration Tests

For each Express route, test:

### Happy Path (Required)
- [ ] Valid request → correct HTTP status + correct response body
- [ ] After mutation: query DB directly to verify state was written correctly
- [ ] Response body matches what was persisted

### Input Validation (Required)
- [ ] Missing required fields → 400 with `{ error: "..." }`
- [ ] Invalid path (non-existent directory) → 400
- [ ] Duplicate resource → 409

### Error Paths (Required)
- [ ] Resource not found → 404
- [ ] Verify error response shape: `{ error: string }`

### Side Effects (Required for mutations)
For POST (create):
- [ ] Record exists in DB after success
- [ ] Record does NOT exist after validation failure

For PUT (update):
- [ ] Only targeted fields changed
- [ ] Other fields preserved

For DELETE:
- [ ] Record removed from DB
- [ ] Subsequent GET returns 404 or empty

### Idempotency (Recommended)
- [ ] DELETE on already-deleted resource → 200 (not 500)
- [ ] PUT with same data → same result

## Service Unit Tests

Service functions are pure — test them without Express or SQLite:

```javascript
import { describe, it, expect } from 'vitest';
import { addProject } from '../../services/projectService.js';

describe('addProject', () => {
  it('returns error when project path already exists', () => {
    const existing = [{ name: 'foo', path: '/home/user/foo' }];
    const result = addProject('bar', '/home/user/foo', existing);
    expect(result.error).toBe('project already exists');
    expect(result.status).toBe(409);
  });

  it('returns the new project on success', () => {
    const result = addProject('bar', '/home/user/bar', []);
    expect(result.data).toEqual({ name: 'bar', path: '/home/user/bar' });
  });
});
```

## Frontend Tests

### Component Tests (Recommended)
- Mock API calls with `vi.fn()` or MSW
- Verify that success triggers a toast/confirmation
- Verify that failure triggers an error toast
- Verify that loading states appear during async operations

### Error Handling Coverage (Required)
For every component that calls an API:
- [ ] Test the failure path — does the component show an error?
- [ ] Test network failure — does it show "server unreachable"?
- [ ] Test that state is NOT updated on failure (no silent corruption)

## Running Tests

```bash
# Run all server tests (use maxWorkers to avoid OOM)
cd server && npx vitest --maxWorkers=1

# Run a specific test file
cd server && npx vitest __tests__/api/projects.test.js --maxWorkers=1

# Run client tests
cd client && npx vitest --maxWorkers=1
```

## Rules

1. **Every API route must have at least a happy path and one error path test.**
2. **Verify DB state directly** — don't trust the API response alone after mutations.
3. **No `catch(() => {})` in test helpers** — if something fails, the test should fail.
4. **Each test is independent** — no shared mutable state between tests. Seed data per test.
5. **Name tests descriptively**: `returns 400 when project name is missing` not `test1`.
6. **Run tests before reporting** — don't hand back a failing suite.
