import { randomUUID } from 'node:crypto';
import type { Prisma, ProductStatus } from '@prisma/client';
import { config } from '../../config.js';
import { prisma } from '../../shared/db.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { presignUpload, publicUrl } from '../../shared/storage.js';

export type VariantAttributes = { size?: string; color?: string };

export const variantLabel = (attrs: unknown) => {
  const a = (attrs ?? {}) as VariantAttributes;
  return [a.color, a.size].filter(Boolean).join(' / ') || 'Default';
};

export type StockLevel = 'ok' | 'low' | 'out';
export const stockLevel = (qty: number, threshold = config.LOW_STOCK_THRESHOLD): StockLevel =>
  qty <= 0 ? 'out' : qty < threshold ? 'low' : 'ok';

// ── Products ─────────────────────────────────────────────────────────────────

export interface ListProductsQuery {
  categoryId?: string;
  status?: ProductStatus;
  search?: string;
  stock?: StockLevel;
  page: number;
  pageSize: number;
}

export async function listProducts(q: ListProductsQuery) {
  const where: Prisma.ProductWhereInput = {
    categoryId: q.categoryId,
    status: q.status,
    ...(q.search && {
      OR: [
        { name: { contains: q.search, mode: 'insensitive' } },
        { sku: { contains: q.search, mode: 'insensitive' } },
        { variants: { some: { sku: { contains: q.search, mode: 'insensitive' } } } },
      ],
    }),
  };

  // Stock filtering is on the aggregate across variants, so resolve matching ids first.
  if (q.stock) {
    const rows = await prisma.$queryRaw<{ productId: string }[]>`
      SELECT "productId" FROM "ProductVariant" GROUP BY "productId"
      HAVING CASE
        WHEN SUM("stockQty") <= 0 THEN 'out'
        WHEN SUM("stockQty") < ${config.LOW_STOCK_THRESHOLD} THEN 'low'
        ELSE 'ok' END = ${q.stock}`;
    where.id = { in: rows.map((r) => r.productId) };
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        category: { select: { id: true, name: true } },
        images: { orderBy: { position: 'asc' }, take: 1, select: { url: true, alt: true } },
        variants: { select: { stockQty: true, priceCents: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);

  const items = products.map((p) => {
    const totalStock = p.variants.reduce((n, v) => n + v.stockQty, 0);
    return {
      id: p.id,
      name: p.name,
      sku: p.sku,
      status: p.status,
      priceCents: p.priceCents,
      category: p.category,
      image: p.images[0] ?? null,
      variantCount: p.variants.length,
      totalStock,
      stockLevel: stockLevel(totalStock),
      // A healthy total can hide one sold-out size/color; surface that separately.
      lowVariantCount: p.variants.filter((v) => stockLevel(v.stockQty) !== 'ok').length,
      updatedAt: p.updatedAt,
    };
  });
  return { items, total, page: q.page, pageSize: q.pageSize, lowStockThreshold: config.LOW_STOCK_THRESHOLD };
}

export async function getProduct(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true } },
      images: { orderBy: { position: 'asc' } },
      variants: { orderBy: { sku: 'asc' } },
    },
  });
  if (!product) throw notFound('Product');
  return {
    ...product,
    variants: product.variants.map((v) => ({ ...v, label: variantLabel(v.attributes), stockLevel: stockLevel(v.stockQty) })),
  };
}

export interface VariantInput {
  sku: string;
  attributes: VariantAttributes;
  priceCents: number;
}

export async function createProduct(input: {
  name: string;
  sku: string;
  description: string;
  categoryId: string;
  priceCents: number;
  status: ProductStatus;
  variants: VariantInput[];
}) {
  // Stock is owned by the inventory module: new variants start at 0 and are
  // stocked through inventory adjustments.
  const variants = input.variants.length
    ? input.variants
    : [{ sku: input.sku, attributes: {}, priceCents: input.priceCents }];
  const product = await prisma.product.create({
    data: {
      name: input.name,
      sku: input.sku,
      description: input.description,
      categoryId: input.categoryId,
      priceCents: input.priceCents,
      status: input.status,
      variants: { create: variants.map((v) => ({ sku: v.sku, attributes: v.attributes, priceCents: v.priceCents })) },
    },
  });
  return getProduct(product.id);
}

export async function updateProduct(
  id: string,
  patch: Partial<{ name: string; sku: string; description: string; categoryId: string; priceCents: number; status: ProductStatus }>,
) {
  await prisma.product.update({ where: { id }, data: patch });
  return getProduct(id);
}

export async function deleteProducts(ids: string[]) {
  // Order items keep name/sku/price snapshots, so historical orders are unaffected.
  const { count } = await prisma.product.deleteMany({ where: { id: { in: ids } } });
  return count;
}

export async function setProductStatus(ids: string[], status: ProductStatus) {
  const { count } = await prisma.product.updateMany({ where: { id: { in: ids } }, data: { status } });
  return count;
}

// ── Variants ─────────────────────────────────────────────────────────────────

export async function addVariant(productId: string, input: VariantInput) {
  await prisma.productVariant.create({
    data: { productId, sku: input.sku, attributes: input.attributes, priceCents: input.priceCents },
  });
  return getProduct(productId);
}

export async function updateVariant(productId: string, variantId: string, patch: Partial<VariantInput>) {
  const { count } = await prisma.productVariant.updateMany({
    where: { id: variantId, productId },
    data: { sku: patch.sku, priceCents: patch.priceCents, attributes: patch.attributes },
  });
  if (!count) throw notFound('Variant');
  return getProduct(productId);
}

export async function deleteVariant(productId: string, variantId: string) {
  const remaining = await prisma.productVariant.count({ where: { productId } });
  if (remaining <= 1) throw conflict('A product needs at least one variant');
  const { count } = await prisma.productVariant.deleteMany({ where: { id: variantId, productId } });
  if (!count) throw notFound('Variant');
  return getProduct(productId);
}

// ── Categories ───────────────────────────────────────────────────────────────

export async function listCategories() {
  const rows = await prisma.category.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  });
  return rows.map((c) => ({ id: c.id, name: c.name, productCount: c._count.products }));
}

export const createCategory = (name: string) => prisma.category.create({ data: { name } });
export const renameCategory = (id: string, name: string) => prisma.category.update({ where: { id }, data: { name } });

export async function deleteCategory(id: string) {
  const inUse = await prisma.product.count({ where: { categoryId: id } });
  if (inUse) throw conflict(`Move this category's ${inUse} product(s) before deleting it`);
  await prisma.category.delete({ where: { id } });
}

// ── Images (browser → S3 direct upload) ──────────────────────────────────────

const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function createImageUpload(productId: string, contentType: string) {
  const ext = IMAGE_TYPES[contentType];
  if (!ext) throw badRequest('Images must be JPEG, PNG or WebP');
  if (!(await prisma.product.count({ where: { id: productId } }))) throw notFound('Product');
  const key = `products/${productId}/${randomUUID()}.${ext}`;
  return { key, uploadUrl: await presignUpload(key, contentType), publicUrl: publicUrl(key) };
}

export async function attachImage(productId: string, key: string, alt: string) {
  if (!key.startsWith(`products/${productId}/`)) throw badRequest('Image key does not belong to this product');
  const position = await prisma.productImage.count({ where: { productId } });
  await prisma.productImage.create({ data: { productId, storageKey: key, url: publicUrl(key), alt, position } });
  return getProduct(productId);
}

export async function removeImage(productId: string, imageId: string) {
  await prisma.productImage.deleteMany({ where: { id: imageId, productId } });
  return getProduct(productId);
}

// ── Public API for other modules ─────────────────────────────────────────────

export interface SellableVariant {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  label: string;
  priceCents: number;
  stockQty: number;
  imageUrl: string | null;
  isActive: boolean;
}

export async function getVariants(ids: string[]): Promise<Map<string, SellableVariant>> {
  const rows = await prisma.productVariant.findMany({
    where: { id: { in: [...new Set(ids)] } },
    include: {
      product: {
        select: { id: true, name: true, status: true, images: { orderBy: { position: 'asc' }, take: 1, select: { url: true } } },
      },
    },
  });
  return new Map(
    rows.map((v) => [
      v.id,
      {
        variantId: v.id,
        productId: v.product.id,
        productName: v.product.name,
        sku: v.sku,
        label: variantLabel(v.attributes),
        priceCents: v.priceCents,
        stockQty: v.stockQty,
        imageUrl: v.product.images[0]?.url ?? null,
        isActive: v.product.status === 'active',
      },
    ]),
  );
}

export async function listStorefrontProducts(q: { categoryId?: string; search?: string; page: number; pageSize: number }) {
  const where: Prisma.ProductWhereInput = {
    status: 'active',
    categoryId: q.categoryId,
    ...(q.search && { name: { contains: q.search, mode: 'insensitive' } }),
  };
  const [items, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        name: true,
        description: true,
        priceCents: true,
        images: { orderBy: { position: 'asc' }, select: { url: true, alt: true } },
        variants: { select: { id: true, sku: true, attributes: true, priceCents: true, stockQty: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);
  return {
    items: items.map((p) => ({
      ...p,
      variants: p.variants.map(({ stockQty, ...v }) => ({ ...v, label: variantLabel(v.attributes), inStock: stockQty > 0 })),
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}
