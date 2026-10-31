import { Client } from 'pg';

async function setupUnavailabilityTable() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/golden_cabs';
  const client = new Client({ connectionString });

  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL for UnavailabilitySchedule setup');

    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS "UnavailabilitySchedule" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "driverId" TEXT,
        "vehicleId" TEXT,
        "date" VARCHAR(10) NOT NULL,
        "reason" TEXT DEFAULT 'Scheduled Offline',
        "createdAt" TIMESTAMPTZ DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS "idx_unavailability_driver_date" ON "UnavailabilitySchedule" ("driverId", "date");
      CREATE INDEX IF NOT EXISTS "idx_unavailability_vehicle_date" ON "UnavailabilitySchedule" ("vehicleId", "date");
      CREATE UNIQUE INDEX IF NOT EXISTS "idx_unavailability_unique" ON "UnavailabilitySchedule" (
        COALESCE("driverId", ''),
        COALESCE("vehicleId", ''),
        "date"
      );
    `;

    await client.query(createTableQuery);
    console.log('✅ "UnavailabilitySchedule" table and indexes verified in PostgreSQL!');

    const res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'UnavailabilitySchedule';
    `);
    console.log('Table columns:', res.rows.map(r => `${r.column_name} (${r.data_type})`));
  } catch (err) {
    console.error('❌ Error setting up UnavailabilitySchedule table:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

setupUnavailabilityTable();

