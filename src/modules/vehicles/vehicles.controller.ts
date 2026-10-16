import type { FastifyReply, FastifyRequest } from 'fastify';
import { vehiclesService } from './vehicles.service';

export class VehiclesController {
  async getAllVehicles(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const filters = req.query as {
        category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
        type?: 'SEDAN' | 'SUV' | 'HATCHBACK' | 'LUXURY' | 'AUTO';
        status?: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'MAINTENANCE';
        hubId?: string;
      };
      const vehicles = await vehiclesService.getAllVehicles(filters);
      return reply.send({ success: true, data: vehicles });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch vehicles', error: String(error) });
    }
  }

  async getVehicleById(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const vehicle = await vehiclesService.getVehicleById(id);
      if (!vehicle) {
        return reply.status(404).send({ success: false, message: 'Vehicle not found' });
      }
      return reply.send({ success: true, data: vehicle });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch vehicle', error: String(error) });
    }
  }

  async createVehicle(req: FastifyRequest<any>, reply: FastifyReply) {
    const body = req.body as {
      vehicleNumber: string;
      brand: string;
      model: string;
      year: number;
      vehicleType?: 'SEDAN' | 'SUV' | 'HATCHBACK' | 'LUXURY' | 'AUTO';
      category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
      seatCapacity?: number;
      pricePerKm?: number;
      basePrice?: number;
      rcNumber?: string;
      insuranceNumber?: string;
      assignedHubId?: string;
    };

    const { vehicleNumber, brand, model, year } = body || {};
    if (!vehicleNumber || !brand || !model || !year) {
      return reply.status(400).send({ success: false, message: 'vehicleNumber, brand, model, and year are required' });
    }

    try {
      const vehicle = await vehiclesService.createVehicle(body);
      return reply.send({ success: true, message: 'Vehicle registered successfully', data: vehicle });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to create vehicle' });
    }
  }

  async updateStatus(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const { status } = (req.body as { status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'MAINTENANCE' }) || {};

    if (!status) {
      return reply.status(400).send({ success: false, message: 'status is required' });
    }

    try {
      const updated = await vehiclesService.updateVehicleStatus(id, status);
      return reply.send({ success: true, message: `Vehicle status updated to ${status}`, data: updated });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to update vehicle status', error: String(error) });
    }
  }

  async assignDriver(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const { driverProfileId } = (req.body as { driverProfileId: string | null }) || {};

    try {
      const updated = await vehiclesService.assignVehicleToDriver(id, driverProfileId);
      return reply.send({ success: true, message: 'Driver assignment updated', data: updated });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: error.message || 'Failed to assign driver' });
    }
  }
}

export const vehiclesController = new VehiclesController();
