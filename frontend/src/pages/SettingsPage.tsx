import { useMemo, useState, type FormEvent } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { useAuth } from '../providers/AuthProvider';
import { useTenant } from '../providers/TenantProvider';
import { notifyDataChanged, useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { authApi } from '../lib/api/authApi';
import { membersApi } from '../lib/api/membersApi';
import { errorMessage, fieldErrors } from '../lib/api/apiClient';
import { formatDate } from '../lib/dates';
import type { Member, MemberRole } from '../types';

type Section = 'Profile' | 'Workspace' | 'Members' | 'Activity';

const ROLE_LABEL: Record<MemberRole, string> = { ADMIN: 'Administrator', MEMBER: 'Member', VIEWER: 'Viewer' };
const ROLE_HINT: Record<MemberRole, string> = {
  ADMIN: 'Can do everything, including managing members.',
  MEMBER: 'Can record and correct transactions.',
  VIEWER: 'Can look, but not change anything.',
};
const ENTITY_LABEL: Record<string, string> = {
  accounts: 'an account', categories: 'a category', contacts: 'a contact', ledger_transactions: 'a transaction',
  income_records: 'an income record', expense_records: 'an expense record', debts: 'a loan', debt_repayments: 'a loan payment',
  investment_dividends: 'a dividend', investment_portfolios: 'a portfolio', investment_instruments: 'an investment',
  recurring_transactions: 'a recurring item', recurring_transaction_occurrences: 'a recurring occurrence',
  tenant_memberships: 'a member', rbac_membership_roles: "a member's role", tenants: 'the workspace settings', tags: 'a tag',
};
const ACTION_LABEL: Record<string, string> = { INSERT: 'added', UPDATE: 'changed', DELETE: 'removed' };

function timezones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return supported.includes('UTC') ? supported : ['UTC', ...supported];
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px', padding: '10px 0', borderTop: '1px solid var(--border)', fontSize: '13px' }}>
      <dt style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd style={{ margin: 0, textAlign: 'right' }}>{value}</dd>
    </div>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const problems: Record<string, string> = {};
    if (!current) problems.current_password = 'Enter your current password.';
    if (next.length < 10) problems.new_password = 'Use at least 10 characters.';
    setErrors(problems);
    setMessage(null);
    if (Object.keys(problems).length) return;
    setSaving(true);
    try {
      await authApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      setMessage({ tone: 'ok', text: 'Password changed. Other devices have been signed out.' });
    } catch (err) {
      setErrors(fieldErrors(err));
      setMessage({ tone: 'error', text: errorMessage(err, 'The password could not be changed.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-label="Change password" style={{ padding: '16px 20px', marginTop: '14px' }}>
      <h2 style={{ fontSize: '14px', margin: '0 0 8px' }}>Change password</h2>
      {message && <div className={message.tone === 'ok' ? 'callout' : 'auth-error'} role={message.tone === 'ok' ? 'status' : 'alert'} style={{ fontSize: '12px', padding: '8px 12px', marginBottom: '8px' }}>{message.text}</div>}
      <div className="field-row">
        <label className="field">
          Current password
          <input aria-label="Current password" type="password" autoComplete="current-password" aria-invalid={Boolean(errors.current_password)} value={current} onChange={(e) => setCurrent(e.target.value)} />
          {errors.current_password && <small className="field-error" role="alert">{errors.current_password}</small>}
        </label>
        <label className="field">
          New password
          <input aria-label="New password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.new_password)} value={next} onChange={(e) => setNext(e.target.value)} />
          {errors.new_password && <small className="field-error" role="alert">{errors.new_password}</small>}
        </label>
      </div>
      <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Change password'}</button>
    </form>
  );
}

function WorkspaceSettings() {
  const { currentCompany, availableCompanies, patchCurrentCompany } = useTenant();
  const { canUpdateWorkspace } = useFinancialPermissions();
  const [timezone, setTimezone] = useState(currentCompany?.timezone ?? 'UTC');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const zones = useMemo(timezones, []);

  if (!currentCompany) return <p className="card" style={{ padding: '20px', fontSize: '13px' }}>No workspace is selected.</p>;

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const updated = await membersApi.updateWorkspace(currentCompany.id, { timezone });
      patchCurrentCompany({ timezone: updated.timezone });
      notifyDataChanged(['reports', 'transactions']);
      setMessage({ tone: 'ok', text: `Reports now use ${updated.timezone} days.` });
    } catch (err) {
      setMessage({ tone: 'error', text: errorMessage(err, 'The timezone could not be saved.') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: '8px 20px 16px' }}>
      <dl style={{ margin: 0 }}>
        <Row label="Workspace" value={currentCompany.name} />
        <Row label="Base currency" value={`${currentCompany.currency.code} (${currentCompany.currency.symbol})`} />
        <Row label="Workspaces you belong to" value={String(availableCompanies.filter((c) => c.is_member).length)} />
      </dl>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
        {message && <div className={message.tone === 'ok' ? 'callout' : 'auth-error'} role={message.tone === 'ok' ? 'status' : 'alert'} style={{ fontSize: '12px', padding: '8px 12px', marginBottom: '8px' }}>{message.text}</div>}
        <label className="field">
          Timezone
          <select aria-label="Timezone" value={timezone} disabled={!canUpdateWorkspace || saving} onChange={(e) => setTimezone(e.target.value)}>
            {!zones.includes(timezone) && <option value={timezone}>{timezone}</option>}
            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
          <small>Decides which day and month a transaction belongs to in reports. Existing transactions keep the time they were recorded at.</small>
        </label>
        {canUpdateWorkspace && (
          <Button kind="primary" disabled={saving || timezone === currentCompany.timezone} onClick={() => void save()}>{saving ? 'Saving…' : 'Save timezone'}</Button>
        )}
      </div>
    </div>
  );
}

function Members() {
  const { user } = useAuth();
  const { canViewMembers, canManageMembers } = useFinancialPermissions();
  const members = useTenantQuery(() => membersApi.list(), [], { topics: ['members'], enabled: canViewMembers });
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<MemberRole>('MEMBER');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [suspending, setSuspending] = useState<Member | null>(null);

  if (!canViewMembers) return <div className="card app-state error-state" role="alert">You do not have permission to see who is in this workspace.</div>;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const problems: Record<string, string> = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) problems.email = 'Enter a valid email address.';
    if (needsPassword && password.length < 10) problems.password = 'Use at least 10 characters.';
    setErrors(problems);
    setError(null);
    if (Object.keys(problems).length) return;
    setSaving(true);
    try {
      const [first, ...rest] = name.trim().split(/\s+/);
      const result = await membersApi.add({ email: email.trim(), role, first_name: first || undefined, last_name: rest.join(' ') || undefined, password: needsPassword ? password : undefined });
      setNotice(result.created_user
        ? `${result.email} was added with a new account. Share the temporary password with them privately and ask them to change it under Settings.`
        : `${result.email} now has access as ${ROLE_LABEL[result.role]}.`);
      setAdding(false);
      setEmail(''); setName(''); setPassword(''); setNeedsPassword(false);
      notifyDataChanged(['members']);
    } catch (err) {
      const fields = fieldErrors(err);
      setErrors(fields);
      // Nobody has an account with this email: ask for a temporary password and try again.
      if (fields.password && !needsPassword) setNeedsPassword(true);
      else setError(errorMessage(err, 'This person could not be added.'));
    } finally {
      setSaving(false);
    }
  };

  const change = async (member: Member, changes: { role?: MemberRole; status?: 'ACTIVE' | 'SUSPENDED' }) => {
    setBusyId(member.id);
    setError(null);
    setNotice(null);
    try {
      await membersApi.update(member.id, changes);
      notifyDataChanged(['members']);
      setSuspending(null);
    } catch (err) {
      setError(errorMessage(err, 'The change could not be saved.'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      {error && <div className="auth-error" role="alert">{error}</div>}
      {notice && <p className="callout" role="status" style={{ fontSize: '12px', padding: '10px 14px' }}>{notice}</p>}
      {canManageMembers && !adding && <div style={{ marginBottom: '10px' }}><Button kind="primary" icon="plus" onClick={() => { setAdding(true); setNotice(null); }}>Add member</Button></div>}

      {adding && (
        <form className="card" onSubmit={add} noValidate aria-label="Add member" style={{ padding: '16px 20px', marginBottom: '12px' }}>
          <h2 style={{ fontSize: '14px', margin: '0 0 8px' }}>Add a member</h2>
          <div className="field-row">
            <label className="field">
              Email
              <input autoFocus aria-label="Member email" type="email" aria-invalid={Boolean(errors.email)} value={email} onChange={(e) => { setEmail(e.target.value); setNeedsPassword(false); }} />
              {errors.email && <small className="field-error" role="alert">{errors.email}</small>}
            </label>
            <label className="field">
              Access
              <select aria-label="Access level" value={role} onChange={(e) => setRole(e.target.value as MemberRole)}>
                {(Object.keys(ROLE_LABEL) as MemberRole[]).map((value) => <option key={value} value={value}>{ROLE_LABEL[value]}</option>)}
              </select>
              <small>{ROLE_HINT[role]}</small>
            </label>
          </div>
          {needsPassword && (
            <div className="field-row">
              <label className="field">
                Their name <small>Optional</small>
                <input aria-label="Member name" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="field">
                Temporary password
                <input aria-label="Temporary password" type="password" autoComplete="new-password" aria-invalid={Boolean(errors.password)} value={password} onChange={(e) => setPassword(e.target.value)} />
                <small>Nobody has a FinTrace account with this email yet, so one will be created.</small>
                {errors.password && password !== '' && <small className="field-error" role="alert">{errors.password}</small>}
              </label>
            </div>
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Adding…' : needsPassword ? 'Create account and add' : 'Add member'}</button>
            <Button onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {members.loading && !members.data && <LoadingSkeleton lines={3} message="Loading members…" />}
      {members.error && <ErrorState error={members.error} onRetry={members.reload} />}
      {members.data && (
        <ul className="card member-list" aria-label="Workspace members" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {members.data.results.map((member) => {
            const displayName = [member.first_name, member.last_name].filter(Boolean).join(' ') || member.username;
            const isSelf = member.user_id === user?.id;
            const editable = canManageMembers && !isSelf && !member.is_owner;
            const currentRole = (member.role_codes.find((code) => code in ROLE_LABEL) ?? 'MEMBER') as MemberRole;
            return (
              <li key={member.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap', padding: '12px 16px', borderTop: '1px solid var(--border)', opacity: member.status === 'ACTIVE' ? 1 : 0.6 }}>
                <span>
                  <strong style={{ display: 'block', fontSize: '13px' }}>{displayName}{isSelf ? ' (you)' : ''}</strong>
                  <small style={{ color: 'var(--muted)' }}>
                    {member.email} · {member.status === 'ACTIVE' ? `joined ${formatDate(member.joined_at)}` : 'access suspended'}
                  </small>
                </span>
                {editable ? (
                  <span style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <select aria-label={`Access level for ${displayName}`} value={currentRole} disabled={busyId === member.id || member.status !== 'ACTIVE'}
                      onChange={(e) => void change(member, { role: e.target.value as MemberRole })}>
                      {(Object.keys(ROLE_LABEL) as MemberRole[]).map((value) => <option key={value} value={value}>{ROLE_LABEL[value]}</option>)}
                    </select>
                    {member.status === 'ACTIVE'
                      ? <Button kind="ghost" disabled={busyId === member.id} ariaLabel={`Suspend ${displayName}`} onClick={() => setSuspending(member)}>Suspend</Button>
                      : <Button kind="ghost" disabled={busyId === member.id} ariaLabel={`Restore access for ${displayName}`} onClick={() => void change(member, { status: 'ACTIVE' })}>Restore access</Button>}
                  </span>
                ) : (
                  <span style={{ fontSize: '12px' }}>{member.is_owner ? 'Owner' : member.roles.join(', ') || 'No role'}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {suspending && (
        <div className="overlay modal-overlay" onMouseDown={() => setSuspending(null)}>
          <div className="action-modal card" role="alertdialog" aria-modal="true" aria-label="Suspend member" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-form" style={{ padding: '20px 24px' }}>
              <h2 style={{ marginTop: 0 }}>Suspend {suspending.email}?</h2>
              <p style={{ fontSize: '12px' }}>They will lose access to this workspace immediately. Everything they recorded stays, and you can restore their access later.</p>
            </div>
            <div className="drawer-foot">
              <Button onClick={() => setSuspending(null)}>Cancel</Button>
              <Button kind="danger" disabled={busyId === suspending.id} onClick={() => void change(suspending, { status: 'SUSPENDED' })}>{busyId === suspending.id ? 'Suspending…' : 'Suspend access'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Activity() {
  const { canViewActivity } = useFinancialPermissions();
  const [offset, setOffset] = useState(0);
  const PAGE = 50;
  const feed = useTenantQuery(() => membersApi.activity(PAGE, offset), [offset], { enabled: canViewActivity });
  if (!canViewActivity) return <div className="card app-state error-state" role="alert">You do not have permission to see this workspace's activity.</div>;
  const rows = feed.data?.results ?? [];
  return (
    <>
      {feed.loading && !feed.data && <LoadingSkeleton lines={4} message="Loading activity…" />}
      {feed.error && <ErrorState error={feed.error} onRetry={feed.reload} />}
      {feed.data && rows.length === 0 && <p className="card" style={{ padding: '20px', fontSize: '13px' }}>{offset ? 'No earlier activity.' : 'Nothing has happened in this workspace yet.'}</p>}
      {rows.length > 0 && (
        <ul className="card" aria-label="Workspace activity" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((event) => (
            <li key={event.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: '12px' }}>
              <span><strong>{event.actor_name || event.actor_username || 'Someone'}</strong> {ACTION_LABEL[event.action.toUpperCase()] ?? event.action.toLowerCase()} {ENTITY_LABEL[event.entity_type] ?? event.entity_type.replace(/_/g, ' ')}</span>
              <time dateTime={event.occurred_at} style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{new Date(event.occurred_at).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      )}
      {feed.data && (offset > 0 || rows.length === PAGE) && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '10px' }}>
          <Button kind="ghost" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</Button>
          <Button kind="ghost" disabled={rows.length < PAGE} onClick={() => setOffset(offset + PAGE)}>Older</Button>
        </div>
      )}
    </>
  );
}

export function SettingsPage({ setPage }: { setPage?: (page: string) => void }) {
  const { user } = useAuth();
  const [section, setSection] = useState<Section>('Profile');

  return (
    <>
      <PageHeader title="Settings" subtitle="Your profile, this workspace and who has access to it." eyebrow="Account" />

      <div className="tabs" role="tablist" aria-label="Settings section">
        {(['Profile', 'Workspace', 'Members', 'Activity'] as Section[]).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={section === value} className={section === value ? 'active' : ''} onClick={() => setSection(value)}>{value}</button>
        ))}
        {setPage && (
          <>
            <button type="button" onClick={() => setPage('Categories')}>Categories</button>
            <button type="button" onClick={() => setPage('Contacts')}>Contacts</button>
          </>
        )}
      </div>

      {section === 'Profile' && (
        <>
          <dl className="card" style={{ padding: '8px 20px', margin: 0 }}>
            <Row label="Name" value={[user?.first_name, user?.last_name].filter(Boolean).join(' ') || '—'} />
            <Row label="Username" value={user?.username ?? '—'} />
            <Row label="Email" value={user?.email ?? '—'} />
          </dl>
          <ChangePassword />
        </>
      )}
      {section === 'Workspace' && <WorkspaceSettings />}
      {section === 'Members' && <Members />}
      {section === 'Activity' && <Activity />}
    </>
  );
}
