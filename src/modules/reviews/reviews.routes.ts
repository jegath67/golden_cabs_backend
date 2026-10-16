import type { FastifyInstance } from 'fastify';
import { reviewsController } from './reviews.controller';
import { authenticate, requireRoles } from '../../middlewares/auth.middleware';

export async function reviewsRoutes(app: FastifyInstance) {
  // Customer submits review for a ride
  app.post(
    '/rides/:id/review',
    { preHandler: [authenticate] },
    reviewsController.createReview.bind(reviewsController)
  );

  // Get review for a specific ride
  app.get(
    '/rides/:id/review',
    reviewsController.getReview.bind(reviewsController)
  );

  // Admin lists all reviews with search, filter, and metrics
  app.get(
    '/admin/reviews',
    reviewsController.getAdminReviews.bind(reviewsController)
  );

  // Driver/partner queries driver reviews
  app.get(
    '/drivers/:driverId/reviews',
    reviewsController.getDriverReviews.bind(reviewsController)
  );
}
