import { z } from 'zod';
import { badRequest } from './errors.js';

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Invalid request', z.flattenError(result.error));
  }
  return result.data;
}

export const PageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const IdParams = z.object({ id: z.string().uuid() });

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function page<T>(items: T[], total: number, q: { page: number; pageSize: number }): Page<T> {
  return { items, total, page: q.page, pageSize: q.pageSize };
}
