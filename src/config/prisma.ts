import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:123456@localhost:5432/golden_cabs';
const adapter = new PrismaPg({ connectionString });

export const prisma = new PrismaClient({ adapter });
