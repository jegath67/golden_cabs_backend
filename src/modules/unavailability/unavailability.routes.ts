import type { FastifyInstance } from 'fastify';
import { unavailabilityController } from './unavailability.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function unavailabilityRoutes(app: FastifyInstance) {
  // Driver unavailability endpoints (Protected)
  app.post(
    '/drivers/unavailability',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN'])] },
    unavailabilityController.saveDriverSchedule.bind(unavailabilityController)
  );

  app.get(
    '/drivers/unavailability',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN'])] },
    unavailabilityController.getDriverSchedule.bind(unavailabilityController)
  );

  app.delete(
    '/drivers/unavailability/:date',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN'])] },
    unavailabilityController.removeDriverDate.bind(unavailabilityController)
  );

  // Vehicle-specific endpoints
  app.get(
    '/vehicles/:id/unavailability',
    unavailabilityController.getVehicleSchedule.bind(unavailabilityController)
  );

  app.post(
    '/vehicles/:id/unavailability',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN', 'DISPATCHER'])] },
    unavailabilityController.saveVehicleSchedule.bind(unavailabilityController)
  );
}

