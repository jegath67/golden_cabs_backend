import { prisma } from '../../config/prisma';

export class ExploreService {
  async getAllPlaces(category?: string, status?: string, search?: string) {
    const count = await prisma.explorePlace.count();
    if (count === 0) {
      await this.seedDefaultPlaces();
    }

    const where: any = {};
    if (category && category !== 'All') {
      where.category = { equals: category, mode: 'insensitive' };
    }
    if (status && status !== 'All') {
      where.status = { equals: status, mode: 'insensitive' };
    }
    if (search && search.trim()) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { location: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ];
    }

    return prisma.explorePlace.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPlaceById(id: string) {
    return prisma.explorePlace.findUnique({
      where: { id },
    });
  }

  async createPlace(data: any) {
    return prisma.explorePlace.create({
      data: {
        name: data.name,
        category: data.category || 'Restaurants',
        subCategory: data.subCategory || data.category || 'Special',
        location: data.location || 'Chennai',
        address: data.address || '',
        phone: data.phone || '+91 9876543210',
        imageUrl: data.imageUrl || '',
        image: data.image || '🍛',
        offers: data.offers || '',
        offerExpiry: data.offerExpiry || '',
        rating: data.rating !== undefined ? Number(data.rating) : 4.5,
        reviewsCount: data.reviewsCount !== undefined ? Number(data.reviewsCount) : 120,
        openTime: data.openTime || '07:00 AM',
        closeTime: data.closeTime || '11:00 PM',
        distance: data.distance || '2.5 km',
        avgCost: data.avgCost || '₹500 for two',
        status: data.status || 'Active',
        gallery: Array.isArray(data.gallery) ? data.gallery : [],
      },
    });
  }

  async updatePlace(id: string, data: any) {
    return prisma.explorePlace.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.category !== undefined && { category: data.category }),
        ...(data.subCategory !== undefined && { subCategory: data.subCategory }),
        ...(data.location !== undefined && { location: data.location }),
        ...(data.address !== undefined && { address: data.address }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.imageUrl !== undefined && { imageUrl: data.imageUrl }),
        ...(data.image !== undefined && { image: data.image }),
        ...(data.offers !== undefined && { offers: data.offers }),
        ...(data.offerExpiry !== undefined && { offerExpiry: data.offerExpiry }),
        ...(data.rating !== undefined && { rating: Number(data.rating) }),
        ...(data.reviewsCount !== undefined && { reviewsCount: Number(data.reviewsCount) }),
        ...(data.openTime !== undefined && { openTime: data.openTime }),
        ...(data.closeTime !== undefined && { closeTime: data.closeTime }),
        ...(data.distance !== undefined && { distance: data.distance }),
        ...(data.avgCost !== undefined && { avgCost: data.avgCost }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.gallery !== undefined && { gallery: Array.isArray(data.gallery) ? data.gallery : [] }),
      },
    });
  }

  async deletePlace(id: string) {
    return prisma.explorePlace.delete({
      where: { id },
    });
  }

  private async seedDefaultPlaces() {
    const defaultPlaces = [
      {
        name: 'Saravana Bhavan',
        category: 'Restaurants',
        subCategory: 'South Indian',
        location: 'Anna Nagar, Chennai',
        address: '123, Anna Nagar Main Road, Chennai - 600040',
        phone: '+91 9876543210',
        image: '🍛',
        imageUrl: 'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=600&auto=format&fit=crop&q=80',
        offers: '20% off on weekdays',
        offerExpiry: '30 Sep 2026, 11:59 PM',
        rating: 4.5,
        reviewsCount: 320,
        openTime: '7:00 AM',
        closeTime: '11:00 PM',
        distance: '2.5 km',
        avgCost: '₹400 for two',
        status: 'Active',
        gallery: [
          'https://images.unsplash.com/photo-1589301760014-d929f3979dbc?w=600&auto=format&fit=crop&q=80',
          'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80'
        ],
      },
      {
        name: 'Buhari Hotel',
        category: 'Restaurants',
        subCategory: 'Multi Cuisine',
        location: 'T Nagar, Chennai',
        address: '456, Usman Road, T Nagar, Chennai - 600017',
        phone: '+91 8765432109',
        image: '🥘',
        imageUrl: 'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80',
        offers: 'Buy 1 Get 1 on Biriyani',
        offerExpiry: '15 Oct 2026, 10:00 PM',
        rating: 4.8,
        reviewsCount: 540,
        openTime: '11:00 AM',
        closeTime: '11:00 PM',
        distance: '3.2 km',
        avgCost: '₹600 for two',
        status: 'Active',
        gallery: [
          'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80',
          'https://images.unsplash.com/photo-1633945274405-b6c8069047b0?w=600&auto=format&fit=crop&q=80'
        ],
      },
      {
        name: 'Nalli Silks',
        category: 'Textiles',
        subCategory: 'Silk Sarees',
        location: 'Pondy Bazaar, Chennai',
        address: '789, Pondy Bazaar, T Nagar, Chennai - 600017',
        phone: '+91 7654321098',
        image: '👘',
        imageUrl: 'https://images.unsplash.com/photo-1610030469983-98e550d6193c?w=600&auto=format&fit=crop&q=80',
        offers: 'Flat 30% off on wedding collection',
        offerExpiry: '25 Oct 2026, 09:00 PM',
        rating: 4.7,
        reviewsCount: 420,
        openTime: '9:00 AM',
        closeTime: '9:00 PM',
        distance: '1.8 km',
        avgCost: '₹2000 - ₹50000',
        status: 'Active',
        gallery: [
          'https://images.unsplash.com/photo-1610030469983-98e550d6193c?w=600&auto=format&fit=crop&q=80'
        ],
      },
      {
        name: 'Starbucks Coffee',
        category: 'Cafe',
        subCategory: 'Coffee Shop',
        location: 'Phoenix Mall, Chennai',
        address: '142, Velachery Main Road, Chennai - 600042',
        phone: '+91 5432109876',
        image: '☕',
        imageUrl: 'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=600&auto=format&fit=crop&q=80',
        offers: 'Free pastry with large coffee',
        offerExpiry: '31 Oct 2026, 11:00 PM',
        rating: 4.4,
        reviewsCount: 680,
        openTime: '8:00 AM',
        closeTime: '11:00 PM',
        distance: '5.3 km',
        avgCost: '₹700 for two',
        status: 'Active',
        gallery: [
          'https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?w=600&auto=format&fit=crop&q=80'
        ],
      },
      {
        name: '10 Downing Street',
        category: 'Pubs & Bars',
        subCategory: 'Pub & Bar',
        location: 'Nungambakkam, Chennai',
        address: '88, Dr. Natesan Road, Nungambakkam, Chennai - 600034',
        phone: '+91 3210987654',
        image: '🍺',
        imageUrl: 'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=600&auto=format&fit=crop&q=80',
        offers: 'Happy hours 5-7 PM - 50% off',
        offerExpiry: '20 Oct 2026, 07:00 PM',
        rating: 4.6,
        reviewsCount: 390,
        openTime: '5:00 PM',
        closeTime: '1:00 AM',
        distance: '3.7 km',
        avgCost: '₹1500 for two',
        status: 'Active',
        gallery: [
          'https://images.unsplash.com/photo-1514933651103-005eec06c04b?w=600&auto=format&fit=crop&q=80'
        ],
      },
    ];

    for (const place of defaultPlaces) {
      await prisma.explorePlace.create({ data: place });
    }
  }
}

export const exploreService = new ExploreService();
