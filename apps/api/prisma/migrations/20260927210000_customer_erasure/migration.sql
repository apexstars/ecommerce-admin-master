-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "erasedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Customer_createdAt_idx" ON "Customer"("createdAt");

