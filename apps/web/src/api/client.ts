/**
 * Admin API client. The access token lives only in memory (never localStorage);
 * the refresh token is an httpOnly cookie the browser sends to /api/admin/auth.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let accessToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<boolean> | null = null;
let onSessionExpired: () => void = () => {};

export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

export function setSession(token: string | null, expiresIn?: number) {
  accessToken = token;
  clearTimeout(refreshTimer);
  // Refresh a minute before expiry so requests rarely hit a 401.
  if (token && expiresIn) refreshTimer = setTimeout(() => void refreshSession(), Math.max(10, expiresIn - 60) * 1000);
}

/** Single-flight: concurrent 401s share one refresh request. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= fetch('/api/admin/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) {
        setSession(null);
        return false;
      }
      const body = (await res.json()) as { accessToken: string; expiresIn: number };
      setSession(body.accessToken, body.expiresIn);
      return true;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

type Query = Record<string, string | number | boolean | undefined | null>;

export async function api<T>(path: string, opts: { method?: string; body?: unknown; query?: Query } = {}): Promise<T> {
  const qs = opts.query
    ? new URLSearchParams(
        Object.entries(opts.query).flatMap(([k, v]) => (v === undefined || v === null || v === '' ? [] : [[k, String(v)]])),
      ).toString()
    : '';
  const url = `/api/admin${path}${qs ? `?${qs}` : ''}`;

  const send = () =>
    fetch(url, {
      method: opts.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(opts.body !== undefined && { 'content-type': 'application/json' }),
        ...(accessToken && { authorization: `Bearer ${accessToken}` }),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

  let res = await send();
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await send();
    else onSessionExpired();
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: unknown } } | null;
    throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? res.statusText, body?.error?.details);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
