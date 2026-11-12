import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const connectionString =
    process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/golden_cabs';
  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log('Connected to PostgreSQL');

    await client.query(`
      ALTER TABLE "Wallet"
      ADD COLUMN IF NOT EXISTS "bankName" TEXT;
    `);
    console.log('✅ Added bankName column to Wallet');

    await client.query(`
      ALTER TABLE "WalletTransaction"
      ADD COLUMN IF NOT EXISTS "bankName" TEXT,
      ADD COLUMN IF NOT EXISTS "bankAccountNumber" TEXT,
      ADD COLUMN IF NOT EXISTS "bankIfsc" TEXT,
      ADD COLUMN IF NOT EXISTS "bankHolderName" TEXT;
    `);
    console.log('✅ Added bank snapshot columns to WalletTransaction');

    // Non-destructive backfill for existing withdrawal transactions lacking snapshot
    await client.query(`
      UPDATE "WalletTransaction" wt
      SET
        "bankName" = COALESCE(wt."bankName", w."bankName"),
        "bankAccountNumber" = COALESCE(wt."bankAccountNumber", w."bankAccountNumber"),
        "bankIfsc" = COALESCE(wt."bankIfsc", w."bankIfsc"),
        "bankHolderName" = COALESCE(wt."bankHolderName", w."bankHolderName")
      FROM "Wallet" w
      WHERE wt."walletId" = w."id"
        AND wt."type"::text = 'WITHDRAWAL'
        AND wt."bankAccountNumber" IS NULL
        AND w."bankAccountNumber" IS NOT NULL;
    `);
    console.log('✅ Backfilled existing WITHDRAWAL transactions with bank snapshots');

    // Check & create partial unique index on non-empty utrNumber
    const dupUtr = await client.query(`
      SELECT "utrNumber", COUNT(*) AS cnt
      FROM "WalletTransaction"
      WHERE "utrNumber" IS NOT NULL AND TRIM("utrNumber") <> ''
      GROUP BY "utrNumber"
      HAVING COUNT(*) > 1;
    `);
    if (dupUtr.rows.length === 0) {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "WalletTransaction_utrNumber_unique_idx"
        ON "WalletTransaction" ("utrNumber")
        WHERE "utrNumber" IS NOT NULL AND TRIM("utrNumber") <> '';
      `);
      console.log('✅ Created unique partial index on WalletTransaction(utrNumber)');
    } else {
      console.warn('⚠️ Duplicate legacy UTRs detected, skipping unique index:', dupUtr.rows);
    }

    // Check & create partial unique index on (referenceRideId, type) for ride settlements
    const dupRideTx = await client.query(`
      SELECT "referenceRideId", "type"::text AS tx_type, COUNT(*) AS cnt
      FROM "WalletTransaction"
      WHERE "referenceRideId" IS NOT NULL
        AND "type"::text IN ('COMMISSION', 'EARNING')
      GROUP BY "referenceRideId", "type"
      HAVING COUNT(*) > 1;
    `);
    if (dupRideTx.rows.length === 0) {
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "WalletTransaction_ride_settlement_unique_idx"
        ON "WalletTransaction" ("referenceRideId", "type")
        WHERE "referenceRideId" IS NOT NULL
          AND "type" IN ('COMMISSION'::"WalletTxType", 'EARNING'::"WalletTxType");
      `);
      console.log('✅ Created unique partial index on WalletTransaction(referenceRideId, type)');
    } else {
      console.warn('⚠️ Duplicate legacy ride settlements detected, skipping unique index:', dupRideTx.rows);
    }
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
