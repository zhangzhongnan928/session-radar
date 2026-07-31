import { describe, expect, it } from 'vitest';
import { Router } from './router.js';

const noop = (): void => {};

function router(): Router {
  return new Router()
    .get('/api/coverage', noop)
    .get('/api/analysis/status', noop)
    .get('/api/workitems', noop)
    .get('/api/workitems/:id', noop)
    .get('/api/workitems/:id/evidence', noop)
    .post('/api/workitems/:id/analyze', noop)
    .post('/api/workitems/:id/seen', noop);
}

function resolve(method: string, path: string) {
  return router().resolve(method, path, new URLSearchParams());
}

describe('Router', () => {
  it('matches a static route', () => {
    expect(resolve('GET', '/api/coverage')).not.toHaveProperty('error');
  });

  it('extracts path params', () => {
    const result = resolve('GET', '/api/workitems/wi_123/evidence');
    expect('match' in result && result.match.params['id']).toBe('wi_123');
  });

  it('prefers the more specific route over the param route', () => {
    const result = resolve('GET', '/api/workitems');
    expect('match' in result && Object.keys(result.match.params)).toEqual([]);
  });

  it('decodes an encoded param', () => {
    const result = resolve('GET', '/api/workitems/a%2Fb');
    expect('match' in result && result.match.params['id']).toBe('a/b');
  });

  it('serves HEAD from the GET handler', () => {
    expect(resolve('HEAD', '/api/coverage')).not.toHaveProperty('error');
  });

  it('distinguishes an unknown path from a wrong method', () => {
    expect(resolve('GET', '/api/nope')).toEqual({ error: 'not_found' });
    expect(resolve('DELETE', '/api/coverage')).toEqual({ error: 'method_not_allowed' });
  });

  it('does not match a prefix as if it were the whole path', () => {
    expect(resolve('GET', '/api/workitems/wi_1/evidence/extra')).toEqual({ error: 'not_found' });
  });

  it('ignores trailing slashes', () => {
    expect(resolve('GET', '/api/coverage/')).not.toHaveProperty('error');
  });

  it('routes methods independently on the same path', () => {
    expect(resolve('POST', '/api/workitems/wi_1/seen')).not.toHaveProperty('error');
    expect(resolve('GET', '/api/workitems/wi_1/seen')).toEqual({ error: 'method_not_allowed' });
    expect(resolve('POST', '/api/workitems/wi_1/analyze')).not.toHaveProperty('error');
    expect(resolve('GET', '/api/analysis/status')).not.toHaveProperty('error');
    expect(resolve('GET', '/api/workitems/wi_1/analyze')).toEqual({
      error: 'method_not_allowed',
    });
  });
});
