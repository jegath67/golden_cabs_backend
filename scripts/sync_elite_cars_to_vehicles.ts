import { prisma } from '../src/config/prisma';
import { FuelType, GearType, VehicleCategory, VehicleStatus } from '../src/generated/prisma/client';

function parseSeatCount(seats?: string | null): number {
  if (!seats) return 4;
  const digits = seats.replace(/[^0-9]/g, '');
  const parsed = parseInt(digits, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function mapFuelType(raw?: string | null): FuelType {
  const upper = (raw || 'PETROL').trim().toUpperCase();
  if (upper === 'DIESEL') return 'DIESEL';
  if (upper === 'ELECTRIC' || upper === 'EV') return 'ELECTRIC';
  if (upper === 'CNG') return 'CNG';
  return 'PETROL';
}

function mapGearType(raw?: string | null): GearType {
  const upper = (raw || 'AUTOMATIC').trim().toUpperCase();
  if (upper === 'MANUAL') return 'MANUAL';
  return 'AUTOMATIC';
}

function mapVehicleCategory(raw?: string | null): VehicleCategory {
  const upper = (raw || 'LUXURY').trim().toUpperCase();
  if (upper === 'BUDGET') return 'BUDGET';
  if (upper === 'PREMIUM') return 'PREMIUM';
  return 'LUXURY';
}

function mapVehicleStatus(raw?: string | null): VehicleStatus {
  const upper = (raw || 'AVAILABLE').trim().toUpperCase();
  if (upper === 'MAINTENANCE' || upper === 'INACTIVE') return 'MAINTENANCE';
  return 'VERIFIED';
}

async function generateUniquePlate(index: number): Promise<string> {
  let seq = index + 1;
  while (true) {
    const candidate = `ELITE-${String(seq).padStart(3, '0')}`;
    const exists = await prisma.vehicle.findUnique({ where: { vehicleNumber: candidate } });
    if (!exists) return candidate;
    seq += 1;
  }
}

async function main() {
  // 1. Non-destructive additive DDL (safe if already present)
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Vehicle"
      ADD COLUMN IF NOT EXISTS "speed" TEXT,
      ADD COLUMN IF NOT EXISTS "features" TEXT,
      ADD COLUMN IF NOT EXISTS "eliteRating" DOUBLE PRECISION DEFAULT 4.9,
      ADD COLUMN IF NOT EXISTS "eliteStatus" TEXT,
      ADD COLUMN IF NOT EXISTS "sourceEliteCarId" TEXT;
  `);
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Vehicle_sourceEliteCarId_key"
      ON "Vehicle"("sourceEliteCarId");
  `);

  const eliteCars = await prisma.eliteCar.findMany({
    orderBy: { createdAt: 'asc' },
  });

  let createdCount = 0;
  let skippedCount = 0;

  for (let i = 0; i < eliteCars.length; i++) {
    const ec = eliteCars[i];

    const existing = await prisma.vehicle.findFirst({
      where: {
        OR: [{ id: ec.id }, { sourceEliteCarId: ec.id }],
      },
      include: { photos: true },
    });

    if (existing) {
      await prisma.vehicle.update({
        where: { id: existing.id },
        data: {
          sourceEliteCarId: existing.sourceEliteCarId ?? ec.id,
          speed: existing.speed ?? ec.speed ?? '250 km/h',
          features: existing.features ?? ec.features ?? 'Luxury Package',
          eliteRating: existing.eliteRating ?? ec.rating ?? 4.9,
          eliteStatus: existing.eliteStatus ?? ec.status ?? 'AVAILABLE',
        },
      });
      skippedCount += 1;
      continue;
    }

    const vehicleNumber = await generateUniquePlate(i);
    const vehicleStatus = mapVehicleStatus(ec.status);

    await prisma.vehicle.create({
      data: {
        id: ec.id,
        sourceEliteCarId: ec.id,
        vehicleNumber,
        brand: ec.brand,
        model: ec.model,
        year: ec.createdAt.getFullYear() || 2024,
        vehicleType: 'LUXURY',
        category: mapVehicleCategory(ec.category),
        fuelType: mapFuelType(ec.fuelType),
        gearType: mapGearType(ec.transmission),
        seatCapacity: parseSeatCount(ec.seats),
        pricePerKm: ec.pricePerKm || 80.0,
        basePrice: 0.0,
        acAvailable: true,
        luggageCapacity: true,
        status: vehicleStatus,
        isOnline: (ec.status || '').toUpperCase() === 'AVAILABLE',
        speed: ec.speed || '250 km/h',
        features: ec.features || 'Luxury Package',
        eliteRating: ec.rating ?? 4.9,
        eliteStatus: (ec.status || 'AVAILABLE').toUpperCase(),
        ownerId: null,
        createdAt: ec.createdAt,
      },
    });

    // Preserve cover image first, followed by extra gallery photos in exact order
    const coverUrl = (ec.image || '').trim();
    if (coverUrl) {
      await prisma.vehiclePhoto.create({
        data: {
          vehicleId: ec.id,
          photoUrl: coverUrl,
          tag: 'cover',
        },
      });
    }

    const galleryList = Array.isArray(ec.gallery) ? ec.gallery : [];
    for (const gUrl of galleryList) {
      const clean = (gUrl || '').trim();
      if (clean) {
        await prisma.vehiclePhoto.create({
          data: {
            vehicleId: ec.id,
            photoUrl: clean,
            tag: 'gallery',
          },
        });
      }
    }

    createdCount += 1;
  }

  const luxuryVehicles = await prisma.vehicle.findMany({
    where: { category: 'LUXURY' },
    include: { photos: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(
    JSON.stringify(
      {
        eliteCarSourceCount: eliteCars.length,
        migratedToVehicle: createdCount,
        alreadySynced: skippedCount,
        totalLuxuryVehiclesNow: luxuryVehicles.length,
        luxuryVehicles: luxuryVehicles.map((v) => ({
          id: v.id,
          vehicleNumber: v.vehicleNumber,
          brand: v.brand,
          model: v.model,
          status: v.status,
          eliteStatus: v.eliteStatus,
          category: v.category,
          vehicleType: v.vehicleType,
          photosCount: v.photos.length,
        })),
      },
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
