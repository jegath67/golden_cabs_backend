import { FastifyRequest, FastifyReply } from 'fastify';
import { exploreService } from './explore.service';

export class ExploreController {
  async getAllPlaces(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { category, status, search } = req.query as {
        category?: string;
        status?: string;
        search?: string;
      };
      const places = await exploreService.getAllPlaces(category, status, search);
      return reply.send({
        success: true,
        data: places,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch explore places',
      });
    }
  }

  async getPlaceById(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const place = await exploreService.getPlaceById(id);
      if (!place) {
        return reply.status(404).send({
          success: false,
          message: 'Place not found',
        });
      }
      return reply.send({
        success: true,
        data: place,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch place details',
      });
    }
  }

  async createPlace(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const body = req.body as any;
      if (!body.name) {
        return reply.status(400).send({
          success: false,
          message: 'Name is required',
        });
      }
      const place = await exploreService.createPlace(body);
      return reply.status(201).send({
        success: true,
        message: 'Place created successfully',
        data: place,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to create place',
      });
    }
  }

  async updatePlace(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const place = await exploreService.updatePlace(id, body);
      return reply.send({
        success: true,
        message: 'Place updated successfully',
        data: place,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to update place',
      });
    }
  }

  async deletePlace(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      await exploreService.deletePlace(id);
      return reply.send({
        success: true,
        message: 'Place deleted successfully',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to delete place',
      });
    }
  }
}

export const exploreController = new ExploreController();
