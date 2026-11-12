import type { FastifyInstance } from 'fastify';
import { paymentsController } from './payments.controller';
import { authenticate, requireRoles } from '../../middlewares/auth.middleware';

export async function paymentsRoutes(app: FastifyInstance) {
  // Preserve exact raw JSON string on payment routes for strict Razorpay HMAC webhook signature checks
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      (req as any).rawBody = body;
      const trimmed = typeof body === 'string' ? body.trim() : '';
      done(null, trimmed ? JSON.parse(trimmed) : {});
    } catch (err: any) {
      done(err, undefined);
    }
  });

  app.get('/gateway-status', paymentsController.getGatewayStatus.bind(paymentsController));

  app.post(
    '/razorpay/order',
    { preHandler: [requireRoles(['CUSTOMER'])] },
    paymentsController.createRazorpayOrder.bind(paymentsController)
  );

  app.post(
    '/razorpay/verify',
    { preHandler: [requireRoles(['CUSTOMER'])] },
    paymentsController.verifyRazorpayPayment.bind(paymentsController)
  );

  app.get(
    '/ride/:rideId/status',
    { preHandler: [authenticate] },
    paymentsController.getRidePaymentStatus.bind(paymentsController)
  );

  app.post(
    '/razorpay/webhook',
    paymentsController.handleRazorpayWebhook.bind(paymentsController)
  );
}
