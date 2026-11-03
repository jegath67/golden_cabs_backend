import { prisma } from '../src/config/prisma';

async function main() {
  console.log('Ensuring PlatformSetting table exists in PostgreSQL...');
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "PlatformSetting" (
      "id" TEXT PRIMARY KEY,
      "key" TEXT NOT NULL,
      "value" TEXT NOT NULL,
      "description" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "PlatformSetting_key_key" ON "PlatformSetting"("key");
  `);

  // Seed default 20% commission if not already present
  await prisma.$executeRawUnsafe(`
    INSERT INTO "PlatformSetting" ("id", "key", "value", "description", "updatedAt")
    VALUES ('platform-commission-setting', 'PLATFORM_COMMISSION_PERCENT', '20', 'Platform commission percentage deducted from driver rides', NOW())
    ON CONFLICT ("key") DO NOTHING;
  `);

  console.log('✅ PlatformSetting verified and seeded with 20% default commission!');
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
