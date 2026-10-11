import { apiRequest } from './apiClient';
import type { ActivityEvent, ListResponse, Member, MemberRole } from '../../types';

export interface AddMemberInput {
  email: string;
  role: MemberRole;
  first_name?: string;
  last_name?: string;
  /** Only needed when nobody has a FinTrace account with this email yet. */
  password?: string;
}

export const membersApi = {
  list: (limit = 100) => apiRequest<ListResponse<Member>>('/memberships/', { query: { limit } }),
  add: (data: AddMemberInput) =>
    apiRequest<{ id: string; email: string; role: MemberRole; created_user: boolean }>('/memberships/', { method: 'POST', body: data }),
  update: (id: string, data: { role?: MemberRole; status?: 'ACTIVE' | 'SUSPENDED' }) =>
    apiRequest<{ id: string }>(`/memberships/${id}/`, { method: 'PATCH', body: data }),
  activity: (limit = 50, offset = 0) => apiRequest<ListResponse<ActivityEvent>>('/activity/', { query: { limit, offset } }),
  updateWorkspace: (id: string, data: { name?: string; timezone?: string }) =>
    apiRequest<{ id: string; name: string; timezone: string }>(`/tenants/${id}/`, { method: 'PATCH', body: data }),
};
