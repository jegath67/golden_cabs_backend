import { prisma } from '../../config/prisma';

export interface CreateReviewInput {
  rating: number;
  comment?: string;
  tags?: string[];
  cleanliness?: string;
  punctuality?: string;
}

export interface AdminReviewFilters {
  rating?: number;
  search?: string;
  driverId?: string;
  limit?: number;
  page?: number;
}

export class ReviewsService {
  /**
   * Customer submits a review for a completed ride.
   * Atomically saves review and recalculates driver's average rating.
   */
  async createReview(customerId: string, rideId: string, input: CreateReviewInput) {
    const { rating, comment, tags = [], cleanliness, punctuality } = input;

    if (!rating || rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }

    const ride = await prisma.ride.findUnique({
      where: { id: rideId },
      include: { driver: true },
    });

    if (!ride) {
      throw new Error('Ride not found');
    }

    if (ride.customerId !== customerId) {
      // Also allow if in dev mode
      const user = await prisma.user.findUnique({ where: { id: customerId } });
      if (user && user.role !== 'CUSTOMER' && user.role !== 'ADMIN') {
        throw new Error('You are not authorized to review this ride');
      }
    }

    if (!ride.driverId) {
      throw new Error('No driver assigned to this ride to review');
    }

    const review = await prisma.$transaction(async (tx) => {
      // Upsert review in case customer updates their review
      const rev = await tx.review.upsert({
        where: { rideId },
        update: {
          rating: Number(rating),
          comment: comment || null,
          tags: tags || [],
          cleanliness: cleanliness || null,
          punctuality: punctuality || null,
        },
        create: {
          rideId,
          customerId: ride.customerId,
          driverId: ride.driverId!,
          rating: Number(rating),
          comment: comment || null,
          tags: tags || [],
          cleanliness: cleanliness || null,
          punctuality: punctuality || null,
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          driver: {
            include: {
              user: { select: { id: true, name: true, phone: true } },
              assignedVehicle: true,
            },
          },
        },
      });

      // Recalculate average rating for the driver
      const agg = await tx.review.aggregate({
        where: { driverId: ride.driverId! },
        _avg: { rating: true },
        _count: { rating: true },
      });

      if (agg._avg.rating !== null) {
        const newAvg = Math.round(agg._avg.rating * 10) / 10;
        await tx.driverProfile.update({
          where: { id: ride.driverId! },
          data: { rating: newAvg },
        });
      }

      return rev;
    });

    return review;
  }

  /**
   * Get review for a specific ride
   */
  async getReviewByRideId(rideId: string) {
    return prisma.review.findUnique({
      where: { rideId },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        driver: {
          include: {
            user: { select: { name: true, phone: true } },
            assignedVehicle: true,
          },
        },
      },
    });
  }

  /**
   * Admin dashboard: List all reviews with filtering and summary metrics
   */
  async getAdminReviews(filters: AdminReviewFilters = {}) {
    const { rating, search, driverId, limit = 50, page = 1 } = filters;
    const skip = (page - 1) * limit;

    const where: any = {};

    if (rating && rating >= 1 && rating <= 5) {
      where.rating = {
        gte: rating,
        lt: rating + 1,
      };
    }

    if (driverId) {
      where.driverId = driverId;
    }

    if (search && search.trim().length > 0) {
      const q = search.trim();
      where.OR = [
        { comment: { contains: q, mode: 'insensitive' } },
        { customer: { name: { contains: q, mode: 'insensitive' } } },
        { customer: { phone: { contains: q } } },
        { driver: { user: { name: { contains: q, mode: 'insensitive' } } } },
        { ride: { bookingCode: { contains: q, mode: 'insensitive' } } },
      ];
    }

    const [reviews, totalCount, aggregate] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          driver: {
            include: {
              user: { select: { id: true, name: true, phone: true } },
              assignedVehicle: true,
            },
          },
          ride: {
            select: {
              id: true,
              bookingCode: true,
              pickupLocation: true,
              dropLocation: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.review.count({ where }),
      prisma.review.aggregate({
        _avg: { rating: true },
        _count: { rating: true },
      }),
    ]);

    // Star distributions
    const starCounts = await Promise.all([
      prisma.review.count({ where: { rating: { gte: 5 } } }),
      prisma.review.count({ where: { rating: { gte: 4, lt: 5 } } }),
      prisma.review.count({ where: { rating: { gte: 3, lt: 4 } } }),
      prisma.review.count({ where: { rating: { gte: 2, lt: 3 } } }),
      prisma.review.count({ where: { rating: { gte: 1, lt: 2 } } }),
    ]);

    // Format for Admin Dashboard Reviews Table
    const formatted = reviews.map((r) => {
      const dateStr = r.createdAt
        ? r.createdAt.toISOString().replace('T', ' ').substring(0, 16)
        : '';

      return {
        id: r.id,
        tripId: r.ride?.bookingCode || r.rideId,
        customerName: r.customer?.name || 'Customer',
        customerId: r.customerId,
        customerPhone: r.customer?.phone || '',
        customerAvatar: (r.customer?.name || 'C').substring(0, 1).toUpperCase(),
        driverName: r.driver?.user?.name || 'Driver',
        driverId: r.driver?.assignedVehicle?.vehicleNumber || r.driverId,
        driverAvatar: (r.driver?.user?.name || 'D').substring(0, 1).toUpperCase(),
        rating: r.rating,
        reviewText: r.comment || (r.tags && r.tags.length > 0 ? r.tags.join(', ') : 'No written feedback'),
        tags: r.tags || [],
        cleanliness: r.cleanliness || 'Good',
        punctuality: r.punctuality || 'On Time',
        date: dateStr,
        status: 'Active',
      };
    });

    return {
      reviews: formatted,
      totalCount,
      summary: {
        totalReviews: aggregate._count.rating || 0,
        averageRating: aggregate._avg.rating ? Math.round(aggregate._avg.rating * 10) / 10 : 5.0,
        fiveStars: starCounts[0],
        fourStars: starCounts[1],
        threeStars: starCounts[2],
        twoStars: starCounts[3],
        oneStar: starCounts[4],
      },
    };
  }

  /**
   * Driver's own reviews & rating breakdown
   */
  async getDriverReviews(driverId: string) {
    const [reviews, aggregate] = await Promise.all([
      prisma.review.findMany({
        where: { driverId },
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: {
          customer: { select: { name: true } },
        },
      }),
      prisma.review.aggregate({
        where: { driverId },
        _avg: { rating: true },
        _count: { rating: true },
      }),
    ]);

    return {
      averageRating: aggregate._avg.rating ? Math.round(aggregate._avg.rating * 10) / 10 : 5.0,
      totalReviews: aggregate._count.rating || 0,
      reviews: reviews.map((r) => ({
        id: r.id,
        customerName: r.customer?.name || 'Customer',
        rating: r.rating,
        comment: r.comment || '',
        tags: r.tags,
        date: r.createdAt.toISOString(),
      })),
    };
  }
}

export const reviewsService = new ReviewsService();
