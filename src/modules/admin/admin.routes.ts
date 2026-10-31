import type { FastifyInstance } from 'fastify';
import { adminController } from './admin.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function adminRoutes(app: FastifyInstance) {
  const adminGuard = { preHandler: [requireRoles(['SUPER_ADMIN', 'ADMIN', 'ZONE_ADMIN', 'DISPATCHER'])] };
  const superAdminGuard = { preHandler: [requireRoles(['SUPER_ADMIN', 'ADMIN'])] };

  // Customer Management Endpoints
  app.get('/customers', adminGuard, adminController.getCustomers.bind(adminController));
  app.get('/customers/:id', adminGuard, adminController.getCustomerById.bind(adminController));
  app.get('/customers/:id/rides', adminGuard, adminController.getCustomerRides.bind(adminController));
  app.patch('/customers/:id/status', superAdminGuard, adminController.updateCustomerStatus.bind(adminController));
  app.post('/customers', superAdminGuard, adminController.addCustomer.bind(adminController));

  // Ride Requests Management Endpoints
  app.get('/rides', adminGuard, adminController.getRides.bind(adminController));
  app.get('/rides/:id', adminGuard, adminController.getRideById.bind(adminController));
  app.get('/rides/:id/eligible-drivers', adminGuard, adminController.getEligibleDrivers.bind(adminController));
  app.patch('/rides/:id/assign', adminGuard, adminController.assignRide.bind(adminController));

  // Sub-Admin & Zone Admin Management Endpoints
  app.get('/sub-admins', superAdminGuard, adminController.getSubAdmins.bind(adminController));
  app.post('/sub-admins', superAdminGuard, adminController.createSubAdmin.bind(adminController));
  app.patch('/sub-admins/:id', superAdminGuard, adminController.updateSubAdmin.bind(adminController));
  app.delete('/sub-admins/:id', superAdminGuard, adminController.deleteSubAdmin.bind(adminController));
}
