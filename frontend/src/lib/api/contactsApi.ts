import { apiRequest } from './apiClient';
import type { Contact, ListResponse } from '../../types';

export type ContactInput = { name: string; email?: string | null; phone?: string | null; notes?: string };

export const contactsApi = {
  list: (limit = 200, offset = 0) => apiRequest<ListResponse<Contact>>('/contacts/', { query: { limit, offset } }),
  create: (data: ContactInput) => apiRequest<Contact>('/contacts/', { method: 'POST', body: data }),
  update: (id: string, data: Partial<ContactInput>) => apiRequest<Contact>(`/contacts/${id}/`, { method: 'PATCH', body: data }),
  archive: (id: string) => apiRequest<{ status: string; id: string }>(`/contacts/${id}/archive/`, { method: 'POST' }),
};
