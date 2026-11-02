import { FastifyInstance } from 'fastify';
import { pricingSlabsController } from './pricing-slabs.controller';

export async function pricingSlabsRoutes(fastify: FastifyInstance) {
  fastify.get('/', pricingSlabsController.getAllSlabs.bind(pricingSlabsController));
  fastify.get('/:id', pricingSlabsController.getSlabById.bind(pricingSlabsController));
  fastify.post('/', pricingSlabsController.createSlab.bind(pricingSlabsController));
  fastify.put('/:id', pricingSlabsController.updateSlab.bind(pricingSlabsController));
  fastify.delete('/:id', pricingSlabsController.deleteSlab.bind(pricingSlabsController));
}

