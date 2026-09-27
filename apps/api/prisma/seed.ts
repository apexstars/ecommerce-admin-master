import { type FulfillmentStatus, type OrderStatus, type PermissionAction, type PermissionResource, PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/shared/crypto.js';
import { PERMISSION_CATALOG, SEED_ROLES } from '../src/modules/identity/permissions.js';
import { computeTotals } from '../src/modules/orders/pricing.js';

const prisma = new PrismaClient();
const DEV_PASSWORD = 'password1234';

// Deterministic PRNG so every seed produces the same data.
let state = 42;
const rand = () => ((state = (state * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

async function wipe() {
  // Dev-only reset, children first.
  await prisma.$transaction([
    prisma.outboxEvent.deleteMany(),
    prisma.auditLogEntry.deleteMany(),
    prisma.stockMovement.deleteMany(),
    prisma.inventoryReservation.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.orderItem.deleteMany(),
    prisma.order.deleteMany(),
    prisma.discount.deleteMany(),
    prisma.productImage.deleteMany(),
    prisma.productVariant.deleteMany(),
    prisma.product.deleteMany(),
    prisma.category.deleteMany(),
    prisma.address.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.user.deleteMany(),
    prisma.rolePermission.deleteMany(),
    prisma.role.deleteMany(),
    prisma.permission.deleteMany(),
  ]);
  await prisma.$executeRaw`ALTER SEQUENCE "Order_number_seq" RESTART WITH 1001`;
}

async function seedRbac() {
  await prisma.permission.createMany({
    data: PERMISSION_CATALOG.map((p) => ({ resource: p.resource as PermissionResource, action: p.action as PermissionAction })),
  });
  const permissions = await prisma.permission.findMany();
  const idOf = new Map(permissions.map((p) => [`${p.resource}:${p.action}`, p.id]));

  const roles = new Map<string, string>();
  for (const r of SEED_ROLES) {
    const role = await prisma.role.create({ data: { name: r.name, description: r.description, isSystem: r.isSystem } });
    await prisma.rolePermission.createMany({ data: r.permissions.map((k) => ({ roleId: role.id, permissionId: idOf.get(k)! })) });
    roles.set(r.name, role.id);
  }

  const passwordHash = await hashPassword(DEV_PASSWORD);
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  const staff = [
    { name: 'Avery Chen', email: 'admin@shop.test', role: 'Super Admin', lastActiveAt: hoursAgo(0.1) },
    { name: 'Marcus Reid', email: 'marcus@shop.test', role: 'Super Admin', lastActiveAt: hoursAgo(26) },
    { name: 'Priya Natarajan', email: 'catalog@shop.test', role: 'Catalog Manager', lastActiveAt: hoursAgo(2) },
    { name: 'Diego Alvarez', email: 'fulfillment@shop.test', role: 'Order Fulfillment', lastActiveAt: hoursAgo(0.5) },
    { name: 'Hana Suzuki', email: 'fulfillment2@shop.test', role: 'Order Fulfillment', lastActiveAt: hoursAgo(5) },
    { name: 'Sam Okafor', email: 'support@shop.test', role: 'Support', lastActiveAt: hoursAgo(1) },
    { name: 'Lena Fischer', email: 'finance@shop.test', role: 'Finance', lastActiveAt: hoursAgo(49) },
  ];
  for (const s of staff) {
    await prisma.user.create({
      data: { name: s.name, email: s.email, roleId: roles.get(s.role)!, status: 'active', passwordHash, lastActiveAt: s.lastActiveAt },
    });
  }
  // A pending invitation (no password, can't sign in until accepted).
  await prisma.user.create({
    data: { name: 'Jordan Blake', email: 'jordan@shop.test', roleId: roles.get('Support')!, status: 'invited', inviteExpiresAt: new Date(Date.now() + 7 * 86400_000) },
  });
}

const CATALOG: { category: string; products: { name: string; price: number; sizes?: string[]; colors?: string[]; status?: 'draft' }[] }[] = [
  {
    category: 'Apparel',
    products: [
      { name: 'Everyday Cotton Tee', price: 2800, sizes: ['S', 'M', 'L', 'XL'], colors: ['Black', 'White'] },
      { name: 'Merino Crew Sweater', price: 9800, sizes: ['S', 'M', 'L'], colors: ['Oat', 'Navy'] },
      { name: 'Relaxed Linen Shirt', price: 7400, sizes: ['M', 'L'], colors: ['Sand'] },
      { name: 'Heavyweight Hoodie', price: 8800, sizes: ['S', 'M', 'L', 'XL'], colors: ['Charcoal'] },
      { name: 'Quilted Field Jacket', price: 18900, sizes: ['M', 'L'], colors: ['Olive'], status: 'draft' },
    ],
  },
  {
    category: 'Footwear',
    products: [
      { name: 'Court Leather Sneaker', price: 12500, sizes: ['8', '9', '10', '11'], colors: ['White'] },
      { name: 'Trail Runner 2', price: 14000, sizes: ['9', '10', '11'], colors: ['Slate', 'Ember'] },
      { name: 'Suede Chelsea Boot', price: 21000, sizes: ['9', '10'], colors: ['Tobacco'] },
      { name: 'Recycled Slide', price: 4200, sizes: ['M', 'L'], colors: ['Black'] },
    ],
  },
  {
    category: 'Accessories',
    products: [
      { name: 'Canvas Weekender Bag', price: 13500, colors: ['Natural', 'Black'] },
      { name: 'Ribbed Beanie', price: 3200, colors: ['Rust', 'Grey', 'Black'] },
      { name: 'Leather Card Holder', price: 4500, colors: ['Tan'] },
      { name: 'Polarized Sunglasses', price: 11000, colors: ['Tortoise'] },
      { name: 'Wool Scarf', price: 6500, colors: ['Camel'], status: 'draft' },
    ],
  },
  {
    category: 'Home',
    products: [
      { name: 'Stoneware Mug Set', price: 3800 },
      { name: 'Waffle Bath Towel', price: 4600, colors: ['White', 'Sage'] },
      { name: 'Soy Candle — Cedar', price: 3400 },
      { name: 'Linen Throw Blanket', price: 12800, colors: ['Oatmeal'] },
    ],
  },
];

const skuPart = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 4);

async function seedCatalog() {
  const variants: { id: string; productId: string; name: string; label: string; sku: string; priceCents: number; active: boolean }[] = [];
  let n = 100;
  for (const group of CATALOG) {
    const category = await prisma.category.create({ data: { name: group.category } });
    for (const p of group.products) {
      const sku = `${skuPart(group.category)}-${n++}`;
      const combos = (p.colors ?? [undefined]).flatMap((color) => (p.sizes ?? [undefined]).map((size) => ({ color, size })));
      const product = await prisma.product.create({
        data: {
          name: p.name,
          sku,
          categoryId: category.id,
          priceCents: p.price,
          status: p.status ?? 'active',
          description: `${p.name} from our ${group.category.toLowerCase()} collection.`,
          variants: {
            create: combos.map((attrs) => {
              // Mostly healthy stock, with a sprinkling of low and sold-out variants.
              const roll = rand();
              const stockQty = roll < 0.08 ? 0 : roll < 0.2 ? int(1, 9) : int(12, 80);
              return {
                sku: [sku, attrs.color && skuPart(attrs.color), attrs.size].filter(Boolean).join('-'),
                attributes: Object.fromEntries(Object.entries(attrs).filter(([, v]) => v)),
                priceCents: p.price,
                stockQty,
              };
            }),
          },
        },
        include: { variants: true },
      });
      for (const v of product.variants) {
        const a = v.attributes as { color?: string; size?: string };
        variants.push({
          id: v.id,
          productId: product.id,
          name: product.name,
          label: [a.color, a.size].filter(Boolean).join(' / ') || 'Default',
          sku: v.sku,
          priceCents: v.priceCents,
          active: product.status === 'active',
        });
      }
    }
  }
  // Guarantee the dashboard's low-stock panel and the red/amber states have something to show.
  const [first, second, third] = variants.filter((v) => v.active);
  await prisma.productVariant.update({ where: { id: first!.id }, data: { stockQty: 0 } });
  await prisma.productVariant.update({ where: { id: second!.id }, data: { stockQty: 3 } });
  await prisma.productVariant.update({ where: { id: third!.id }, data: { stockQty: 7 } });
  return variants.filter((v) => v.active);
}

const FIRST = ['Olivia', 'Noah', 'Emma', 'Liam', 'Ava', 'Mateo', 'Sofia', 'Kenji', 'Amara', 'Lucas', 'Zara', 'Ethan', 'Maya', 'Omar', 'Chloe', 'Ines', 'Theo', 'Nia', 'Felix', 'Ruby'];
const LAST = ['Johnson', 'Kim', 'Garcia', 'Patel', 'Nguyen', 'Silva', 'Rossi', 'Tanaka', 'Mensah', 'Dubois', 'Khan', 'Walsh', 'Cohen', 'Haddad', 'Larsen'];
const CITIES = [
  { city: 'Portland', region: 'OR', postalCode: '97205' },
  { city: 'Austin', region: 'TX', postalCode: '78701' },
  { city: 'Brooklyn', region: 'NY', postalCode: '11201' },
  { city: 'Chicago', region: 'IL', postalCode: '60607' },
  { city: 'Denver', region: 'CO', postalCode: '80202' },
];

async function seedCustomers() {
  const customers = [];
  for (let i = 0; i < 24; i++) {
    const first = FIRST[i % FIRST.length]!;
    const last = pick(LAST);
    const place = pick(CITIES);
    const customer = await prisma.customer.create({
      data: {
        name: `${first} ${last}`,
        email: `${first}.${last}${i}@example.com`.toLowerCase(),
        passwordHash: i === 0 ? await hashPassword(DEV_PASSWORD) : null,
        createdAt: new Date(Date.now() - int(20, 200) * 86400_000),
        addresses: {
          create: { name: `${first} ${last}`, line1: `${int(10, 999)} ${pick(['Oak', 'Maple', 'Pine', 'Cedar', 'Elm'])} St`, ...place, country: 'US', isDefault: true },
        },
      },
      include: { addresses: true },
    });
    customers.push(customer);
  }
  return customers;
}

async function seedDiscounts() {
  const day = 86400_000;
  await prisma.discount.createMany({
    data: [
      { code: 'WELCOME10', type: 'percent', value: 10, startsAt: new Date(Date.now() - 90 * day) },
      { code: 'FALL25', type: 'percent', value: 25, startsAt: new Date(Date.now() - 5 * day), endsAt: new Date(Date.now() + 20 * day), usageLimit: 500 },
      { code: 'SHIPFREE', type: 'fixed', value: 800, startsAt: new Date(Date.now() - 30 * day), endsAt: new Date(Date.now() - day) },
      { code: 'VIP50', type: 'fixed', value: 5000, startsAt: new Date(Date.now() + 7 * day), usageLimit: 50 },
    ],
  });
}

async function seedOrders(customers: Awaited<ReturnType<typeof seedCustomers>>, variants: Awaited<ReturnType<typeof seedCatalog>>) {
  const now = Date.now();
  const hour = 3600_000;
  const rules = { taxRateBps: 800, flatShippingCents: 800, freeShippingOverCents: 10000 };
  const brands = [['visa', '4242'], ['mastercard', '4444'], ['amex', '0005'], ['visa', '1881']] as const;

  // [days ago, how many orders]. Today and yesterday are dense so day-over-day deltas are meaningful.
  const schedule: [number, number][] = [[0, 9], [1, 11], [2, 7], [3, 8], [4, 6], [5, 9], [6, 5], [7, 7], [8, 6], [9, 8], [10, 5], [11, 6], [12, 4], [13, 6]];

  // Oldest first, so order numbers increase with placedAt as they would in production.
  for (const [daysAgo, count] of [...schedule].reverse()) {
    const hoursAgo = Array.from({ length: count }, () =>
      Math.max(0.05, daysAgo === 0 ? rand() * Math.max(1, new Date().getHours()) : daysAgo * 24 + rand() * 24 - 12),
    ).sort((a, b) => b - a);
    for (const hoursIntoPast of hoursAgo) {
      const placedAt = new Date(now - hoursIntoPast * hour);
      const customer = pick(customers);
      const lines = Array.from({ length: int(1, 3) }, () => ({ v: pick(variants), qty: rand() < 0.8 ? 1 : 2 }));
      const subtotal = lines.reduce((s, l) => s + l.v.priceCents * l.qty, 0);
      const useCode = rand() < 0.15;
      const discount = useCode ? Math.round(subtotal * 0.1) : 0;
      const totals = computeTotals(subtotal, discount, rules);

      // Older orders have progressed further through fulfillment.
      const r = rand();
      let status: OrderStatus = 'paid';
      let fulfillment: FulfillmentStatus = 'unfulfilled';
      if (daysAgo >= 4) fulfillment = r < 0.85 ? 'delivered' : 'shipped';
      else if (daysAgo >= 2) fulfillment = pick(['shipped', 'shipped', 'preparing', 'delivered'] as const);
      else if (daysAgo === 1) fulfillment = pick(['preparing', 'unfulfilled', 'shipped'] as const);
      if (r > 0.93) status = 'cancelled';
      else if (r > 0.88 && daysAgo > 1) status = 'refunded';
      else if (daysAgo === 0 && r < 0.12) status = 'pending';
      if (status !== 'paid') fulfillment = status === 'refunded' ? fulfillment : 'unfulfilled';
      if (status === 'pending') fulfillment = 'unfulfilled';

      const step = (h: number) => new Date(placedAt.getTime() + h * hour);
      const reached = (f: FulfillmentStatus) => ['unfulfilled', 'preparing', 'shipped', 'delivered'].indexOf(fulfillment) >= ['unfulfilled', 'preparing', 'shipped', 'delivered'].indexOf(f);
      const paid = status === 'paid' || status === 'refunded';
      const [brand, last4] = pick(brands);
      const address = customer.addresses[0]!;

      const order = await prisma.order.create({
        data: {
          customerId: customer.id,
          status,
          fulfillmentStatus: fulfillment,
          ...totals,
          discountCode: useCode ? 'WELCOME10' : null,
          shippingAddress: { name: address.name, line1: address.line1, line2: null, city: address.city, region: address.region, postalCode: address.postalCode, country: address.country },
          placedAt,
          paidAt: paid ? step(0.01) : null,
          preparingAt: paid && reached('preparing') ? step(3) : null,
          shippedAt: paid && reached('shipped') ? step(20) : null,
          deliveredAt: paid && reached('delivered') ? step(70) : null,
          cancelledAt: status === 'cancelled' ? step(1) : null,
          cancelReason: status === 'cancelled' ? pick(['Customer request', 'Payment failed (card_declined)']) : null,
          refundedAt: status === 'refunded' ? step(90) : null,
          confirmationSentAt: paid ? step(0.02) : null,
          items: {
            create: lines.map((l) => ({ variantId: l.v.id, productName: l.v.name, variantLabel: l.v.label, sku: l.v.sku, qty: l.qty, unitPriceCents: l.v.priceCents })),
          },
        },
      });
      await prisma.payment.create({
        data: {
          orderId: order.id,
          provider: 'fake',
          paymentMethodToken: 'pm_card_visa',
          providerPaymentId: status === 'pending' ? null : `pi_seed_${order.number}`,
          amountCents: order.totalCents,
          refundedCents: status === 'refunded' ? order.totalCents : 0,
          status: status === 'pending' ? 'pending' : status === 'cancelled' ? 'failed' : status === 'refunded' ? 'refunded' : 'succeeded',
          failureReason: status === 'cancelled' ? 'order_cancelled' : null,
          cardBrand: brand,
          cardLast4: last4,
          createdAt: placedAt,
        },
      });
      if (status === 'paid') {
        const merged = new Map<string, number>();
        for (const l of lines) merged.set(l.v.id, (merged.get(l.v.id) ?? 0) + l.qty);
        await prisma.inventoryReservation.createMany({
          data: [...merged].map(([variantId, qty]) => ({ orderId: order.id, variantId, qty, status: 'committed' as const })),
        });
      }
    }
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  await wipe();
  await seedRbac();
  const variants = await seedCatalog();
  const customers = await seedCustomers();
  await seedDiscounts();
  await seedOrders(customers, variants);
  const [orders, products] = await Promise.all([prisma.order.count(), prisma.product.count()]);
  console.log(`Seeded ${SEED_ROLES.length} roles, ${products} products, ${customers.length} customers, ${orders} orders.`);
  console.log(`Sign in: admin@shop.test / ${DEV_PASSWORD}  (other staff: catalog@, fulfillment@, support@, finance@shop.test)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
