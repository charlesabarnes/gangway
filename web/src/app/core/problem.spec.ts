import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { toProblem } from './problem';

describe('toProblem', () => {
  it('reads problem+json: title, detail, the request id, and validation issues', () => {
    const p = toProblem(new HttpErrorResponse({
      status: 422, statusText: 'Unprocessable',
      error: { title: 'unprocessable', detail: 'request validation failed', requestId: '01ABC', issues: [{ path: 'password', message: 'at least 12 characters' }] },
    }));
    expect(p).toEqual({ status: 422, title: 'unprocessable', detail: 'request validation failed', requestId: '01ABC', retryAfter: null, issues: [{ path: 'password', message: 'at least 12 characters' }] });
  });

  it('takes Retry-After from the header, and falls back to the body', () => {
    const locked = { title: 'rate limited', detail: 'too many failed logins; try again later', retryAfter: 60 };
    expect(toProblem(new HttpErrorResponse({ status: 429, error: locked, headers: new HttpHeaders({ 'retry-after': '42' }) })).retryAfter).toBe(42);
    expect(toProblem(new HttpErrorResponse({ status: 429, error: locked })).retryAfter).toBe(60);
  });

  it('status 0 is "cannot reach the server", not a blank error', () => {
    const p = toProblem(new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') }));
    expect(p.title).toBe('Cannot reach the server');
    expect(p.requestId).toBeNull();
  });

  it("a proxy's bare 502/503 is a restart; gangway's OWN 503 keeps its words", () => {
    expect(toProblem(new HttpErrorResponse({ status: 502, error: '<html>Bad Gateway</html>' })).title).toBe('gangway is restarting');
    const draining = toProblem(new HttpErrorResponse({ status: 503, error: { title: 'unavailable', detail: 'gangway is shutting down', requestId: '01X' } }));
    expect(draining).toMatchObject({ title: 'unavailable', detail: 'gangway is shutting down', requestId: '01X' });
  });

  it('anything that is not an HTTP error still becomes something showable', () => {
    expect(toProblem(new Error('boom')).detail).toBe('boom');
    expect(toProblem('nonsense').title).toBe('Something went wrong');
    expect(toProblem(new HttpErrorResponse({ status: 500, error: null })).title).toBe('HTTP 500');
  });
});
