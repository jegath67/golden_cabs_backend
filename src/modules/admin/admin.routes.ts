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

  // Driver Payouts Management Endpoints
  app.get('/payouts', adminGuard, adminController.getPayouts.bind(adminController));
  app.patch('/payouts/:id/status', superAdminGuard, adminController.updatePayoutStatus.bind(adminController));
  app.get('/settlements/overview', adminGuard, adminController.getSettlementsOverview.bind(adminController));

  // Platform Commission Settings Endpoints
  app.get('/settings/commission', adminGuard, adminController.getCommissionSettings.bind(adminController));
  app.patch('/settings/commission', superAdminGuard, adminController.updateCommissionSettings.bind(adminController));

  // Payment Overview & Transactions Endpoints
  app.get('/payments', adminGuard, adminController.getPayments.bind(adminController));

  // Live Map Tracking Endpoint
  app.get('/live-map', adminGuard, adminController.getLiveMapData.bind(adminController));
}
