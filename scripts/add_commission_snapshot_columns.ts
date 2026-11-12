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

    // 1. Add commissionPercent on PricingSlab
    await client.query(`
      ALTER TABLE "PricingSlab"
      ADD COLUMN IF NOT EXISTS "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 20.0;
    `);
    console.log('✅ Added commissionPercent column to PricingSlab');

    // 2. Add snapshot columns on FareBreakdown
    await client.query(`
      ALTER TABLE "FareBreakdown"
      ADD COLUMN IF NOT EXISTS "commissionPercent" DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS "commissionAmount" DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS "driverAmount" DOUBLE PRECISION,
      ADD COLUMN IF NOT EXISTS "pricingSlabId" TEXT;
    `);
    console.log('✅ Added commission snapshot columns to FareBreakdown');

    // 3. One-time backfill for existing FareBreakdown rows so historical rides never mutate when PricingSlabs change later
    const settingRes = await client.query(
      `SELECT "value" FROM "PlatformSetting" WHERE "key" = 'PLATFORM_COMMISSION_PERCENT' LIMIT 1;`
    );
    const parsedPct = Number(settingRes.rows[0]?.value);
    const legacyPercent =
      !isNaN(parsedPct) && parsedPct >= 0 && parsedPct <= 100 ? parsedPct : 20.0;

    // 3a. Freeze rides that already have a WalletTransaction ledger entry
    await client.query(
      `
      WITH tx_per_ride AS (
        SELECT DISTINCT ON ("referenceRideId")
          "referenceRideId" AS ride_id,
          "type"::text AS tx_type,
          "amount" AS tx_amount
        FROM "WalletTransaction"
        WHERE "referenceRideId" IS NOT NULL
          AND "type"::text IN ('COMMISSION', 'EARNING')
        ORDER BY "referenceRideId", "createdAt" ASC
      )
      UPDATE "FareBreakdown" fb
      SET
        "commissionPercent" = COALESCE(fb."commissionPercent", $1),
        "commissionAmount" = CASE
          WHEN r."status"::text = 'CANCELLED' OR r."paymentStatus"::text = 'REFUNDED' THEN 0
          WHEN tx.tx_type = 'COMMISSION' THEN ROUND((tx.tx_amount)::numeric, 2)::double precision
          WHEN tx.tx_type = 'EARNING' THEN ROUND(GREATEST(0, (COALESCE(r."finalFare", fb."totalFare", r."estimatedFare", 0) + COALESCE(fb."discountAmount", 0) - tx.tx_amount))::numeric, 2)::double precision
          ELSE ROUND(((COALESCE(r."finalFare", fb."totalFare", r."estimatedFare", 0) + COALESCE(fb."discountAmount", 0)) * ($1 / 100.0))::numeric, 2)::double precision
        END,
        "driverAmount" = CASE
          WHEN r."status"::text = 'CANCELLED' OR r."paymentStatus"::text = 'REFUNDED' THEN 0
          WHEN tx.tx_type = 'EARNING' THEN ROUND((tx.tx_amount)::numeric, 2)::double precision
          WHEN tx.tx_type = 'COMMISSION' THEN ROUND(GREATEST(0, (COALESCE(r."finalFare", fb."totalFare", r."estimatedFare", 0) + COALESCE(fb."discountAmount", 0) - tx.tx_amount))::numeric, 2)::double precision
          ELSE ROUND(((COALESCE(r."finalFare", fb."totalFare", r."estimatedFare", 0) + COALESCE(fb."discountAmount", 0)) - ROUND(((COALESCE(r."finalFare", fb."totalFare", r."estimatedFare", 0) + COALESCE(fb."discountAmount", 0)) * ($1 / 100.0))::numeric, 2))::numeric, 2)::double precision
        END
      FROM "Ride" r
      LEFT JOIN tx_per_ride tx ON tx.ride_id = r."id"
      WHERE fb."rideId" = r."id"
        AND fb."commissionPercent" IS NULL;
      `,
      [legacyPercent]
    );
    console.log(`✅ Backfilled existing FareBreakdown rows with legacy rate (${legacyPercent}%) / wallet ledger`);

    // 4. Verify columns
    const verifyRes = await client.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE (table_name = 'PricingSlab' AND column_name = 'commissionPercent')
         OR (table_name = 'FareBreakdown' AND column_name IN ('commissionPercent', 'commissionAmount', 'driverAmount', 'pricingSlabId'))
      ORDER BY table_name, column_name;
    `);
    console.log('Verified columns:', verifyRes.rows);
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
