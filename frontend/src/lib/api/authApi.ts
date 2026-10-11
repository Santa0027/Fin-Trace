import { apiRequest } from './apiClient';
import type { Company, PermissionRow, Session } from '../../types';

export const authApi = {
  /** The current session, or a 401 ApiError when signed out. */
  session: () => apiRequest<Session>('/auth/me/', { quietUnauthorized: true }),
  login: (identifier: string, password: string) =>
    apiRequest<Session>('/auth/login/', {
      method: 'POST',
      body: { email: identifier, password },
      quietUnauthorized: true,
    }),
  logout: () => apiRequest<{ authenticated: false }>('/auth/logout/', { method: 'POST' }),
  companies: () => apiRequest<{ companies: Company[] }>('/auth/companies/'),
  switchCompany: (companyId: string) =>
    apiRequest<{ tenant: Company }>('/auth/switch-tenant/', { method: 'POST', body: { company_id: companyId } }),
  changePassword: (currentPassword: string, newPassword: string) =>
    apiRequest<{ status: string }>('/auth/change-password/', { method: 'POST', body: { current_password: currentPassword, new_password: newPassword } }),
  permissions: () => apiRequest<{ results: PermissionRow[] }>('/rbac/effective-permissions/'),
};
