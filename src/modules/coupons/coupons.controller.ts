import type { FastifyReply, FastifyRequest } from 'fastify';
import { couponsService } from './coupons.service';

export class CouponsController {
  async listCoupons(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const coupons = await couponsService.listActiveCoupons();
      return reply.send({
        success: true,
        data: coupons,
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to fetch coupons',
        error: String(error),
      });
    }
  }

  async applyCoupon(req: FastifyRequest<any>, reply: FastifyReply) {
    const { code, fare } = (req.body as any) || {};

    if (!code || typeof code !== 'string') {
      return reply.status(400).send({
        success: false,
        message: 'Please enter a promo code.',
      });
    }

    const numericFare = Number(fare);
    if (isNaN(numericFare) || numericFare <= 0) {
      return reply.status(400).send({
        success: false,
        message: 'A valid positive fare amount is required to apply coupon.',
      });
    }

    try {
      const result = await couponsService.validateAndApplyCoupon(code, numericFare);
      return reply.send({
        success: true,
        message: 'Coupon applied successfully',
        data: result,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        message: error.message || 'Failed to apply coupon',
      });
    }
  }

  async createCoupon(req: FastifyRequest<any>, reply: FastifyReply) {
    const body = (req.body as any) || {};
    const { code, discountType, discountValue } = body;

    if (!code || !discountType || discountValue === undefined) {
      return reply.status(400).send({
        success: false,
        message: 'code, discountType (FLAT | PERCENTAGE), and discountValue are required.',
      });
    }

    if (discountType !== 'FLAT' && discountType !== 'PERCENTAGE') {
      return reply.status(400).send({
        success: false,
        message: 'discountType must be either FLAT or PERCENTAGE.',
      });
    }

    try {
      const created = await couponsService.createCoupon({
        code,
        description: body.description,
        discountType,
        discountValue: Number(discountValue),
        minOrderAmount: body.minOrderAmount ? Number(body.minOrderAmount) : 0,
        maxDiscount: body.maxDiscount ? Number(body.maxDiscount) : undefined,
        validUntil: body.validUntil ? new Date(body.validUntil) : undefined,
        usageLimit: body.usageLimit ? Number(body.usageLimit) : undefined,
      });

      return reply.status(201).send({
        success: true,
        message: 'Coupon created successfully',
        data: created,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        message: error.message || 'Failed to create coupon',
      });
    }
  }
}

export const couponsController = new CouponsController();
