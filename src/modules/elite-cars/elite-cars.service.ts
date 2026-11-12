import { prisma } from '../../config/prisma';
import {
  FuelType,
  GearType,
  VehicleCategory,
  VehicleStatus,
  VehicleType,
} from '../../generated/prisma/client';

const ACTIVE_RIDE_STATUSES = ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ONGOING'] as const;
const DEFAULT_COVER_IMAGE = 'assets/images/all_vehicles/Ferrari-4.jpg';

function parseSeatCount(seats: unknown): number {
  if (typeof seats === 'number' && Number.isFinite(seats) && seats > 0) {
    return Math.round(seats);
  }
  const digits = String(seats ?? '').replace(/[^0-9]/g, '');
  const parsed = parseInt(digits, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

function mapFuelType(raw?: unknown): FuelType {
  const upper = String(raw || 'PETROL').trim().toUpperCase();
  if (upper === 'DIESEL') return 'DIESEL';
  if (upper === 'ELECTRIC' || upper === 'EV') return 'ELECTRIC';
  if (upper === 'CNG') return 'CNG';
  return 'PETROL';
}

function mapGearType(raw?: unknown): GearType {
  const upper = String(raw || 'AUTOMATIC').trim().toUpperCase();
  return upper === 'MANUAL' ? 'MANUAL' : 'AUTOMATIC';
}

function mapVehicleCategory(raw?: unknown): VehicleCategory {
  const upper = String(raw || 'LUXURY').trim().toUpperCase();
  if (upper === 'BUDGET') return 'BUDGET';
  if (upper === 'PREMIUM') return 'PREMIUM';
  return 'LUXURY';
}

function mapVehicleType(rawType?: unknown, category?: VehicleCategory): VehicleType {
  const upper = String(rawType || '').trim().toUpperCase();
  if (upper === 'SEDAN') return 'SEDAN';
  if (upper === 'SUV') return 'SUV';
  if (upper === 'HATCHBACK') return 'HATCHBACK';
  if (upper === 'AUTO') return 'AUTO';
  if (upper === 'LUXURY') return 'LUXURY';
  return category === 'LUXURY' ? 'LUXURY' : 'SEDAN';
}

function formatEnumLabel(val: string | null | undefined, fallback: string): string {
  if (!val) return fallback;
  const upper = val.toUpperCase();
  if (upper === 'SUV') return 'SUV';
  if (upper === 'CNG') return 'CNG';
  return val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
}

function formatCategoryLabel(category: VehicleCategory): string {
  if (category === 'LUXURY') return 'Luxury';
  if (category === 'PREMIUM') return 'Premium';
  return 'Budget';
}

function parseStatusMapping(rawStatus?: unknown): {
  vehicleStatus: VehicleStatus;
  eliteStatus: string;
  isOnline: boolean;
} {
  const upper = String(rawStatus || 'AVAILABLE').trim().toUpperCase();
  if (upper === 'MAINTENANCE' || upper === 'INACTIVE') {
    return { vehicleStatus: 'MAINTENANCE', eliteStatus: 'MAINTENANCE', isOnline: false };
  }
  if (upper === 'BOOKED' || upper === 'ON_TRIP' || upper === 'UNAVAILABLE') {
    return { vehicleStatus: 'VERIFIED', eliteStatus: upper, isOnline: false };
  }
  return { vehicleStatus: 'VERIFIED', eliteStatus: 'AVAILABLE', isOnline: true };
}

async function generateUniqueElitePlate(): Promise<string> {
  const count = await prisma.vehicle.count({ where: { category: 'LUXURY' } });
  let seq = count + 1;
  while (true) {
    const candidate = `ELITE-${String(seq).padStart(3, '0')}`;
    const exists = await prisma.vehicle.findUnique({ where: { vehicleNumber: candidate } });
    if (!exists) return candidate;
    seq += 1;
  }
}

const VEHICLE_ELITE_INCLUDE = {
  photos: { orderBy: { createdAt: 'asc' as const } },
  owner: { include: { user: true } },
  assignedDriver: { include: { user: true } },
  rides: {
    where: {
      status: { in: [...ACTIVE_RIDE_STATUSES] },
    },
    take: 1,
  },
};

export class EliteCarsService {
  private async checkDriverOnTrip(v: any): Promise<boolean> {
    if (Array.isArray(v.rides) && v.rides.length > 0) return true;

    const driverIds = [v.ownerId, v.assignedDriver?.id].filter(
      (id): id is string => typeof id === 'string' && id.length > 0
    );
    if (driverIds.length === 0) return false;

    const activeDriverRide = await prisma.ride.findFirst({
      where: {
        driverId: { in: driverIds },
        status: { in: [...ACTIVE_RIDE_STATUSES] },
      },
      select: { id: true },
    });
    return Boolean(activeDriverRide);
  }

  private async formatVehicleAsEliteCar(v: any) {
    const isLuxury = v.category === 'LUXURY' || v.vehicleType === 'LUXURY';
    const isOnTrip = await this.checkDriverOnTrip(v);

    let computedStatus: string;
    if (v.status === 'MAINTENANCE') {
      computedStatus = 'MAINTENANCE';
    } else if (isOnTrip) {
      computedStatus = isLuxury ? 'BOOKED' : 'ON_TRIP';
    } else if (v.eliteStatus) {
      computedStatus = v.eliteStatus.toUpperCase();
    } else {
      computedStatus = 'AVAILABLE';
    }

    const photos: Array<{ photoUrl: string; tag: string | null }> = Array.isArray(v.photos) ? v.photos : [];
    const coverEntry = photos.find((p) => p.tag === 'cover') ?? photos[0];
    const mainPhoto = coverEntry?.photoUrl || DEFAULT_COVER_IMAGE;
    const extraGallery = photos.filter((p) => p.tag !== 'cover').map((p) => p.photoUrl);
    const gallery = extraGallery.length > 0 ? extraGallery : [mainPhoto];

    const rating = typeof v.eliteRating === 'number' ? v.eliteRating : isLuxury ? 4.9 : 4.8;
    const pricePerKm = typeof v.pricePerKm === 'number' && v.pricePerKm > 0 ? v.pricePerKm : isLuxury ? 80.0 : 14.0;
    const brand = v.brand || 'Golden';
    const model = v.model || 'Sedan';

    return {
      id: v.id,
      vehicleNumber: v.vehicleNumber,
      brand,
      model,
      carName: model.toLowerCase().startsWith(brand.toLowerCase()) ? model : `${brand} ${model}`,
      rating,
      starCount: String(rating),
      category: formatCategoryLabel(v.category),
      status: computedStatus,
      image: mainPhoto,
      gallery,
      speed: v.speed || (isLuxury ? '250 km/h' : '180 km/h'),
      seats: `${v.seatCapacity || 4} Seats`,
      features: v.features || (isLuxury ? 'Leather Seats, Air Suspension' : 'AC, Music System'),
      price: `₹${Math.round(pricePerKm)}/km`,
      pricePerKm,
      fuelType: formatEnumLabel(v.fuelType, 'Petrol'),
      transmission: formatEnumLabel(v.gearType, isLuxury ? 'Automatic' : 'Manual'),
      vehicleType: formatEnumLabel(v.vehicleType, isLuxury ? 'Luxury' : 'Sedan'),
      acAvailable: v.acAvailable ?? true,
      luggageCapacity: v.luggageCapacity ?? true,
      assignedDriver: v.assignedDriver?.id ?? null,
      driverName: v.assignedDriver?.user?.name ?? null,
      ownerId: v.ownerId ?? null,
      personaType: v.owner?.personaType || (isLuxury ? 'FLEET' : 'RENTAL'),
      createdAt: v.createdAt,
    };
  }

  async getAllCars(brand?: string, status?: string, category?: string) {
    const isBudgetOnly = Boolean(category && category.toLowerCase() === 'budget');
    const isLuxuryOnly = Boolean(category && category.toLowerCase() === 'luxury');

    if (!isBudgetOnly) {
      const luxuryCount = await prisma.vehicle.count({
        where: { OR: [{ category: 'LUXURY' }, { vehicleType: 'LUXURY' }] },
      });
      if (luxuryCount === 0) {
        await this.seedDefaultCars();
      }
    }

    const luxuryCondition = {
      AND: [
        { OR: [{ category: 'LUXURY' as VehicleCategory }, { vehicleType: 'LUXURY' as VehicleType }] },
        { status: { in: ['VERIFIED' as VehicleStatus, 'MAINTENANCE' as VehicleStatus] } },
      ],
    };

    const budgetCondition = {
      AND: [
        { status: 'VERIFIED' as VehicleStatus },
        { NOT: { OR: [{ category: 'LUXURY' as VehicleCategory }, { vehicleType: 'LUXURY' as VehicleType }] } },
        {
          OR: [
            { owner: { personaType: { in: ['RENTAL' as const, 'OWN_VEHICLE' as const] } } },
            { ownerId: { not: null } },
          ],
        },
      ],
    };

    const where: any = isLuxuryOnly
      ? luxuryCondition
      : isBudgetOnly
      ? budgetCondition
      : { OR: [luxuryCondition, budgetCondition] };

    if (brand && brand !== 'All' && brand !== 'All Brands') {
      where.brand = { contains: brand, mode: 'insensitive' };
    }

    const vehicles = await prisma.vehicle.findMany({
      where,
      include: VEHICLE_ELITE_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    const formatted = [];
    for (const v of vehicles) {
      const car = await this.formatVehicleAsEliteCar(v);
      if (status && status !== 'All') {
        const reqStatus = status.toUpperCase();
        const curStatus = car.status.toUpperCase();
        if (reqStatus === 'ON_TRIP' || reqStatus === 'BOOKED') {
          if (curStatus !== 'ON_TRIP' && curStatus !== 'BOOKED') continue;
        } else if (curStatus !== reqStatus) {
          continue;
        }
      }
      formatted.push(car);
    }

    // Keep Luxury cars ordered ahead of Budget partner vehicles when fetching All
    if (!isBudgetOnly && !isLuxuryOnly) {
      formatted.sort((a, b) => {
        const aLux = a.category === 'Luxury' ? 0 : 1;
        const bLux = b.category === 'Luxury' ? 0 : 1;
        return aLux - bLux;
      });
    }

    return formatted;
  }

  async getCarById(id: string) {
    const v = await prisma.vehicle.findFirst({
      where: {
        OR: [{ id }, { sourceEliteCarId: id }],
      },
      include: VEHICLE_ELITE_INCLUDE,
    });

    if (!v) return null;
    return this.formatVehicleAsEliteCar(v);
  }

  async createCar(data: any) {
    const category = mapVehicleCategory(data.category);
    const vehicleType = mapVehicleType(data.vehicleType, category);
    const { vehicleStatus, eliteStatus, isOnline } = parseStatusMapping(data.status);

    const requestedPlate = String(data.vehicleNumber || '').trim().toUpperCase();
    const vehicleNumber = requestedPlate || (await generateUniqueElitePlate());

    const coverUrl = String(data.image || '').trim() || DEFAULT_COVER_IMAGE;
    const rawGallery: string[] = Array.isArray(data.gallery) && data.gallery.length > 0
      ? data.gallery.map((g: unknown) => String(g || '').trim()).filter(Boolean)
      : [coverUrl];

    const created = await prisma.$transaction(async (tx) => {
      const vehicle = await tx.vehicle.create({
        data: {
          vehicleNumber,
          brand: String(data.brand || 'ELITE').trim(),
          model: String(data.model || 'Luxury Model').trim(),
          year: Number(data.year) || new Date().getFullYear(),
          vehicleType,
          category,
          fuelType: mapFuelType(data.fuelType),
          gearType: mapGearType(data.transmission || data.gearType),
          seatCapacity: parseSeatCount(data.seats),
          pricePerKm: data.pricePerKm !== undefined ? Number(data.pricePerKm) || 80.0 : 80.0,
          basePrice: data.basePrice !== undefined ? Number(data.basePrice) || 0.0 : 0.0,
          acAvailable: data.acAvailable ?? true,
          luggageCapacity: data.luggageCapacity ?? true,
          status: vehicleStatus,
          eliteStatus,
          isOnline,
          speed: data.speed || '250 km/h',
          features: data.features || 'Leather Seats, Air Suspension',
          eliteRating: data.rating !== undefined ? Number(data.rating) : 4.9,
          ownerId: data.ownerId || null,
        },
      });

      await tx.vehiclePhoto.create({
        data: { vehicleId: vehicle.id, photoUrl: coverUrl, tag: 'cover' },
      });

      for (const gUrl of rawGallery) {
        await tx.vehiclePhoto.create({
          data: { vehicleId: vehicle.id, photoUrl: gUrl, tag: 'gallery' },
        });
      }

      return vehicle;
    });

    return this.getCarById(created.id);
  }

  async updateCar(id: string, data: any) {
    const existing = await prisma.vehicle.findFirst({
      where: { OR: [{ id }, { sourceEliteCarId: id }] },
    });
    if (!existing) {
      throw new Error('Elite car not found');
    }

    const updatePayload: any = {};
    if (data.brand !== undefined) updatePayload.brand = String(data.brand).trim();
    if (data.model !== undefined) updatePayload.model = String(data.model).trim();
    if (data.vehicleNumber !== undefined && String(data.vehicleNumber).trim().length > 0) {
      updatePayload.vehicleNumber = String(data.vehicleNumber).trim().toUpperCase();
    }
    if (data.category !== undefined) {
      updatePayload.category = mapVehicleCategory(data.category);
    }
    if (data.vehicleType !== undefined) {
      updatePayload.vehicleType = mapVehicleType(data.vehicleType, updatePayload.category ?? existing.category);
    }
    if (data.rating !== undefined) updatePayload.eliteRating = Number(data.rating);
    if (data.speed !== undefined) updatePayload.speed = data.speed;
    if (data.features !== undefined) updatePayload.features = data.features;
    if (data.seats !== undefined) updatePayload.seatCapacity = parseSeatCount(data.seats);
    if (data.pricePerKm !== undefined) updatePayload.pricePerKm = Number(data.pricePerKm);
    if (data.fuelType !== undefined) updatePayload.fuelType = mapFuelType(data.fuelType);
    if (data.transmission !== undefined || data.gearType !== undefined) {
      updatePayload.gearType = mapGearType(data.transmission ?? data.gearType);
    }
    if (data.status !== undefined) {
      const parsed = parseStatusMapping(data.status);
      updatePayload.status = parsed.vehicleStatus;
      updatePayload.eliteStatus = parsed.eliteStatus;
      updatePayload.isOnline = parsed.isOnline;
    }

    const hasPhotoUpdates = data.image !== undefined || Array.isArray(data.gallery);

    await prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id: existing.id },
        data: updatePayload,
      });

      if (hasPhotoUpdates) {
        const existingPhotos = await tx.vehiclePhoto.findMany({
          where: { vehicleId: existing.id },
          orderBy: { createdAt: 'asc' },
        });
        const prevCover = existingPhotos.find((p) => p.tag === 'cover')?.photoUrl ?? existingPhotos[0]?.photoUrl;
        const prevGallery = existingPhotos.filter((p) => p.tag !== 'cover').map((p) => p.photoUrl);

        const nextCover = data.image !== undefined
          ? String(data.image || '').trim() || DEFAULT_COVER_IMAGE
          : prevCover || DEFAULT_COVER_IMAGE;
        const nextGallery = Array.isArray(data.gallery) && data.gallery.length > 0
          ? data.gallery.map((g: unknown) => String(g || '').trim()).filter(Boolean)
          : prevGallery.length > 0
          ? prevGallery
          : [nextCover];

        await tx.vehiclePhoto.deleteMany({ where: { vehicleId: existing.id } });
        await tx.vehiclePhoto.create({
          data: { vehicleId: existing.id, photoUrl: nextCover, tag: 'cover' },
        });
        for (const gUrl of nextGallery) {
          await tx.vehiclePhoto.create({
            data: { vehicleId: existing.id, photoUrl: gUrl, tag: 'gallery' },
          });
        }
      }
    });

    return this.getCarById(existing.id);
  }

  async deleteCar(id: string) {
    const existing = await prisma.vehicle.findFirst({
      where: { OR: [{ id }, { sourceEliteCarId: id }] },
      include: {
        assignedDriver: { select: { id: true } },
        rides: { select: { id: true }, take: 1 },
      },
    });
    if (!existing) {
      throw new Error('Elite car not found');
    }

    if (existing.rides.length > 0) {
      throw new Error('Cannot delete a vehicle with ride history; set status to MAINTENANCE instead');
    }

    await prisma.$transaction(async (tx) => {
      if (existing.assignedDriver?.id) {
        await tx.driverProfile.update({
          where: { id: existing.assignedDriver.id },
          data: { assignedVehicleId: null, isOnline: false, shiftStatus: 'OFF_SHIFT' },
        });
      }
      await tx.vehicle.delete({ where: { id: existing.id } });
    });

    return { id: existing.id, deleted: true };
  }

  private async seedDefaultCars() {
    const defaultCars = [
      {
        vehicleNumber: 'ELITE-001',
        brand: 'FERRARI',
        model: 'Ferrari F8 Tributo',
        rating: 4.9,
        status: 'AVAILABLE',
        category: 'Luxury',
        image: 'assets/images/all_vehicles/Ferrari-4.jpg',
        gallery: [
          'assets/images/all_vehicles/Ferrari-4.jpg',
          'assets/images/all_vehicles/Jaguar-F-1.jpg',
          'assets/images/all_vehicles/Jeep-3.jpg',
        ],
        speed: '340 km/h',
        seats: '2 Seats',
        features: 'Launch Control, Sport Exhaust',
        pricePerKm: 120.0,
        fuelType: 'Petrol',
        transmission: 'Automatic',
      },
      {
        vehicleNumber: 'ELITE-002',
        brand: 'ROLLS ROYCE',
        model: 'Rolls Royce Ghost',
        rating: 4.9,
        status: 'BOOKED',
        category: 'Luxury',
        image: 'assets/images/all_vehicles/Rolls-Royce-3.jpg',
        gallery: [
          'assets/images/all_vehicles/Rolls-Royce-3.jpg',
          'assets/images/all_vehicles/Toyota-Mirai1.jpg',
          'assets/images/all_vehicles/Toyota-Sequoia-4.jpg',
        ],
        speed: '250 km/h',
        seats: '4 Seats',
        features: 'Starlight Headliner, Massage Seats',
        pricePerKm: 150.0,
        fuelType: 'Petrol',
        transmission: 'Automatic',
      },
      {
        vehicleNumber: 'ELITE-003',
        brand: 'BMW',
        model: 'BMW X5 M',
        rating: 4.8,
        status: 'MAINTENANCE',
        category: 'Luxury',
        image: 'assets/images/all_vehicles/BMW-X5_M_4.jpg',
        gallery: [
          'assets/images/all_vehicles/BMW-X5_M_4.jpg',
          'assets/images/all_vehicles/BMW-X3_M_1.jpg',
          'assets/images/all_vehicles/Land_Rover-Defender_1.jpg',
        ],
        speed: '290 km/h',
        seats: '5 Seats',
        features: 'WiFi Available, Panoramic Sunroof',
        pricePerKm: 80.0,
        fuelType: 'Petrol',
        transmission: 'Automatic',
      },
      {
        vehicleNumber: 'ELITE-004',
        brand: 'AUDI',
        model: 'Audi Q7',
        rating: 4.7,
        status: 'AVAILABLE',
        category: 'Luxury',
        image: 'assets/images/all_vehicles/Audi-Q7_1.jpg',
        gallery: [
          'assets/images/all_vehicles/Audi-Q7_1.jpg',
          'assets/images/all_vehicles/Fiat-1.jpg',
          'assets/images/all_vehicles/Kia-1.jpg',
        ],
        speed: '250 km/h',
        seats: '7 Seats',
        features: 'Panoramic Sunroof, 360 Camera',
        pricePerKm: 60.0,
        fuelType: 'Diesel',
        transmission: 'Automatic',
      },
    ];

    for (const car of defaultCars) {
      const exists = await prisma.vehicle.findUnique({ where: { vehicleNumber: car.vehicleNumber } });
      if (!exists) {
        await this.createCar(car);
      }
    }
  }
}

export const eliteCarsService = new EliteCarsService();
