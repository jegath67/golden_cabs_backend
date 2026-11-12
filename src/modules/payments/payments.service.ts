import crypto from 'crypto';
import { createRequire } from 'module';
import { prisma } from '../../config/prisma';
import { ridesService } from '../rides/rides.service';
import {
  computeCommissionSplit,
  normalizeCommissionPercent,
} from '../pricing-slabs/pricing-slabs.service';
import { platformSettingsService } from '../settings/platform-settings.service';
import { notificationsService } from '../notifications/notifications.service';

const require = createRequire(import.meta.url);
const RazorpaySDK = require('razorpay');

export interface RazorpayOrderCreateParams {
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrderResponse {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status?: string;
}

export interface RazorpayClientLike {
  orders: {
    create(params: RazorpayOrderCreateParams): Promise<RazorpayOrderResponse>;
  };
}

export class PaymentsService {
  private testRazorpayClient: RazorpayClientLike | null = null;

  /**
   * Injects a Razorpay test double for automated unit/integration tests.
   * Never used in production runtime.
   */
  setRazorpayClientForTesting(client: RazorpayClientLike | null) {
    this.testRazorpayClient = client;
  }

  private getConfiguredSecrets() {
    const keyId = (process.env.RAZORPAY_KEY_ID || '').trim();
    const keySecret = (process.env.RAZORPAY_KEY_SECRET || '').trim();
    const webhookSecret = (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim();
    return { keyId, keySecret, webhookSecret };
  }

  private getRazorpayClient(): { client: RazorpayClientLike; keyId: string } {
    const { keyId, keySecret } = this.getConfiguredSecrets();
    if (!keyId || !keySecret) {
      throw Object.assign(
        new Error(
          'Razorpay order creation blocked: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are not configured'
        ),
        { statusCode: 503, blocked: true }
      );
    }

    if (this.testRazorpayClient) {
      return { client: this.testRazorpayClient, keyId };
    }

    const sdk = new RazorpaySDK({
      key_id: keyId,
      key_secret: keySecret,
    });
    return { client: sdk as RazorpayClientLike, keyId };
  }

  /**
   * Checks live Razorpay gateway configuration status from environment variables.
   * Never fabricates or simulates gateway credentials or exposes secrets.
   */
  getGatewayStatus() {
    const { keyId, keySecret, webhookSecret } = this.getConfiguredSecrets();
    const checkoutConfigured = Boolean(keyId && keySecret);
    const webhookConfigured = Boolean(webhookSecret);
    const mode = keyId
      ? keyId.startsWith('rzp_live_')
        ? 'LIVE'
        : 'TEST'
      : 'UNCONFIGURED';

    return {
      provider: 'RAZORPAY',
      mode,
      checkoutConfigured,
      webhookConfigured,
      blocked: !checkoutConfigured || !webhookConfigured,
      blockedReason:
        checkoutConfigured && webhookConfigured
          ? null
          : 'Razorpay credentials (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET) are not configured on backend',
    };
  }

  /**
   * Constant-time HMAC-SHA256 verification for Razorpay webhook payloads.
   */
  verifyWebhookSignature(rawPayload: string, signatureHeader?: string): boolean {
    const { webhookSecret } = this.getConfiguredSecrets();
    if (!webhookSecret) {
      throw Object.assign(
        new Error('Razorpay webhook verification blocked: RAZORPAY_WEBHOOK_SECRET is not configured'),
        { statusCode: 503, blocked: true }
      );
    }
    if (!signatureHeader || !rawPayload) {
      return false;
    }

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawPayload)
      .digest('hex');

    const sigBuf = Buffer.from(signatureHeader.trim(), 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  /**
   * Constant-time HMAC-SHA256 verification for Razorpay client payment callback.
   */
  verifyOrderPaymentSignature(params: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }): boolean {
    const { keySecret } = this.getConfiguredSecrets();
    if (!keySecret) {
      throw Object.assign(
        new Error('Razorpay payment verification blocked: RAZORPAY_KEY_SECRET is not configured'),
        { statusCode: 503, blocked: true }
      );
    }
    const payload = `${params.razorpayOrderId}|${params.razorpayPaymentId}`;
    const expected = crypto.createHmac('sha256', keySecret).update(payload).digest('hex');

    const sigBuf = Buffer.from(String(params.razorpaySignature || '').trim(), 'utf8');
    const expBuf = Buffer.from(expected, 'utf8');
    if (sigBuf.length !== expBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }

  private async resolveRideForUpdate(tx: any, rideIdentifier: string) {
    const cleanId = String(rideIdentifier || '').trim();
    if (!cleanId) return null;

    const locked = await tx.$queryRaw<any[]>`
      SELECT "id" FROM "Ride"
      WHERE "id" = ${cleanId}
         OR "bookingCode" = ${cleanId}
         OR "bookingCode" = ${`GC-${cleanId.replace(/^GC-/i, '')}`}
         OR "bookingCode" = ${cleanId.replace(/^GC-/i, '')}
      FOR UPDATE
    `;
    if (!locked.length) return null;

    return tx.ride.findUnique({
      where: { id: locked[0].id },
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
        fareBreakdown: true,
        driver: { include: { wallet: true } },
      },
    });
  }

  private computePayableInr(ride: any): number {
    const raw = ride.finalFare ?? ride.fareBreakdown?.totalFare ?? ride.estimatedFare ?? 0;
    return Math.round(Number(raw) * 100) / 100;
  }

  /**
   * Creates an authoritative Razorpay order for a customer ride.
   * Never trusts client-provided amounts; reuses open idempotent order for same ride & amount.
   */
  async createRazorpayOrder(params: {
    customerId: string;
    rideIdentifier: string;
    paymentMethod?: 'UPI' | 'CARD' | 'WALLET';
  }) {
    const { client, keyId } = this.getRazorpayClient();
    const { customerId, rideIdentifier } = params;
    const method = params.paymentMethod || 'UPI';

    const lockPrep = await prisma.$transaction(async (tx) => {
      const ride = await this.resolveRideForUpdate(tx, rideIdentifier);
      if (!ride) {
        throw Object.assign(new Error('Ride not found'), { statusCode: 404 });
      }
      if (ride.customerId !== customerId) {
        throw Object.assign(new Error('Forbidden: You do not own this ride'), { statusCode: 403 });
      }
      if (ride.status === 'CANCELLED') {
        throw Object.assign(new Error('Cannot initiate payment for a cancelled ride'), {
          statusCode: 400,
        });
      }
      if (ride.paymentStatus === 'REFUNDED') {
        throw Object.assign(new Error('Ride payment has already been refunded'), {
          statusCode: 400,
        });
      }
      if (ride.paymentStatus === 'PAID') {
        throw Object.assign(new Error('Ride is already paid'), { statusCode: 409 });
      }

      const paidPaymentTx = await tx.paymentTransaction.findFirst({
        where: {
          rideId: ride.id,
          status: { in: ['PAID', 'CAPTURED'] },
        },
      });
      if (paidPaymentTx) {
        throw Object.assign(new Error('Ride already has a confirmed payment'), { statusCode: 409 });
      }

      const payableInr = this.computePayableInr(ride);
      const amountPaise = Math.round(payableInr * 100);
      if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
        throw Object.assign(new Error('Valid payable fare greater than ₹0 is required'), {
          statusCode: 400,
        });
      }

      const existingOpenOrder = await tx.paymentTransaction.findFirst({
        where: {
          rideId: ride.id,
          status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] },
          amountPaise,
          currency: 'INR',
        },
        orderBy: { createdAt: 'desc' },
      });

      return {
        ride,
        payableInr,
        amountPaise,
        existingOpenOrder,
      };
    });

    const { ride, payableInr, amountPaise, existingOpenOrder } = lockPrep;

    if (existingOpenOrder) {
      return {
        reused: true,
        paymentTransactionId: existingOpenOrder.id,
        orderId: existingOpenOrder.razorpayOrderId,
        receipt: existingOpenOrder.receipt,
        amountPaise: existingOpenOrder.amountPaise,
        amountInr: existingOpenOrder.amountInr,
        currency: existingOpenOrder.currency,
        keyId,
        rideId: ride.id,
        bookingCode: ride.bookingCode,
        paymentStatus: ride.paymentStatus,
        gatewayStatus: existingOpenOrder.status,
        prefill: {
          name: ride.customer?.name || 'Customer',
          contact: ride.customer?.phone || '',
          email: ride.customer?.email || '',
        },
      };
    }

    const receiptSuffix = Date.now().toString(36).toUpperCase();
    const baseCode = (ride.bookingCode || ride.id.substring(0, 8)).replace(/[^a-zA-Z0-9_-]/g, '');
    const receipt = `GC_${baseCode}_${receiptSuffix}`.slice(0, 40);

    const razorpayOrder = await client.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: {
        rideId: ride.id,
        bookingCode: ride.bookingCode,
        customerId: ride.customerId,
      },
    });

    if (!razorpayOrder?.id) {
      throw Object.assign(new Error('Failed to create Razorpay order'), { statusCode: 502 });
    }

    const savedTx = await prisma.paymentTransaction.create({
      data: {
        rideId: ride.id,
        customerId: ride.customerId,
        provider: 'RAZORPAY',
        razorpayOrderId: razorpayOrder.id,
        receipt,
        amountPaise,
        amountInr: payableInr,
        currency: 'INR',
        paymentMethod: method,
        status: 'CREATED',
        verificationStatus: 'UNVERIFIED',
      },
    });

    return {
      reused: false,
      paymentTransactionId: savedTx.id,
      orderId: savedTx.razorpayOrderId,
      receipt: savedTx.receipt,
      amountPaise: savedTx.amountPaise,
      amountInr: savedTx.amountInr,
      currency: savedTx.currency,
      keyId,
      rideId: ride.id,
      bookingCode: ride.bookingCode,
      paymentStatus: ride.paymentStatus,
      gatewayStatus: savedTx.status,
      prefill: {
        name: ride.customer?.name || 'Customer',
        contact: ride.customer?.phone || '',
        email: ride.customer?.email || '',
      },
    };
  }

  /**
   * Client callback payment verification endpoint service.
   * Verifies ride ownership, stored order/payment association, amount, currency, and HMAC signature.
   */
  async verifyClientRazorpayPayment(params: {
    customerId: string;
    rideIdentifier: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
    paymentMethod?: 'UPI' | 'CARD' | 'WALLET';
  }) {
    const cleanOrderId = String(params.razorpayOrderId || '').trim();
    const cleanPaymentId = String(params.razorpayPaymentId || '').trim();
    const cleanSig = String(params.razorpaySignature || '').trim();

    if (!cleanOrderId || !cleanPaymentId || !cleanSig) {
      throw Object.assign(
        new Error('razorpayOrderId, razorpayPaymentId, and razorpaySignature are required'),
        { statusCode: 400 }
      );
    }

    // Ensure key secret is present cleanly before touching DB state
    const { keySecret } = this.getConfiguredSecrets();
    if (!keySecret) {
      throw Object.assign(
        new Error('Razorpay payment verification blocked: RAZORPAY_KEY_SECRET is not configured'),
        { statusCode: 503, blocked: true }
      );
    }

    const preCheck = await prisma.$transaction(async (tx) => {
      const ride = await this.resolveRideForUpdate(tx, params.rideIdentifier);
      if (!ride) {
        throw Object.assign(new Error('Ride not found for payment verification'), { statusCode: 404 });
      }
      if (ride.customerId !== params.customerId) {
        throw Object.assign(new Error('Forbidden: Ride does not belong to customer'), {
          statusCode: 403,
        });
      }
      if (ride.status === 'CANCELLED' || ride.paymentStatus === 'REFUNDED') {
        throw Object.assign(
          new Error(`Cannot verify payment for ${ride.status} / ${ride.paymentStatus} ride`),
          { statusCode: 400 }
        );
      }

      const orderTx = await tx.paymentTransaction.findUnique({
        where: { razorpayOrderId: cleanOrderId },
      });
      if (!orderTx) {
        throw Object.assign(new Error('Razorpay order record not found'), { statusCode: 404 });
      }
      if (orderTx.rideId !== ride.id || orderTx.customerId !== params.customerId) {
        throw Object.assign(
          new Error('Forbidden: Order reference does not match this ride/customer'),
          { statusCode: 403 }
        );
      }
      if (orderTx.currency !== 'INR') {
        throw Object.assign(new Error(`Invalid payment currency: ${orderTx.currency}`), {
          statusCode: 400,
        });
      }
      if (orderTx.razorpayPaymentId && orderTx.razorpayPaymentId !== cleanPaymentId) {
        throw Object.assign(
          new Error('Order is already bound to a different Razorpay payment ID'),
          { statusCode: 409 }
        );
      }

      const duplicatePaymentOnOtherRide = await tx.paymentTransaction.findFirst({
        where: {
          razorpayPaymentId: cleanPaymentId,
          id: { not: orderTx.id },
        },
      });
      if (duplicatePaymentOnOtherRide) {
        throw Object.assign(
          new Error('Payment reference is already attached to another ride'),
          { statusCode: 409 }
        );
      }

      const expectedPaise = Math.round(this.computePayableInr(ride) * 100);
      if (Math.abs(orderTx.amountPaise - expectedPaise) > 50) {
        throw Object.assign(
          new Error(
            `Order amount ₹${orderTx.amountInr} does not match current ride fare ₹${expectedPaise / 100}`
          ),
          { statusCode: 400 }
        );
      }

      return { ride, orderTx };
    });

    const isSignatureValid = this.verifyOrderPaymentSignature({
      razorpayOrderId: cleanOrderId,
      razorpayPaymentId: cleanPaymentId,
      razorpaySignature: cleanSig,
    });

    if (!isSignatureValid) {
      await prisma.paymentTransaction.updateMany({
        where: {
          id: preCheck.orderTx.id,
          status: { notIn: ['PAID', 'CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
        },
        data: {
          status: 'FAILED',
          verificationStatus: 'FAILED',
          failureReason: 'Invalid Razorpay signature verification',
          failedAt: new Date(),
        },
      });

      throw Object.assign(new Error('Invalid Razorpay payment signature'), { statusCode: 400 });
    }

    return this.confirmVerifiedOnlinePayment({
      rideIdentifier: preCheck.ride.id,
      paymentMethod: params.paymentMethod || (preCheck.orderTx.paymentMethod as any) || 'UPI',
      gateway: 'RAZORPAY',
      gatewayPaymentId: cleanPaymentId,
      gatewayOrderId: cleanOrderId,
      razorpaySignature: cleanSig,
      verifiedAmountInr: preCheck.orderTx.amountPaise / 100,
      verificationSource: 'SIGNATURE_VERIFIED',
    });
  }

  /**
   * Authoritative, idempotent server-side UPI/Online payment confirmation and delayed settlement.
   * Must ONLY be invoked after server-side signature or webhook verification.
   */
  async confirmVerifiedOnlinePayment(params: {
    rideIdentifier: string;
    paymentMethod?: 'UPI' | 'CARD' | 'WALLET';
    gateway: string;
    gatewayPaymentId: string;
    gatewayOrderId?: string | null;
    razorpaySignature?: string | null;
    verifiedAmountInr: number;
    currency?: string;
    gatewayMethod?: string | null;
    gatewayEventId?: string | null;
    gatewayEventType?: string | null;
    webhookPayload?: any;
    verificationSource?: 'SIGNATURE_VERIFIED' | 'WEBHOOK_CONFIRMED';
  }) {
    const {
      rideIdentifier,
      gateway,
      gatewayPaymentId,
      gatewayOrderId,
      razorpaySignature,
      verifiedAmountInr,
      gatewayMethod,
      gatewayEventId,
      gatewayEventType,
      webhookPayload,
      verificationSource = 'SIGNATURE_VERIFIED',
    } = params;

    if (params.currency && params.currency.toUpperCase() !== 'INR') {
      throw Object.assign(new Error(`Unsupported currency: ${params.currency}`), {
        statusCode: 400,
      });
    }

    const cleanMethod = params.paymentMethod || 'UPI';

    const outcome = await prisma.$transaction(async (tx) => {
      // Idempotency guard on webhook event ID
      if (gatewayEventId) {
        const existingEvent = await tx.gatewayWebhookEvent.findUnique({
          where: { eventId: gatewayEventId },
        });
        if (existingEvent) {
          return {
            rideId: '',
            bookingCode: '',
            driverUserId: null,
            alreadyProcessed: true,
            duplicateEvent: true,
            settledNow: false,
            driverNetEarnings: 0,
            companyCommission: 0,
          };
        }
      }

      const ride = await this.resolveRideForUpdate(tx, rideIdentifier);
      if (!ride) {
        throw Object.assign(new Error('Ride not found for payment verification'), { statusCode: 404 });
      }
      if (ride.status === 'CANCELLED' || ride.paymentStatus === 'REFUNDED') {
        throw Object.assign(
          new Error(`Cannot verify payment for ${ride.status} / ${ride.paymentStatus} ride`),
          { statusCode: 400 }
        );
      }

      const payableFare = this.computePayableInr(ride);
      const discountAmount = ride.fareBreakdown?.discountAmount ?? 0;
      const grossFare = Math.round((payableFare + discountAmount) * 100) / 100;

      if (verifiedAmountInr + 0.5 < payableFare) {
        throw Object.assign(
          new Error(`Verified amount ₹${verifiedAmountInr} is less than payable fare ₹${payableFare}`),
          { statusCode: 400 }
        );
      }

      // Check existing PaymentTransaction row matching this orderId or paymentId
      let paymentTx = gatewayOrderId
        ? await tx.paymentTransaction.findUnique({
            where: { razorpayOrderId: gatewayOrderId },
          })
        : null;

      if (paymentTx && paymentTx.rideId !== ride.id) {
        throw Object.assign(new Error('Order reference belongs to another ride'), {
          statusCode: 403,
        });
      }

      const paymentById = await tx.paymentTransaction.findFirst({
        where: { razorpayPaymentId: gatewayPaymentId },
      });
      if (paymentById && paymentById.rideId !== ride.id) {
        throw Object.assign(new Error('Payment ID already belongs to another ride'), {
          statusCode: 409,
        });
      }

      const now = new Date();
      const targetGatewayStatus =
        verificationSource === 'WEBHOOK_CONFIRMED' ? 'CAPTURED' : 'PAID';

      if (paymentTx) {
        const existingEvents: string[] = Array.isArray(paymentTx.gatewayEventIds)
          ? (paymentTx.gatewayEventIds as string[])
          : [];
        const nextEvents =
          gatewayEventId && !existingEvents.includes(gatewayEventId)
            ? [...existingEvents, gatewayEventId]
            : existingEvents;

        paymentTx = await tx.paymentTransaction.update({
          where: { id: paymentTx.id },
          data: {
            razorpayPaymentId: gatewayPaymentId,
            ...(razorpaySignature ? { razorpaySignature } : {}),
            ...(gatewayMethod ? { gatewayMethod } : {}),
            status:
              paymentTx.status === 'REFUNDED' || paymentTx.status === 'PARTIALLY_REFUNDED'
                ? paymentTx.status
                : targetGatewayStatus,
            verificationStatus:
              paymentTx.verificationStatus === 'WEBHOOK_CONFIRMED'
                ? 'WEBHOOK_CONFIRMED'
                : verificationSource,
            failureReason: null,
            gatewayEventIds: nextEvents,
            verifiedAt: paymentTx.verifiedAt ?? now,
            capturedAt:
              verificationSource === 'WEBHOOK_CONFIRMED'
                ? paymentTx.capturedAt ?? now
                : paymentTx.capturedAt,
          },
        });
      } else {
        const syntheticOrderId =
          gatewayOrderId || `direct_${gatewayPaymentId}`;
        const receipt = `GC_${(ride.bookingCode || ride.id.substring(0, 8)).replace(/[^a-zA-Z0-9_-]/g, '')}_${Date.now().toString(36)}`.slice(
          0,
          40
        );
        paymentTx = await tx.paymentTransaction.create({
          data: {
            rideId: ride.id,
            customerId: ride.customerId,
            provider: gateway,
            razorpayOrderId: syntheticOrderId,
            razorpayPaymentId: gatewayPaymentId,
            razorpaySignature: razorpaySignature || null,
            receipt,
            amountPaise: Math.round(payableFare * 100),
            amountInr: payableFare,
            currency: 'INR',
            paymentMethod: ride.paymentMethod === 'CASH' ? cleanMethod : ride.paymentMethod,
            gatewayMethod: gatewayMethod || null,
            status: targetGatewayStatus,
            verificationStatus: verificationSource,
            gatewayEventIds: gatewayEventId ? [gatewayEventId] : [],
            verifiedAt: now,
            capturedAt: verificationSource === 'WEBHOOK_CONFIRMED' ? now : null,
          },
        });
      }

      if (gatewayEventId) {
        await tx.gatewayWebhookEvent.create({
          data: {
            provider: gateway,
            eventId: gatewayEventId,
            eventType: gatewayEventType || 'payment.captured',
            razorpayOrderId: gatewayOrderId || paymentTx.razorpayOrderId,
            razorpayPaymentId: gatewayPaymentId,
            paymentTransactionId: paymentTx.id,
            payload: webhookPayload ?? null,
            processed: true,
          },
        });
      }

      const existingMeta = (ride.stops as any) || {};
      const alreadyProcessedPaymentId =
        existingMeta.gatewayPaymentId &&
        String(existingMeta.gatewayPaymentId) === String(gatewayPaymentId);

      // Update ride payment status -> PAID if not already PAID
      if (ride.paymentStatus !== 'PAID') {
        await tx.ride.update({
          where: { id: ride.id },
          data: {
            paymentMethod: ride.paymentMethod === 'CASH' ? cleanMethod : ride.paymentMethod,
            paymentStatus: 'PAID',
            stops: {
              ...existingMeta,
              gateway,
              gatewayPaymentId,
              ...(gatewayOrderId ? { gatewayOrderId } : {}),
              paymentVerifiedAt: now.toISOString(),
            },
          },
        });
      }

      // If ride is already COMPLETED, ensure driver net earnings are credited idempotently
      let settlementResult: {
        settled: boolean;
        type?: 'COMMISSION' | 'EARNING';
        driverNetEarnings: number;
        companyCommission: number;
      } = { settled: false, driverNetEarnings: 0, companyCommission: 0 };

      if (ride.status === 'COMPLETED') {
        const fallbackPct = await platformSettingsService.getCommissionPercent();
        const frozenPct =
          ride.fareBreakdown?.commissionPercent != null
            ? normalizeCommissionPercent(ride.fareBreakdown.commissionPercent, fallbackPct)
            : normalizeCommissionPercent(fallbackPct, 20.0);
        const split = computeCommissionSplit(grossFare, frozenPct);

        await tx.fareBreakdown.upsert({
          where: { rideId: ride.id },
          update: {
            totalFare: payableFare,
            commissionPercent: frozenPct,
            commissionAmount: split.commissionAmount,
            driverAmount: split.driverAmount,
          },
          create: {
            rideId: ride.id,
            distanceKm: ride.distanceKm || 0,
            pricePerKm: 0,
            baseFare: payableFare,
            discountAmount,
            totalFare: payableFare,
            commissionPercent: frozenPct,
            commissionAmount: split.commissionAmount,
            driverAmount: split.driverAmount,
          },
        });

        settlementResult = await ridesService.settleCompletedRideWalletInTx(tx, {
          rideId: ride.id,
          bookingCode: ride.bookingCode,
          driverId: ride.driverId,
          paymentMethod: ride.paymentMethod === 'CASH' ? cleanMethod : ride.paymentMethod,
          paymentStatus: 'PAID',
          customerPayable: payableFare,
          companyCommission: split.commissionAmount,
          driverNetEarnings: split.driverAmount,
          appliedCommissionPercent: frozenPct,
        });
      }

      return {
        rideId: ride.id,
        bookingCode: ride.bookingCode,
        paymentTransactionId: paymentTx.id,
        paymentStatus: 'PAID',
        gatewayStatus: paymentTx.status,
        driverUserId: ride.driver?.userId || null,
        alreadyProcessed: Boolean(
          alreadyProcessedPaymentId || (ride.paymentStatus === 'PAID' && !settlementResult.settled)
        ),
        settledNow: settlementResult.settled,
        driverNetEarnings: settlementResult.driverNetEarnings,
        companyCommission: settlementResult.companyCommission,
      };
    });

    if (outcome.settledNow && outcome.driverUserId) {
      notificationsService
        .sendToUser({
          userId: outcome.driverUserId,
          title: '💰 Online Payment Verified!',
          message: `₹${outcome.driverNetEarnings} credited to your wallet for trip ${outcome.bookingCode}.`,
          type: 'wallet_credited',
          data: {
            rideId: outcome.rideId,
            amount: String(outcome.driverNetEarnings),
          },
        })
        .catch((e) => console.error('[PaymentsService] Wallet notification error:', e));
    }

    return outcome;
  }

  /**
   * Processes verified Razorpay webhooks idempotently (payment.captured, order.paid, payment.authorized, payment.failed).
   */
  async handleRazorpayWebhookPayload(params: {
    rawBody: string;
    signatureHeader?: string;
    eventIdHeader?: string;
    parsedBody?: any;
  }) {
    const valid = this.verifyWebhookSignature(params.rawBody, params.signatureHeader);
    if (!valid) {
      throw Object.assign(new Error('Invalid webhook signature'), { statusCode: 401 });
    }

    const body =
      params.parsedBody && typeof params.parsedBody === 'object'
        ? params.parsedBody
        : JSON.parse(params.rawBody || '{}');
    const event = String(body.event || '').trim();
    const paymentEntity = body.payload?.payment?.entity || {};
    const orderEntity = body.payload?.order?.entity || {};
    const notes = paymentEntity.notes || orderEntity.notes || {};

    const gatewayPaymentId = paymentEntity.id ? String(paymentEntity.id) : null;
    const gatewayOrderId =
      paymentEntity.order_id || orderEntity.id
        ? String(paymentEntity.order_id || orderEntity.id)
        : null;

    const eventId =
      (params.eventIdHeader && params.eventIdHeader.trim()) ||
      (body.id && String(body.id).trim()) ||
      `rzp_${crypto
        .createHash('sha256')
        .update(`${event}:${gatewayPaymentId || ''}:${gatewayOrderId || ''}:${body.created_at || ''}`)
        .digest('hex')
        .slice(0, 32)}`;

    if (event === 'payment.authorized') {
      return prisma.$transaction(async (tx) => {
        const existingEvent = await tx.gatewayWebhookEvent.findUnique({ where: { eventId } });
        if (existingEvent) {
          return { ignored: true, duplicateEvent: true, event, eventId };
        }

        const existingTx = gatewayOrderId
          ? await tx.paymentTransaction.findUnique({ where: { razorpayOrderId: gatewayOrderId } })
          : null;

        if (existingTx && ['CREATED', 'PENDING'].includes(existingTx.status)) {
          await tx.paymentTransaction.update({
            where: { id: existingTx.id },
            data: {
              ...(gatewayPaymentId ? { razorpayPaymentId: gatewayPaymentId } : {}),
              ...(paymentEntity.method ? { gatewayMethod: String(paymentEntity.method) } : {}),
              status: 'AUTHORIZED',
            },
          });
        }

        await tx.gatewayWebhookEvent.create({
          data: {
            provider: 'RAZORPAY',
            eventId,
            eventType: event,
            razorpayOrderId: gatewayOrderId,
            razorpayPaymentId: gatewayPaymentId,
            paymentTransactionId: existingTx?.id || null,
            payload: body,
            processed: true,
          },
        });

        // Never mark paid or credit wallet on AUTHORIZED alone
        return { ignored: false, event, eventId, settledNow: false, status: 'AUTHORIZED' };
      });
    }

    if (event === 'payment.failed') {
      const failureReason =
        String(
          paymentEntity.error_description ||
            paymentEntity.error_reason ||
            paymentEntity.error_code ||
            'Payment failed at Razorpay gateway'
        ).trim();

      return prisma.$transaction(async (tx) => {
        const existingEvent = await tx.gatewayWebhookEvent.findUnique({ where: { eventId } });
        if (existingEvent) {
          return { ignored: true, duplicateEvent: true, event, eventId };
        }

        const existingTx = gatewayOrderId
          ? await tx.paymentTransaction.findUnique({ where: { razorpayOrderId: gatewayOrderId } })
          : null;

        if (
          existingTx &&
          !['PAID', 'CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(existingTx.status)
        ) {
          await tx.paymentTransaction.update({
            where: { id: existingTx.id },
            data: {
              ...(gatewayPaymentId ? { razorpayPaymentId: gatewayPaymentId } : {}),
              ...(paymentEntity.method ? { gatewayMethod: String(paymentEntity.method) } : {}),
              status: 'FAILED',
              verificationStatus: 'FAILED',
              failureReason,
              failedAt: new Date(),
            },
          });
        }

        await tx.gatewayWebhookEvent.create({
          data: {
            provider: 'RAZORPAY',
            eventId,
            eventType: event,
            razorpayOrderId: gatewayOrderId,
            razorpayPaymentId: gatewayPaymentId,
            paymentTransactionId: existingTx?.id || null,
            payload: body,
            processed: true,
          },
        });

        return {
          ignored: false,
          event,
          eventId,
          settledNow: false,
          status: 'FAILED',
          failureReason,
        };
      });
    }

    if (event !== 'payment.captured' && event !== 'order.paid') {
      return { ignored: true, event, eventId };
    }

    let rideIdentifier = notes.rideId || notes.bookingCode || null;
    if (!rideIdentifier && gatewayOrderId) {
      const orderTx = await prisma.paymentTransaction.findUnique({
        where: { razorpayOrderId: gatewayOrderId },
      });
      if (orderTx) {
        rideIdentifier = orderTx.rideId;
      }
    }

    if (!rideIdentifier || !gatewayPaymentId) {
      throw Object.assign(
        new Error('Missing rideId/bookingCode or payment id in webhook payload'),
        { statusCode: 400 }
      );
    }

    const amountPaise = Number(paymentEntity.amount || orderEntity.amount_paid || 0);
    const currency = String(paymentEntity.currency || orderEntity.currency || 'INR');
    const rawGatewayMethod = paymentEntity.method ? String(paymentEntity.method).toUpperCase() : '';
    const mappedMethod: 'UPI' | 'CARD' | 'WALLET' =
      rawGatewayMethod === 'CARD'
        ? 'CARD'
        : rawGatewayMethod === 'WALLET'
          ? 'WALLET'
          : 'UPI';

    return this.confirmVerifiedOnlinePayment({
      rideIdentifier: String(rideIdentifier),
      paymentMethod: mappedMethod,
      gateway: 'RAZORPAY',
      gatewayPaymentId,
      gatewayOrderId,
      verifiedAmountInr: Math.round((amountPaise / 100) * 100) / 100,
      currency,
      gatewayMethod: paymentEntity.method ? String(paymentEntity.method) : null,
      gatewayEventId: eventId,
      gatewayEventType: event,
      webhookPayload: body,
      verificationSource: 'WEBHOOK_CONFIRMED',
    });
  }

  /**
   * Returns current backend payment & Razorpay order status for customer/driver status refresh.
   */
  async getRidePaymentStatus(params: {
    rideIdentifier: string;
    userId: string;
    role: string;
  }) {
    const cleanId = String(params.rideIdentifier || '').trim();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanId);

    const ride = await prisma.ride.findFirst({
      where: {
        OR: [
          ...(isUuid ? [{ id: cleanId }] : []),
          { bookingCode: cleanId },
          { bookingCode: cleanId.replace(/^GC-/i, '') },
          { bookingCode: `GC-${cleanId.replace(/^GC-/i, '')}` },
        ],
      },
      include: {
        driver: { select: { userId: true } },
        fareBreakdown: true,
        paymentTransactions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!ride) {
      throw Object.assign(new Error('Ride not found'), { statusCode: 404 });
    }

    const isAdmin = ['SUPER_ADMIN', 'ADMIN', 'ZONE_ADMIN', 'DISPATCHER'].includes(params.role);
    const isOwnerCustomer = ride.customerId === params.userId;
    const isAssignedDriver = ride.driver?.userId === params.userId;
    if (!isAdmin && !isOwnerCustomer && !isAssignedDriver) {
      throw Object.assign(new Error('Forbidden: Access denied for this ride payment status'), {
        statusCode: 403,
      });
    }

    const latestTx = ride.paymentTransactions[0] || null;
    const payableInr = this.computePayableInr(ride);

    return {
      rideId: ride.id,
      bookingCode: ride.bookingCode,
      rideStatus: ride.status,
      paymentMethod: ride.paymentMethod,
      paymentStatus: ride.paymentStatus,
      payableInr,
      latestTransaction: latestTx
        ? {
            id: latestTx.id,
            razorpayOrderId: latestTx.razorpayOrderId,
            razorpayPaymentId: latestTx.razorpayPaymentId,
            amountInr: latestTx.amountInr,
            amountPaise: latestTx.amountPaise,
            currency: latestTx.currency,
            gatewayMethod: latestTx.gatewayMethod,
            status: latestTx.status,
            verificationStatus: latestTx.verificationStatus,
            failureReason: latestTx.failureReason,
            verifiedAt: latestTx.verifiedAt?.toISOString() || null,
            capturedAt: latestTx.capturedAt?.toISOString() || null,
            failedAt: latestTx.failedAt?.toISOString() || null,
          }
        : null,
    };
  }
}

export const paymentsService = new PaymentsService();
