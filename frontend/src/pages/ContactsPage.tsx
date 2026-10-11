import { useMemo, useState } from 'react';
import { PageHeader } from '../components/common/PageHeader';
import { Button } from '../components/common/Button';
import { Icon } from '../components/common/Icon';
import { LoadingSkeleton } from '../components/common/LoadingSkeleton';
import { ErrorState } from '../components/common/ErrorState';
import { EmptyState } from '../components/common/EmptyState';
import { ContactFormModal } from '../components/modals/ContactFormModal';
import { notifyDataChanged, useTenantQuery } from '../hooks/useTenantQuery';
import { useFinancialPermissions } from '../hooks/useFinancialPermissions';
import { contactsApi } from '../lib/api/contactsApi';
import { errorMessage } from '../lib/api/apiClient';
import type { Contact } from '../types';

export function ContactsPage() {
  const { canCreateContacts, canUpdateContacts } = useFinancialPermissions();
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<{ contact: Contact | null } | null>(null);
  const [archiving, setArchiving] = useState<Contact | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, loading, error, forbidden, reload } = useTenantQuery(() => contactsApi.list(), [], { topics: ['contacts'] });
  const contacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.results ?? []).filter(
      (c) => c.status === 'ACTIVE' && (!q || c.name.toLowerCase().includes(q) || (c.email ?? '').toLowerCase().includes(q))
    );
  }, [data, search]);
  const hasAny = (data?.results ?? []).some((c) => c.status === 'ACTIVE');

  const archive = async () => {
    if (!archiving) return;
    setBusy(true);
    setActionError(null);
    try {
      await contactsApi.archive(archiving.id);
      notifyDataChanged(['contacts']);
      setArchiving(null);
    } catch (err) {
      setActionError(errorMessage(err, 'The contact could not be archived.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle="People and businesses you pay, get paid by, borrow from or lend to."
        action={canCreateContacts ? <Button kind="primary" icon="plus" onClick={() => setForm({ contact: null })}>Add contact</Button> : undefined}
      />

      {hasAny && (
        <div className="toolbar">
          <label className="input-like" style={{ width: '280px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Icon name="search" />
            <input type="search" aria-label="Search contacts" style={{ border: 0, outline: 0, background: 'transparent', width: '100%', fontSize: '12px' }}
              placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>
      )}

      {loading && !data && <LoadingSkeleton lines={4} message="Loading contacts…" />}
      {forbidden && <div className="card app-state error-state" role="alert">You do not have permission to view contacts in this workspace.</div>}
      {error && !forbidden && <ErrorState error={error} onRetry={reload} />}
      {actionError && <div className="auth-error" role="alert">{actionError}</div>}

      {data && !error && !hasAny && (
        <EmptyState title="No contacts yet" message="Add the people and businesses you deal with to tag transactions and track loans."
          actionText={canCreateContacts ? 'Add contact' : undefined} actionIcon="plus" onAction={canCreateContacts ? () => setForm({ contact: null }) : undefined} />
      )}
      {data && hasAny && contacts.length === 0 && <EmptyState message="No contacts match this search." />}

      {contacts.length > 0 && (
        <ul className="card" aria-label="Contacts" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {contacts.map((contact) => (
            <li key={contact.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
              <span>
                <strong style={{ display: 'block', fontSize: '13px' }}>{contact.name}</strong>
                <small style={{ color: 'var(--muted)' }}>{[contact.email, contact.phone].filter(Boolean).join(' · ') || 'No contact details'}</small>
              </span>
              {canUpdateContacts && (
                <span style={{ display: 'flex', gap: '6px' }}>
                  <Button kind="ghost" icon="edit" ariaLabel={`Edit ${contact.name}`} onClick={() => setForm({ contact })}>Edit</Button>
                  <Button kind="ghost" ariaLabel={`Archive ${contact.name}`} onClick={() => setArchiving(contact)}>Archive</Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      {form && <ContactFormModal contact={form.contact} close={() => setForm(null)} saved={() => setForm(null)} />}

      {archiving && (
        <div className="overlay modal-overlay" onMouseDown={() => setArchiving(null)}>
          <div className="action-modal card" role="alertdialog" aria-modal="true" aria-label="Archive contact" onMouseDown={(e) => e.stopPropagation()}>
            <div className="modal-form" style={{ padding: '20px 24px' }}>
              <h2 style={{ marginTop: 0 }}>Archive {archiving.name}?</h2>
              <p style={{ fontSize: '12px' }}>Past transactions and loans keep this contact. It will no longer be offered for new ones.</p>
            </div>
            <div className="drawer-foot">
              <Button onClick={() => setArchiving(null)}>Cancel</Button>
              <Button kind="danger" disabled={busy} onClick={() => void archive()}>{busy ? 'Archiving…' : 'Archive'}</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
