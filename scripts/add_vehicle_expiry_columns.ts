import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/golden_cabs';
  const client = new Client({ connectionString });
  try {
    await client.connect();
    console.log('Connected to PostgreSQL');
    await client.query(`
      ALTER TABLE "DriverProfile" 
      ADD COLUMN IF NOT EXISTS "vehicleAssignedAt" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "vehicleExpiresAt" TIMESTAMPTZ;
    `);
    console.log('✅ Added vehicleAssignedAt and vehicleExpiresAt columns to DriverProfile table');
    
    // Check columns
    const res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'DriverProfile' AND column_name IN ('vehicleAssignedAt', 'vehicleExpiresAt');
    `);
    console.log('Columns verified:', res.rows);
  } catch (err) {
    console.error('Error running migration:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
