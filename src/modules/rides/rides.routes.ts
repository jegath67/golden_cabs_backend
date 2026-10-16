import type { FastifyInstance } from 'fastify';
import { ridesController } from './rides.controller';
import { authenticate, requireRoles } from '../../middlewares/auth.middleware';

export async function ridesRoutes(app: FastifyInstance) {
  // Public fare estimate
  app.post('/estimate', ridesController.estimateFare.bind(ridesController));

  // Customer creates a ride request
  app.post(
    '/request',
    { preHandler: [requireRoles(['CUSTOMER'])] },
    ridesController.requestRide.bind(ridesController)
  );

  // Drivers query available ride requests
  app.get(
    '/available',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN'])] },
    ridesController.getAvailableRides.bind(ridesController)
  );

  // Driver accepts a ride
  app.post(
    '/:id/accept',
    { preHandler: [requireRoles(['DRIVER'])] },
    ridesController.acceptRide.bind(ridesController)
  );

  // Status updates: en_route, arrived, cancelled
  app.patch(
    '/:id/status',
    { preHandler: [authenticate] },
    ridesController.updateStatus.bind(ridesController)
  );

  // Driver starts ride with OTP
  app.post(
    '/:id/start',
    { preHandler: [requireRoles(['DRIVER'])] },
    ridesController.startRide.bind(ridesController)
  );

  // Driver completes ride
  app.post(
    '/:id/complete',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN'])] },
    ridesController.completeRide.bind(ridesController)
  );

  // Trip history for logged-in user
  app.get(
    '/my-rides',
    { preHandler: [authenticate] },
    ridesController.getMyRides.bind(ridesController)
  );

  // Get specific ride details
  app.get(
    '/:id',
    { preHandler: [authenticate] },
    ridesController.getRideDetails.bind(ridesController)
  );
}
