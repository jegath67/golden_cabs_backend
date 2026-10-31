import type { FastifyInstance } from 'fastify';
import { driversController } from './drivers.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function driversRoutes(app: FastifyInstance) {
  // Driver protected routes
  app.get(
    '/me',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.getMyProfile.bind(driversController)
  );

  app.put(
    '/kyc',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.updateKyc.bind(driversController)
  );

  app.patch(
    '/profile',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.updateProfile.bind(driversController)
  );

  app.get(
    '/reports',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.getReports.bind(driversController)
  );

  app.post(
    '/reports',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.createReport.bind(driversController)
  );

  app.post(
    '/shift',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.toggleShift.bind(driversController)
  );

  app.post(
    '/location',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.updateLocation.bind(driversController)
  );

  app.post(
    '/hub',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.selectHub.bind(driversController)
  );

  app.post(
    '/request-vehicle',
    { preHandler: [requireRoles(['DRIVER'])] },
    driversController.requestVehicle.bind(driversController)
  );

  // Admin routes
  app.get(
    '/',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    driversController.getAllDrivers.bind(driversController)
  );

  app.get(
    '/vehicle-requests',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    driversController.getVehicleRequests.bind(driversController)
  );

  app.patch(
    '/vehicle-requests/:id/cancel',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    driversController.cancelVehicleRequest.bind(driversController)
  );

  app.patch(
    '/:id/verify',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    driversController.verifyDriver.bind(driversController)
  );

  app.patch(
    '/:id/status',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    driversController.updateStatus.bind(driversController)
  );
}
