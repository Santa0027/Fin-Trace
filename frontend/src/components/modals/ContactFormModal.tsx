import { useState, type FormEvent } from 'react';
import { Icon } from '../common/Icon';
import { Button } from '../common/Button';
import { contactsApi } from '../../lib/api/contactsApi';
import { errorMessage, fieldErrors } from '../../lib/api/apiClient';
import { notifyDataChanged } from '../../hooks/useTenantQuery';
import type { Contact } from '../../types';

interface ContactFormModalProps {
  contact: Contact | null;
  close: () => void;
  saved: () => void;
}

export function ContactFormModal({ contact, close, saved }: ContactFormModalProps) {
  const [name, setName] = useState(contact?.name ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter a name.';
    if (email.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) next.email = 'Enter a valid email address.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setSaving(true);
    setError(null);
    try {
      const payload = { name: name.trim(), email: email.trim() || null, phone: phone.trim() || null, notes: notes.trim() };
      if (contact) await contactsApi.update(contact.id, payload);
      else await contactsApi.create(payload);
      notifyDataChanged(['contacts']);
      saved();
    } catch (err) {
      setErrors(fieldErrors(err));
      setError(errorMessage(err, 'The contact could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="overlay modal-overlay" onMouseDown={close}>
      <form className="action-modal card" role="dialog" aria-modal="true" aria-label={contact ? 'Edit contact' : 'Add contact'} onMouseDown={(e) => e.stopPropagation()} onSubmit={submit} noValidate>
        <div className="drawer-head">
          <div>
            <h2>{contact ? 'Edit contact' : 'Add contact'}</h2>
            <p>People and businesses you pay or get paid by.</p>
          </div>
          <Button kind="icon" ariaLabel="Close" onClick={close}><Icon name="close" /></Button>
        </div>
        <div className="modal-form" style={{ padding: '20px 24px' }}>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <label className="field">
            Name
            <input autoFocus aria-label="Name" aria-invalid={Boolean(errors.name)} value={name} maxLength={255} onChange={(e) => setName(e.target.value)} />
            {errors.name && <small className="field-error" role="alert">{errors.name}</small>}
          </label>
          <div className="field-row">
            <label className="field">
              Email <small>Optional</small>
              <input aria-label="Email" type="email" aria-invalid={Boolean(errors.email)} value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
              {errors.email && <small className="field-error" role="alert">{errors.email}</small>}
            </label>
            <label className="field">
              Phone <small>Optional</small>
              <input aria-label="Phone" type="tel" value={phone} maxLength={50} onChange={(e) => setPhone(e.target.value)} />
            </label>
          </div>
          <label className="field">
            Notes <small>Optional</small>
            <textarea aria-label="Notes" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
        <div className="drawer-foot">
          <Button onClick={close}>Cancel</Button>
          <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
}
