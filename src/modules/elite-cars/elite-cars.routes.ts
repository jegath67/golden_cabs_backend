import { FastifyInstance } from 'fastify';
import { eliteCarsController } from './elite-cars.controller';

export async function eliteCarsRoutes(fastify: FastifyInstance) {
  fastify.get('/', eliteCarsController.getAllCars.bind(eliteCarsController));
  fastify.get('/:id', eliteCarsController.getCarById.bind(eliteCarsController));
  fastify.post('/', eliteCarsController.createCar.bind(eliteCarsController));
  fastify.put('/:id', eliteCarsController.updateCar.bind(eliteCarsController));
  fastify.delete('/:id', eliteCarsController.deleteCar.bind(eliteCarsController));
}
