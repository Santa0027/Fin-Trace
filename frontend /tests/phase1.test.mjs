import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const main = readFileSync(new URL("../src/app/main.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/app/App.tsx", import.meta.url), "utf8");
const apiClient = readFileSync(new URL("../src/lib/api/apiClient.ts", import.meta.url), "utf8");
const authProvider = readFileSync(new URL("../src/providers/AuthProvider.tsx", import.meta.url), "utf8");
const tenantProvider = readFileSync(new URL("../src/providers/TenantProvider.tsx", import.meta.url), "utf8");

test("auth and tenant providers are mounted in the required order", () => {
  assert.match(main, /<AuthProvider>\s*<TenantProvider>\s*<App \/>/s);
});

test("protected app renders login before authenticated shell", () => {
  assert.match(app, /if \(!isAuthenticated\) {\s*return <LoginPage\/>/);
  assert.match(app, /if \(isLoading\)/);
});

test("auth provider uses Django session endpoints", () => {
  assert.match(authProvider, /\/auth\/csrf\//);
  assert.match(authProvider, /\/auth\/login\//);
  assert.match(authProvider, /\/auth\/me\//);
  assert.match(authProvider, /\/auth\/logout\//);
});

test("tenant provider loads and switches companies through backend endpoints", () => {
  assert.match(tenantProvider, /\/auth\/companies\//);
  assert.match(tenantProvider, /\/auth\/switch-tenant\//);
  assert.match(tenantProvider, /tenant:changed/);
});

test("api client includes cookies, csrf, and unauthorized surfacing", () => {
  assert.match(apiClient, /credentials:\s*"include"/);
  assert.match(apiClient, /X-CSRFToken/);
  assert.match(apiClient, /auth:unauthorized/);
});

test("phase 2 accounts use real resource endpoints and archive instead of delete", () => {
  assert.match(app, /\/accounts\/\?limit=100/);
  assert.match(app, /\/accounts\/\$\{account\.id\}\/archive\//);
  assert.doesNotMatch(app, /method:\s*"DELETE"[^]*accounts/);
});

test("phase 2 transaction list, detail, and reversal use ledger endpoints", () => {
  assert.match(app, /\/transactions\/\?limit=\$\{limit\}&offset=\$\{offset\}/);
  assert.match(app, /\/transactions\/\$\{transaction\.id\}\//);
  assert.match(app, /\/transactions\/\$\{transaction\.id\}\/reverse\//);
  assert.match(app, /Idempotency-Key/);
});

test("phase 2 income and expense forms use backend APIs with idempotency", () => {
  assert.match(app, /\/income\//);
  assert.match(app, /\/expenses\//);
  assert.match(app, /newIdempotencyKey\(isExpense \? "expense" : "income"\)/);
  assert.match(app, /disabled=\{!permitted \|\| submitting\}/);
});

test("phase 2 supporting data and rbac are API-backed", () => {
  assert.match(app, /\/categories\/\?limit=100/);
  assert.match(app, /\/contacts\/\?limit=100/);
  assert.match(app, /\/currencies\//);
  assert.match(tenantProvider, /\/rbac\/effective-permissions\//);
  assert.match(tenantProvider, /setPermissions\(\[\]\)/);
});

test("phase 2 tenant and financial mutations trigger shared invalidation", () => {
  assert.match(app, /financial-data:changed/);
  assert.match(app, /tenant:changed/);
  assert.match(app, /eventRefreshFinancialState\(\)/);
});
