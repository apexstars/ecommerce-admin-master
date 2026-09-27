import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  AddressInput,
  AuditEntry,
  Category,
  CustomerDetail,
  CustomerOrderStats,
  CustomerRow,
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
  customerId?: string;
}

export const useOrders = (p: OrdersParams) =>
  useQuery({
    queryKey: ['orders', p],
    queryFn: () => api<OrderList>('/orders', { query: { ...p, pageSize: p.customerId ? 10 : 20 } }),
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

// ── Customers ──
export interface CustomersParams {
  search: string;
  sort: 'newest' | 'oldest' | 'name';
  page: number;
}

export const useCustomers = (p: CustomersParams) =>
  useQuery({
    queryKey: ['customers', p],
    queryFn: () => api<Page<CustomerRow>>('/customers', { query: { ...p, pageSize: 25 } }),
    placeholderData: keepPreviousData,
  });

export const useCustomer = (id: string) =>
  useQuery({ queryKey: ['customer', id], queryFn: () => api<CustomerDetail>(`/customers/${id}`) });

/** Purchase history lives in the orders module and needs orders:view — callers pass `enabled`. */
export const useCustomerStats = (ids: string[], enabled: boolean) =>
  useQuery({
    queryKey: ['customer-stats', ids],
    queryFn: () => api<Record<string, CustomerOrderStats>>('/orders/customer-stats', { query: { customerIds: ids.join(',') } }),
    enabled: enabled && ids.length > 0,
    placeholderData: keepPreviousData,
  });

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; email: string; address?: AddressInput }) => api<CustomerDetail>('/customers', { method: 'POST', body: v }),
    onSuccess: (c) => {
      qc.setQueryData(['customer', c.id], c);
      void qc.invalidateQueries({ queryKey: ['customers'] });
    },
  });
}

export function useCustomerMutations(id: string) {
  const qc = useQueryClient();
  const onSuccess = (c?: CustomerDetail) => {
    if (c) qc.setQueryData(['customer', id], c);
    else void qc.invalidateQueries({ queryKey: ['customer', id] });
    void qc.invalidateQueries({ queryKey: ['customers'] });
  };
  return {
    update: useMutation({
      mutationFn: (v: { name?: string; email?: string }) => api<CustomerDetail>(`/customers/${id}`, { method: 'PATCH', body: v }),
      onSuccess,
    }),
    erase: useMutation({ mutationFn: () => api<void>(`/customers/${id}`, { method: 'DELETE' }), onSuccess: () => onSuccess() }),
    addAddress: useMutation({
      mutationFn: (v: AddressInput) => api<CustomerDetail>(`/customers/${id}/addresses`, { method: 'POST', body: v }),
      onSuccess,
    }),
    updateAddress: useMutation({
      mutationFn: ({ addressId, ...v }: Partial<AddressInput> & { addressId: string }) =>
        api<CustomerDetail>(`/customers/${id}/addresses/${addressId}`, { method: 'PATCH', body: v }),
      onSuccess,
    }),
    removeAddress: useMutation({
      mutationFn: (addressId: string) => api<CustomerDetail>(`/customers/${id}/addresses/${addressId}`, { method: 'DELETE' }),
      onSuccess,
    }),
  };
}
