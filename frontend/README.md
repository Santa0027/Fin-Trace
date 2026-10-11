# FinTrace web app

React + TypeScript + Vite. It talks to the Django API in this repository; there
is no mock backend.

```bash
npm install
npm run dev      # http://127.0.0.1:3000, proxies /api to the backend
npm run lint     # type-check
npm test         # component tests
npm run build
```

Start the backend first (`python manage.py runserver` from the repository root).
If it is not on port 8000, set `FINTRACE_API_PROXY_TARGET` in `.env` (see
`.env.example`), and make sure the backend's `CSRF_TRUSTED_ORIGINS` includes
`http://127.0.0.1:3000`.

## How the app talks to the API

- `src/lib/api/apiClient.ts` is the only place that calls `fetch`. It sends the
  session cookie and CSRF token, and turns every failure into an `ApiError`
  carrying the backend's `code`, `message` and per-field errors.
- One module per area in `src/lib/api/` (accounts, transactions, income, …).
- The active workspace lives in the server session. The client never sends a
  tenant id.
- Money is a decimal string end to end. Totals shown as financial facts come
  from the backend, which derives them from the ledger.
- Money-changing requests carry an `Idempotency-Key` (`useSubmission`), so a
  double click or a retry after a dropped connection cannot post twice.
- `useTenantQuery` tags fetched data with the workspace it belongs to, so one
  workspace's data is never shown under another.
