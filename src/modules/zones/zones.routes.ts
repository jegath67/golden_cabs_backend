import type { FastifyInstance } from 'fastify';
import { zonesController } from './zones.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function zonesRoutes(app: FastifyInstance) {
  // Public or Authenticated Read
  app.get('/', zonesController.getAllZones.bind(zonesController));
  app.get('/:id', zonesController.getZoneById.bind(zonesController));

  // Admin & Super Admin Management
  app.post(
    '/',
    { preHandler: [requireRoles(['SUPER_ADMIN', 'ADMIN'])] },
    zonesController.createZone.bind(zonesController)
  );

  app.patch(
    '/:id',
    { preHandler: [requireRoles(['SUPER_ADMIN', 'ADMIN'])] },
    zonesController.updateZone.bind(zonesController)
  );

  app.delete(
    '/:id',
    { preHandler: [requireRoles(['SUPER_ADMIN'])] },
    zonesController.deleteZone.bind(zonesController)
  );
}
