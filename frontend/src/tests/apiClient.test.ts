import { describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest } from '../lib/api/apiClient';
import { formatMoney, parseAmountInput, setWorkspaceCurrency } from '../lib/money';
import { apiError, installApi, USD } from './harness';

describe('apiClient', () => {
  it('sends the CSRF token and idempotency key on money-changing requests, never a tenant id', async () => {
    const api = installApi({ 'POST /transfers/': () => ({ status: 201, body: { id: 't1', ledger_transaction_id: 't1' } }) });
    await apiRequest('/transfers/', { method: 'POST', body: { amount: '10' }, idempotencyKey: 'transfer-abc' });
    const [request] = api.calls('POST', '/transfers/');
    expect(request.headers['X-CSRFToken']).toBe('test-csrf-token');
    expect(request.headers['Idempotency-Key']).toBe('transfer-abc');
    expect(Object.keys(request.headers).join(' ').toLowerCase()).not.toContain('tenant');
    expect(JSON.stringify(request.body)).not.toContain('tenant');
  });

  it('turns the backend error envelope into an ApiError with code, message and field errors', async () => {
    installApi({ 'POST /income/': () => apiError(400, 'ACCOUNT_INACTIVE', 'Savings is archived. Choose an active account.', { destination_account_id: 'Savings is archived.' }) });
    const error = await apiRequest('/income/', { method: 'POST', body: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: 'ACCOUNT_INACTIVE', message: 'Savings is archived. Choose an active account.', fields: { destination_account_id: 'Savings is archived.' }, retryable: false });
  });

  it('reports an unreachable server as a retryable network error', async () => {
    installApi({ 'GET /accounts/': () => new TypeError('Failed to fetch') });
    const error = (await apiRequest('/accounts/').catch((e: unknown) => e)) as ApiError;
    expect(error).toMatchObject({ status: 0, code: 'NETWORK_ERROR', retryable: true });
    expect(error.message).toMatch(/cannot reach/i);
  });

  it('broadcasts an expired session on 401, except for the session probe', async () => {
    installApi({ 'GET /accounts/': () => apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'), 'GET /auth/me/': () => apiError(401, 'UNAUTHENTICATED', 'Sign in to continue.') });
    const listener = vi.fn();
    window.addEventListener('auth:unauthorized', listener);
    await apiRequest('/auth/me/', { quietUnauthorized: true }).catch(() => undefined);
    expect(listener).not.toHaveBeenCalled();
    await apiRequest('/accounts/').catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('auth:unauthorized', listener);
  });

  it('refreshes a stale CSRF token once and retries', async () => {
    let attempts = 0;
    const api = installApi({
      'POST /contacts/': () => (++attempts === 1 ? apiError(403, 'CSRF_FAILED', 'Token out of date.') : { status: 201, body: { id: 'c1' } }),
    });
    await expect(apiRequest('/contacts/', { method: 'POST', body: { name: 'A' } })).resolves.toEqual({ id: 'c1' });
    expect(api.calls('POST', '/contacts/')).toHaveLength(2);
    expect(api.calls('GET', '/auth/csrf/')).toHaveLength(1);
  });

  it('does not fall back to a generic message when the server gives no JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 502 })));
    const error = (await apiRequest('/accounts/').catch((e: unknown) => e)) as ApiError;
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/nothing was saved/i);
  });
});

describe('money', () => {
  it('validates typed amounts as exact decimals without float conversion', () => {
    expect(parseAmountInput('1,500.50')).toEqual({ value: '1500.50' });
    expect(parseAmountInput('0.1')).toEqual({ value: '0.1' });
    expect(parseAmountInput('')).toEqual({ error: 'Enter an amount.' });
    expect(parseAmountInput('0.00').error).toMatch(/greater than zero/);
    expect(parseAmountInput('-5').error).toBeDefined();
    expect(parseAmountInput('1e3').error).toBeDefined();
    expect(parseAmountInput('10.999').error).toMatch(/2 decimal places/);
    expect(parseAmountInput('10.5', 0).error).toMatch(/no decimal places/);
  });

  it('formats in the workspace currency rather than a hardcoded one', () => {
    setWorkspaceCurrency(USD);
    expect(formatMoney('1234.5')).toContain('1,234.50');
    expect(formatMoney('1234.5')).toContain('$');
    setWorkspaceCurrency({ id: 'inr', code: 'INR', symbol: '₹', decimal_places: 2 });
    expect(formatMoney('100')).toContain('₹');
    setWorkspaceCurrency(null);
  });
});
