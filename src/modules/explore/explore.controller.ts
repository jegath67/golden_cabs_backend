import { FastifyRequest, FastifyReply } from 'fastify';
import { exploreService } from './explore.service';

export function formatPlaceCode(place: { id?: string | null; category?: string | null; name?: string | null }): string {
  if (!place || !place.id) return 'HTL-00001';
  const rawId = String(place.id);
  if (
    rawId.startsWith('HTL-') ||
    rawId.startsWith('REST') ||
    rawId.startsWith('TEX') ||
    rawId.startsWith('CAF') ||
    rawId.startsWith('PUB') ||
    rawId.startsWith('EXP-')
  ) {
    return rawId;
  }
  const clean = rawId.replace(/-/g, '').toUpperCase();
  const suffix = clean.length >= 5 ? clean.substring(0, 5) : clean.padStart(4, '0');

  const cat = (place.category || '').toLowerCase();
  const name = (place.name || '').toLowerCase();

  if (cat.includes('restaurant') || cat.includes('hotel') || name.includes('hotel')) {
    return `HTL-${suffix}`;
  } else if (cat.includes('textile')) {
    return `TEX-${suffix}`;
  } else if (cat.includes('cafe')) {
    return `CAF-${suffix}`;
  } else if (cat.includes('pub') || cat.includes('bar')) {
    return `PUB-${suffix}`;
  }
  return `EXP-${suffix}`;
}

export function formatPlaceResponse(place: any) {
  if (!place) return place;
  const code = formatPlaceCode(place);
  return {
    ...place,
    placeCode: code,
    hotelCode: code,
    displayId: code,
  };
}

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
        data: places.map(formatPlaceResponse),
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
        data: formatPlaceResponse(place),
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
        data: formatPlaceResponse(place),
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
        data: formatPlaceResponse(place),
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
