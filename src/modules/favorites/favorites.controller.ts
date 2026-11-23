import { FastifyRequest, FastifyReply } from 'fastify';
import { favoritesService, FavoriteType } from './favorites.service';

export class FavoritesController {
  async getFavorites(req: FastifyRequest, reply: FastifyReply) {
    try {
      const customerId = (req.user as any)?.id;
      if (!customerId) {
        return reply.status(401).send({
          success: false,
          message: 'Unauthorized: User ID missing in token',
        });
      }

      const data = await favoritesService.getFavorites(customerId);
      return reply.send({
        success: true,
        data,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to retrieve favorites',
      });
    }
  }

  async addFavorite(req: FastifyRequest, reply: FastifyReply) {
    try {
      const customerId = (req.user as any)?.id;
      if (!customerId) {
        return reply.status(401).send({
          success: false,
          message: 'Unauthorized: User ID missing in token',
        });
      }

      const body = req.body as { itemType?: string; itemId?: string };
      if (!body || !body.itemType || !body.itemId) {
        return reply.status(400).send({
          success: false,
          message: 'itemType (CAR | EXPLORE) and itemId are required.',
        });
      }

      const itemType = body.itemType.toUpperCase() as FavoriteType;
      if (!['CAR', 'EXPLORE'].includes(itemType)) {
        return reply.status(400).send({
          success: false,
          message: `Invalid itemType: ${body.itemType}. Must be CAR or EXPLORE.`,
        });
      }

      const data = await favoritesService.addFavorite(customerId, itemType, body.itemId);
      return reply.status(201).send({
        success: true,
        message: 'Item saved to favorites',
        data,
      });
    } catch (error: any) {
      const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
      return reply.status(statusCode).send({
        success: false,
        message: error.message || 'Failed to save favorite',
      });
    }
  }

  async removeFavorite(req: FastifyRequest, reply: FastifyReply) {
    try {
      const customerId = (req.user as any)?.id;
      if (!customerId) {
        return reply.status(401).send({
          success: false,
          message: 'Unauthorized: User ID missing in token',
        });
      }

      const params = req.params as { itemType?: string; itemId?: string };
      if (!params || !params.itemType || !params.itemId) {
        return reply.status(400).send({
          success: false,
          message: 'itemType and itemId path parameters are required.',
        });
      }

      const itemType = params.itemType.toUpperCase() as FavoriteType;
      if (!['CAR', 'EXPLORE'].includes(itemType)) {
        return reply.status(400).send({
          success: false,
          message: `Invalid itemType: ${params.itemType}. Must be CAR or EXPLORE.`,
        });
      }

      const data = await favoritesService.removeFavorite(customerId, itemType, params.itemId);
      return reply.send({
        success: true,
        message: 'Item removed from favorites',
        data,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to remove favorite',
      });
    }
  }
}

export const favoritesController = new FavoritesController();
