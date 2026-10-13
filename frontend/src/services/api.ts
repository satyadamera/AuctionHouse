/**
 * Fetch-based API client.
 *
 * Token handling
 * - The access token (15 min JWT) lives only in this module's memory — not localStorage — so a
 *   script injected into the page cannot read a persisted credential.
 * - The refresh token is an HttpOnly cookie the browser sends to /api/v1/auth/refresh by itself.
 * - On a 401 the client refreshes once (single-flight: concurrent 401s share one refresh call) and
 *   retries the original request.
 */
import type { PageMeta, User } from '@/types/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

interface Envelope<T> {
  success: boolean;
  data: T;
  meta?: PageMeta & Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown; requestId?: string };
}

let accessToken: string | null = null;
const tokenListeners = new Set<(t: string | null) => void>();

export const getAccessToken = () => accessToken;
export function setAccessToken(t: string | null) {
  accessToken = t;
  tokenListeners.forEach((l) => l(t));
}
export function onAccessTokenChange(l: (t: string | null) => void) {
  tokenListeners.add(l);
  return () => tokenListeners.delete(l);
}

export interface Session {
  user: User;
  accessToken: string;
  expiresIn: number;
}

let refreshing: Promise<Session | null> | null = null;

/** Exchanges the refresh cookie for a new session. Returns null when there is no valid session. */
export function refreshSession(): Promise<Session | null> {
  refreshing ??= (async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'X-Auctra-CSRF': '1' } });
      if (res.ok) {
        const body = (await res.json()) as Envelope<Session>;
        setAccessToken(body.data.accessToken);
        return body.data;
      }
      // Another tab may have just rotated the cookie; wait briefly and retry with the newer one.
      const body = (await res.json().catch(() => null)) as Envelope<unknown> | null;
      if (!body?.error?.message.includes('retry')) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    setAccessToken(null);
    return null;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** internal: prevents infinite refresh loops */
  _retried?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']) {
  const url = new URL(`/api/v1${path}`, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  return url.pathname + url.search;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<{ data: T; meta?: Envelope<T>['meta'] }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (path.startsWith('/auth/')) headers['X-Auctra-CSRF'] = '1';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      signal: opts.signal,
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach Auctra. Check your connection and try again.');
  }

  if (res.status === 401 && accessToken && !opts._retried && !path.startsWith('/auth/')) {
    const session = await refreshSession();
    if (session) return request<T>(path, { ...opts, _retried: true });
  }

  const body = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !body?.success) {
    const e = body?.error;
    throw new ApiError(res.status, e?.code ?? 'HTTP_ERROR', e?.message ?? `Request failed (${res.status})`, e?.details, e?.requestId);
  }
  return { data: body.data, meta: body.meta };
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ?? {} }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Human-readable message for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
