import 'dotenv/config';
import { prisma } from '../src/config/prisma';

async function main() {
  console.log('Running additive migration: PaymentTransaction & GatewayWebhookEvent...');

  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      CREATE TYPE "GatewayPaymentStatus" AS ENUM (
        'CREATED',
        'PENDING',
        'AUTHORIZED',
        'CAPTURED',
        'PAID',
        'FAILED',
        'REFUNDED',
        'PARTIALLY_REFUNDED'
      );
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PaymentTransaction" (
      "id" TEXT NOT NULL,
      "rideId" TEXT NOT NULL,
      "customerId" TEXT NOT NULL,
      "provider" TEXT NOT NULL DEFAULT 'RAZORPAY',
      "razorpayOrderId" TEXT NOT NULL,
      "razorpayPaymentId" TEXT,
      "razorpaySignature" TEXT,
      "receipt" TEXT NOT NULL,
      "amountPaise" INTEGER NOT NULL,
      "amountInr" DOUBLE PRECISION NOT NULL,
      "currency" TEXT NOT NULL DEFAULT 'INR',
      "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'UPI',
      "gatewayMethod" TEXT,
      "status" "GatewayPaymentStatus" NOT NULL DEFAULT 'CREATED',
      "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
      "failureReason" TEXT,
      "gatewayEventIds" JSONB,
      "refundedAmountPaise" INTEGER NOT NULL DEFAULT 0,
      "verifiedAt" TIMESTAMP(3),
      "capturedAt" TIMESTAMP(3),
      "failedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "GatewayWebhookEvent" (
      "id" TEXT NOT NULL,
      "provider" TEXT NOT NULL DEFAULT 'RAZORPAY',
      "eventId" TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      "razorpayOrderId" TEXT,
      "razorpayPaymentId" TEXT,
      "paymentTransactionId" TEXT,
      "payload" JSONB,
      "processed" BOOLEAN NOT NULL DEFAULT true,
      "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "GatewayWebhookEvent_pkey" PRIMARY KEY ("id")
    );
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTransaction_razorpayOrderId_key" ON "PaymentTransaction"("razorpayOrderId");
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTransaction_razorpayPaymentId_key" ON "PaymentTransaction"("razorpayPaymentId") WHERE "razorpayPaymentId" IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS "PaymentTransaction_receipt_key" ON "PaymentTransaction"("receipt");
    CREATE INDEX IF NOT EXISTS "PaymentTransaction_rideId_status_idx" ON "PaymentTransaction"("rideId", "status");
    CREATE INDEX IF NOT EXISTS "PaymentTransaction_customerId_createdAt_idx" ON "PaymentTransaction"("customerId", "createdAt");
    CREATE UNIQUE INDEX IF NOT EXISTS "GatewayWebhookEvent_eventId_key" ON "GatewayWebhookEvent"("eventId");
    CREATE INDEX IF NOT EXISTS "GatewayWebhookEvent_razorpayOrderId_idx" ON "GatewayWebhookEvent"("razorpayOrderId");
    CREATE INDEX IF NOT EXISTS "GatewayWebhookEvent_razorpayPaymentId_idx" ON "GatewayWebhookEvent"("razorpayPaymentId");
  `);

  await prisma.$executeRawUnsafe(`
    DO $$ BEGIN
      ALTER TABLE "PaymentTransaction"
        ADD CONSTRAINT "PaymentTransaction_rideId_fkey"
        FOREIGN KEY ("rideId") REFERENCES "Ride"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "PaymentTransaction"
        ADD CONSTRAINT "PaymentTransaction_customerId_fkey"
        FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE "GatewayWebhookEvent"
        ADD CONSTRAINT "GatewayWebhookEvent_paymentTransactionId_fkey"
        FOREIGN KEY ("paymentTransactionId") REFERENCES "PaymentTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
    END $$;
  `);

  console.log('✅ Additive migration completed successfully.');
}

main()
  .catch((err) => {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
