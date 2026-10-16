import type { FastifyInstance } from 'fastify';
import { couponsController } from './coupons.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function couponsRoutes(app: FastifyInstance) {
  // Public customer browsing of active coupons
  app.get('/', couponsController.listCoupons.bind(couponsController));

  // Customer applies/previews coupon against estimated fare
  app.post('/apply', couponsController.applyCoupon.bind(couponsController));

  // Admin creates new coupon
  app.post(
    '/',
    { preHandler: [requireRoles(['ADMIN', 'DISPATCHER'])] },
    couponsController.createCoupon.bind(couponsController)
  );
}
