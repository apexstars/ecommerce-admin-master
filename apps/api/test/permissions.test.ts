import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, isPermissionKey, PERMISSION_CATALOG, SEED_ROLES } from '../src/modules/identity/permissions.js';

const role = (name: string) => new Set(SEED_ROLES.find((r) => r.name === name)!.permissions);

describe('permission catalog', () => {
  it('is resource × action, with refund only on orders', () => {
    expect(PERMISSION_CATALOG).toHaveLength(7 * 4 + 1);
    expect(isPermissionKey('orders:refund')).toBe(true);
    expect(isPermissionKey('products:refund')).toBe(false);
    expect(isPermissionKey('made:up')).toBe(false);
  });
});

describe('seeded roles', () => {
  it('has exactly one system role (Super Admin) with every permission', () => {
    const system = SEED_ROLES.filter((r) => r.isSystem);
    expect(system.map((r) => r.name)).toEqual(['Super Admin']);
    expect(new Set(system[0]!.permissions)).toEqual(new Set(ALL_PERMISSIONS));
  });

  it('only references real permissions', () => {
    for (const r of SEED_ROLES) for (const p of r.permissions) expect(isPermissionKey(p), `${r.name}: ${p}`).toBe(true);
  });

  it('Catalog Manager: full catalog/inventory/discounts, view-only orders/customers/reports', () => {
    const p = role('Catalog Manager');
    for (const res of ['products', 'inventory', 'discounts']) for (const a of ['view', 'create', 'edit', 'delete']) expect(p.has(`${res}:${a}` as never)).toBe(true);
    for (const res of ['orders', 'customers', 'reports']) {
      expect(p.has(`${res}:view` as never)).toBe(true);
      expect(p.has(`${res}:edit` as never)).toBe(false);
    }
    expect(p.has('orders:refund')).toBe(false);
    expect([...p].some((k) => k.startsWith('settings:'))).toBe(false);
  });

  it('Order Fulfillment: orders view+edit, no refunds', () => {
    expect(role('Order Fulfillment')).toEqual(new Set(['orders:view', 'orders:edit', 'products:view', 'inventory:view', 'customers:view']));
  });

  it('Support: orders view+edit+refund, customers view+edit, products view', () => {
    expect(role('Support')).toEqual(
      new Set(['orders:view', 'orders:edit', 'orders:refund', 'customers:view', 'customers:edit', 'products:view']),
    );
  });

  it('Finance: reports view+create, orders view+refund, view-only elsewhere', () => {
    const p = role('Finance');
    expect(p.has('reports:create')).toBe(true);
    expect(p.has('orders:refund')).toBe(true);
    expect(p.has('orders:edit')).toBe(false);
    expect(p.has('settings:view')).toBe(true);
    expect(p.has('settings:edit')).toBe(false);
  });
});
