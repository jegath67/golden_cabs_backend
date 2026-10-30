import type { FastifyInstance } from 'fastify';
import { vehiclesController } from './vehicles.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function vehiclesRoutes(app: FastifyInstance) {
  // Public or Authenticated browse
  app.get('/', vehiclesController.getAllVehicles.bind(vehiclesController));
  app.get('/:id', vehiclesController.getVehicleById.bind(vehiclesController));
  app.get('/:id/photos', vehiclesController.getPhotos.bind(vehiclesController));

  // Upload or attach photo to existing vehicle
  app.post(
    '/:id/photos',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN', 'DISPATCHER'])] },
    vehiclesController.addPhoto.bind(vehiclesController)
  );

  // Partner or Admin register vehicle
  app.post(
    '/',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN', 'DISPATCHER'])] },
    vehiclesController.createVehicle.bind(vehiclesController)
  );

  // Admin status update & driver assignment
  app.patch(
    '/:id/status',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    vehiclesController.updateStatus.bind(vehiclesController)
  );

  app.patch(
    '/:id/assign-driver',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    vehiclesController.assignDriver.bind(vehiclesController)
  );

  // Partner or Admin toggle vehicle online availability
  app.patch(
    '/:id/availability',
    { preHandler: [requireRoles(['DRIVER', 'ADMIN', 'DISPATCHER'])] },
    vehiclesController.toggleAvailability.bind(vehiclesController)
  );
}
