import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { apiClient } from "../lib/api/apiClient";
import { useAuth } from "../providers/AuthProvider";
import { useTenant } from "../providers/TenantProvider";

type IconName =
  | "home" | "wallet" | "swap" | "repeat" | "debt" | "trend" | "chart"
  | "settings" | "search" | "bell" | "plus" | "arrow" | "sun" | "moon"
  | "chevron" | "more" | "calendar" | "filter" | "download" | "close"
  | "check" | "building" | "card" | "lock" | "users" | "plug";

const paths: Record<IconName, ReactNode> = {
  home: <><path d="M3 10.8 12 3l9 7.8"/><path d="M5.5 9.5V21h13V9.5M9 21v-7h6v7"/></>,
  wallet: <><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19a1 1 0 0 1 1 1v15H6a3 3 0 0 1-3-3V7"/><path d="M3 8h15M16 13h4v4h-4a2 2 0 0 1 0-4Z"/></>,
  swap: <><path d="M4 7h14M15 4l3 3-3 3M20 17H6M9 14l-3 3 3 3"/></>,
  repeat: <><path d="M17 2l3 3-3 3"/><path d="M3 11V9a4 4 0 0 1 4-4h13M7 22l-3-3 3-3"/><path d="M21 13v2a4 4 0 0 1-4 4H4"/></>,
  debt: <><path d="M4 6h16v14H4z"/><path d="M8 6V4h8v2M8 11h8M8 15h5"/></>,
  trend: <><path d="M3 18 9 12l4 4 8-10"/><path d="M15 6h6v6"/></>,
  chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21H9.6v-.08A1.7 1.7 0 0 0 8.5 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.6-1H3v-4h.08A1.7 1.7 0 0 0 4.6 8.5a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6V3h4v.08A1.7 1.7 0 0 0 15.5 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.6 1h.08v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  arrow: <path d="m5 12 14 0m-6-6 6 6-6 6"/>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>,
  moon: <path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"/>,
  chevron: <path d="m9 18 6-6-6-6"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></>,
  filter: <path d="M4 5h16l-6 7v6l-4 2v-8Z"/>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M5 21h14"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  check: <path d="m5 12 4 4L19 6"/>,
  building: <><path d="M4 21V7l8-4 8 4v14M9 9h1m4 0h1M9 13h1m4 0h1M9 17h6"/></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/></>,
  lock: <><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
  plug: <><path d="m8 12 8-8m-5 11 8-8M5 19l-2 2m4-8 4 4-3 3a3 3 0 0 1-4-4Z"/></>,
};

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("").trim();
  return "";
}

function dispatchAction(action: string) {
  window.dispatchEvent(new CustomEvent("fintrace-action", { detail: action }));
}

function Button({ children, kind = "secondary", icon, onClick, className = "", ariaLabel, disabled = false }: { children?: ReactNode; kind?: "primary" | "secondary" | "ghost" | "icon" | "danger"; icon?: IconName; onClick?: () => void; className?: string; ariaLabel?: string; disabled?: boolean }) {
  const action = ariaLabel || nodeText(children) || "Open options";
  return <button type="button" aria-label={ariaLabel} className={`btn btn-${kind} ${className}`} disabled={disabled} onClick={onClick || (() => dispatchAction(action))}>{icon && <Icon name={icon} />}{children}</button>;
}

const nav = [
  ["Dashboard", "home"], ["Accounts", "wallet"], ["Transactions", "swap"],
  ["Recurring", "repeat"], ["Debts", "debt"], ["Investments", "trend"], ["Reports", "chart"],
] as [string, IconName][];

type ApiRow = Record<string, any>;
type ListResponse = { results?: ApiRow[]; limit?: number; offset?: number };
type SelectOption = { id: string; label: string };

const ACCOUNT_TYPES = ["ASSET", "BANK", "CASH", "CREDIT_CARD", "WALLET", "INVESTMENT", "LIABILITY", "LOAN", "EQUITY", "INCOME", "EXPENSE"];

function formatMoney(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return "Unavailable";
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "Unavailable";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(numeric);
}

function displayUserName(user: any) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ").trim();
  return name || user?.username || user?.email || "FinTrace User";
}

function initialsFromName(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join("") || "FT";
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function newIdempotencyKey(scope: string) {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${scope}-${random}`;
}

function eventRefreshFinancialState() {
  window.dispatchEvent(new CustomEvent("financial-data:changed"));
}

function apiMessage(err: unknown) {
  return err instanceof Error ? err.message : "Request failed";
}

function isForbidden(err: unknown) {
  return typeof err === "object" && err !== null && "status" in err && (err as { status?: number }).status === 403;
}

function useTenantReloadKey() {
  const { currentCompany } = useTenant();
  return String(currentCompany?.company_id || currentCompany?.id || "");
}

function useFinancialPermissions() {
  const { can, permissionsLoading } = useTenant();
  return {
    permissionsLoading,
    canViewAccounts: can("accounts.view"),
    canCreateAccounts: can("accounts.create"),
    canUpdateAccounts: can("accounts.update"),
    canViewCategories: can("categories.view"),
    canCreateCategories: can("categories.create"),
    canUpdateCategories: can("categories.update"),
    canViewTransactions: can("transactions.view"),
    canCreateTransactions: can("transactions.create"),
    canPostTransactions: can("transactions.post"),
    canReverseTransactions: can("transactions.reverse"),
    canCreateIncome: can("income.create"),
    canCreateExpenses: can("expenses.create"),
  };
}

function useApiList(endpoint: string, deps: unknown[] = []) {
  const tenantKey = useTenantReloadKey();
  const [rows, setRows] = useState<ApiRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = async () => {
    const requestTenant = tenantKey;
    setRows([]);
    if (!requestTenant) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const data = await apiClient(endpoint) as ListResponse;
      if (requestTenant === tenantKey) setRows(data.results || []);
    } catch (err) {
      if (requestTenant === tenantKey) {
        setForbidden(isForbidden(err));
        setError(apiMessage(err));
      }
    } finally {
      if (requestTenant === tenantKey) setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener("tenant:changed", reload);
    window.addEventListener("financial-data:changed", reload);
    return () => {
      window.removeEventListener("tenant:changed", reload);
      window.removeEventListener("financial-data:changed", reload);
    };
  }, [tenantKey, endpoint, ...deps]);

  return { rows, loading, error, forbidden, reload: load, setRows };
}

function Logo() {
  return <div className="logo"><span className="logo-mark"><i /><i /><i /></span><strong>FINTRACE</strong></div>;
}

function Sidebar({ page, setPage, collapsed, setCollapsed, userName, userRole }: { page: string; setPage: (v: string) => void; collapsed: boolean; setCollapsed: (v: boolean) => void; userName: string; userRole: string }) {
  const { canViewAccounts, canViewTransactions } = useFinancialPermissions();
  const visibleNav = nav.filter(([label]) => {
    if (label === "Accounts") return canViewAccounts;
    if (label === "Transactions") return canViewTransactions;
    return true;
  });
  return <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
    <div className="side-head"><Logo/><Button kind="icon" onClick={() => setCollapsed(!collapsed)}><Icon name="chevron"/></Button></div>
    <nav className="nav-list" aria-label="Primary">
      {visibleNav.map(([label, icon]) => <button key={label} className={`nav-item ${page === label ? "active" : ""}`} onClick={() => setPage(label)}><Icon name={icon}/><span>{label}</span></button>)}
    </nav>
    <div className="side-bottom">
      <button className={`nav-item ${page === "Settings" ? "active" : ""}`} onClick={() => setPage("Settings")}><Icon name="settings"/><span>Settings</span></button>
      <div className="user-mini"><div className="avatar">{initialsFromName(userName)}</div><div><strong>{userName}</strong><span>{userRole}</span></div><Icon name="more"/></div>
    </div>
  </aside>;
}

function Topbar({ theme, setTheme, setSearchOpen, tenantOpen, setTenantOpen, showNotifications, onLogout, userName }: { theme: string; setTheme: (v: string) => void; setSearchOpen: (v: boolean) => void; tenantOpen: boolean; setTenantOpen: (v: boolean) => void; showNotifications: () => void; onLogout: () => void; userName: string }) {
  const { currentCompany, availableCompanies, isLoadingCompanies, tenantError, switchCompany, isSwitchingCompany } = useTenant();
  const tenantName = currentCompany?.company_name || currentCompany?.name || "No company selected";
  return <header className="topbar">
    <div className="tenant-wrap">
      <button className="tenant" onClick={(e) => { e.stopPropagation(); setTenantOpen(!tenantOpen); }} disabled={isLoadingCompanies || isSwitchingCompany}><span className="tenant-logo">{initialsFromName(tenantName)}</span><span><small>Workspace</small><strong>{isLoadingCompanies ? "Loading..." : tenantName}</strong></span><Icon name="chevron"/></button>
      {tenantOpen && <div className="popover tenant-menu">
        <p className="eyebrow">Workspaces</p>
        {tenantError && <div className="menu-state">{tenantError}</div>}
        {!tenantError && !isLoadingCompanies && availableCompanies.length === 0 && <div className="menu-state">No companies available.</div>}
        {availableCompanies.map((company) => {
          const id = String(company.company_id || company.id);
          const name = company.company_name || company.name || company.slug || "Company";
          const selected = String(currentCompany?.company_id || currentCompany?.id || "") === id;
          return <button className={selected ? "selected" : ""} key={id} onClick={async () => { await switchCompany(id); setTenantOpen(false); dispatchAction("Workspace changed"); }}><span className="tenant-logo">{initialsFromName(name)}</span><span><strong>{name}</strong><small>{company.status || company.slug || "Available"}</small></span>{selected && <Icon name="check"/>}</button>;
        })}
      </div>}
    </div>
    <button className="search-trigger" onClick={() => setSearchOpen(true)}><Icon name="search"/><span>Search Fintrace...</span><kbd>⌘ K</kbd></button>
    <div className="top-actions"><Button kind="icon" ariaLabel="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}><Icon name={theme === "dark" ? "sun" : "moon"}/></Button><Button kind="icon" ariaLabel="Notifications" onClick={showNotifications}><Icon name="bell"/><i className="notice"/></Button><Button kind="ghost" onClick={onLogout}>Logout</Button><button className="avatar avatar-button" onClick={() => dispatchAction("User menu")}>{initialsFromName(userName)}</button></div>
  </header>;
}

function PageTitle({ title, subtitle, action }: { title: string; subtitle: string; action?: ReactNode }) {
  return <div className="page-title"><div><p className="eyebrow">Personal Finance</p><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>;
}

function Metric({ label, value, delta, icon }: { label: string; value: string; delta: string; icon: IconName }) {
  const positive = delta.startsWith("+");
  return <div className="metric card"><div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon name={icon}/></span></div><strong className="financial">{value}</strong><div className="delta-row"><span className={positive ? "positive" : "good"}>{delta}</span><span>vs last month</span></div></div>;
}

function CashFlowChart({ investment = false }: { investment?: boolean }) {
  const ranges = investment ? ["1D","1W","1M","3M","6M","1Y","ALL"] : ["7D","30D","3M","6M","1Y"];
  const [range, setRange] = useState(investment ? "1M" : "30D");
  return <div className={`card chart-card ${investment ? "portfolio-chart" : ""}`}>
    <div className="card-head"><div><h2>{investment ? "Portfolio performance" : "Cash flow"}</h2><p>{investment ? `Value across all investments · ${range}` : `Income and expenses · ${range}`}</p></div><div className="range">{ranges.map(x => <button className={range === x ? "active" : ""} onClick={() => setRange(x)} key={x}>{x}</button>)}</div></div>
    <div className="chart-area">
      <div className="chart-y"><span>₹2L</span><span>₹1.5L</span><span>₹1L</span><span>₹50K</span><span>₹0</span></div>
      <svg viewBox="0 0 720 220" preserveAspectRatio="none" role="img" aria-label="Financial performance chart">
        <defs><linearGradient id="area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--primary)" stopOpacity=".22"/><stop offset="1" stopColor="var(--primary)" stopOpacity="0"/></linearGradient></defs>
        {[20,65,110,155,200].map(y => <line key={y} x1="0" x2="720" y1={y} y2={y} className="grid-line"/>)}
        <path className="area" d={investment ? "M0 180 C55 165 80 172 120 142 S195 154 240 122 310 132 360 96 445 114 500 78 600 80 720 38 L720 220 L0 220Z" : "M0 158 C55 140 80 155 120 126 S195 144 240 112 310 122 360 82 445 116 500 72 600 95 720 44 L720 220 L0 220Z"}/>
        <path className="line-primary" d={investment ? "M0 180 C55 165 80 172 120 142 S195 154 240 122 310 132 360 96 445 114 500 78 600 80 720 38" : "M0 158 C55 140 80 155 120 126 S195 144 240 112 310 122 360 82 445 116 500 72 600 95 720 44"}/>
        {!investment && <path className="line-secondary" d="M0 185 C60 170 90 188 145 158 S230 172 280 145 355 165 420 130 505 155 560 120 645 142 720 96"/>}
        <circle cx="500" cy={investment ? 78 : 72} r="5" className="chart-point"/>
      </svg>
      <div className="chart-tip"><span>{investment ? "Portfolio value" : "Net cash flow"}</span><strong>{investment ? "₹12,84,500" : "₹92,550"}</strong><small>Sep 18, 2026</small></div>
      <div className="chart-x"><span>1 Sep</span><span>7 Sep</span><span>14 Sep</span><span>21 Sep</span><span>30 Sep</span></div>
    </div>
    {!investment && <div className="legend"><span><i className="dot primary"/>Income <strong>₹1,85,000</strong></span><span><i className="dot coral"/>Expenses <strong>₹92,450</strong></span></div>}
  </div>;
}

function Spending() {
  return <div className="card spending"><div className="card-head"><div><h2>Spending</h2><p>September 2026</p></div><Button kind="ghost">View report <Icon name="arrow"/></Button></div><div className="spend-body"><div className="donut"><div><strong>₹92,450</strong><span>Total spent</span></div></div><div className="spend-list">
    {[["Housing","₹29,584","32%"],["Food & dining","₹16,641","18%"],["Transport","₹11,094","12%"],["Shopping","₹9,245","10%"],["Other","₹25,886","28%"]].map((x,i)=><div key={x[0]}><i className={`cat c${i}`}/><span>{x[0]}<small>{x[1]}</small></span><strong>{x[2]}</strong></div>)}
  </div></div></div>;
}

function TransactionsCard({ full = false, rows = [], isRealData = false }: { full?: boolean; rows?: any[]; isRealData?: boolean }) {
  return <div className={`card transactions-card ${full ? "full" : ""}`}><div className="card-head"><div><h2>Recent transactions</h2><p>{isRealData ? "Loaded from FinTrace ledger" : "No live transaction feed connected here yet"}</p></div><Button kind="ghost">View all <Icon name="arrow"/></Button></div><div className="transaction-head"><span>Transaction</span><span>Account</span><span>Date</span><span>Amount</span></div>{rows.length === 0 && <div className="empty-state">No transactions available for this company.</div>}{rows.map((t, i) => <div className="transaction-row" key={t.id || t.name || i}><div className={`merchant m${i % 4}`}><span>{(t.icon || t.reference || t.description || "T").slice(0, 1)}</span></div><div className="transaction-name"><strong>{t.reference || t.description || t.name || "Ledger transaction"}</strong><span>{t.status || t.category || "Transaction"}</span></div><span className="account-col">{t.account || "Ledger"}</span><span className="date-col">{t.occurred_at ? new Date(t.occurred_at).toLocaleDateString() : t.date || "Unavailable"}</span><strong className={`amount ${t.tone || ""}`}>{t.amount || "View detail"}</strong><Button kind="icon"><Icon name="more"/></Button></div>)}</div>;
}

function AccountsCard({ setPage, accounts }: { setPage: (v: string) => void; accounts: ApiRow[] }) {
  const total = accounts.reduce((sum, account) => sum + Number(account.balance || account.current_balance || account.base_balance || 0), 0);
  return <div className="card accounts-card"><div className="card-head"><div><h2>Your accounts</h2><p>{accounts.length ? `${formatMoney(total)} across ${accounts.length} accounts` : "No accounts available"}</p></div><Button kind="ghost" onClick={() => setPage("Accounts")}>Manage <Icon name="arrow"/></Button></div>{accounts.length === 0 && <div className="empty-state">Create accounts in this company to populate balances.</div>}{accounts.slice(0, 4).map((account,i)=><button className="account-row" key={account.id || account.name || i} onClick={()=>setPage("Accounts")}><span className={`bank b${i % 4}`}>{String(account.name || "ACC").slice(0,3).toUpperCase()}</span><span><strong>{account.name || "Account"}</strong><small>{account.type || account.normal_balance || "Account"}</small></span><strong>{formatMoney(account.balance || account.current_balance || account.base_balance)}</strong><Icon name="chevron"/></button>)}</div>;
}

function Dashboard({ setPage, openExpense }: { setPage: (v: string) => void; openExpense: () => void }) {
  const { user } = useAuth();
  const { currentCompany } = useTenant();
  const { canCreateIncome, canCreateExpenses } = useFinancialPermissions();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [income, setIncome] = useState<ApiRow[]>([]);
  const [expenses, setExpenses] = useState<ApiRow[]>([]);
  const [accounts, setAccounts] = useState<ApiRow[]>([]);
  const [transactionsRows, setTransactionsRows] = useState<ApiRow[]>([]);
  const [debtRows, setDebtRows] = useState<ApiRow[]>([]);
  const [investmentRows, setInvestmentRows] = useState<ApiRow[]>([]);

  const loadDashboard = async () => {
    if (!currentCompany) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [incomeData, expenseData, accountData, transactionData, debtData, investmentData] = await Promise.all([
        apiClient("/income/?limit=50").catch(() => ({ results: [] })),
        apiClient("/expenses/?limit=50").catch(() => ({ results: [] })),
        apiClient("/accounts/?limit=50").catch(() => ({ results: [] })),
        apiClient("/transactions/?limit=8").catch(() => ({ results: [] })),
        apiClient("/reports/debt-balances/?limit=50").catch(() => ({ results: [] })),
        apiClient("/reports/investment-position-summary/?limit=50").catch(() => ({ results: [] })),
      ]);
      setIncome(incomeData.results || []);
      setExpenses(expenseData.results || []);
      setAccounts(accountData.results || []);
      setTransactionsRows(transactionData.results || []);
      setDebtRows(debtData.results || []);
      setInvestmentRows(investmentData.results || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDashboard();
    const reload = () => void loadDashboard();
    window.addEventListener("tenant:changed", reload);
    return () => window.removeEventListener("tenant:changed", reload);
  }, [currentCompany?.company_id, currentCompany?.id]);

  const totalIncome = income.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalExpenses = expenses.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const totalBalance = accounts.reduce((sum, row) => sum + Number(row.balance || row.current_balance || row.base_balance || 0), 0);
  const debtTotal = debtRows.reduce((sum, row) => sum + Number(row.outstanding_balance || row.balance || 0), 0);
  const investmentTotal = investmentRows.reduce((sum, row) => sum + Number(row.market_value || row.current_value || row.value || 0), 0);

  return <><PageTitle title={`Good morning, ${displayUserName(user).split(" ")[0]}`} subtitle={currentCompany ? `Financial overview for ${currentCompany.company_name || currentCompany.name}.` : "Select a company to load financial data."} action={<div className="title-actions"><Button icon="calendar">This month</Button>{canCreateExpenses && <Button kind="primary" icon="plus" onClick={openExpense}>Add expense</Button>}</div>}/>
    {loading && <div className="card app-state">Loading live dashboard...</div>}
    {error && <div className="card app-state error-state">{error}</div>}
    <div className="quick-row">{canCreateIncome && <Button kind="primary" icon="plus" onClick={() => dispatchAction("Add income")}>Add income</Button>}{canCreateExpenses && <Button icon="plus" onClick={openExpense}>Add expense</Button>}</div>
    <section className="metrics-grid"><Metric label="Total balance" value={accounts.length ? formatMoney(totalBalance) : "Unavailable"} delta="Live API" icon="wallet"/><Metric label="Income" value={income.length ? formatMoney(totalIncome) : "Unavailable"} delta="Live API" icon="trend"/><Metric label="Expenses" value={expenses.length ? formatMoney(totalExpenses) : "Unavailable"} delta="Live API" icon="card"/><Metric label="Net cash flow" value={(income.length || expenses.length) ? formatMoney(totalIncome - totalExpenses) : "Unavailable"} delta="Calculated" icon="chart"/></section>
    <section className="metrics-grid"><Metric label="Debt" value={debtRows.length ? formatMoney(debtTotal) : "Unavailable"} delta="Report API" icon="debt"/><Metric label="Investment value" value={investmentRows.length ? formatMoney(investmentTotal) : "Unavailable"} delta="Report API" icon="trend"/><Metric label="Recent transactions" value={String(transactionsRows.length)} delta="Ledger API" icon="swap"/><Metric label="Companies" value={currentCompany ? "Active" : "Unavailable"} delta="Tenant context" icon="building"/></section>
    <section className="dashboard-grid"><div className="card chart-card"><div className="card-head"><div><h2>Cash flow chart</h2><p>Historical chart endpoint is not available yet.</p></div></div><div className="empty-state">Trend visualization will be enabled when a backend time-series report exists.</div></div><div className="card spending"><div className="card-head"><div><h2>Spending</h2><p>Category analytics endpoint is not available yet.</p></div></div><div className="empty-state">No category breakdown API is currently implemented.</div></div></section>
    <section className="dashboard-grid lower"><TransactionsCard rows={transactionsRows} isRealData/><AccountsCard setPage={setPage} accounts={accounts}/></section>
  </>;
}

function AccountsPage({ setPage }: { setPage: (v: string) => void }) {
  const { rows, loading, error, forbidden, reload } = useApiList("/accounts/?limit=100");
  const { rows: balances, loading: balancesLoading } = useApiList("/reports/account-balances/?limit=100");
  const { rows: currencies } = useApiList("/currencies/");
  const { canCreateAccounts, canUpdateAccounts } = useFinancialPermissions();
  const [selected, setSelected] = useState<ApiRow | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ApiRow | null>(null);
  const balanceByAccount = new Map(balances.map(balance => [String(balance.account_id), balance]));
  const accountRows = rows.map(account => ({ ...account, ...(balanceByAccount.get(String(account.id)) || {}) }));
  const total = accountRows.reduce((sum, account) => sum + Number(account.balance_base_amount || account.balance_amount || 0), 0);

  const openEdit = (account: ApiRow) => {
    setEditing(account);
    setFormOpen(true);
  };

  const archive = async (account: ApiRow) => {
    if (!canUpdateAccounts) return;
    try {
      await apiClient(`/accounts/${account.id}/archive/`, { method: "POST" });
      eventRefreshFinancialState();
      await reload();
    } catch (err) {
      window.alert(apiMessage(err));
    }
  };

  return <><PageTitle title="Accounts" subtitle="Manage tenant-scoped financial accounts." action={canCreateAccounts ? <Button kind="primary" icon="plus" onClick={() => { setEditing(null); setFormOpen(true); }}>Add account</Button> : <Button icon="lock">Create restricted</Button>}/>
    <div className="toolbar"><button className="input-like" onClick={() => dispatchAction("Search accounts")}><Icon name="search"/>Search accounts</button><span className="toolbar-spacer"/><p><strong>{accountRows.length}</strong> accounts · <strong>{accountRows.length ? formatMoney(total) : "No balance report"}</strong></p></div>
    {(loading || balancesLoading) && <div className="card app-state">Loading accounts and authoritative balances...</div>}
    {forbidden && <div className="card app-state error-state">You do not have permission to view accounts for this company.</div>}
    {error && !forbidden && <div className="card app-state error-state">{error}</div>}
    {!loading && !error && accountRows.length === 0 && <div className="card empty-state">No accounts have been created yet.</div>}
    {!loading && !error && accountRows.length > 0 && <div className="card data-table account-table"><div className="table-header"><span>Account</span><span>Type</span><span>Ledger balance</span><span>Status</span><span>Updated</span><span/></div>{accountRows.map((account,i)=><div className="table-row clickable" key={account.id || account.account_id || account.name} onClick={() => setSelected(account)}><div className="table-account"><span className={`bank b${i % 4}`}>{String(account.name || "ACC").slice(0,3).toUpperCase()}</span><span><strong>{account.name || "Account"}</strong><small>{account.institution || account.normal_balance || "Tenant account"}</small></span></div><span>{account.type || "Unspecified"}</span><strong className="mono">{formatMoney(account.balance_amount)}</strong><span><i className="status-dot"/> {account.is_active === false ? "Inactive" : "Active"}</span><span>{account.updated_at ? new Date(account.updated_at).toLocaleDateString() : "Unavailable"}</span><Button kind="icon" ariaLabel={`${account.name} options`} onClick={() => setSelected(account)}><Icon name="more"/></Button></div>)}</div>}
    {selected && <AccountDetailModal account={selected} close={() => setSelected(null)} edit={() => openEdit(selected)} archive={() => void archive(selected)} canEdit={canUpdateAccounts}/>}
    {formOpen && <AccountForm account={editing} currencies={currencies} close={() => { setFormOpen(false); setEditing(null); }} saved={async () => { setFormOpen(false); setEditing(null); eventRefreshFinancialState(); await reload(); }}/>}
  </>;
}

function AccountForm({ account, currencies, close, saved }: { account: ApiRow | null; currencies: ApiRow[]; close: () => void; saved: () => Promise<void> }) {
  const isEdit = !!account;
  const [name, setName] = useState(account?.name || "");
  const [type, setType] = useState(account?.type || "ASSET");
  const [normalBalance, setNormalBalance] = useState(account?.normal_balance || "DEBIT");
  const [institution, setInstitution] = useState(account?.institution || "");
  const [accountNumber, setAccountNumber] = useState(account?.account_number || "");
  const [currencyId, setCurrencyId] = useState(account?.currency_id || currencies[0]?.id || "");
  const [notes, setNotes] = useState(account?.notes || "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (isEdit) {
        await apiClient(`/accounts/${account.id}/`, { method: "PATCH", body: JSON.stringify({ name, institution, account_number: accountNumber, notes, is_active: account.is_active !== false }) });
      } else {
        await apiClient("/accounts/", { method: "POST", body: JSON.stringify({ name, type, normal_balance: normalBalance, institution, account_number: accountNumber, currency_id: currencyId, notes }) });
      }
      await saved();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="overlay modal-overlay" onMouseDown={close}><form className="action-modal card" onMouseDown={event => event.stopPropagation()} onSubmit={submit}><div className="drawer-head"><div><h2>{isEdit ? "Edit account" : "Add account"}</h2><p>{isEdit ? "Update supported account fields." : "Create a tenant-scoped financial account."}</p></div><Button kind="icon" ariaLabel="Close modal" onClick={close}><Icon name="close"/></Button></div><div className="modal-form">{error && <div className="auth-error">{error}</div>}<label className="field">Account name<input autoFocus value={name} onChange={event => setName(event.target.value)} required/></label><label className="field">Account type<select value={type} onChange={event => setType(event.target.value)} disabled={isEdit}>{ACCOUNT_TYPES.map(value => <option key={value} value={value}>{value.replace(/_/g, " ")}</option>)}</select></label><label className="field">Normal balance<select value={normalBalance} onChange={event => setNormalBalance(event.target.value)} disabled={isEdit}><option value="DEBIT">Debit</option><option value="CREDIT">Credit</option></select></label><label className="field">Currency<select value={currencyId} onChange={event => setCurrencyId(event.target.value)} disabled={isEdit} required={!isEdit}>{currencies.map(currency => <option key={currency.id} value={currency.id}>{currency.code || currency.name}</option>)}</select></label><label className="field">Institution<input value={institution} onChange={event => setInstitution(event.target.value)}/></label><label className="field">Account number<input value={accountNumber} onChange={event => setAccountNumber(event.target.value)}/></label><label className="field">Notes<textarea value={notes} onChange={event => setNotes(event.target.value)}/></label></div><div className="drawer-foot"><Button onClick={close}>Cancel</Button><button className="btn btn-primary" type="submit" disabled={submitting}>{submitting ? "Saving..." : isEdit ? "Save account" : "Create account"}</button></div></form></div>;
}

function AccountDetailModal({ account, close, edit, archive, canEdit }: { account: ApiRow; close: () => void; edit: () => void; archive: () => void; canEdit: boolean }) {
  return <div className="overlay modal-overlay" onMouseDown={close}><div className="action-modal card" onMouseDown={event => event.stopPropagation()}><div className="drawer-head"><div><h2>{account.name || "Account"}</h2><p>{account.type || "Account"} · {account.id || account.account_id}</p></div><Button kind="icon" ariaLabel="Close modal" onClick={close}><Icon name="close"/></Button></div><div className="modal-form">{[["Ledger balance", formatMoney(account.balance_amount)],["Base ledger balance", formatMoney(account.balance_base_amount)],["Opening balance", "Not stored separately by backend"],["Status", account.is_active === false ? "Inactive" : "Active"],["Institution", account.institution || "Unavailable"],["Normal balance", account.normal_balance || "Unavailable"],["Currency", account.currency_id || "Unavailable"],["Notes", account.notes || "None"],["Created", account.created_at ? new Date(account.created_at).toLocaleString() : "Unavailable"]].map(([label, value]) => <div className="info-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}<div className="empty-state">Account-scoped transaction history is not exposed by the backend transaction list endpoint yet.</div></div><div className="drawer-foot"><Button onClick={close}>Close</Button>{canEdit && <Button onClick={edit}>Edit</Button>}{canEdit && <Button kind="danger" onClick={archive}>Archive</Button>}</div></div></div>;
}

function TransactionsPage({ openExpense }: { openExpense: () => void }) {
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const { rows, loading, error, forbidden, reload } = useApiList(`/transactions/?limit=${limit}&offset=${offset}`, [offset]);
  const { canCreateIncome, canCreateExpenses, canReverseTransactions } = useFinancialPermissions();
  const [selected, setSelected] = useState<ApiRow | null>(null);

  return <><PageTitle title="Transactions" subtitle="Track posted ledger activity." action={<div className="title-actions">{canCreateIncome && <Button kind="primary" icon="plus" onClick={() => dispatchAction("Add income")}>Add income</Button>}{canCreateExpenses && <Button icon="plus" onClick={openExpense}>Add expense</Button>}</div>}/>
    <div className="toolbar"><button className="input-like" onClick={() => window.alert("Backend transaction search is not exposed yet.")}><Icon name="search"/>Search unavailable</button><Button icon="filter" onClick={() => window.alert("Backend transaction filters are not exposed yet; only limit/offset pagination is supported.")}>Filters unavailable</Button><span className="toolbar-spacer"/><p>Showing {offset + 1}-{offset + rows.length}</p></div>
    {loading && <div className="card app-state">Loading transactions...</div>}
    {forbidden && <div className="card app-state error-state">You do not have permission to view transactions for this company.</div>}
    {error && !forbidden && <div className="card app-state error-state">{error}</div>}
    {!loading && !error && rows.length === 0 && <div className="card empty-state">No transactions found.</div>}
    {!loading && !error && rows.length > 0 && <div className="card transactions-card full"><div className="transaction-head"><span>Transaction</span><span>Status</span><span>Date</span><span>Reference</span><span/></div>{rows.map((row, i) => <div className="transaction-row clickable" key={row.id} onClick={() => setSelected(row)}><div className={`merchant m${i % 4}`}><span>{String(row.reference || row.description || "T").slice(0, 1) || "T"}</span></div><div className="transaction-name"><strong>{row.description || row.reference || "Ledger transaction"}</strong><span>{row.id}</span></div><span className="account-col">{row.status || "Unknown"}</span><span className="date-col">{row.occurred_at ? new Date(row.occurred_at).toLocaleString() : "Unavailable"}</span><strong className="amount">{row.reference || "No reference"}</strong><Button kind="icon" ariaLabel="Transaction detail"><Icon name="more"/></Button></div>)}</div>}
    <div className="toolbar"><Button onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button><Button onClick={() => setOffset(offset + limit)} disabled={rows.length < limit}>Next</Button></div>
    {selected && <TransactionDetailModal transaction={selected} close={() => setSelected(null)} reloaded={async () => { setSelected(null); eventRefreshFinancialState(); await reload(); }} canReverse={canReverseTransactions}/>}
  </>;
}

function TransactionDetailModal({ transaction, close, reloaded, canReverse }: { transaction: ApiRow; close: () => void; reloaded: () => Promise<void>; canReverse: boolean }) {
  const [detail, setDetail] = useState<ApiRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiClient(`/transactions/${transaction.id}/`).then(data => { if (active) setDetail(data as ApiRow); }).catch(err => { if (active) setError(apiMessage(err)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [transaction.id]);

  const reverse = async () => {
    setReversing(true);
    setError(null);
    try {
      await apiClient(`/transactions/${transaction.id}/reverse/`, { method: "POST", headers: { "Idempotency-Key": newIdempotencyKey("ledger-reverse") }, body: JSON.stringify({ occurred_at: nowIso(), reference: `REV-${transaction.reference || transaction.id}` }) });
      await reloaded();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setReversing(false);
    }
  };

  const row = detail || transaction;
  return <div className="overlay modal-overlay" onMouseDown={close}><div className="action-modal card" onMouseDown={event => event.stopPropagation()}><div className="drawer-head"><div><h2>Transaction detail</h2><p>{row.id}</p></div><Button kind="icon" ariaLabel="Close modal" onClick={close}><Icon name="close"/></Button></div><div className="modal-form">{loading && <div className="app-state">Loading transaction...</div>}{error && <div className="auth-error">{error}</div>}{[["Status", row.status || "Unavailable"],["Reference", row.reference || "None"],["Description", row.description || "None"],["Occurred", row.occurred_at ? new Date(row.occurred_at).toLocaleString() : "Unavailable"],["Reverses", row.reverses_transaction_id || "None"]].map(([label, value]) => <div className="info-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}{Array.isArray(row.entries) && <div className="card data-table"><div className="table-header"><span>Account</span><span>Debit</span><span>Credit</span></div>{row.entries.map((entry: ApiRow) => <div className="table-row" key={entry.id}><span>{entry.account_id}</span><span>{formatMoney(entry.debit_amount)}</span><span>{formatMoney(entry.credit_amount)}</span></div>)}</div>}</div><div className="drawer-foot"><Button onClick={close}>Close</Button>{canReverse && row.status === "COMPLETED" && !row.reverses_transaction_id && <Button kind="danger" onClick={reverse}>{reversing ? "Reversing..." : "Reverse transaction"}</Button>}</div></div></div>;
}

function InvestmentsPage({ setPage }: { setPage: (v: string) => void }) {
  const holdings = [["RELIANCE","Reliance Industries","12","₹2,418.50","₹2,956.40","₹35,476.80","+₹6,454.80"],["HDFCBANK","HDFC Bank","20","₹1,522.10","₹1,694.20","₹33,884.00","+₹3,442.00"],["PARAG","Parag Parikh Flexi Cap","—","₹62.44","₹78.92","₹3,15,680.00","+₹48,240.00"],["GOLDBEES","Nippon Gold ETF","100","₹51.23","₹62.48","₹6,248.00","+₹1,125.00"]];
  return <><PageTitle title="Investments" subtitle="Your portfolio at a glance." action={<><Button icon="plug" onClick={() => setPage("Investment integrations")}>Integrations</Button><Button kind="primary" icon="plus">Add investment</Button></>}/><section className="metrics-grid"><Metric label="Portfolio value" value="₹12,84,500" delta="+7.9%" icon="trend"/><Metric label="Invested" value="₹11,90,000" delta="+2.1%" icon="wallet"/><Metric label="Total P&L" value="+₹94,500" delta="+7.94%" icon="chart"/><Metric label="Today’s change" value="+₹8,240" delta="+0.65%" icon="trend"/></section><CashFlowChart investment/><div className="card data-table holdings"><div className="card-head"><div><h2>Holdings</h2><p>Assets across connected accounts</p></div><Button kind="ghost">View all holdings <Icon name="arrow"/></Button></div><div className="table-header"><span>Asset</span><span>Qty</span><span>Avg. price</span><span>Current price</span><span>Value</span><span>P&L</span></div>{holdings.map((r,i)=><div className="table-row clickable" onClick={() => dispatchAction(`${r[0]} holding details`)} key={r[0]}><div className="holding-name"><span className={`asset a${i}`}>{r[0][0]}</span><span><strong>{r[0]}</strong><small>{r[1]}</small></span></div>{r.slice(2,6).map(x=><span className="mono" key={x}>{x}</span>)}<strong className="positive mono">{r[6]}</strong></div>)}</div></>;
}

function AccountDetailsPage({ setPage }: { setPage: (v: string) => void }) {
  return <><button className="back-link" onClick={() => setPage("Accounts")}><Icon name="chevron"/> Accounts</button><div className="card empty-state">Account details are opened from the real Accounts table.</div></>;
}

function InvestmentIntegrationsPage({ setPage }: { setPage: (v: string) => void }) {
  const [connected, setConnected] = useState({ Zerodha: true, Coin: true, Groww: false });
  return <><button className="back-link" onClick={() => setPage("Investments")}><Icon name="chevron"/> Investments</button><PageTitle title="Investment integrations" subtitle="Connect your investment accounts and keep your portfolio synchronized." action={<Button icon="plus">Request integration</Button>}/>
    <div className="integration-grid">{[
      ["Zerodha","Stocks, ETFs & investments","Z","4 min ago"],
      ["Coin","Mutual fund investments","C","12 min ago"],
      ["Groww","Stocks and mutual funds","G","Not connected"],
    ].map(([name,desc,letter,sync],i) => <div className="card integration-card" key={name}><div className={`integration-logo int-${i}`}>{letter}</div><div className="integration-heading"><div><h2>{name}</h2><p>{desc}</p></div><span className={connected[name as keyof typeof connected] ? "badge" : "badge neutral"}>{connected[name as keyof typeof connected] ? "Connected" : "Available"}</span></div><div className="sync-line"><span>Last synced</span><strong>{sync}</strong></div><div className="integration-actions">{connected[name as keyof typeof connected] ? <><Button icon="repeat" onClick={() => dispatchAction(`${name} sync started`)}>Sync now</Button><Button onClick={() => dispatchAction(`Manage ${name}`)}>Manage</Button><Button kind="ghost" onClick={() => setConnected({...connected,[name]:false})}>Disconnect</Button></> : <Button kind="primary" onClick={() => setConnected({...connected,[name]:true})}>Connect {name}</Button>}</div></div>)}
    </div><div className="card integration-note"><Icon name="lock"/><div><strong>Your data stays secure</strong><p>Fintrace uses encrypted, read-only connections. We can never place trades or move funds.</p></div></div>
  </>;
}

function GenericPage({ page }: { page: string }) {
  const data: Record<string, { sub: string; metrics: [string,string,string,IconName][]; title: string }> = {
    Recurring: { sub: "Automate and monitor your recurring finances.", title: "Upcoming schedules", metrics: [["Monthly recurring","₹48,920","12 active","repeat"],["Next 7 days","₹14,649","4 payments","calendar"],["Income schedules","₹85,000","1 active","trend"],["Paused","₹3,250","2 schedules","repeat"]] },
    Debts: { sub: "A clear path to becoming debt-free.", title: "Your debts", metrics: [["Total debt","₹4,82,500","4 accounts","debt"],["Outstanding","₹3,25,000","67.4% remaining","wallet"],["Paid","₹1,57,500","32.6% complete","check"],["Upcoming","₹24,500","Due this month","calendar"]] },
    Reports: { sub: "Understand your money with precise financial analytics.", title: "Financial reports", metrics: [["Total income","₹1,85,000","+12.4%","trend"],["Total expenses","₹92,450","−3.2%","card"],["Savings rate","50.03%","+4.6%","chart"],["Net worth","₹16,02,060","+6.8%","wallet"]] },
  };
  const d = data[page];
  return <><PageTitle title={page} subtitle={d.sub} action={<Button kind="primary" icon={page === "Reports" ? "download" : "plus"}>{page === "Reports" ? "Export report" : `Add ${page === "Debts" ? "debt" : "recurring"}`}</Button>}/><section className="metrics-grid">{d.metrics.map(x=><Metric key={x[0]} label={x[0]} value={x[1]} delta={x[2]} icon={x[3]}/>)}</section>{page === "Reports" ? <CashFlowChart/> : <div className="card schedule-list"><div className="card-head"><div><h2>{d.title}</h2><p>{page === "Debts" ? "Repayment progress and next payments" : "Payments due in the next 30 days"}</p></div><Button kind="ghost">View all <Icon name="arrow"/></Button></div>{["Netflix","Home loan","Adobe Creative Cloud","Vehicle loan"].slice(0,page === "Debts" ? 2 : 4).map((n,i)=><div className="schedule-row" key={n}><span className={`merchant m${i}`}>{n[0]}</span><span><strong>{n}</strong><small>{page === "Debts" ? ["HDFC Bank · 8.4% interest","ICICI Bank · 9.1% interest"][i] : "Monthly · HDFC Savings"}</small></span><div className="progress-wrap">{page === "Debts" && <i><b style={{width: i ? "42%" : "68%"}}/></i>}<small>{page === "Debts" ? `${i ? "42" : "68"}% paid` : `Next on ${15+i*3} Sep`}</small></div><strong className="mono">{page === "Debts" ? ["₹2,45,000","₹80,000"][i] : ["₹649","₹3,250","₹1,675","₹14,500"][i]}</strong><span className="badge">Active</span><Button kind="icon"><Icon name="more"/></Button></div>)}</div>}</>;
}

function SettingsPage() {
  const { user } = useAuth();
  const sections = [["Profile","users"],["Workspace","building"],["Members","users"],["Categories","filter"],["Integrations","plug"],["Notifications","bell"],["Security","lock"],["Preferences","settings"]];
  const [section, setSection] = useState("Profile");
  const [toggles, setToggles] = useState([true,true,false]);
  const title = section === "Profile" ? "Profile information" : section === "Members" ? "Workspace members" : `${section} settings`;
  return <><PageTitle title="Settings" subtitle="Manage your profile, workspace, and preferences."/><div className="settings-layout"><div className="settings-nav">{sections.map(([x,i])=><button onClick={() => setSection(x)} className={section===x?"active":""} key={x}><Icon name={i as IconName}/>{x}</button>)}</div><div className="card settings-content"><div className="setting-title"><h2>{title}</h2><p>{section === "Members" ? "Manage access and roles for this workspace." : `Review and update your ${section.toLowerCase()} preferences.`}</p></div>
    {section === "Profile" && <><div className="profile-row"><div className="avatar large">{initialsFromName(displayUserName(user))}</div><div><strong>Profile photo</strong><p>PNG or JPG. Maximum 2 MB.</p></div><Button>Change photo</Button></div><div className="form-grid"><label>Full name<span>{displayUserName(user)}</span></label><label>Email address<span>{user?.email || "Unavailable"}</span></label><label>Username<span>{user?.username || "Unavailable"}</span></label><label>Timezone<span>Configured by browser</span></label></div></>}
    {section === "Members" && <div className="member-list">{[["AS","Arjun Sharma","arjun@fintrace.app","Admin"],["NK","Neha Kapoor","neha@example.com","Member"],["RM","Rohan Mehta","rohan@example.com","Viewer"]].map((m,i)=><div key={m[1]}><div className="avatar">{m[0]}</div><span><strong>{m[1]}</strong><small>{m[2]}</small></span><button className="role-select" onClick={() => dispatchAction(`Change ${m[1]} role`)}>{m[3]} <Icon name="chevron"/></button>{i > 0 && <Button kind="icon" ariaLabel={`Remove ${m[1]}`}><Icon name="more"/></Button>}</div>)}<Button icon="plus">Invite member</Button></div>}
    {section === "Categories" && <CategoryManager/>}
    {!["Profile","Members","Categories"].includes(section) && <div className="preference-list">{[
      [`${section} updates`,`Receive important updates about ${section.toLowerCase()}.`],
      ["Product insights","Get helpful recommendations from Fintrace."],
      ["Weekly summary","Receive a concise financial summary every Monday."],
    ].map((x,i)=><div key={x[0]}><span><strong>{x[0]}</strong><small>{x[1]}</small></span><button aria-label={`Toggle ${x[0]}`} className={`switch ${toggles[i]?"on":""}`} onClick={() => setToggles(toggles.map((v,n)=>n===i?!v:v))}><i/></button></div>)}</div>}
    <div className="form-actions"><Button>Cancel</Button><Button kind="primary">Save changes</Button></div></div></div></>;
}

function CategoryManager() {
  const { rows, loading, error, reload } = useApiList("/categories/?limit=100");
  const { canCreateCategories, canUpdateCategories } = useFinancialPermissions();
  const [editing, setEditing] = useState<ApiRow | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("EXPENSE");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reset = () => {
    setEditing(null);
    setName("");
    setType("EXPENSE");
    setFormError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      if (editing) {
        await apiClient(`/categories/${editing.id}/`, { method: "PATCH", body: JSON.stringify({ name, parent_id: editing.parent_id || null, is_active: editing.is_active !== false }) });
      } else {
        await apiClient("/categories/", { method: "POST", body: JSON.stringify({ name, type, parent_id: null }) });
      }
      reset();
      await reload();
    } catch (err) {
      setFormError(apiMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const archive = async (category: ApiRow) => {
    try {
      await apiClient(`/categories/${category.id}/archive/`, { method: "POST" });
      await reload();
    } catch (err) {
      setFormError(apiMessage(err));
    }
  };

  return <div className="category-manager"><form className="modal-form" onSubmit={submit}>{formError && <div className="auth-error">{formError}</div>}<div className="field-row"><label className="field">Category name<input value={name} onChange={event => setName(event.target.value)} disabled={!canCreateCategories && !editing} required/></label><label className="field">Type<select value={type} onChange={event => setType(event.target.value)} disabled={!!editing}><option value="INCOME">Income</option><option value="EXPENSE">Expense</option><option value="TRANSFER">Transfer</option><option value="OTHER">Other</option></select></label></div><div className="form-actions"><Button onClick={reset}>Reset</Button><button className="btn btn-primary" type="submit" disabled={submitting || (!editing && !canCreateCategories) || (!!editing && !canUpdateCategories)}>{submitting ? "Saving..." : editing ? "Update category" : "Create category"}</button></div></form>{loading && <div className="app-state">Loading categories...</div>}{error && <div className="auth-error">{error}</div>}<div className="card data-table"><div className="table-header"><span>Name</span><span>Type</span><span>Status</span><span/></div>{rows.map(category => <div className="table-row" key={category.id}><span>{category.name}</span><span>{category.type}</span><span>{category.is_active === false ? "Inactive" : "Active"}</span><span>{canUpdateCategories && <><Button kind="ghost" onClick={() => { setEditing(category); setName(category.name || ""); setType(category.type || "EXPENSE"); }}>Edit</Button><Button kind="danger" onClick={() => archive(category)}>Archive</Button></>}</span></div>)}</div></div>;
}

function SearchModal({ close, setPage, act }: { close: () => void; setPage: (v: string) => void; act: (v: string) => void }) {
  const [query, setQuery] = useState("");
  const destinations = nav.filter(([x]) => x.toLowerCase().includes(query.toLowerCase()));
  return <div className="overlay" onMouseDown={close}><div className="command" onMouseDown={e=>e.stopPropagation()}><div className="command-search"><Icon name="search"/><input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="Search Fintrace..." /><kbd>ESC</kbd></div><div className="command-body"><p className="eyebrow">Quick actions</p><div className="command-grid">{["Add income","Add expense","Transfer money","Add account"].map((x,i)=><button key={x} onClick={() => { close(); act(x); }}><Icon name={i<2?"plus":i===2?"swap":"wallet"}/>{x}</button>)}</div><p className="eyebrow">Go to</p>{destinations.map(([x,i])=><button className="command-item" key={x} onClick={()=>{setPage(x);close()}}><span><Icon name={i}/>{x}</span><kbd>↵</kbd></button>)}{destinations.length === 0 && <div className="no-results">No pages match “{query}”</div>}</div><div className="command-foot"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Select</span></div></div></div>;
}

function TransactionDrawer({ close, type, saved }: { close: () => void; type: string; saved: () => Promise<void> }) {
  const isTransfer = type === "Transfer money";
  const isExpense = !isTransfer && (type === "Add expense" || type === "Add transaction");
  const isIncome = type === "Add income";
  const { rows: accounts } = useApiList("/accounts/?limit=100");
  const { rows: categories } = useApiList("/categories/?limit=100");
  const { rows: contacts } = useApiList("/contacts/?limit=100");
  const { rows: currencies } = useApiList("/currencies/");
  const { canCreateIncome, canCreateExpenses, canCreateTransactions, canPostTransactions } = useFinancialPermissions();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(todayIsoDate());
  const [cashAccountId, setCashAccountId] = useState("");
  const [counterpartAccountId, setCounterpartAccountId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [currencyId, setCurrencyId] = useState("");
  const [contactId, setContactId] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitKey, setSubmitKey] = useState(() => newIdempotencyKey(isExpense ? "expense" : "income"));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!cashAccountId && accounts[0]?.id) setCashAccountId(accounts[0].id);
    if (!counterpartAccountId && accounts[1]?.id) setCounterpartAccountId(accounts[1].id);
    if (!isTransfer && !categoryId) {
      const category = categories.find(row => row.type === (isExpense ? "EXPENSE" : "INCOME")) || categories[0];
      if (category?.id) setCategoryId(category.id);
    }
    if (!currencyId && currencies[0]?.id) setCurrencyId(currencies[0].id);
  }, [accounts, categories, currencies, cashAccountId, counterpartAccountId, categoryId, currencyId, isExpense]);

  const permitted = isTransfer ? canCreateTransactions && canPostTransactions : isExpense ? canCreateExpenses : canCreateIncome;
  const title = isTransfer ? "Transfer money" : isExpense ? "Add expense" : "Add income";
  const filteredCategories = categories.filter(row => !row.type || row.type === (isExpense ? "EXPENSE" : "INCOME"));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!permitted || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const occurredAt = new Date(`${date}T00:00:00`).toISOString();
      if (isTransfer) {
        if (cashAccountId === counterpartAccountId) throw new Error("Source and destination accounts must be different.");
        const tx = await apiClient("/transactions/", {
          method: "POST",
          body: JSON.stringify({
            occurred_at: occurredAt,
            reference,
            description: notes || "Transfer",
            entries: [
              { account_id: counterpartAccountId, debit_amount: amount, credit_amount: "0" },
              { account_id: cashAccountId, debit_amount: "0", credit_amount: amount },
            ],
          }),
        }) as ApiRow;
        await apiClient(`/transactions/${tx.id}/post/`, { method: "POST" });
        eventRefreshFinancialState();
        await saved();
        return;
      }
      const payload = isExpense
        ? { occurred_at: occurredAt, occurred_on: date, source_account_id: cashAccountId, expense_account_id: counterpartAccountId, category_id: categoryId, amount, currency_id: currencyId, contact_id: contactId || undefined, reference, notes }
        : { occurred_at: occurredAt, occurred_on: date, destination_account_id: cashAccountId, income_account_id: counterpartAccountId, category_id: categoryId, amount, currency_id: currencyId, contact_id: contactId || undefined, reference, notes };
      await apiClient(isExpense ? "/expenses/" : "/income/", { method: "POST", headers: { "Idempotency-Key": submitKey }, body: JSON.stringify(payload) });
      setSubmitKey(newIdempotencyKey(isExpense ? "expense" : "income"));
      eventRefreshFinancialState();
      await saved();
    } catch (err) {
      setError(apiMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="overlay drawer-overlay" onMouseDown={close}><form className="drawer" onMouseDown={e=>e.stopPropagation()} onSubmit={submit}><div className="drawer-head"><div><h2>{title}</h2><p>{isTransfer ? "Creates and posts a two-entry ledger transaction." : "Creates a posted ledger transaction through the backend."}</p></div><Button kind="icon" ariaLabel="Close drawer" onClick={close}><Icon name="close"/></Button></div><div className="drawer-body">{!permitted && <div className="auth-error">You do not have permission to create this financial entry.</div>}{error && <div className="auth-error">{error}</div>}<label className="field amount-field">Amount<div><span>₹</span><input autoFocus value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" required/></div></label><label className="field">{isTransfer ? "Source account" : isExpense ? "Source account" : "Destination account"}<select value={cashAccountId} onChange={event => setCashAccountId(event.target.value)} required>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label className="field">{isTransfer ? "Destination account" : isExpense ? "Expense account" : "Income account"}<select value={counterpartAccountId} onChange={event => setCounterpartAccountId(event.target.value)} required>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.type}</option>)}</select></label>{!isTransfer && <label className="field">Category<select value={categoryId} onChange={event => setCategoryId(event.target.value)} required>{filteredCategories.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>}<div className="field-row"><label className="field">Date<input value={date} onChange={event => setDate(event.target.value)} type="date" required/></label>{!isTransfer && <label className="field">Currency<select value={currencyId} onChange={event => setCurrencyId(event.target.value)} required>{currencies.map(currency => <option key={currency.id} value={currency.id}>{currency.code || currency.name}</option>)}</select></label>}</div>{!isTransfer && <label className="field">Contact <small>Optional</small><select value={contactId} onChange={event => setContactId(event.target.value)}><option value="">None</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select></label>}<label className="field">Reference <small>Optional</small><input value={reference} onChange={event => setReference(event.target.value)}/></label><label className="field">Notes <small>Optional</small><textarea value={notes} onChange={event => setNotes(event.target.value)} /></label></div><div className="drawer-foot"><Button onClick={close}>Cancel</Button><button className="btn btn-primary" type="submit" disabled={!permitted || submitting}>{submitting ? "Saving..." : title}</button></div></form></div>;
}

function ActionModal({ action, close, confirm }: { action: string; close: () => void; confirm: () => void }) {
  const isWorkspace = action === "Create workspace";
  const isAccount = action === "Add account";
  const isInvite = action === "Invite member";
  return <div className="overlay modal-overlay" onMouseDown={close}><div className="action-modal card" onMouseDown={e => e.stopPropagation()}><div className="drawer-head"><div><h2>{action}</h2><p>{isWorkspace ? "Set up a new space for your finances." : isAccount ? "Connect or manually add a financial account." : isInvite ? "Invite a teammate to this workspace." : "Complete this action in Fintrace."}</p></div><Button kind="icon" ariaLabel="Close modal" onClick={close}><Icon name="close"/></Button></div><div className="modal-form"><label className="field">{isWorkspace ? "Workspace name" : isInvite ? "Email address" : isAccount ? "Account name" : "Name"}<input autoFocus placeholder={isWorkspace ? "e.g. Side Business" : isInvite ? "name@company.com" : isAccount ? "e.g. Salary account" : "Enter a name"}/></label><label className="field">{isWorkspace ? "Workspace type" : isInvite ? "Role" : isAccount ? "Account type" : "Type"}<span>{isWorkspace ? "Personal" : isInvite ? "Member" : isAccount ? "Savings account" : "Standard"} <Icon name="chevron"/></span></label>{isAccount && <label className="field">Opening balance<input placeholder="₹ 0.00"/></label>}</div><div className="drawer-foot"><Button onClick={close}>Cancel</Button><Button kind="primary" onClick={confirm}>{isInvite ? "Send invitation" : "Create"}</Button></div></div></div>;
}

function NotificationsPanel({ close }: { close: () => void }) {
  const [read, setRead] = useState(false);
  const notes = [["Recurring payment completed","Netflix · ₹649","2m"],["Investment sync completed","Zerodha portfolio is up to date","12m"],["Account balance changed","HDFC Savings increased by ₹85,000","1h"],["Payment failed","Adobe subscription needs attention","3h"]];
  return <div className="overlay panel-overlay" onMouseDown={close}><div className="notification-panel" onMouseDown={e=>e.stopPropagation()}><div className="drawer-head"><div><h2>Notifications</h2><p>Updates that need your attention</p></div><Button kind="ghost" onClick={() => setRead(true)}>Mark all read</Button></div><div className="notification-list">{notes.map((n,i)=><button key={n[0]} className={!read && i < 3 ? "unread" : ""} onClick={() => dispatchAction(n[0])}><i/><span><strong>{n[0]}</strong><small>{n[1]}</small></span><time>{n[2]}</time></button>)}</div><div className="panel-foot"><Button kind="ghost" onClick={() => { close(); dispatchAction("Notification settings"); }}>Notification settings <Icon name="arrow"/></Button></div></div></div>;
}

function Toast({ message, close }: { message: string; close: () => void }) {
  return <div className="toast" role="status"><span><Icon name="check"/></span><div><strong>{message}</strong><small>Your changes are reflected across Fintrace.</small></div><Button kind="icon" ariaLabel="Dismiss notification" onClick={close}><Icon name="close"/></Button></div>;
}

function LoginPage() {
  const { login, isLoading, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await login({ email, password });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  return <main className="auth-screen">
    <form className="auth-card card" onSubmit={submit}>
      <Logo/>
      <div>
        <p className="eyebrow">Secure access</p>
        <h1>Sign in to FinTrace</h1>
        <p>Use your FinTrace account to load your companies and financial dashboard.</p>
      </div>
      {(submitError || error) && <div className="auth-error">{submitError || error}</div>}
      <label className="field">Email or username<input value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required disabled={submitting || isLoading}/></label>
      <label className="field">Password<input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" required disabled={submitting || isLoading}/></label>
      <button className="btn btn-primary auth-submit" type="submit" disabled={submitting || isLoading}>{submitting ? "Signing in..." : "Sign in"}</button>
    </form>
  </main>;
}

export default function App() {
  const { user, platform, isAuthenticated, isLoading, logout } = useAuth();
  const [page, setPage] = useState("Dashboard");
  const [theme, setTheme] = useState("light");
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [tenantOpen, setTenantOpen] = useState(false);
  const [drawerType, setDrawerType] = useState("");
  const [modalAction, setModalAction] = useState("");
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [toast, setToast] = useState("");
  const userName = displayUserName(user);
  const userRole = platform?.is_superuser ? "Superadmin" : platform?.is_staff ? "Staff" : "Member";
  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  };
  const runAction = (action: string) => {
    const normalized = action.trim();
    if (["Add expense","Add income","Add transaction","Transfer money"].includes(normalized)) {
      setDrawerType(normalized === "Add transaction" ? "Add expense" : normalized);
      return;
    }
    if (normalized === "View report") { setPage("Reports"); return; }
    if (normalized === "View all" || normalized.includes("transactions")) { setPage("Transactions"); return; }
    if (normalized === "Manage" || normalized.includes("account details")) { setPage("Accounts"); return; }
    if (normalized === "Integrations") { setPage("Investment integrations"); return; }
    if (normalized === "Add account") { setPage("Accounts"); return; }
    if (["Create workspace","Invite member","Add investment","Add recurring","Add debt","Request integration"].includes(normalized)) {
      setModalAction(normalized);
      return;
    }
    if (normalized === "Search accounts" || normalized === "Search transactions") { setSearchOpen(true); return; }
    if (normalized === "User menu") { setPage("Settings"); return; }
    if (normalized.includes("Export")) { showToast("Export is being prepared"); return; }
    if (normalized.includes("sync started")) { showToast(normalized); return; }
    if (normalized === "Workspace changed") { showToast("Workspace changed successfully"); return; }
    showToast(normalized || "Action completed");
  };
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen(true); }
      if (e.key === "Escape") { setSearchOpen(false); setDrawerType(""); setModalAction(""); setNotificationsOpen(false); }
    };
    const actionHandler = (e: Event) => runAction((e as CustomEvent<string>).detail);
    window.addEventListener("keydown", handler);
    window.addEventListener("fintrace-action", actionHandler);
    return () => { window.removeEventListener("keydown", handler); window.removeEventListener("fintrace-action", actionHandler); };
  }, []);
  const content = useMemo(() => {
    if (page === "Dashboard") return <Dashboard setPage={setPage} openExpense={()=>setDrawerType("Add expense")}/>;
    if (page === "Accounts") return <AccountsPage setPage={setPage}/>;
    if (page === "Account details") return <AccountsPage setPage={setPage}/>;
    if (page === "Transactions") return <TransactionsPage openExpense={()=>setDrawerType("Add expense")}/>;
    if (page === "Investments") return <InvestmentsPage setPage={setPage}/>;
    if (page === "Investment integrations") return <InvestmentIntegrationsPage setPage={setPage}/>;
    if (["Recurring","Debts","Reports"].includes(page)) return <GenericPage page={page}/>;
    return <SettingsPage/>;
  }, [page]);

  if (isLoading) {
    return <main className="auth-screen"><div className="auth-card card"><Logo/><div className="app-state">Checking your session...</div></div></main>;
  }

  if (!isAuthenticated) {
    return <LoginPage/>;
  }

  return <div className={theme === "dark" ? "app dark" : "app"} onClick={()=>tenantOpen&&setTenantOpen(false)}>
    <Sidebar page={page} setPage={setPage} collapsed={collapsed} setCollapsed={setCollapsed} userName={userName} userRole={userRole}/>
    <div className="main-shell">
      <Topbar theme={theme} setTheme={setTheme} setSearchOpen={setSearchOpen} tenantOpen={tenantOpen} setTenantOpen={v=>{setTenantOpen(v)}} showNotifications={() => setNotificationsOpen(true)} onLogout={logout} userName={userName}/>
      <main className="content">{content}</main>
    </div>
    <nav className="mobile-nav">{nav.slice(0,3).concat([nav[5],["More","more"]]).map(([x,i])=><button key={x} className={page===x?"active":""} onClick={()=>x==="More"?setPage("Settings"):setPage(x)}><Icon name={i as IconName}/><span>{x}</span></button>)}</nav>
    {searchOpen && <SearchModal close={()=>setSearchOpen(false)} setPage={setPage} act={runAction}/>}
    {drawerType && <TransactionDrawer type={drawerType} close={()=>setDrawerType("")} saved={async () => { setDrawerType(""); showToast(`${drawerType.replace("Add ","")} saved successfully`); }}/>}
    {modalAction && <ActionModal action={modalAction} close={() => setModalAction("")} confirm={() => { showToast(`${modalAction} completed`); setModalAction(""); }}/>}
    {notificationsOpen && <NotificationsPanel close={() => setNotificationsOpen(false)}/>}
    {toast && <Toast message={toast} close={() => setToast("")}/>}
  </div>;
}
