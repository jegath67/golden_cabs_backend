import type { FastifyReply, FastifyRequest } from 'fastify';
import { refundsService, type RefundStatusType } from './refunds.service';

export class RefundsController {
  async submitRefundRequest(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const { rideId, reason, additionalNotes } = (req.body as any) || {};

    if (!rideId || typeof rideId !== 'string') {
      return reply.status(400).send({
        success: false,
        message: 'rideId is required.',
      });
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return reply.status(400).send({
        success: false,
        message: 'A valid reason for the refund request is required.',
      });
    }

    try {
      const refund = await refundsService.submitRefundRequest(
        user.id,
        rideId,
        reason,
        additionalNotes
      );

      return reply.status(201).send({
        success: true,
        message: 'Refund request submitted successfully.',
        data: refund,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        message: error.message || 'Failed to submit refund request.',
      });
    }
  }

  async getRefundByRide(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string; role: string };
    const { rideId } = req.params as { rideId: string };

    try {
      const refund = await refundsService.getRefundByRideId(
        rideId,
        user.role === 'CUSTOMER' ? user.id : undefined
      );

      if (!refund) {
        return reply.status(404).send({
          success: false,
          message: 'No refund request found for this ride.',
        });
      }

      return reply.send({
        success: true,
        data: refund,
      });
    } catch (error: any) {
      return reply.status(error.statusCode || 403).send({
        success: false,
        message: error.message || 'Access denied.',
      });
    }
  }

  async listRefunds(req: FastifyRequest<any>, reply: FastifyReply) {
    const { status, page, limit } = (req.query as any) || {};

    try {
      const result = await refundsService.listRefunds({
        status: status as RefundStatusType,
        page: page ? Number(page) : 1,
        limit: limit ? Number(limit) : 20,
      });

      return reply.send({
        success: true,
        data: result,
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to list refund requests.',
        error: String(error),
      });
    }
  }

  async updateRefundStatus(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const { status, adminRemarks } = (req.body as any) || {};

    if (!status) {
      return reply.status(400).send({
        success: false,
        message: 'status is required.',
      });
    }

    try {
      const updated = await refundsService.updateRefundStatus(
        id,
        status as RefundStatusType,
        adminRemarks
      );

      return reply.send({
        success: true,
        message: `Refund status updated to ${status}.`,
        data: updated,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        message: error.message || 'Failed to update refund status.',
      });
    }
  }
}

export const refundsController = new RefundsController();
