import type { FastifyReply, FastifyRequest } from 'fastify';
import { hubsService } from './hubs.service';

export class HubsController {
  async getAllHubs(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { city } = req.query as { city?: string };
      const hubs = await hubsService.getAllHubs(city);
      return reply.send({ success: true, data: hubs });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch hubs', error: String(error) });
    }
  }

  async getHubById(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const hub = await hubsService.getHubById(id);
      if (!hub) {
        return reply.status(404).send({ success: false, message: 'Hub not found' });
      }
      return reply.send({ success: true, data: hub });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch hub', error: String(error) });
    }
  }

  async createHub(req: FastifyRequest<any>, reply: FastifyReply) {
    const { name, latitude, longitude, radiusMeters, city } = req.body as {
      name: string;
      latitude: number;
      longitude: number;
      radiusMeters?: number;
      city?: string;
    };

    if (!name || latitude === undefined || longitude === undefined) {
      return reply.status(400).send({ success: false, message: 'Name, latitude, and longitude are required' });
    }

    try {
      const hub = await hubsService.createHub({ name, latitude, longitude, radiusMeters, city });
      return reply.send({ success: true, message: 'Hub created successfully', data: hub });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to create hub', error: String(error) });
    }
  }

  async getNearestHub(req: FastifyRequest<any>, reply: FastifyReply) {
    const { lat, lng } = req.query as { lat?: string; lng?: string };
    if (!lat || !lng) {
      return reply.status(400).send({ success: false, message: 'lat and lng query parameters are required' });
    }

    try {
      const hub = await hubsService.findNearestHub(parseFloat(lat), parseFloat(lng));
      return reply.send({ success: true, data: hub });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to find nearest hub', error: String(error) });
    }
  }
}

export const hubsController = new HubsController();
