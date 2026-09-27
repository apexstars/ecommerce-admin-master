export type Resource = 'products' | 'inventory' | 'orders' | 'discounts' | 'customers' | 'reports' | 'settings';
export type Action = 'view' | 'create' | 'edit' | 'delete' | 'refund';
export type PermissionKey = `${Resource}:${Action}`;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  role: { id: string; name: string; isSystem: boolean } | null;
  permissions: PermissionKey[];
}

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'cancelled';
export type FulfillmentStatus = 'unfulfilled' | 'preparing' | 'shipped' | 'delivered';
export type OrderFilter = 'all' | 'pending' | 'paid' | 'fulfilled' | 'refunded' | 'cancelled';

export interface CustomerSummary {
  id: string;
  name: string;
  email: string;
}

export interface OrderRow {
  id: string;
  number: number;
  customer: CustomerSummary | null;
  placedAt: string;
  itemCount: number;
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
  totalCents: number;
  currency: string;
}

export interface OrderList extends Page<OrderRow> {
  counts: Record<OrderFilter, number>;
}

export interface TimelineStep {
  key: string;
  label: string;
  at: string | null;
  state: 'done' | 'current' | 'upcoming' | 'skipped';
}

export interface OrderDetail {
  id: string;
  number: number;
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
  currency: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  discountCode: string | null;
  cancelReason: string | null;
  placedAt: string;
  cancelledAt: string | null;
  refundedAt: string | null;
  shippingAddress: { name: string; line1: string; line2: string | null; city: string; region: string; postalCode: string; country: string };
  items: { id: string; productName: string; variantLabel: string; sku: string; imageUrl: string | null; qty: number; unitPriceCents: number }[];
  customer: CustomerSummary | null;
  payment: {
    status: 'pending' | 'requires_action' | 'succeeded' | 'failed' | 'refunded';
    provider: string;
    providerPaymentId: string | null;
    amountCents: number;
    refundedCents: number;
    cardBrand: string | null;
    cardLast4: string | null;
    failureReason: string | null;
  } | null;
  timeline: TimelineStep[];
  actions: { nextFulfillment: FulfillmentStatus | null; canCancel: boolean; cancelRequiresRefund: boolean; canRefund: boolean };
}

export type StockLevel = 'ok' | 'low' | 'out';

export interface ProductRow {
  id: string;
  name: string;
  sku: string;
  status: 'active' | 'draft';
  priceCents: number;
  category: { id: string; name: string };
  image: { url: string; alt: string } | null;
  variantCount: number;
  totalStock: number;
  stockLevel: StockLevel;
  lowVariantCount: number;
}

export interface ProductList extends Page<ProductRow> {
  lowStockThreshold: number;
}

export interface Category {
  id: string;
  name: string;
  productCount: number;
}

export interface Stat {
  value: number;
  previous: number;
  change: number | null;
}

export interface Dashboard {
  timeZone: string;
  asOf: string;
  stats: { revenue: Stat; orders: Stat; aov: Stat };
  recentOrders: OrderRow[];
  lowStock: {
    threshold: number;
    items: { variantId: string; productId: string; productName: string; label: string; sku: string; stockQty: number; stockLevel: StockLevel }[];
  };
}

export interface RoleSummary {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  memberCount: number;
  permissionCount: number;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  status: 'active' | 'invited';
  lastActiveAt: string | null;
}

export interface RoleDetail {
  id: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: PermissionKey[];
  members: Member[];
  updatedAt: string;
}

export interface PermissionCatalog {
  resources: Resource[];
  actions: Action[];
  permissions: { resource: Resource; action: Action; key: PermissionKey }[];
}

export interface StaffRow extends Member {
  createdAt: string;
  role: { id: string; name: string; isSystem: boolean } | null;
}

export interface AuditEntry {
  id: string;
  action: string;
  resourceType: string;
  resourceId: string;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
  timestamp: string;
  actor: { id: string; name: string; email: string } | null;
}

export interface Location {
  city: string;
  region: string;
  country: string;
}

export interface CustomerRow {
  id: string;
  name: string;
  email: string;
  createdAt: string;
  updatedAt: string;
  erasedAt: string | null;
  /** Has a storefront login (vs. a guest/admin-created record). */
  hasAccount: boolean;
  location: Location | null;
}

export interface Address {
  id: string;
  name: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  isDefault: boolean;
}

export type AddressInput = Omit<Address, 'id' | 'isDefault'> & { isDefault?: boolean };

export interface CustomerDetail extends Omit<CustomerRow, 'location'> {
  addresses: Address[];
}

export interface CustomerOrderStats {
  orderCount: number;
  paidOrderCount: number;
  totalSpentCents: number;
  lastOrderAt: string | null;
}
