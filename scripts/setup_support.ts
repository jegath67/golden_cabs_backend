import { prisma } from '../src/config/prisma';

async function setup() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "SupportTicket" (
      "id" TEXT PRIMARY KEY,
      "ticketCode" TEXT NOT NULL UNIQUE,
      "userId" TEXT NOT NULL,
      "userName" TEXT NOT NULL,
      "userPhone" TEXT NOT NULL,
      "userRole" TEXT NOT NULL,
      "complaintType" TEXT NOT NULL DEFAULT 'Customer',
      "category" TEXT NOT NULL,
      "subject" TEXT NOT NULL,
      "description" TEXT NOT NULL,
      "tripId" TEXT,
      "againstName" TEXT,
      "againstId" TEXT,
      "priority" TEXT NOT NULL DEFAULT 'Medium',
      "status" TEXT NOT NULL DEFAULT 'Open',
      "zone" TEXT DEFAULT 'Puducherry',
      "assignedTo" TEXT,
      "resolutionNote" TEXT,
      "resolvedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS "SupportTicket_userId_idx" ON "SupportTicket"("userId");
    CREATE INDEX IF NOT EXISTS "SupportTicket_status_idx" ON "SupportTicket"("status");
    CREATE INDEX IF NOT EXISTS "SupportTicket_userRole_idx" ON "SupportTicket"("userRole");
  `);
  console.log('✅ SupportTicket table verified in PostgreSQL');

  const count = await prisma.$queryRawUnsafe<any[]>('SELECT COUNT(*) as count FROM "SupportTicket"');
  console.log('Current SupportTicket count:', count);
}

setup()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

