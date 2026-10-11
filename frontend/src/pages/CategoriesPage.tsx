import { useMemo, useState, type FormEvent } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { Icon } from '../components/common/Icon';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { EmptyState } from '../components/common/EmptyState';
import { notifyDataChanged, useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { categoriesApi } from '../lib/api/categoriesApi';
import { errorMessage, fieldErrors } from '../lib/api/apiClient';
import type { Category } from '../types';

type Kind = 'EXPENSE' | 'INCOME';

const KIND_COPY: Record<Kind, { tab: string; singular: string; example: string }> = {
  EXPENSE: { tab: 'Expense categories', singular: 'expense category', example: 'e.g. Groceries' },
  INCOME: { tab: 'Income categories', singular: 'income category', example: 'e.g. Salary' },
};

export function CategoriesPage() {
  const { canCreateCategories, canUpdateCategories } = useFinancialPermissions();
  const [kind, setKind] = useState<Kind>('EXPENSE');
  const [form, setForm] = useState<{ category: Category | null } | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<Category | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, loading, error, forbidden, reload } = useTenantQuery(() => categoriesApi.list(), [], { topics: ['categories'] });
  const rows = useMemo(() => (data?.results ?? []).filter((c) => c.type === kind), [data, kind]);
  const active = rows.filter((c) => c.is_active);
  const archived = rows.filter((c) => !c.is_active);

  const open = (category: Category | null) => {
    setForm({ category });
    setName(category?.name ?? '');
    setFormError(null);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !form) return;
    if (!name.trim()) {
      setFormError('Enter a category name.');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (form.category) await categoriesApi.update(form.category.id, { name: name.trim() });
      else await categoriesApi.create({ name: name.trim(), type: kind });
      notifyDataChanged(['categories', 'transactions', 'reports']);
      setForm(null);
    } catch (err) {
      setFormError(fieldErrors(err).name ?? errorMessage(err, 'The category could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (category: Category, isActive: boolean) => {
    setBusyId(category.id);
    setActionError(null);
    try {
      if (isActive) await categoriesApi.update(category.id, { is_active: true });
      else await categoriesApi.archive(category.id);
      notifyDataChanged(['categories']);
      setArchiving(null);
    } catch (err) {
      setActionError(errorMessage(err, 'The category could not be changed.'));
    } finally {
      setBusyId(null);
    }
  };

  const renderRow = (category: Category) => (
    <li key={category.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
      <span style={{ fontSize: '13px', color: category.is_active ? undefined : 'var(--muted)' }}>{category.name}</span>
      {canUpdateCategories && (
        <span style={{ display: 'flex', gap: '6px' }}>
          {category.is_active ? (
            <>
              <Button kind="ghost" icon="edit" ariaLabel={`Rename ${category.name}`} onClick={() => open(category)}>Rename</Button>
              <Button kind="ghost" ariaLabel={`Archive ${category.name}`} onClick={() => setArchiving(category)}>Archive</Button>
            </>
          ) : (
            <Button kind="ghost" ariaLabel={`Restore ${category.name}`} disabled={busyId === category.id} onClick={() => void setActive(category, true)}>Restore</Button>
          )}
        </span>
      )}
    </li>
  );

  return (
    <>
      <PageHeader
        title="Categories"
        subtitle="Labels that describe what income was for and what you spent on. Reports group by these."
        action={canCreateCategories ? <Button kind="primary" icon="plus" onClick={() => open(null)}>Add {KIND_COPY[kind].singular}</Button> : undefined}
      />

      <div className="tabs" role="tablist" aria-label="Category type">
        {(Object.keys(KIND_COPY) as Kind[]).map((value) => (
          <button key={value} type="button" role="tab" aria-selected={kind === value} className={kind === value ? 'active' : ''} onClick={() => setKind(value)}>
            {KIND_COPY[value].tab}
          </button>
        ))}
      </div>

      {loading && !data && <LoadingSkeleton lines={4} message="Loading categories…" />}
      {forbidden && <div className="card app-state error-state" role="alert">You do not have permission to view categories in this workspace.</div>}
      {error && !forbidden && <ErrorState error={error} onRetry={reload} />}
      {actionError && <div className="auth-error" role="alert">{actionError}</div>}

      {data && !error && rows.length === 0 && (
        <EmptyState
          title={`No ${KIND_COPY[kind].singular} yet`}
          message={kind === 'EXPENSE' ? 'Add categories like Rent, Groceries or Transport so you can see where money goes.' : 'Add categories like Salary or Freelance so you can see where money comes from.'}
          actionText={canCreateCategories ? `Add ${KIND_COPY[kind].singular}` : undefined}
          actionIcon="plus"
          onAction={canCreateCategories ? () => open(null) : undefined}
        />
      )}

      {active.length > 0 && <ul className="card" aria-label={KIND_COPY[kind].tab} style={{ listStyle: 'none', margin: 0, padding: 0 }}>{active.map(renderRow)}</ul>}
      {archived.length > 0 && (
        <>
          <h3 style={{ fontSize: '12px', color: 'var(--muted)', margin: '18px 0 8px' }}>Archived — kept for past transactions, hidden from new ones</h3>
          <ul className="card" aria-label="Archived categories" style={{ listStyle: 'none', margin: 0, padding: 0 }}>{archived.map(renderRow)}</ul>
        </>
      )}

      {form && (
        <div className="overlay modal-overlay" onMouseDown={() => setForm(null)}>
          <form className="action-modal card" role="dialog" aria-modal="true" aria-label={form.category ? 'Rename category' : 'Add category'} onMouseDown={(e) => e.stopPropagation()} onSubmit={save} noValidate>
            <div className="drawer-head">
              <h2>{form.category ? 'Rename category' : `Add ${KIND_COPY[kind].singular}`}</h2>
              <Button kind="icon" ariaLabel="Close" onClick={() => setForm(null)}><Icon name="close" /></Button>
            </div>
            <div className="modal-form" style={{ padding: '20px 24px' }}>
              <label className="field">
                Name
                <input autoFocus aria-label="Category name" aria-invalid={Boolean(formError)} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder={KIND_COPY[kind].example} />
                {formError && <small className="field-error" role="alert">{formError}</small>}
              </label>
            </div>
            <div className="drawer-foot">
              <Button onClick={() => setForm(null)}>Cancel</Button>
              <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </div>
      )}

      {archiving && (
        <div className="overlay modal-overlay" onMouseDown={() => setArchiving(null)}>
          <div className="action-modal card" role="alertdialog" aria-modal="true" aria-label="Archive category" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-form" style={{ padding: '20px 24px' }}>
              <h2 style={{ marginTop: 0 }}>Archive “{archiving.name}”?</h2>
              <p style={{ fontSize: '12px' }}>Past transactions keep this category. It will no longer be offered when recording new ones, and you can restore it later.</p>
            </div>
            <div className="drawer-foot">
              <Button onClick={() => setArchiving(null)}>Cancel</Button>
              <Button kind="danger" disabled={busyId === archiving.id} onClick={() => void setActive(archiving, false)}>{busyId === archiving.id ? 'Archiving…' : 'Archive'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
