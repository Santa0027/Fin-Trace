import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../lib/api/apiClient';
import { useAuth } from '../providers/AuthProvider';
import { useTenant } from '../providers/TenantProvider';

/** Areas of data a mutation can make stale. */
export type DataTopic =
  | 'accounts' | 'transactions' | 'income' | 'expenses' | 'categories' | 'contacts'
  | 'debts' | 'investments' | 'recurring' | 'reports' | 'members' | 'broker';

const DATA_CHANGED = 'financial-data:changed';

/**
 * Tell mounted queries their data is stale. Pass the topics a mutation touched;
 * queries subscribed to any of them refetch (queries with no topics always do).
 */
export function notifyDataChanged(topics: DataTopic[] = []): void {
  window.dispatchEvent(new CustomEvent<DataTopic[]>(DATA_CHANGED, { detail: topics }));
}

interface QueryState<T> {
  tenantId: string;
  data?: T;
  error: string | null;
  forbidden: boolean;
}

/**
 * Fetch data that belongs to the active workspace.
 *
 * Results are tagged with the workspace they were fetched for and are only
 * returned while that workspace is still active, so one workspace's figures can
 * never be shown under another, even for a moment. Responses that arrive after
 * a workspace switch, or out of order, are discarded.
 */
export function useTenantQuery<T>(queryFn: () => Promise<T>, deps: unknown[] = [], options: { topics?: DataTopic[]; enabled?: boolean } = {}) {
  const { currentCompany } = useTenant();
  const { isAuthenticated } = useAuth();
  const tenantId = currentCompany?.id ?? '';
  const enabled = (options.enabled ?? true) && isAuthenticated && Boolean(tenantId);

  const [state, setState] = useState<QueryState<T>>({ tenantId: '', error: null, forbidden: false });
  const [loading, setLoading] = useState(enabled);
  const requestSeq = useRef(0);
  const queryRef = useRef(queryFn);
  queryRef.current = queryFn;
  const topics = options.topics;
  const topicsKey = (topics ?? []).join(',');

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await queryRef.current();
      if (seq === requestSeq.current) setState({ tenantId, data, error: null, forbidden: false });
    } catch (err) {
      if (seq === requestSeq.current) {
        setState((previous) => ({
          tenantId,
          // Keep showing the last good data for this workspace if a refresh fails.
          data: previous.tenantId === tenantId ? previous.data : undefined,
          error: errorMessage(err, 'Could not load this data.'),
          forbidden: err instanceof ApiError && err.status === 403,
        }));
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, enabled, ...deps]);

  useEffect(() => {
    void load();
    const onChanged = (event: Event) => {
      const changed = (event as CustomEvent<DataTopic[]>).detail ?? [];
      const mine = topicsKey ? topicsKey.split(',') : [];
      if (!mine.length || !changed.length || changed.some((topic) => mine.includes(topic))) void load();
    };
    window.addEventListener(DATA_CHANGED, onChanged);
    return () => {
      // Invalidate any in-flight request so it cannot land after unmount or a switch.
      requestSeq.current += 1;
      window.removeEventListener(DATA_CHANGED, onChanged);
    };
  }, [load, topicsKey]);

  const current = state.tenantId === tenantId && enabled;
  return {
    data: current ? state.data : undefined,
    loading: loading || (enabled && state.tenantId !== tenantId),
    error: current ? state.error : null,
    forbidden: current ? state.forbidden : false,
    reload: load,
  };
}
