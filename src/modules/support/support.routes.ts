import type { FastifyInstance } from 'fastify';
import { supportController } from './support.controller';
import { authenticate, requireRoles } from '../../middlewares/auth.middleware';

export async function supportRoutes(app: FastifyInstance) {
  // User (Customer / Driver) endpoints
  app.post(
    '/tickets',
    { preHandler: [authenticate] },
    supportController.createTicket.bind(supportController)
  );

  app.get(
    '/my-tickets',
    { preHandler: [authenticate] },
    supportController.getMyTickets.bind(supportController)
  );

  // Admin management endpoints
  app.get(
    '/admin/complaints',
    { preHandler: [requireRoles(['ADMIN', 'SUPER_ADMIN', 'ZONE_ADMIN', 'DISPATCHER'])] },
    supportController.getAllComplaints.bind(supportController)
  );

  app.patch(
    '/admin/complaints/:id/status',
    { preHandler: [requireRoles(['ADMIN', 'SUPER_ADMIN', 'ZONE_ADMIN', 'DISPATCHER'])] },
    supportController.updateComplaintStatus.bind(supportController)
  );
}

