import { FastifyInstance } from 'fastify';
import { bannersController } from './banners.controller';

export async function bannersRoutes(fastify: FastifyInstance) {
  fastify.get('/', bannersController.getAllBanners.bind(bannersController));
  fastify.get('/history', bannersController.getCampaignHistory.bind(bannersController));
  fastify.get('/:id', bannersController.getBannerById.bind(bannersController));
  fastify.post('/', bannersController.createBanner.bind(bannersController));
  fastify.put('/:id', bannersController.updateBanner.bind(bannersController));
  fastify.delete('/:id', bannersController.deleteBanner.bind(bannersController));
}
