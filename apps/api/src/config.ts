import { z } from 'zod';

try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the real environment
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const Env = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().default(4000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().default('redis://localhost:6379'),
    WEB_ORIGIN: z.string().default('http://localhost:5173'),

    ADMIN_JWT_SECRET: z.string().min(32),
    CUSTOMER_JWT_SECRET: z.string().min(32),
    ADMIN_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    ADMIN_SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(8 * 3600),
    CUSTOMER_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),

    STRIPE_SECRET_KEY: z.string().optional().transform((v) => v || undefined),
    STRIPE_WEBHOOK_SECRET: z.string().optional().transform((v) => v || undefined),

    S3_ENDPOINT: z.string().optional().transform((v) => v || undefined),
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().default('product-images'),
    S3_ACCESS_KEY_ID: z.string().default(''),
    S3_SECRET_ACCESS_KEY: z.string().default(''),
    S3_PUBLIC_URL: z.string().default('http://localhost:9000/product-images'),

    LOW_STOCK_THRESHOLD: z.coerce.number().int().nonnegative().default(10),
    TAX_RATE_BPS: z.coerce.number().int().nonnegative().default(800),
    FLAT_SHIPPING_CENTS: z.coerce.number().int().nonnegative().default(800),
    FREE_SHIPPING_OVER_CENTS: z.coerce.number().int().nonnegative().default(10000),

    RUN_WORKER_IN_PROCESS: bool.default(true),
  })
  .refine((e) => e.ADMIN_JWT_SECRET !== e.CUSTOMER_JWT_SECRET, {
    message: 'ADMIN_JWT_SECRET and CUSTOMER_JWT_SECRET must differ',
  });

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export const isProd = config.NODE_ENV === 'production';
