import { apiRequest } from './apiClient';
import type { Category, ListResponse } from '../../types';

export const categoriesApi = {
  list: (limit = 200, offset = 0) => apiRequest<ListResponse<Category>>('/categories/', { query: { limit, offset } }),
  create: (data: { name: string; type: string; parent_id?: string | null }) =>
    apiRequest<Category>('/categories/', { method: 'POST', body: data }),
  update: (id: string, data: Partial<Pick<Category, 'name' | 'parent_id' | 'is_active'>>) =>
    apiRequest<Category>(`/categories/${id}/`, { method: 'PATCH', body: data }),
  archive: (id: string) => apiRequest<{ status: string; id: string }>(`/categories/${id}/archive/`, { method: 'POST' }),
};
