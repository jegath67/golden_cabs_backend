import { prisma } from '../../config/prisma';

export class BannersService {
  async getAllBanners(target?: string, status?: string) {
    const count = await prisma.promoBanner.count();
    if (count === 0) {
      await this.seedDefaultBanners();
    }

    const where: any = {};
    if (target && target !== 'All') {
      const lower = target.toLowerCase();
      if (lower.includes('driver')) {
        where.OR = [
          { target: { contains: 'driver', mode: 'insensitive' } },
          { target: { equals: 'Both', mode: 'insensitive' } },
          { target: { equals: 'All', mode: 'insensitive' } },
        ];
      } else if (lower.includes('user') || lower.includes('customer')) {
        where.OR = [
          { target: { contains: 'user', mode: 'insensitive' } },
          { target: { contains: 'customer', mode: 'insensitive' } },
          { target: { equals: 'Both', mode: 'insensitive' } },
          { target: { equals: 'All', mode: 'insensitive' } },
        ];
      } else {
        where.OR = [
          { target: { equals: target, mode: 'insensitive' } },
          { target: { equals: 'Both', mode: 'insensitive' } },
          { target: { equals: 'All', mode: 'insensitive' } },
        ];
      }
    }
    if (status && status !== 'All') {
      where.status = { equals: status, mode: 'insensitive' };
    }

    return prisma.promoBanner.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getBannerById(id: string) {
    return prisma.promoBanner.findUnique({
      where: { id },
    });
  }

  async createBanner(data: any) {
    return prisma.promoBanner.create({
      data: {
        title: data.title,
        description: data.description || '',
        imageUrl: data.imageUrl || 'assets/images/banners/banner1.jpg',
        target: data.target || 'User App',
        status: data.status || 'Active',
        startDate: data.startDate || new Date().toISOString().split('T')[0],
        endDate: data.endDate || '',
        priority: data.priority || 'High',
        campaignType: data.campaignType || 'Promotional Offer',
      },
    });
  }

  async updateBanner(id: string, data: any) {
    return prisma.promoBanner.update({
      where: { id },
      data: {
        ...(data.title !== undefined && { title: data.title }),
        ...(data.description !== undefined && { description: data.description }),
        ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
        ...(data.target !== undefined && { target: data.target }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.startDate !== undefined && { startDate: data.startDate }),
        ...(data.endDate !== undefined && { endDate: data.endDate }),
        ...(data.priority !== undefined && { priority: data.priority }),
        ...(data.campaignType !== undefined && { campaignType: data.campaignType }),
      },
    });
  }

  async deleteBanner(id: string) {
    return prisma.promoBanner.delete({
      where: { id },
    });
  }

  private async seedDefaultBanners() {
    const defaultBanners = [
      {
        title: 'New Year Special Offer',
        description: 'Get 50% off on your first ride',
        imageUrl: 'assets/images/banners/banner1.jpg',
        target: 'User App',
        status: 'Active',
        startDate: '2024-01-01',
        endDate: '2026-12-31',
        priority: 'High',
        campaignType: 'Promotional Offer',
      },
      {
        title: 'Weekend Getaway Deal',
        description: 'Flat ₹500 off on outstation weekend bookings',
        imageUrl: 'assets/images/banners/banner2.jpg',
        target: 'User App',
        status: 'Active',
        startDate: '2024-01-15',
        endDate: '2026-12-31',
        priority: 'Medium',
        campaignType: 'Promotional Offer',
      },
      {
        title: 'Summer Luxury Campaign',
        description: 'Beat the heat with our cool AC rides',
        imageUrl: 'assets/images/banners/banner3.jpg',
        target: 'User App',
        status: 'Active',
        startDate: '2024-06-01',
        endDate: '2026-12-31',
        priority: 'High',
        campaignType: 'Seasonal Campaign',
      },
    ];

    for (const bnr of defaultBanners) {
      await prisma.promoBanner.create({ data: bnr });
    }
  }
}

export const bannersService = new BannersService();
