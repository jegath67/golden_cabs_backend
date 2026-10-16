import type { FastifyReply, FastifyRequest } from 'fastify';
import { reviewsService, type CreateReviewInput } from './reviews.service';

export class ReviewsController {
  async createReview(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const { id } = req.params as { id: string }; // rideId
    const body = req.body as CreateReviewInput;

    try {
      const review = await reviewsService.createReview(user.id, id, body);
      return reply.send({
        success: true,
        message: 'Review submitted successfully',
        data: review,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        message: error.message || 'Failed to submit review',
      });
    }
  }

  async getReview(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string }; // rideId
    try {
      const review = await reviewsService.getReviewByRideId(id);
      return reply.send({
        success: true,
        data: review,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to get review',
      });
    }
  }

  async getAdminReviews(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const query = (req.query as any) || {};
      const rating = query.rating ? parseInt(query.rating, 10) : undefined;
      const search = query.search || undefined;
      const driverId = query.driverId || undefined;
      const limit = query.limit ? parseInt(query.limit, 10) : 50;
      const page = query.page ? parseInt(query.page, 10) : 1;

      const result = await reviewsService.getAdminReviews({
        rating,
        search,
        driverId,
        limit,
        page,
      });

      return reply.send({
        success: true,
        data: result.reviews,
        total: result.totalCount,
        summary: result.summary,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch reviews',
      });
    }
  }

  async getDriverReviews(req: FastifyRequest<any>, reply: FastifyReply) {
    const { driverId } = req.params as { driverId: string };
    try {
      const result = await reviewsService.getDriverReviews(driverId);
      return reply.send({
        success: true,
        data: result,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch driver reviews',
      });
    }
  }
}

export const reviewsController = new ReviewsController();
