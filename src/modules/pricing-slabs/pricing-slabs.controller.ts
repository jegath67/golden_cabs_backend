import { FastifyRequest, FastifyReply } from 'fastify';
import { pricingSlabsService } from './pricing-slabs.service';

export class PricingSlabsController {
  async getAllSlabs(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { vehicleType, rideType, zone, status } = req.query as {
        vehicleType?: string;
        rideType?: string;
        zone?: string;
        status?: string;
      };

      const slabs = await pricingSlabsService.getAllSlabs({
        vehicleType,
        rideType,
        zone,
        status,
      });

      return reply.send({
        success: true,
        data: slabs,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch pricing slabs',
      });
    }
  }

  async getSlabById(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const slab = await pricingSlabsService.getSlabById(id);
      if (!slab) {
        return reply.status(404).send({
          success: false,
          message: 'Pricing slab not found',
        });
      }

      return reply.send({
        success: true,
        data: slab,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch pricing slab',
      });
    }
  }

  async createSlab(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const created = await pricingSlabsService.createSlab(req.body);
      return reply.status(201).send({
        success: true,
        message: 'Pricing slab created successfully',
        data: created,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to create pricing slab',
      });
    }
  }

  async updateSlab(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const updated = await pricingSlabsService.updateSlab(id, req.body);
      return reply.send({
        success: true,
        message: 'Pricing slab updated successfully',
        data: updated,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to update pricing slab',
      });
    }
  }

  async deleteSlab(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const result = await pricingSlabsService.deleteSlab(id);
      return reply.send({
        success: true,
        message: result.message,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to delete pricing slab',
      });
    }
  }
}

export const pricingSlabsController = new PricingSlabsController();

