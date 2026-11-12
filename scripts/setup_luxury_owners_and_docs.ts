import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/prisma';

const ASSET_SRC_DIR = 'd:/flutter projects/golden_cabs_admin/assets/images/all_vehicles';
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

function ensureUploadFile(sourceFilename: string, targetFilename: string): string {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  const srcPath = path.join(ASSET_SRC_DIR, sourceFilename);
  const destPath = path.join(UPLOADS_DIR, targetFilename);
  if (fs.existsSync(srcPath) && !fs.existsSync(destPath)) {
    fs.copyFileSync(srcPath, destPath);
  }
  return `/uploads/${targetFilename}`;
}

interface LuxuryOwnerSeed {
  matchPlateOrModel: string;
  newVehicleNumber?: string;
  rcNumber: string;
  rcExpiry: string;
  insuranceNumber: string;
  insuranceExpiry: string;
  ownerName: string;
  ownerPhone: string;
  ownerEmail: string;
  aadharNumber: string;
  panNumber: string;
  coverAsset: string;
  coverUpload: string;
  galleryAssets: Array<{ asset: string; upload: string }>;
}

const LUXURY_SEEDS: LuxuryOwnerSeed[] = [
  {
    matchPlateOrModel: 'Ferrari',
    rcNumber: 'TN01EL8801',
    rcExpiry: '2030-08-15',
    insuranceNumber: 'POL-EL-2026-8801',
    insuranceExpiry: '2027-08-15',
    ownerName: 'Vikram Raj',
    ownerPhone: '9840112201',
    ownerEmail: 'vikram.elite@goldencabs.in',
    aadharNumber: '482910394812',
    panNumber: 'ABCPV8801K',
    coverAsset: 'Ferrari-4.jpg',
    coverUpload: 'veh_elite_ferrari_cover.jpg',
    galleryAssets: [
      { asset: 'Ferrari-4.jpg', upload: 'veh_elite_ferrari_1.jpg' },
      { asset: 'Jaguar-F-1.jpg', upload: 'veh_elite_ferrari_2.jpg' },
      { asset: 'Jeep-3.jpg', upload: 'veh_elite_ferrari_3.jpg' },
    ],
  },
  {
    matchPlateOrModel: 'Rolls Royce',
    rcNumber: 'TN09EL9902',
    rcExpiry: '2030-11-20',
    insuranceNumber: 'POL-EL-2026-9902',
    insuranceExpiry: '2027-11-20',
    ownerName: 'Arjun Karthik',
    ownerPhone: '9840112202',
    ownerEmail: 'arjun.elite@goldencabs.in',
    aadharNumber: '591029384721',
    panNumber: 'BCDEA9902M',
    coverAsset: 'Rolls-Royce-3.jpg',
    coverUpload: 'veh_elite_rolls_cover.jpg',
    galleryAssets: [
      { asset: 'Rolls-Royce-3.jpg', upload: 'veh_elite_rolls_1.jpg' },
      { asset: 'Toyota-Mirai1.jpg', upload: 'veh_elite_rolls_2.jpg' },
      { asset: 'Toyota-Sequoia-4.jpg', upload: 'veh_elite_rolls_3.jpg' },
    ],
  },
  {
    matchPlateOrModel: 'BMW',
    rcNumber: 'TN10EL5503',
    rcExpiry: '2029-05-10',
    insuranceNumber: 'POL-EL-2026-5503',
    insuranceExpiry: '2027-05-10',
    ownerName: 'Praveen Kumar',
    ownerPhone: '9840112203',
    ownerEmail: 'praveen.elite@goldencabs.in',
    aadharNumber: '672910482934',
    panNumber: 'CDEFK5503R',
    coverAsset: 'BMW-X5_M_4.jpg',
    coverUpload: 'veh_elite_bmw_cover.jpg',
    galleryAssets: [
      { asset: 'BMW-X5_M_4.jpg', upload: 'veh_elite_bmw_1.jpg' },
      { asset: 'BMW-X3_M_1.jpg', upload: 'veh_elite_bmw_2.jpg' },
      { asset: 'Land_Rover-Defender_1.jpg', upload: 'veh_elite_bmw_3.jpg' },
    ],
  },
  {
    matchPlateOrModel: 'Audi',
    rcNumber: 'TN11EL7704',
    rcExpiry: '2030-03-25',
    insuranceNumber: 'POL-EL-2026-7704',
    insuranceExpiry: '2027-03-25',
    ownerName: 'Surya Prakash',
    ownerPhone: '9840112204',
    ownerEmail: 'surya.elite@goldencabs.in',
    aadharNumber: '749201938456',
    panNumber: 'DEFGS7704P',
    coverAsset: 'Audi-Q7_1.jpg',
    coverUpload: 'veh_elite_audi_cover.jpg',
    galleryAssets: [
      { asset: 'Audi-Q7_1.jpg', upload: 'veh_elite_audi_1.jpg' },
      { asset: 'Fiat-1.jpg', upload: 'veh_elite_audi_2.jpg' },
      { asset: 'Kia-1.jpg', upload: 'veh_elite_audi_3.jpg' },
    ],
  },
];

async function main() {
  const passwordHash = await bcrypt.hash('Golden@123', 10);

  // Reuse clean existing doc images in /uploads for RC/Insurance/KYC copies
  const docRcFront = '/uploads/doc_1793102896500_9770b0fc9873.jpg';
  const docRcBack = '/uploads/doc_1793102896555_457d9aedf5a1.jpg';
  const docInsurance = '/uploads/doc_1793102896595_8587dea8c3fa.jpg';
  const docAadharFront = '/uploads/doc_1793102896324_29b5c1b93cbb.jpg';
  const docAadharBack = '/uploads/doc_1793102896401_b455c0ef75b7.jpg';
  const docPan = '/uploads/doc_1793102896421_8c2102da74bc.jpg';
  const docSelfie = '/uploads/doc_1793102896199_6d56516d010e.jpg';

  const results: any[] = [];

  for (const seed of LUXURY_SEEDS) {
    // 1. Ensure user + RENTAL DriverProfile + DriverWallet exist
    let user = await prisma.user.findUnique({
      where: { phone: seed.ownerPhone },
      include: { driverProfile: { include: { wallet: true } } },
    });

    if (!user) {
      user = await prisma.user.create({
        data: {
          phone: seed.ownerPhone,
          name: seed.ownerName,
          email: seed.ownerEmail,
          passwordHash,
          role: 'DRIVER',
          isActive: true,
        },
        include: { driverProfile: { include: { wallet: true } } },
      });
    } else {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          name: seed.ownerName,
          email: seed.ownerEmail,
          passwordHash,
          role: 'DRIVER',
          isActive: true,
        },
        include: { driverProfile: { include: { wallet: true } } },
      });
    }

    let profile = user.driverProfile;
    if (!profile) {
      profile = await prisma.driverProfile.create({
        data: {
          userId: user.id,
          personaType: 'RENTAL',
          approvalStatus: 'APPROVED',
          aadharNumber: seed.aadharNumber,
          aadharFront: docAadharFront,
          aadharBack: docAadharBack,
          panNumber: seed.panNumber,
          panImage: docPan,
          selfieImage: docSelfie,
          wallet: { create: { balance: 0 } },
        },
        include: { wallet: true },
      });
    } else {
      profile = await prisma.driverProfile.update({
        where: { id: profile.id },
        data: {
          personaType: 'RENTAL',
          approvalStatus: 'APPROVED',
          aadharNumber: profile.aadharNumber ?? seed.aadharNumber,
          aadharFront: profile.aadharFront ?? docAadharFront,
          aadharBack: profile.aadharBack ?? docAadharBack,
          panNumber: profile.panNumber ?? seed.panNumber,
          panImage: profile.panImage ?? docPan,
          selfieImage: profile.selfieImage ?? docSelfie,
        },
        include: { wallet: true },
      });

      if (!profile.wallet) {
        await prisma.driverWallet.create({
          data: { driverId: profile.id, balance: 0 },
        });
      }
    }

    // 2. Locate matching Luxury Vehicle
    const vehicle = await prisma.vehicle.findFirst({
      where: {
        category: 'LUXURY',
        OR: [
          { model: { contains: seed.matchPlateOrModel, mode: 'insensitive' } },
          { brand: { contains: seed.matchPlateOrModel, mode: 'insensitive' } },
        ],
      },
    });

    if (!vehicle) {
      console.warn(`Luxury vehicle matching "${seed.matchPlateOrModel}" not found`);
      continue;
    }

    // 3. Copy real car images into /uploads/
    const coverUrl = ensureUploadFile(seed.coverAsset, seed.coverUpload);
    const galleryUrls = seed.galleryAssets.map((g) => ensureUploadFile(g.asset, g.upload));

    // 4. Update Vehicle owner + RC + Insurance + VehiclePhotos
    await prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id: vehicle.id },
        data: {
          ownerId: profile.id,
          rcNumber: seed.rcNumber,
          rcExpiry: seed.rcExpiry,
          rcFront: docRcFront,
          rcBack: docRcBack,
          insuranceNumber: seed.insuranceNumber,
          insuranceExpiry: seed.insuranceExpiry,
          insuranceDoc: docInsurance,
        },
      });

      await tx.vehiclePhoto.deleteMany({ where: { vehicleId: vehicle.id } });
      await tx.vehiclePhoto.create({
        data: { vehicleId: vehicle.id, photoUrl: coverUrl, tag: 'cover' },
      });
      for (const gUrl of galleryUrls) {
        await tx.vehiclePhoto.create({
          data: { vehicleId: vehicle.id, photoUrl: gUrl, tag: 'gallery' },
        });
      }
    });

    results.push({
      vehicleNumber: vehicle.vehicleNumber,
      model: vehicle.model,
      ownerName: seed.ownerName,
      phone: seed.ownerPhone,
      personaType: 'RENTAL',
      rcNumber: seed.rcNumber,
      insuranceNumber: seed.insuranceNumber,
      coverUrl,
      galleryCount: galleryUrls.length,
    });
  }

  console.log(JSON.stringify({ updatedCount: results.length, luxuryOwners: results }, null, 2));
}

main()
  .catch((err) => {
    console.error('Setup failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
