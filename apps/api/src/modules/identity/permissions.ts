/**
 * The permission model: resource × action. This file is the single source of
 * truth for which combinations exist, and for the starter roles.
 */

export const RESOURCES = ['products', 'inventory', 'orders', 'discounts', 'customers', 'reports', 'settings'] as const;
export const ACTIONS = ['view', 'create', 'edit', 'delete', 'refund'] as const;

export type Resource = (typeof RESOURCES)[number];
export type Action = (typeof ACTIONS)[number];
export type PermissionKey = `${Resource}:${Action}`;

/** `refund` is an order-only action; everything else applies to all resources. */
const ACTION_SCOPE: Record<Action, readonly Resource[]> = {
  view: RESOURCES,
  create: RESOURCES,
  edit: RESOURCES,
  delete: RESOURCES,
  refund: ['orders'],
};

export const PERMISSION_CATALOG: { resource: Resource; action: Action; key: PermissionKey }[] = RESOURCES.flatMap(
  (resource) =>
    ACTIONS.filter((action) => ACTION_SCOPE[action].includes(resource)).map((action) => ({
      resource,
      action,
      key: `${resource}:${action}` as PermissionKey,
    })),
);

const VALID_KEYS = new Set<string>(PERMISSION_CATALOG.map((p) => p.key));
export const ALL_PERMISSIONS: PermissionKey[] = PERMISSION_CATALOG.map((p) => p.key);

export const isPermissionKey = (key: string): key is PermissionKey => VALID_KEYS.has(key);

export const toKey = (resource: string, action: string) => `${resource}:${action}` as PermissionKey;

function grant(resources: Resource[], actions: Action[]): PermissionKey[] {
  return resources.flatMap((r) => actions.map((a) => toKey(r, a))).filter(isPermissionKey);
}

const CRUD: Action[] = ['view', 'create', 'edit', 'delete'];

export const SUPER_ADMIN_ROLE = 'Super Admin';

export const SEED_ROLES: { name: string; description: string; isSystem: boolean; permissions: PermissionKey[] }[] = [
  {
    name: SUPER_ADMIN_ROLE,
    description: 'Full access to every part of the store. Built in and cannot be edited or deleted.',
    isSystem: true,
    permissions: ALL_PERMISSIONS,
  },
  {
    name: 'Catalog Manager',
    description: 'Owns products, stock levels and promotions. Read-only on orders, customers and reports.',
    isSystem: false,
    permissions: [
      ...grant(['products', 'inventory', 'discounts'], CRUD),
      ...grant(['orders', 'customers', 'reports'], ['view']),
    ],
  },
  {
    name: 'Order Fulfillment',
    description: 'Picks, packs and ships orders. Read-only on products, inventory and customers.',
    isSystem: false,
    permissions: [...grant(['orders'], ['view', 'edit']), ...grant(['products', 'inventory', 'customers'], ['view'])],
  },
  {
    name: 'Support',
    description: 'Helps customers with their orders, including refunds.',
    isSystem: false,
    permissions: [
      ...grant(['orders'], ['view', 'edit', 'refund']),
      ...grant(['customers'], ['view', 'edit']),
      ...grant(['products'], ['view']),
    ],
  },
  {
    name: 'Finance',
    description: 'Reporting and refunds. View-only everywhere else.',
    isSystem: false,
    permissions: [
      ...grant(['reports'], ['view', 'create']),
      ...grant(['orders'], ['view', 'refund']),
      ...grant(['products', 'inventory', 'discounts', 'customers', 'settings'], ['view']),
    ],
  },
];
