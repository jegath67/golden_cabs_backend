import type { FastifyInstance } from 'fastify';
import { hubsController } from './hubs.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function hubsRoutes(app: FastifyInstance) {
  app.get('/', hubsController.getAllHubs.bind(hubsController));
  app.get('/nearest', hubsController.getNearestHub.bind(hubsController));
  app.get('/:id', hubsController.getHubById.bind(hubsController));

  // Admin only
  app.post(
    '/',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    hubsController.createHub.bind(hubsController)
  );
}
