import type { FastifyReply, FastifyRequest } from 'fastify';
import { paymentsService } from './payments.service';

export class PaymentsController {
  async getGatewayStatus(_req: FastifyRequest, reply: FastifyReply) {
    return reply.send({
      success: true,
      data: paymentsService.getGatewayStatus(),
    });
  }

  /**
   * Creates or reuses an authoritative Razorpay order for a customer ride.
   * Never trusts client-provided fare amounts; always calculates from DB ride/fareBreakdown.
   */
  async createRazorpayOrder(req: FastifyRequest, reply: FastifyReply) {
    try {
      const user = req.user as { id: string; role: string };
      const { rideId, paymentMethod } = (req.body as any) || {};
      if (!rideId) {
        return reply.status(400).send({
          success: false,
          message: 'rideId is required',
        });
      }

      const rawMethod = String(paymentMethod || 'UPI').trim().toUpperCase();
      const normalizedMethod: 'UPI' | 'CARD' | 'WALLET' =
        rawMethod === 'CARD' ? 'CARD' : rawMethod === 'WALLET' ? 'WALLET' : 'UPI';

      const data = await paymentsService.createRazorpayOrder({
        customerId: user.id,
        rideIdentifier: String(rideId),
        paymentMethod: normalizedMethod,
      });

      return reply.send({
        success: true,
        data,
      });
    } catch (error: any) {
      const status = error?.statusCode || 400;
      return reply.status(status).send({
        success: false,
        blocked: Boolean(error?.blocked),
        message: error.message || 'Failed to create Razorpay order',
      });
    }
  }

  /**
   * Server-side Razorpay payment callback signature verifier.
   * Requires RAZORPAY_KEY_SECRET in server environment; never trusts unverified client callbacks.
   */
  async verifyRazorpayPayment(req: FastifyRequest, reply: FastifyReply) {
    try {
      const user = req.user as { id: string; role: string };
      const { rideId, razorpayOrderId, razorpayPaymentId, razorpaySignature, paymentMethod } =
        (req.body as any) || {};

      if (!rideId || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return reply.status(400).send({
          success: false,
          message: 'rideId, razorpayOrderId, razorpayPaymentId, and razorpaySignature are required',
        });
      }

      const rawMethod = String(paymentMethod || 'UPI').trim().toUpperCase();
      const normalizedMethod: 'UPI' | 'CARD' | 'WALLET' =
        rawMethod === 'CARD' ? 'CARD' : rawMethod === 'WALLET' ? 'WALLET' : 'UPI';

      const result = await paymentsService.verifyClientRazorpayPayment({
        customerId: user.id,
        rideIdentifier: String(rideId),
        razorpayOrderId: String(razorpayOrderId),
        razorpayPaymentId: String(razorpayPaymentId),
        razorpaySignature: String(razorpaySignature),
        paymentMethod: normalizedMethod,
      });

      return reply.send({
        success: true,
        message: result.alreadyProcessed
          ? 'Payment was already processed'
          : 'Payment verified and settled',
        data: result,
      });
    } catch (error: any) {
      const status = error?.statusCode || 400;
      return reply.status(status).send({
        success: false,
        blocked: Boolean(error?.blocked),
        message: error.message || 'Payment verification failed',
      });
    }
  }

  /**
   * Server-side Razorpay webhook handler (payment.captured / order.paid / payment.authorized / payment.failed).
   * Validates HMAC signature with RAZORPAY_WEBHOOK_SECRET and settles completed rides idempotently.
   */
  async handleRazorpayWebhook(req: FastifyRequest, reply: FastifyReply) {
    try {
      const signature = req.headers['x-razorpay-signature'] as string | undefined;
      const eventIdHeader = req.headers['x-razorpay-event-id'] as string | undefined;
      const rawBody =
        typeof (req as any).rawBody === 'string'
          ? (req as any).rawBody
          : JSON.stringify(req.body || {});

      const result = await paymentsService.handleRazorpayWebhookPayload({
        rawBody,
        signatureHeader: signature,
        eventIdHeader,
        parsedBody: req.body,
      });

      return reply.send({ success: true, data: result });
    } catch (error: any) {
      const status = error?.statusCode || 400;
      return reply.status(status).send({
        success: false,
        blocked: Boolean(error?.blocked),
        message: error.message || 'Webhook processing failed',
      });
    }
  }

  async getRidePaymentStatus(req: FastifyRequest, reply: FastifyReply) {
    try {
      const user = req.user as { id: string; role: string };
      const { rideId } = req.params as { rideId: string };
      const data = await paymentsService.getRidePaymentStatus({
        rideIdentifier: rideId,
        userId: user.id,
        role: user.role,
      });
      return reply.send({ success: true, data });
    } catch (error: any) {
      const status = error?.statusCode || 400;
      return reply.status(status).send({
        success: false,
        message: error.message || 'Failed to fetch ride payment status',
      });
    }
  }
}

export const paymentsController = new PaymentsController();
