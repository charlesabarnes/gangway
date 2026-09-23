import { HttpErrorResponse } from '@angular/common/http';

export type ProblemError = {
  status: number;
  title: string;
  detail: string;
  requestId: string | null;
  retryAfter: number | null;
  issues: { path: string; message: string }[];
};

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function toProblem(e: unknown): ProblemError {
  const base: ProblemError = {
    status: 0,
    title: 'Something went wrong',
    detail: 'An unexpected error occurred.',
    requestId: null,
    retryAfter: null,
    issues: [],
  };
  if (!(e instanceof HttpErrorResponse))
    return { ...base, detail: e instanceof Error ? e.message : base.detail };

  if (e.status === 0)
    return {
      ...base,
      title: 'Cannot reach the server',
      detail:
        'The request did not get a response. Check your connection; gangway may be restarting.',
    };

  const body: Record<string, unknown> =
    e.error !== null && typeof e.error === 'object' ? (e.error as Record<string, unknown>) : {};
  const header = Number(e.headers.get('retry-after'));
  const fromBody = typeof body['retryAfter'] === 'number' ? (body['retryAfter'] as number) : NaN;
  const retryAfter =
    Number.isFinite(header) && header > 0 ? header : Number.isFinite(fromBody) ? fromBody : null;
  const issues = Array.isArray(body['issues'])
    ? (body['issues'] as unknown[]).flatMap((i) =>
        i !== null && typeof i === 'object'
          ? [
              {
                path: String((i as Record<string, unknown>)['path'] ?? ''),
                message: String((i as Record<string, unknown>)['message'] ?? ''),
              },
            ]
          : [],
      )
    : [];

  const restarting =
    (e.status === 502 || e.status === 503 || e.status === 504) && str(body['detail']) === null;
  return {
    status: e.status,
    title: restarting ? 'gangway is restarting' : (str(body['title']) ?? `HTTP ${e.status}`),
    detail: restarting
      ? 'The server is not answering yet. This usually clears in a few seconds.'
      : (str(body['detail']) ?? e.statusText ?? base.detail),
    requestId: str(body['requestId']),
    retryAfter,
    issues,
  };
}
