import type { FastifyReply, FastifyRequest } from 'fastify';
import { ridesService, type EstimateFareInput } from './rides.service';
import { prisma } from '../../config/prisma';

export class RidesController {
  async estimateFare(req: FastifyRequest<any>, reply: FastifyReply) {
    const { pickupLat, pickupLng, dropLat, dropLng } = (req.body as EstimateFareInput) || {};
    if (pickupLat === undefined || pickupLng === undefined || dropLat === undefined || dropLng === undefined) {
      return reply.status(400).send({
        success: false,
        message: 'pickupLat, pickupLng, dropLat, and dropLng are required',
      });
    }

    try {
      const estimate = await ridesService.estimateFare(req.body as EstimateFareInput);
      return reply.send({ success: true, data: estimate });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to estimate fare', error: String(error) });
    }
  }

  async requestRide(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const body = req.body as any;
    const { pickupLocation, pickupLat, pickupLng, dropLocation, dropLat, dropLng } = body || {};

    if (!pickupLocation || !dropLocation || pickupLat === undefined || dropLat === undefined) {
      return reply.status(400).send({
        success: false,
        message: 'pickupLocation, dropLocation, pickup coordinates, and drop coordinates are required',
      });
    }

    try {
      const ride = await ridesService.requestRide(user.id, body);
      return reply.send({ success: true, message: 'Ride requested successfully', data: ride });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to request ride' });
    }
  }

  async acceptRide(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const { id } = req.params as { id: string };

    try {
      const ride = await ridesService.acceptRide(user.id, id);
      return reply.send({ success: true, message: 'Ride accepted', data: ride });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to accept ride' });
    }
  }

  async updateStatus(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string; role: 'CUSTOMER' | 'DRIVER' | 'ADMIN' };
    const { id } = req.params as { id: string };
    const body = (req.body as any) || {};
    const status = body.status;
    const cancelReason = body.cancelReason || body.reason;

    try {
      const updated = await ridesService.updateStatus(id, status, user.role, cancelReason, user.id);
      return reply.send({ success: true, message: `Ride updated to ${status}`, data: updated });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to update ride status' });
    }
  }

  async startRide(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const { otp } = (req.body as { otp?: string }) || {};
    const user = req.user as { id: string; role: string } | undefined;

    if (!otp) {
      return reply.status(400).send({ success: false, message: 'Start OTP is required' });
    }

    try {
      const updated = await ridesService.startRide(id, otp, user?.id);
      return reply.send({ success: true, message: 'Ride started', data: updated });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to start ride' });
    }
  }

  async completeRide(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };

    try {
      const completed = await ridesService.completeRide(id);
      return reply.send({ success: true, message: 'Ride completed successfully', data: completed });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to complete ride' });
    }
  }

  async getRideDetails(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const user = req.user as { id: string; role: string } | undefined;
      const ride = await ridesService.getRideById(id);
      if (!ride) {
        return reply.status(404).send({ success: false, message: 'Ride not found' });
      }

      // If user is CUSTOMER but not the owner of this ride, deny access
      if (user?.role === 'CUSTOMER' && ride.customerId !== user?.id) {
        return reply.status(403).send({
          success: false,
          message: 'Forbidden: You do not have permission to view this ride',
        });
      }

      // If user is DRIVER, ensure driver is assigned to this ride and strip startOtp
      if (user?.role === 'DRIVER') {
        const dp = await prisma.driverProfile.findUnique({ where: { userId: user.id } });
        if (!dp || ride.driverId !== dp.id) {
          return reply.status(403).send({
            success: false,
            message: 'Forbidden: You do not have permission to view this ride',
          });
        }
        const { startOtp, ...safeRide } = ride;
        return reply.send({ success: true, data: safeRide });
      }

      return reply.send({ success: true, data: ride });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch ride', error: String(error) });
    }
  }

  async getMyRides(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string; role: string };

    try {
      const rides =
        user.role === 'DRIVER'
          ? await ridesService.getDriverRides(user.id)
          : await ridesService.getCustomerRides(user.id);

      return reply.send({ success: true, data: rides });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch rides', error: String(error) });
    }
  }

  async getAvailableRides(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const user = req.user as { id: string } | undefined;
      const limit = (req.query as any)?.limit ? parseInt((req.query as any).limit, 10) : 20;
      const rides = await ridesService.getAvailableRides(limit, user?.id);
      return reply.send({ success: true, data: rides });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch available rides', error: String(error) });
    }
  }
}

export const ridesController = new RidesController();
