import { FastifyRequest, FastifyReply } from 'fastify';
import { eliteCarsService } from './elite-cars.service';

export class EliteCarsController {
  async getAllCars(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { brand, status, category } = req.query as {
        brand?: string;
        status?: string;
        category?: string;
      };
      const cars = await eliteCarsService.getAllCars(brand, status, category);
      return reply.send({
        success: true,
        data: cars,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch elite cars',
      });
    }
  }

  async getCarById(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const car = await eliteCarsService.getCarById(id);
      if (!car) {
        return reply.status(404).send({
          success: false,
          message: 'Car not found',
        });
      }
      return reply.send({
        success: true,
        data: car,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch car details',
      });
    }
  }

  async createCar(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const body = req.body as any;
      if (!body.brand || !body.model) {
        return reply.status(400).send({
          success: false,
          message: 'Brand and Model are required',
        });
      }
      const car = await eliteCarsService.createCar(body);
      return reply.status(201).send({
        success: true,
        message: 'Elite car added successfully',
        data: car,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to add elite car',
      });
    }
  }

  async updateCar(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const car = await eliteCarsService.updateCar(id, body);
      return reply.send({
        success: true,
        message: 'Elite car updated successfully',
        data: car,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to update elite car',
      });
    }
  }

  async deleteCar(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      await eliteCarsService.deleteCar(id);
      return reply.send({
        success: true,
        message: 'Elite car removed successfully',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to delete elite car',
      });
    }
  }
}

export const eliteCarsController = new EliteCarsController();
