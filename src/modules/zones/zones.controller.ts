import type { FastifyReply, FastifyRequest } from 'fastify';
import { zonesService } from './zones.service';

export class ZonesController {
  async getAllZones(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const zones = await zonesService.getAllZones();
      return reply.send({ success: true, data: zones });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch zones', error: error.message });
    }
  }

  async getZoneById(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const zone = await zonesService.getZoneById(id);
      if (!zone) {
        return reply.status(404).send({ success: false, message: 'Zone not found' });
      }
      return reply.send({ success: true, data: zone });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch zone', error: error.message });
    }
  }

  async createZone(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const body = req.body as any;
      if (!body.name) {
        return reply.status(400).send({ success: false, message: 'Zone name is required' });
      }
      const created = await zonesService.createZone(body);
      return reply.status(201).send({ success: true, message: 'Zone created successfully', data: created });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to create zone' });
    }
  }

  async updateZone(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const updated = await zonesService.updateZone(id, body);
      return reply.send({ success: true, message: 'Zone updated successfully', data: updated });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to update zone' });
    }
  }

  async deleteZone(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      await zonesService.deleteZone(id);
      return reply.send({ success: true, message: 'Zone deleted successfully' });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to delete zone' });
    }
  }
}

export const zonesController = new ZonesController();
