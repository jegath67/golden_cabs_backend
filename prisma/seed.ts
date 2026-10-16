import { prisma } from '../src/config/prisma';
import bcrypt from 'bcryptjs';

async function seed() {
  console.log('🌱 Starting Golden Cabs database seeding...');

  // -------------------------------------------------------------
  // 1. SEED AUDITED PUDUCHERRY HUBS (Idempotent)
  // -------------------------------------------------------------
  const hubsData = [
    {
      name: 'White Town Hub',
      latitude: 11.9338,
      longitude: 79.8358,
      radiusMeters: 500.0,
      city: 'Puducherry',
    },
    {
      name: 'New Bus Stand Hub',
      latitude: 11.9360,
      longitude: 79.8174,
      radiusMeters: 500.0,
      city: 'Puducherry',
    },
    {
      name: 'Railway Station Hub',
      latitude: 11.9265,
      longitude: 79.8305,
      radiusMeters: 500.0,
      city: 'Puducherry',
    },
    {
      name: 'Puducherry Airport Hub',
      latitude: 11.9680,
      longitude: 79.8120,
      radiusMeters: 750.0,
      city: 'Puducherry',
    },
  ];

  for (const hub of hubsData) {
    const existing = await prisma.hub.findFirst({
      where: {
        name: hub.name,
        city: hub.city,
      },
    });

    if (existing) {
      console.log(`ℹ️ Hub already exists: ${hub.name} (${existing.id}) - Preserving`);
    } else {
      const created = await prisma.hub.create({
        data: {
          name: hub.name,
          latitude: hub.latitude,
          longitude: hub.longitude,
          radiusMeters: hub.radiusMeters,
          city: hub.city,
          isActive: true,
        },
      });
      console.log(`✅ Created Hub: ${created.name} (${created.id})`);
    }
  }

  // -------------------------------------------------------------
  // 2. SEED AUDITED BASELINE COUPONS (Idempotent by code)
  // -------------------------------------------------------------
  // Future expiration date (1 year out from baseline audit date)
  const futureExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const couponsData = [
    {
      code: 'GOLDEN50',
      description: 'Get 50% off up to ₹100 on your ride booking',
      discountType: 'PERCENTAGE' as const,
      discountValue: 50.0,
      minOrderAmount: 0.0,
      maxDiscount: 100.0,
      validUntil: futureExpiry,
      usageLimit: 10000,
      isActive: true,
    },
    {
      code: 'FLAT100',
      description: 'Get flat ₹100 instant discount on rides above ₹300',
      discountType: 'FLAT' as const,
      discountValue: 100.0,
      minOrderAmount: 300.0,
      maxDiscount: null,
      validUntil: futureExpiry,
      usageLimit: 10000,
      isActive: true,
    },
    {
      code: 'WELCOME20',
      description: 'Special 20% discount up to ₹75 on rides above ₹150',
      discountType: 'PERCENTAGE' as const,
      discountValue: 20.0,
      minOrderAmount: 150.0,
      maxDiscount: 75.0,
      validUntil: futureExpiry,
      usageLimit: 10000,
      isActive: true,
    },
    {
      code: 'CITYRIDE',
      description: 'Save flat ₹50 on all city cab rides above ₹200',
      discountType: 'FLAT' as const,
      discountValue: 50.0,
      minOrderAmount: 200.0,
      maxDiscount: null,
      validUntil: futureExpiry,
      usageLimit: 10000,
      isActive: true,
    },
    {
      code: 'FESTIVE25',
      description: 'Get 25% discount up to ₹150 on outstation & rental rides',
      discountType: 'PERCENTAGE' as const,
      discountValue: 25.0,
      minOrderAmount: 400.0,
      maxDiscount: 150.0,
      validUntil: futureExpiry,
      usageLimit: 10000,
      isActive: true,
    },
    {
      code: 'ELITE150',
      description: 'Save flat ₹150 on luxury & elite car bookings above ₹700',
      discountType: 'FLAT' as const,
      discountValue: 150.0,
      minOrderAmount: 700.0,
      maxDiscount: null,
      validUntil: futureExpiry,
      usageLimit: 10000,
      isActive: true,
    },
  ];

  for (const coupon of couponsData) {
    const upserted = await prisma.coupon.upsert({
      where: { code: coupon.code },
      update: {
        description: coupon.description,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        minOrderAmount: coupon.minOrderAmount,
        maxDiscount: coupon.maxDiscount,
        validUntil: coupon.validUntil,
        isActive: coupon.isActive,
      },
      create: coupon,
    });
    console.log(`✅ Seeded Coupon: ${upserted.code} (${upserted.discountType} ${upserted.discountValue})`);
  }

  // -------------------------------------------------------------
  // 3. SEED DEFAULT ADMIN USER (Idempotent by phone/email)
  // -------------------------------------------------------------
  const adminEmail = 'admin@goldencabs.com';
  const adminPhone = '9999999999';
  const adminPasswordHash = await bcrypt.hash('admin123', 10);

  const existingAdmin = await prisma.user.findFirst({
    where: {
      OR: [{ email: adminEmail }, { phone: adminPhone }],
    },
  });

  if (existingAdmin) {
    const updated = await prisma.user.update({
      where: { id: existingAdmin.id },
      data: {
        role: 'ADMIN',
        passwordHash: adminPasswordHash,
        isActive: true,
      },
    });
    console.log(`ℹ️ Existing Admin updated: ${updated.email} (${updated.phone})`);
  } else {
    const createdAdmin = await prisma.user.create({
      data: {
        phone: adminPhone,
        email: adminEmail,
        name: 'Golden Cabs Super Admin',
        passwordHash: adminPasswordHash,
        role: 'ADMIN',
        isActive: true,
      },
    });
    console.log(`✅ Created Admin: ${createdAdmin.email} (${createdAdmin.phone})`);
  }

  console.log('✨ Seeding completed successfully.');
}

seed()
  .catch((err) => {
    console.error('❌ Seeding failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
