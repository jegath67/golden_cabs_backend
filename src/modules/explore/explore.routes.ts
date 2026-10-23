import { FastifyInstance } from 'fastify';
import { exploreController } from './explore.controller';

export async function exploreRoutes(fastify: FastifyInstance) {
  fastify.get('/', exploreController.getAllPlaces.bind(exploreController));
  fastify.get('/:id', exploreController.getPlaceById.bind(exploreController));
  fastify.post('/', exploreController.createPlace.bind(exploreController));
  fastify.put('/:id', exploreController.updatePlace.bind(exploreController));
  fastify.delete('/:id', exploreController.deletePlace.bind(exploreController));
}
