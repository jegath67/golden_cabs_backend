import type { FastifyInstance } from 'fastify';
import { refundsController } from './refunds.controller';
import { authenticate, requireRoles } from '../../middlewares/auth.middleware';

export async function refundsRoutes(app: FastifyInstance) {
  // Customer submits refund request for their ride
  app.post(
    '/request',
    { preHandler: [requireRoles(['CUSTOMER'])] },
    refundsController.submitRefundRequest.bind(refundsController)
  );

  // Get refund details by rideId (Accessible by Customer who owns it or Admin)
  app.get(
    '/ride/:rideId',
    { preHandler: [authenticate] },
    refundsController.getRefundByRide.bind(refundsController)
  );

  // Admin lists all refund requests
  app.get(
    '/',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    refundsController.listRefunds.bind(refundsController)
  );

  // Admin transitions refund status (Under Review / Approved / Rejected / Refunded)
  app.patch(
    '/:id/status',
    { preHandler: [requireRoles(['ADMIN'])] },
    refundsController.updateRefundStatus.bind(refundsController)
  );
}
