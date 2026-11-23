import { FastifyInstance } from 'fastify';
import { favoritesController } from './favorites.controller';
import { authenticate } from '../../middlewares/auth.middleware';

export async function favoritesRoutes(fastify: FastifyInstance) {
  fastify.addHook('preHandler', authenticate);

  fastify.get('/', favoritesController.getFavorites.bind(favoritesController));
  fastify.post('/', favoritesController.addFavorite.bind(favoritesController));
  fastify.delete('/:itemType/:itemId', favoritesController.removeFavorite.bind(favoritesController));
}
