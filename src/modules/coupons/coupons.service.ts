import { prisma } from '../../config/prisma';

export interface ApplyCouponResult {
  code: string;
  description: string | null;
  discountType: 'FLAT' | 'PERCENTAGE';
  discountValue: number;
  discountAmount: number;
  originalFare: number;
  finalFare: number;
  savingsText: string;
}

export class CouponsService {
  /**
   * List all currently active and unexpired coupons for customer exploration
   */
  async listActiveCoupons() {
    const now = new Date();
    return prisma.coupon.findMany({
      where: {
        isActive: true,
        OR: [
          { validUntil: null },
          { validUntil: { gt: now } },
        ],
      },
      select: {
        id: true,
        code: true,
        description: true,
        discountType: true,
        discountValue: true,
        minOrderAmount: true,
        maxDiscount: true,
        validUntil: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Validate and preview discount for a coupon against a given ride fare.
   * Does NOT consume or increment timesUsed on preview.
   */
  async validateAndApplyCoupon(code: string, fare: number): Promise<ApplyCouponResult> {
    if (!code || typeof code !== 'string' || !code.trim()) {
      throw new Error('Please enter a promo code.');
    }

    if (fare === undefined || fare === null || isNaN(fare) || fare <= 0) {
      throw new Error('Valid ride fare is required.');
    }

    const normalizedCode = code.trim().toUpperCase();

    const coupon = await prisma.coupon.findUnique({
      where: { code: normalizedCode },
    });

    if (!coupon) {
      throw new Error('Invalid promo code.');
    }

    if (!coupon.isActive) {
      throw new Error('This promo code is no longer active.');
    }

    const now = new Date();
    if (coupon.validUntil && coupon.validUntil < now) {
      throw new Error('This promo code has expired.');
    }

    if (fare < coupon.minOrderAmount) {
      throw new Error(`Minimum ride amount of ₹${coupon.minOrderAmount.toFixed(1)} required.`);
    }

    if (coupon.usageLimit !== null && coupon.timesUsed >= coupon.usageLimit) {
      throw new Error('This promo code has reached its maximum usage limit.');
    }

    // Calculate discount amount
    let rawDiscount = 0;
    if (coupon.discountType === 'PERCENTAGE') {
      rawDiscount = fare * (coupon.discountValue / 100);
      if (coupon.maxDiscount !== null && coupon.maxDiscount !== undefined && rawDiscount > coupon.maxDiscount) {
        rawDiscount = coupon.maxDiscount;
      }
    } else {
      // FLAT discount
      rawDiscount = coupon.discountValue;
    }

    // Discount cannot exceed original fare
    if (rawDiscount > fare) {
      rawDiscount = fare;
    }

    const discountAmount = Math.round(rawDiscount * 100) / 100;
    const finalFare = Math.max(0, Math.round((fare - discountAmount) * 100) / 100);

    return {
      code: coupon.code,
      description: coupon.description,
      discountType: coupon.discountType,
      discountValue: coupon.discountValue,
      discountAmount,
      originalFare: fare,
      finalFare,
      savingsText: `You saved ₹${discountAmount.toFixed(0)} on this trip!`,
    };
  }

  /**
   * Atomically consume a coupon usage when a ride is confirmed/booked.
   * Concurrency-safe against race conditions via row-level atomic condition.
   */
  async consumeCoupon(code: string, tx: any = prisma): Promise<boolean> {
    const normalizedCode = code.trim().toUpperCase();

    const updated = await tx.$queryRaw`
      UPDATE "Coupon"
      SET "timesUsed" = "timesUsed" + 1
      WHERE "code" = ${normalizedCode}
        AND "isActive" = true
        AND ("usageLimit" IS NULL OR "timesUsed" < "usageLimit")
      RETURNING "id", "timesUsed";
    `;

    if (!updated || (Array.isArray(updated) && updated.length === 0)) {
      throw new Error('Coupon usage limit reached or coupon is inactive.');
    }

    return true;
  }

  /**
   * Atomically restore coupon usage when a ride is cancelled or abandoned.
   * Decrements timesUsed without dropping below 0.
   */
  async restoreCoupon(code: string, tx: any = prisma): Promise<boolean> {
    const normalizedCode = code.trim().toUpperCase();

    await tx.$queryRaw`
      UPDATE "Coupon"
      SET "timesUsed" = GREATEST(0, "timesUsed" - 1)
      WHERE "code" = ${normalizedCode}
      RETURNING "id", "timesUsed";
    `;

    return true;
  }

  /**
   * Admin: Create a new promotional coupon
   */
  async createCoupon(data: {
    code: string;
    description?: string;
    discountType: 'FLAT' | 'PERCENTAGE';
    discountValue: number;
    minOrderAmount?: number;
    maxDiscount?: number;
    validUntil?: Date;
    usageLimit?: number;
  }) {
    const code = data.code.trim().toUpperCase();

    if (data.discountValue <= 0) {
      throw new Error('Discount value must be greater than zero.');
    }

    if (data.discountType === 'PERCENTAGE' && data.discountValue > 100) {
      throw new Error('Percentage discount cannot exceed 100%.');
    }

    return prisma.coupon.create({
      data: {
        code,
        description: data.description,
        discountType: data.discountType,
        discountValue: data.discountValue,
        minOrderAmount: data.minOrderAmount ?? 0,
        maxDiscount: data.maxDiscount,
        validUntil: data.validUntil,
        usageLimit: data.usageLimit,
        isActive: true,
      },
    });
  }
}

export const couponsService = new CouponsService();
