import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  AuditEntry,
  Category,
  Dashboard,
  FulfillmentStatus,
  OrderDetail,
  OrderFilter,
  OrderList,
  Page,
  PermissionCatalog,
  PermissionKey,
  ProductList,
  RoleDetail,
  RoleSummary,
  StaffRow,
} from './types';

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ── Dashboard ──
export const useDashboard = (enabled = true) =>
  useQuery({
    queryKey: ['dashboard', timeZone],
    queryFn: () => api<Dashboard>('/reports/dashboard', { query: { tz: timeZone } }),
    refetchInterval: 60_000,
    enabled,
  });

// ── Orders ──
export interface OrdersParams {
  filter: OrderFilter;
  search: string;
  page: number;
}

export const useOrders = (p: OrdersParams) =>
  useQuery({
    queryKey: ['orders', p],
    queryFn: () => api<OrderList>('/orders', { query: { ...p, pageSize: 20 } }),
    placeholderData: keepPreviousData,
  });

export const useOrder = (id: string) =>
  useQuery({ queryKey: ['order', id], queryFn: () => api<OrderDetail>(`/orders/${id}`) });

function useOrderMutation<V>(id: string, fn: (v: V) => Promise<OrderDetail>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (order) => {
      qc.setQueryData(['order', id], order);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export const useAdvanceFulfillment = (id: string) =>
  useOrderMutation(id, (status: FulfillmentStatus) => api<OrderDetail>(`/orders/${id}/fulfillment`, { method: 'POST', body: { status } }));
export const useRefundOrder = (id: string) =>
  useOrderMutation(id, (reason: string) => api<OrderDetail>(`/orders/${id}/refund`, { method: 'POST', body: { reason } }));
export const useCancelOrder = (id: string) =>
  useOrderMutation(id, (reason: string) => api<OrderDetail>(`/orders/${id}/cancel`, { method: 'POST', body: { reason } }));

// ── Products ──
export interface ProductsParams {
  categoryId?: string;
  search: string;
  stock?: 'low' | 'out';
  page: number;
}

export const useProducts = (p: ProductsParams) =>
  useQuery({
    queryKey: ['products', p],
    queryFn: () => api<ProductList>('/products', { query: { ...p, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });

export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => api<Category[]>('/categories') });

export function useBulkProducts() {
  const qc = useQueryClient();
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['products'] });
    void qc.invalidateQueries({ queryKey: ['categories'] });
  };
  return {
    setStatus: useMutation({
      mutationFn: (v: { ids: string[]; status: 'active' | 'draft' }) => api<{ updated: number }>('/products/bulk/status', { method: 'POST', body: v }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (ids: string[]) => api<{ deleted: number }>('/products/bulk/delete', { method: 'POST', body: { ids } }),
      onSuccess: done,
    }),
  };
}

// ── Roles, permissions, staff ──
export const useRoles = () => useQuery({ queryKey: ['roles'], queryFn: () => api<RoleSummary[]>('/roles') });
export const useRole = (id: string | undefined) =>
  useQuery({ queryKey: ['role', id], queryFn: () => api<RoleDetail>(`/roles/${id}`), enabled: Boolean(id) });
export const usePermissionCatalog = () =>
  useQuery({ queryKey: ['permission-catalog'], queryFn: () => api<PermissionCatalog>('/permissions'), staleTime: Infinity });
export const useStaff = () =>
  useQuery({ queryKey: ['staff'], queryFn: () => api<Page<StaffRow>>('/staff', { query: { pageSize: 100 } }) });
export const useAudit = (resourceType: string, resourceId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: ['audit', resourceType, resourceId],
    queryFn: () => api<Page<AuditEntry>>('/audit', { query: { resourceType, resourceId, pageSize: 8 } }),
    enabled: enabled && Boolean(resourceId),
  });

function useRoleInvalidation() {
  const qc = useQueryClient();
  return (role?: RoleDetail) => {
    if (role) qc.setQueryData(['role', role.id], role);
    void qc.invalidateQueries({ queryKey: ['roles'] });
    void qc.invalidateQueries({ queryKey: ['staff'] });
    void qc.invalidateQueries({ queryKey: ['audit'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
}

export interface RoleInput {
  name: string;
  description: string;
  permissions: PermissionKey[];
}

export function useRoleMutations(id: string | undefined) {
  const invalidate = useRoleInvalidation();
  return {
    create: useMutation({ mutationFn: (v: RoleInput) => api<RoleDetail>('/roles', { method: 'POST', body: v }), onSuccess: invalidate }),
    update: useMutation({ mutationFn: (v: Partial<RoleInput>) => api<RoleDetail>(`/roles/${id}`, { method: 'PATCH', body: v }), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: () => api<void>(`/roles/${id}`, { method: 'DELETE' }), onSuccess: () => invalidate() }),
    addMember: useMutation({
      mutationFn: (userId: string) => api<RoleDetail>(`/roles/${id}/members`, { method: 'POST', body: { userId } }),
      onSuccess: invalidate,
    }),
    removeMember: useMutation({
      mutationFn: (userId: string) => api<RoleDetail>(`/roles/${id}/members/${userId}`, { method: 'DELETE' }),
      onSuccess: invalidate,
    }),
  };
}

export function useInviteStaff() {
  const invalidate = useRoleInvalidation();
  return useMutation({
    mutationFn: (v: { name: string; email: string; roleId: string }) =>
      api<{ user: { id: string }; inviteUrl?: string }>('/staff/invite', { method: 'POST', body: v }),
    onSuccess: () => invalidate(),
  });
}
