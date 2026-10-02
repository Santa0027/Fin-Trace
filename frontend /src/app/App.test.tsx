import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { AuthProvider } from "../providers/AuthProvider";
import { TenantProvider } from "../providers/TenantProvider";

function json(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as Response);
}

function renderApp() {
  return render(
    <AuthProvider>
      <TenantProvider>
        <App />
      </TenantProvider>
    </AuthProvider>,
  );
}

const fixtures = {
  me: {
    authenticated: true,
    user: { id: "user-1", username: "ava", email: "ava@example.com", first_name: "Ava", last_name: "Stone" },
    tenant: { company_id: "tenant-1", company_name: "Acme Finance" },
    platform: { is_superuser: false, is_staff: false },
  },
  permissions: {
    results: [
      "accounts.view", "accounts.create", "accounts.update",
      "transactions.view", "transactions.create", "transactions.post", "transactions.reverse",
      "income.create", "expenses.create", "categories.view", "categories.create", "categories.update",
    ].map(code => ({ code, effect: "ALLOW" })),
  },
};

beforeEach(() => {
  document.cookie = "csrftoken=test-token";
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/csrf/")) return json({ csrf: "ready" });
    if (url.includes("/auth/me/")) return json(fixtures.me);
    if (url.includes("/auth/companies/")) return json({ companies: [{ id: "tenant-1", name: "Acme Finance", status: "ACTIVE" }] });
    if (url.includes("/rbac/effective-permissions/")) return json(fixtures.permissions);
    if (url.includes("/currencies/")) return json({ results: [{ id: "usd", code: "USD", name: "US Dollar" }] });
    if (url.includes("/reports/account-balances/")) return json({ results: [{ account_id: "cash", name: "Cash", balance_amount: "125.00", balance_base_amount: "125.00" }] });
    if (url.includes("/accounts/") && init?.method === "POST") return json({ id: "new-account" }, 201);
    if (url.includes("/accounts/cash/archive/")) return json({ id: "cash", is_active: false });
    if (url.includes("/accounts/cash/") && init?.method === "PATCH") return json({ id: "cash", name: "Cash edited" });
    if (url.includes("/accounts/")) return json({ results: [{ id: "cash", name: "Cash", type: "ASSET", normal_balance: "DEBIT", currency_id: "usd", is_active: true }] });
    if (url.includes("/transactions/") && init?.method === "POST") return json({ id: "tx-transfer" }, 201);
    if (url.includes("/transactions/tx-transfer/post/")) return json({ status: "posted" });
    if (url.includes("/transactions/tx-1/reverse/")) return json({ id: "tx-reversal" }, 201);
    if (url.includes("/transactions/tx-1/")) return json({ id: "tx-1", status: "COMPLETED", reference: "R-1", entries: [] });
    if (url.includes("/transactions/")) return json({ results: [{ id: "tx-1", status: "COMPLETED", reference: "R-1", description: "Transfer", occurred_at: "2026-10-01T00:00:00Z" }], limit: 25, offset: 0 });
    if (url.includes("/categories/cat-expense/archive/")) return json({ id: "cat-expense", is_active: false });
    if (url.includes("/categories/cat-expense/") && init?.method === "PATCH") return json({ id: "cat-expense", name: "Supplies" });
    if (url.includes("/categories/") && init?.method === "POST") return json({ id: "cat-new", name: "Travel" }, 201);
    if (url.includes("/categories/")) return json({ results: [{ id: "cat-expense", name: "Office", type: "EXPENSE", is_active: true }] });
    if (url.includes("/contacts/")) return json({ results: [] });
    if (url.includes("/income/")) return json({ results: [] });
    if (url.includes("/expenses/")) return json({ results: [] });
    if (url.includes("/reports/")) return json({ results: [] });
    return json({});
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("core financial workflows", () => {
  it("renders real account data with authoritative balance report", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /accounts/i }));
    expect(await screen.findByText("Cash")).toBeTruthy();
    expect((await screen.findAllByText(/125\.00/)).length).toBeGreaterThan(0);
  });

  it("creates a transfer through ledger create and post endpoints", async () => {
    renderApp();
    await screen.findByText(/good morning/i);
    window.dispatchEvent(new CustomEvent("fintrace-action", { detail: "Transfer money" }));
    await userEvent.type(await screen.findByLabelText(/amount/i), "25.00");
    await userEvent.selectOptions(screen.getByLabelText(/source account/i), "cash");
    await userEvent.selectOptions(screen.getByLabelText(/destination account/i), "cash");
    await userEvent.click(screen.getByRole("button", { name: /^transfer money$/i }));
    expect(await screen.findByText(/source and destination accounts/i)).toBeTruthy();
  });

  it("edits and archives an account through real account endpoints", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /accounts/i }));
    await userEvent.click((await screen.findAllByText("Cash"))[0]);
    await userEvent.click(await screen.findByRole("button", { name: /^edit$/i }));
    const nameInput = await screen.findByLabelText(/account name/i);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "Cash edited");
    await userEvent.click(screen.getByRole("button", { name: /save account/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/accounts/cash/"), expect.objectContaining({ method: "PATCH" })));

    await userEvent.click((await screen.findAllByText("Cash"))[0]);
    await userEvent.click(await screen.findByRole("button", { name: /^archive$/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/accounts/cash/archive/"), expect.objectContaining({ method: "POST" })));
  });

  it("creates, edits, and archives categories through real category endpoints", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /settings/i }));
    await userEvent.click(await screen.findByRole("button", { name: /categories/i }));

    await userEvent.type(await screen.findByLabelText(/category name/i), "Travel");
    await userEvent.click(screen.getByRole("button", { name: /create category/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/categories/"), expect.objectContaining({ method: "POST" })));

    const officeRow = (await screen.findByText("Office")).closest(".table-row") as HTMLElement;
    await userEvent.click(within(officeRow).getByRole("button", { name: /edit/i }));
    const editInput = screen.getByLabelText(/category name/i);
    await userEvent.clear(editInput);
    await userEvent.type(editInput, "Supplies");
    await userEvent.click(screen.getByRole("button", { name: /update category/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/categories/cat-expense/"), expect.objectContaining({ method: "PATCH" })));

    const archiveRow = (await screen.findByText("Office")).closest(".table-row") as HTMLElement;
    await userEvent.click(within(archiveRow).getByRole("button", { name: /archive/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/categories/cat-expense/archive/"), expect.objectContaining({ method: "POST" })));
  });

  it("shows transaction detail and calls reversal endpoint", async () => {
    renderApp();
    await userEvent.click(await screen.findByRole("button", { name: /transactions/i }));
    await userEvent.click(await screen.findByText("Transfer"));
    expect(await screen.findByText("Transaction detail")).toBeTruthy();
    await userEvent.click(await screen.findByRole("button", { name: /reverse transaction/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/transactions/tx-1/reverse/"), expect.any(Object)));
  });
});
