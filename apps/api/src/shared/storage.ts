import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

const s3 = new S3Client({
  region: config.S3_REGION,
  endpoint: config.S3_ENDPOINT,
  forcePathStyle: Boolean(config.S3_ENDPOINT), // MinIO / most S3-compatibles
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  },
});

/** Browser uploads straight to the bucket; the API never proxies image bytes. */
export async function presignUpload(key: string, contentType: string, expiresIn = 300) {
  const command = new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(s3, command, { expiresIn });
}

export const publicUrl = (key: string) => `${config.S3_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
