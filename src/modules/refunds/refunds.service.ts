import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';

export type RefundStatusType = 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REFUNDED' | 'REJECTED';

export class RefundsService {
  /**
   * Customer submits a refund request for a paid cancelled or completed ride.
   * Calculates the refund amount strictly from trusted database records.
   */
  async submitRefundRequest(
    customerId: string,
    rideId: string,
    reason: string,
    additionalNotes?: string
  ) {
    if (!rideId || typeof rideId !== 'string') {
      throw new Error('rideId is required');
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      throw new Error('A valid reason for refund is required');
    }

    // 1. Fetch ride and verify ownership
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rideId);
    const ride = isUuid
      ? await prisma.ride.findUnique({
          where: { id: rideId },
          include: {
            customer: true,
            refundRequest: true,
          },
        })
      : await prisma.ride.findUnique({
          where: { bookingCode: rideId },
          include: {
            customer: true,
            refundRequest: true,
          },
        });

    if (!ride) {
      throw new Error('Ride not found');
    }

    if (ride.customerId !== customerId) {
      throw new Error('Forbidden: You are not authorized to request a refund for this ride');
    }

    // 2. Prevent duplicate refund requests
    if (ride.refundRequest) {
      const err: any = new Error('A refund request has already been submitted for this ride');
      err.statusCode = 409;
      throw err;
    }

    // 3. Verify payment eligibility (unpaid cash rides cannot be refunded)
    if (ride.paymentStatus !== 'PAID') {
      throw new Error('Only paid rides are eligible for a refund. Current payment status is ' + ride.paymentStatus);
    }

    // 4. Calculate refundable amount securely from trusted database fields
    const refundableAmount = ride.finalFare ?? ride.estimatedFare;
    if (refundableAmount <= 0) {
      throw new Error('This ride has a zero fare and is not eligible for refund');
    }

    // Combine reason and additional notes if provided
    const fullReason = additionalNotes?.trim()
      ? `${reason.trim()} - Notes: ${additionalNotes.trim()}`
      : reason.trim();

    const refund = await prisma.refundRequest.create({
      data: {
        rideId: ride.id,
        customerId,
        reason: fullReason,
        amount: refundableAmount,
        status: 'SUBMITTED',
      },
      include: {
        ride: {
          select: {
            bookingCode: true,
            pickupLocation: true,
            dropLocation: true,
            paymentMethod: true,
          },
        },
      },
    });

    // Notify customer that refund request was recorded
    notificationsService.sendToUser({
      userId: customerId,
      title: '📋 Refund Request Submitted',
      message: `Your refund request of ₹${refundableAmount} for ${ride.bookingCode} is under review.`,
      type: 'refund_submitted',
      data: { refundId: refund.id, rideId: ride.id },
    }).catch((e) => console.error('Notification error:', e));

    return refund;
  }

  /**
   * Get refund request details for a specific ride (for tracking status in customer app)
   */
  async getRefundByRideId(rideId: string, customerId?: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rideId);
    let targetRideId = rideId;
    if (!isUuid) {
      const ride = await prisma.ride.findUnique({
        where: { bookingCode: rideId },
        select: { id: true },
      });
      if (ride) {
        targetRideId = ride.id;
      }
    }

    const refund = await prisma.refundRequest.findUnique({
      where: { rideId: targetRideId },
      include: {
        ride: {
          select: {
            bookingCode: true,
            pickupLocation: true,
            dropLocation: true,
            paymentMethod: true,
            paymentStatus: true,
          },
        },
      },
    });

    if (!refund) return null;

    if (customerId && refund.customerId !== customerId) {
      throw new Error('Forbidden: You are not authorized to view this refund request');
    }

    return refund;
  }

  /**
   * Admin: List all refund requests with optional status filtering
   */
  async listRefunds(filters?: { status?: RefundStatusType; page?: number; limit?: number }) {
    const page = filters?.page || 1;
    const limit = filters?.limit || 20;
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.refundRequest.findMany({
        where: {
          ...(filters?.status ? { status: filters.status } : {}),
        },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              phone: true,
              email: true,
            },
          },
          ride: {
            select: {
              id: true,
              bookingCode: true,
              pickupLocation: true,
              dropLocation: true,
              paymentMethod: true,
              paymentStatus: true,
              status: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.refundRequest.count({
        where: {
          ...(filters?.status ? { status: filters.status } : {}),
        },
      }),
    ]);

    return {
      items,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Admin: Transition refund status.
   * Strictly enforces allowed state transitions and rejection remarks.
   * Keeps approval separate from settlement.
   */
  async updateRefundStatus(
    refundId: string,
    newStatus: RefundStatusType,
    adminRemarks?: string
  ) {
    const refund = await prisma.refundRequest.findUnique({
      where: { id: refundId },
      include: { ride: true },
    });

    if (!refund) {
      throw new Error('Refund request not found');
    }

    const currentStatus = refund.status;

    // Validate permitted state transitions
    const validTransitions: Record<RefundStatusType, RefundStatusType[]> = {
      SUBMITTED: ['UNDER_REVIEW', 'APPROVED', 'REJECTED'],
      UNDER_REVIEW: ['APPROVED', 'REJECTED'],
      APPROVED: ['REFUNDED'],
      REFUNDED: [], // Terminal state
      REJECTED: [], // Terminal state
    };

    const allowed = validTransitions[currentStatus] || [];
    if (!allowed.includes(newStatus)) {
      throw new Error(
        `Invalid status transition: Cannot transition from ${currentStatus} to ${newStatus}. Allowed transitions: [${allowed.join(', ')}]`
      );
    }

    // Require rejection remarks
    if (newStatus === 'REJECTED' && (!adminRemarks || !adminRemarks.trim())) {
      throw new Error('Admin remarks are mandatory when rejecting a refund request.');
    }

    // If moving to REFUNDED, verify payment method settlement safety
    if (newStatus === 'REFUNDED') {
      const paymentMethod = refund.ride.paymentMethod;

      // In the current architecture:
      // - Customer in-app wallet refund can be settled atomically.
      // - External Payment Gateways (Razorpay/Stripe/UPI intents) are not yet integrated.
      // We do not fake gateway settlement.
      if (paymentMethod !== 'WALLET') {
        const err: any = new Error(
          `Automated gateway refund for payment method '${paymentMethod}' is not configured. Manual banking reversal or payment gateway integration required before finalizing settlement.`
        );
        err.statusCode = 422;
        throw err;
      }

      // Settle wallet refund atomically using conditional status claim and customer ledger entry
      return prisma.$transaction(async (tx) => {
        // Atomic Pessimistic Claim: UPDATE WHERE id = $1 AND status = 'APPROVED'
        // Acquires exclusive row lock. If another concurrent request claimed it, 0 rows returned
        const claimed = await tx.$queryRaw<any[]>`
          UPDATE "RefundRequest"
          SET "status" = 'REFUNDED'::"RefundStatus",
              "adminRemarks" = ${adminRemarks ?? refund.adminRemarks},
              "updatedAt" = NOW()
          WHERE "id" = ${refundId}
            AND "status" = 'APPROVED'::"RefundStatus"
          RETURNING "id", "amount", "customerId", "rideId";
        `;

        if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) {
          const err: any = new Error(
            `Refund settlement rejected: Request ${refundId} is either already settled or not in APPROVED state.`
          );
          err.statusCode = 409;
          throw err;
        }

        const claimedRefund = claimed[0];
        const refundAmount = Math.round(Number(claimedRefund.amount) * 100) / 100;

        // Upsert customer wallet balance
        const customerWallet = await tx.customerWallet.upsert({
          where: { customerId: claimedRefund.customerId },
          create: {
            customerId: claimedRefund.customerId,
            balance: refundAmount,
          },
          update: {
            balance: { increment: refundAmount },
          },
        });

        // Insert ledger entry with UNIQUE referenceRefundId (Idempotency Key)
        await tx.customerWalletTransaction.create({
          data: {
            walletId: customerWallet.id,
            amount: refundAmount,
            type: 'REFUND',
            status: 'COMPLETED',
            description: `Refund for trip ${refund.ride.bookingCode} - Reason: ${refund.reason}`,
            referenceRefundId: refundId,
            referenceRideId: claimedRefund.rideId,
          },
        });

        // Update ride payment status to REFUNDED
        await tx.ride.update({
          where: { id: claimedRefund.rideId },
          data: {
            paymentStatus: 'REFUNDED',
          },
        });

        // Re-fetch complete refund record
        const updated = await tx.refundRequest.findUniqueOrThrow({
          where: { id: refundId },
          include: {
            ride: {
              select: {
                id: true,
                bookingCode: true,
                pickupLocation: true,
                dropLocation: true,
                paymentMethod: true,
                paymentStatus: true,
              },
            },
          },
        });

        // Notify customer
        notificationsService.sendToUser({
          userId: claimedRefund.customerId,
          title: '✅ Refund Settled',
          message: `₹${refundAmount} has been credited to your Golden Cabs wallet.`,
          type: 'refund_completed',
          data: { refundId, rideId: claimedRefund.rideId },
        }).catch((e) => console.error(e));

        return updated;
      });
    }

    // Update status for non-terminal settlement transitions (UNDER_REVIEW, APPROVED, REJECTED)
    const updated = await prisma.refundRequest.update({
      where: { id: refundId },
      data: {
        status: newStatus,
        adminRemarks: adminRemarks ?? refund.adminRemarks,
      },
    });

    // Notify customer of status change
    const statusMessages: Record<string, string> = {
      UNDER_REVIEW: 'Your refund request is currently under review by our support team.',
      APPROVED: `Your refund request of ₹${refund.amount} has been approved and queued for payout.`,
      REJECTED: `Your refund request was rejected. Reason: ${adminRemarks}`,
    };

    if (statusMessages[newStatus]) {
      notificationsService.sendToUser({
        userId: refund.customerId,
        title: `Refund Update: ${newStatus}`,
        message: statusMessages[newStatus]!,
        type: 'refund_status_update',
        data: { refundId, status: newStatus },
      }).catch((e) => console.error(e));
    }

    return updated;
  }
}

export const refundsService = new RefundsService();
