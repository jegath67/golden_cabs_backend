import type { FastifyReply, FastifyRequest } from 'fastify';
import { vehiclesService } from './vehicles.service';
import { prisma } from '../../config/prisma';

export class VehiclesController {
  async getAllVehicles(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      let callerRole: string | undefined;
      let callerUserId: string | undefined;

      try {
        await req.jwtVerify();
        const user = req.user as { id: string; role: string };
        callerRole = user?.role;
        callerUserId = user?.id;
      } catch (_) {
        // Unauthenticated public request
      }

      const filters = req.query as {
        category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
        type?: 'SEDAN' | 'SUV' | 'HATCHBACK' | 'LUXURY' | 'AUTO';
        status?: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'MAINTENANCE';
        hubId?: string;
        unassignedOnly?: string | boolean;
        ownerId?: string;
      };
      const unassignedOnly = filters.unassignedOnly === true || filters.unassignedOnly === 'true';

      let effectiveOwnerId = filters.ownerId;
      let effectiveAssignedVehicleId: string | undefined;

      // If caller is a DRIVER (rental owner or individual driver), enforce isolation to vehicles they own or assigned
      if (callerRole === 'DRIVER' && callerUserId) {
        const driver = await prisma.driverProfile.findUnique({ where: { userId: callerUserId } });
        if (driver) {
          effectiveOwnerId = driver.id;
          effectiveAssignedVehicleId = driver.assignedVehicleId || undefined;
        }
      }

      const vehicles = await vehiclesService.getAllVehicles({
        ...filters,
        ownerId: effectiveOwnerId,
        assignedVehicleId: effectiveAssignedVehicleId,
        unassignedOnly,
      });
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

      try {
        await req.jwtVerify();
        const user = req.user as { id: string; role: string };
        if (user?.role === 'DRIVER') {
          const driver = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
          if (driver && vehicle.ownerId && vehicle.ownerId !== driver.id && vehicle.id !== driver.assignedVehicleId) {
            return reply.status(403).send({ success: false, message: 'Unauthorized to view this vehicle' });
          }
        }
      } catch (_) {}

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
      rcExpiry?: string;
      rcFront?: string;
      rcBack?: string;
      insuranceNumber?: string;
      insuranceExpiry?: string;
      insuranceDoc?: string;
      assignedHubId?: string;
      ownerId?: string;
      photos?: string[];
      vehiclePhoto?: string;
    };

    const { vehicleNumber, brand, model, year } = body || {};
    if (!vehicleNumber || !brand || !model || !year) {
      return reply.status(400).send({ success: false, message: 'vehicleNumber, brand, model, and year are required' });
    }

    try {
      let ownerId: string | undefined = undefined;
      const user = req.user as { id: string; role: string };
      if (user?.role === 'DRIVER') {
        const driver = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
        if (driver) {
          ownerId = driver.id; // Enforce server-side ownership: do not trust client-supplied ownerId
        }
      } else if ((user?.role === 'ADMIN' || user?.role === 'DISPATCHER') && body.ownerId) {
        ownerId = body.ownerId;
      }

      const vehicle = await vehiclesService.createVehicle({
        ...body,
        ownerId,
      });
      return reply.send({ success: true, message: 'Vehicle registered successfully', data: vehicle });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to create vehicle' });
    }
  }

  async updateStatus(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const { status, rejectionReason } = (req.body as { status: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'MAINTENANCE'; rejectionReason?: string }) || {};

    if (!status) {
      return reply.status(400).send({ success: false, message: 'status is required' });
    }

    try {
      const updated = await vehiclesService.updateVehicleStatus(id, status, rejectionReason);
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

  async toggleAvailability(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const { isOnline } = (req.body as { isOnline?: boolean }) || {};

    if (isOnline === undefined || typeof isOnline !== 'boolean') {
      return reply.status(400).send({ success: false, message: 'isOnline boolean is required' });
    }

    try {
      const user = req.user as { id: string; role: string };
      if (user?.role === 'DRIVER') {
        const driver = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
        if (!driver) {
          return reply.status(403).send({ success: false, message: 'Driver profile not found' });
        }
        const vehicle = await prisma.vehicle.findUnique({ where: { id } });
        if (!vehicle || (vehicle.ownerId !== driver.id && vehicle.id !== driver.assignedVehicleId)) {
          return reply.status(403).send({ success: false, message: 'Unauthorized to modify this vehicle' });
        }
      }

      const updated = await vehiclesService.toggleVehicleAvailability(id, isOnline);
      return reply.send({
        success: true,
        message: `Vehicle availability set to ${isOnline ? 'AVAILABLE' : 'UNAVAILABLE'}`,
        data: updated,
      });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to update vehicle availability' });
    }
  }

  async getPhotos(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const photos = await vehiclesService.getVehiclePhotos(id);
      return reply.send({ success: true, data: photos });
    } catch (error: any) {
      return reply.status(500).send({ success: false, message: error.message || 'Failed to fetch photos' });
    }
  }

  async addPhoto(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body as any) || {};
      const { photoUrl, tag } = body;

      if (!photoUrl || typeof photoUrl !== 'string') {
        return reply.status(400).send({ success: false, message: 'photoUrl is required' });
      }

      const photo = await vehiclesService.addVehiclePhoto(id, photoUrl, tag || 'front');
      return reply.send({ success: true, message: 'Photo uploaded successfully', data: photo });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to add photo' });
    }
  }
}

export const vehiclesController = new VehiclesController();
