/**
 * The one place the browser talks to the FinTrace API.
 *
 * - Same-origin requests with the session cookie; the active workspace lives in
 *   the server session, so no tenant id is ever sent from the client.
 * - CSRF token is read from the cookie (fetched on demand) for unsafe methods.
 * - Every failure becomes an ApiError with the backend's code, message and
 *   per-field errors, so screens can say something specific.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL || '/api/v1';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  status: number;
  code: string;
  fields: Record<string, string>;
  body: unknown;

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}, body: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.body = body;
  }

  /** The outcome is unknown (network drop, gateway error): safe to retry with the same idempotency key. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: QueryParams;
  /** Required by every money-changing endpoint; see newIdempotencyKey(). */
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Set for the session probe so an expected 401 does not broadcast a sign-out. */
  quietUnauthorized?: boolean;
}

export function newIdempotencyKey(scope: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${scope}-${random}`;
}

function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function buildUrl(endpoint: string, query?: QueryParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const queryString = params.toString();
  if (!queryString) return `${API_BASE}${endpoint}`;
  return `${API_BASE}${endpoint}${endpoint.includes('?') ? '&' : '?'}${queryString}`;
}

const STATUS_MESSAGES: Record<number, string> = {
  401: 'Your session has expired. Sign in again.',
  403: 'You do not have permission to do this.',
  404: 'This record no longer exists.',
  429: 'Too many attempts. Wait a moment and try again.',
};

async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (error && typeof error === 'object') {
    const { code, message, fields } = error as { code?: string; message?: string; fields?: Record<string, string> };
    return new ApiError(
      response.status,
      code || `HTTP_${response.status}`,
      message || STATUS_MESSAGES[response.status] || 'The request could not be completed.',
      fields && typeof fields === 'object' ? fields : {},
      body
    );
  }
  const fallback =
    STATUS_MESSAGES[response.status] ||
    (response.status >= 500
      ? 'The server ran into a problem. Nothing was saved; please try again.'
      : 'The request could not be completed.');
  return new ApiError(response.status, `HTTP_${response.status}`, fallback, {}, body);
}

async function send(endpoint: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (UNSAFE_METHODS.has(method)) {
    let token = readCookie('csrftoken');
    if (!token) {
      await fetch(buildUrl('/auth/csrf/'), { credentials: 'include' });
      token = readCookie('csrftoken');
    }
    if (token) headers['X-CSRFToken'] = token;
  }
  try {
    return await fetch(buildUrl(endpoint, options.query), {
      method,
      credentials: 'include',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach FinTrace. Check your connection and try again.');
  }
}

export async function apiRequest<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(endpoint, options);

  if (response.status === 403 && UNSAFE_METHODS.has(options.method ?? 'GET')) {
    // A stale CSRF token is recoverable: fetch a fresh one and retry once.
    const error = await toApiError(response.clone());
    if (error.code === 'CSRF_FAILED') {
      await fetch(buildUrl('/auth/csrf/'), { credentials: 'include' });
      response = await send(endpoint, options);
    }
  }

  if (!response.ok) {
    const error = await toApiError(response);
    if (response.status === 401 && !options.quietUnauthorized) {
      window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    }
    throw error;
  }
  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

/** A message fit to show a person, whatever was thrown. */
export function errorMessage(error: unknown, fallback = 'Something unexpected happened. Please try again.'): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError ? error.fields : {};
}
