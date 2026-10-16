import type { FastifyInstance } from 'fastify';
import { adminController } from './admin.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function adminRoutes(app: FastifyInstance) {
  const adminGuard = { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] };

  // Customer Management Endpoints
  app.get('/customers', adminGuard, adminController.getCustomers.bind(adminController));
  app.get('/customers/:id', adminGuard, adminController.getCustomerById.bind(adminController));
  app.patch('/customers/:id/status', adminGuard, adminController.updateCustomerStatus.bind(adminController));
  app.post('/customers', adminGuard, adminController.addCustomer.bind(adminController));

  // Ride Requests Management Endpoints
  app.get('/rides', adminGuard, adminController.getRides.bind(adminController));
  app.get('/rides/:id', adminGuard, adminController.getRideById.bind(adminController));
  app.patch('/rides/:id/assign', adminGuard, adminController.assignRide.bind(adminController));
}
