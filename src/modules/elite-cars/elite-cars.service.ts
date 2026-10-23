import { prisma } from '../../config/prisma';

export class EliteCarsService {
  async getAllCars(brand?: string, status?: string, category?: string) {
    const count = await prisma.eliteCar.count();
    if (count === 0) {
      await this.seedDefaultCars();
    }

    const where: any = {};
    if (brand && brand !== 'All' && brand !== 'All Brands') {
      where.brand = { contains: brand, mode: 'insensitive' };
    }
    if (status && status !== 'All') {
      where.status = { equals: status, mode: 'insensitive' };
    }
    if (category && category !== 'All') {
      where.category = { equals: category, mode: 'insensitive' };
    }

    return prisma.eliteCar.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getCarById(id: string) {
    return prisma.eliteCar.findUnique({
      where: { id },
    });
  }

  async createCar(data: any) {
    return prisma.eliteCar.create({
      data: {
        brand: data.brand || 'Elite',
        model: data.model || 'Luxury Model',
        category: data.category || 'Luxury',
        rating: data.rating !== undefined ? Number(data.rating) : 4.9,
        status: data.status || 'AVAILABLE',
        image: data.image || 'assets/images/all_vehicles/Ferrari-4.jpg',
        gallery: Array.isArray(data.gallery) && data.gallery.length > 0 ? data.gallery : [data.image || 'assets/images/all_vehicles/Ferrari-4.jpg'],
        speed: data.speed || '250 km/h',
        seats: data.seats ? String(data.seats) : '4 Seats',
        features: data.features || 'Leather Seats, Air Suspension',
        price: data.price || `₹${data.pricePerKm || 50}/km`,
        pricePerKm: data.pricePerKm !== undefined ? Number(data.pricePerKm) : 50.0,
        fuelType: data.fuelType || 'Petrol',
        transmission: data.transmission || 'Automatic',
      },
    });
  }

  async updateCar(id: string, data: any) {
    return prisma.eliteCar.update({
      where: { id },
      data: {
        ...(data.brand !== undefined && { brand: data.brand }),
        ...(data.model !== undefined && { model: data.model }),
        ...(data.category !== undefined && { category: data.category }),
        ...(data.rating !== undefined && { rating: Number(data.rating) }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.image !== undefined && { image: data.image }),
        ...(data.gallery !== undefined && { gallery: Array.isArray(data.gallery) ? data.gallery : [] }),
        ...(data.speed !== undefined && { speed: data.speed }),
        ...(data.seats !== undefined && { seats: String(data.seats) }),
        ...(data.features !== undefined && { features: data.features }),
        ...(data.price !== undefined && { price: data.price }),
        ...(data.pricePerKm !== undefined && { pricePerKm: Number(data.pricePerKm) }),
        ...(data.fuelType !== undefined && { fuelType: data.fuelType }),
        ...(data.transmission !== undefined && { transmission: data.transmission }),
      },
    });
  }

  async deleteCar(id: string) {
    return prisma.eliteCar.delete({
      where: { id },
    });
  }

  private async seedDefaultCars() {
    const defaultCars = [
      {
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
        price: '₹120/km',
        pricePerKm: 120.0,
        fuelType: 'Petrol',
        transmission: 'Automatic',
      },
      {
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
        price: '₹150/km',
        pricePerKm: 150.0,
        fuelType: 'Petrol',
        transmission: 'Automatic',
      },
      {
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
        price: '₹80/km',
        pricePerKm: 80.0,
        fuelType: 'Petrol',
        transmission: 'Automatic',
      },
      {
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
        price: '₹60/km',
        pricePerKm: 60.0,
        fuelType: 'Diesel',
        transmission: 'Automatic',
      },
    ];

    for (const car of defaultCars) {
      await prisma.eliteCar.create({ data: car });
    }
  }
}

export const eliteCarsService = new EliteCarsService();
