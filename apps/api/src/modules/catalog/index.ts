import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdParams, PageQuery, parse } from '../../shared/http.js';
import * as catalog from './catalog.service.js';

export { getVariants, stockLevel, variantLabel, type SellableVariant, type StockLevel } from './catalog.service.js';

const Cents = z.number().int().nonnegative();
const Sku = z.string().trim().min(1).max(64);
const Attributes = z.object({ size: z.string().max(40).optional(), color: z.string().max(40).optional() });
const Variant = z.object({ sku: Sku, attributes: Attributes.default({}), priceCents: Cents });
const Status = z.enum(['active', 'draft']);
const Ids = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

export async function catalogAdminRoutes(app: FastifyInstance) {
  // ── products ──
  app.get('/products', { config: { permission: 'products:view' } }, async (req) =>
    catalog.listProducts(
      parse(
        PageQuery.extend({
          categoryId: z.string().uuid().optional(),
          status: Status.optional(),
          search: z.string().trim().optional(),
          stock: z.enum(['ok', 'low', 'out']).optional(),
        }),
        req.query,
      ),
    ),
  );

  app.get('/products/:id', { config: { permission: 'products:view' } }, async (req) =>
    catalog.getProduct(parse(IdParams, req.params).id),
  );

  app.post('/products', { config: { permission: 'products:create' } }, async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200),
        sku: Sku,
        description: z.string().max(5000).default(''),
        categoryId: z.string().uuid(),
        priceCents: Cents,
        status: Status.default('draft'),
        variants: z.array(Variant).max(100).default([]),
      }),
      req.body,
    );
    return reply.code(201).send(await catalog.createProduct(body));
  });

  app.patch('/products/:id', { config: { permission: 'products:edit' } }, async (req) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200).optional(),
        sku: Sku.optional(),
        description: z.string().max(5000).optional(),
        categoryId: z.string().uuid().optional(),
        priceCents: Cents.optional(),
        status: Status.optional(),
      }),
      req.body,
    );
    return catalog.updateProduct(parse(IdParams, req.params).id, body);
  });

  app.delete('/products/:id', { config: { permission: 'products:delete' } }, async (req, reply) => {
    await catalog.deleteProducts([parse(IdParams, req.params).id]);
    return reply.code(204).send();
  });

  app.post('/products/bulk/status', { config: { permission: 'products:edit' } }, async (req) => {
    const body = parse(Ids.extend({ status: Status }), req.body);
    return { updated: await catalog.setProductStatus(body.ids, body.status) };
  });

  app.post('/products/bulk/delete', { config: { permission: 'products:delete' } }, async (req) => {
    return { deleted: await catalog.deleteProducts(parse(Ids, req.body).ids) };
  });

  // ── variants ──
  const VariantParams = z.object({ id: z.string().uuid(), variantId: z.string().uuid() });

  app.post('/products/:id/variants', { config: { permission: 'products:edit' } }, async (req, reply) => {
    return reply.code(201).send(await catalog.addVariant(parse(IdParams, req.params).id, parse(Variant, req.body)));
  });

  app.patch('/products/:id/variants/:variantId', { config: { permission: 'products:edit' } }, async (req) => {
    const { id, variantId } = parse(VariantParams, req.params);
    return catalog.updateVariant(id, variantId, parse(Variant.partial(), req.body));
  });

  app.delete('/products/:id/variants/:variantId', { config: { permission: 'products:edit' } }, async (req) => {
    const { id, variantId } = parse(VariantParams, req.params);
    return catalog.deleteVariant(id, variantId);
  });

  // ── images ──
  app.post('/products/:id/images/upload-url', { config: { permission: 'products:edit' } }, async (req) => {
    const { contentType } = parse(z.object({ contentType: z.string() }), req.body);
    return catalog.createImageUpload(parse(IdParams, req.params).id, contentType);
  });

  app.post('/products/:id/images', { config: { permission: 'products:edit' } }, async (req, reply) => {
    const body = parse(z.object({ key: z.string().min(1), alt: z.string().max(200).default('') }), req.body);
    return reply.code(201).send(await catalog.attachImage(parse(IdParams, req.params).id, body.key, body.alt));
  });

  app.delete('/products/:id/images/:imageId', { config: { permission: 'products:edit' } }, async (req) => {
    const { id, imageId } = parse(z.object({ id: z.string().uuid(), imageId: z.string().uuid() }), req.params);
    return catalog.removeImage(id, imageId);
  });

  // ── categories ──
  const Name = z.object({ name: z.string().trim().min(1).max(60) });

  app.get('/categories', { config: { permission: 'products:view' } }, async () => catalog.listCategories());

  app.post('/categories', { config: { permission: 'products:create' } }, async (req, reply) =>
    reply.code(201).send(await catalog.createCategory(parse(Name, req.body).name)),
  );

  app.patch('/categories/:id', { config: { permission: 'products:edit' } }, async (req) =>
    catalog.renameCategory(parse(IdParams, req.params).id, parse(Name, req.body).name),
  );

  app.delete('/categories/:id', { config: { permission: 'products:delete' } }, async (req, reply) => {
    await catalog.deleteCategory(parse(IdParams, req.params).id);
    return reply.code(204).send();
  });
}

export async function catalogStoreRoutes(app: FastifyInstance) {
  app.get('/products', async (req) =>
    catalog.listStorefrontProducts(
      parse(PageQuery.extend({ categoryId: z.string().uuid().optional(), search: z.string().trim().optional() }), req.query),
    ),
  );
  app.get('/categories', async () => catalog.listCategories());
}
