import type { FastifyReply, FastifyRequest } from 'fastify';
import { driversService } from './drivers.service';

export class DriversController {
  async getMyProfile(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const user = req.user as { id: string };
      const driver = await driversService.getDriverByUserId(user.id);
      if (!driver) {
        return reply.status(404).send({ success: false, message: 'Driver profile not found' });
      }
      return reply.send({ success: true, data: driver });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch driver profile', error: String(error) });
    }
  }

  async updateKyc(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const user = req.user as { id: string };
      const body = req.body as any;
      const updated = await driversService.updateKycDocuments(user.id, body);
      return reply.send({ success: true, message: 'KYC details submitted for review', data: updated });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to update KYC' });
    }
  }

  async toggleShift(req: FastifyRequest<any>, reply: FastifyReply) {
    const { shiftStatus } = (req.body as { shiftStatus?: 'ON_SHIFT' | 'OFF_SHIFT' }) || {};
    if (!shiftStatus) {
      return reply.status(400).send({ success: false, message: 'shiftStatus is required' });
    }

    try {
      const user = req.user as { id: string };
      const updated = await driversService.toggleShift(user.id, shiftStatus);
      return reply.send({
        success: true,
        message: `Shift changed to ${shiftStatus}`,
        data: { isOnline: updated.isOnline, shiftStatus: updated.shiftStatus },
      });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to toggle shift' });
    }
  }

  async updateLocation(req: FastifyRequest<any>, reply: FastifyReply) {
    const { latitude, longitude, heading, speed, accuracy, rideId } = (req.body as {
      latitude?: number;
      longitude?: number;
      heading?: number;
      speed?: number;
      accuracy?: number;
      rideId?: string;
    }) || {};

    if (latitude === undefined || typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      return reply.status(400).send({
        success: false,
        message: 'Valid latitude between -90 and 90 is required',
      });
    }

    if (longitude === undefined || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      return reply.status(400).send({
        success: false,
        message: 'Valid longitude between -180 and 180 is required',
      });
    }

    if (heading !== undefined && (typeof heading !== 'number' || !Number.isFinite(heading) || heading < 0 || heading > 360)) {
      return reply.status(400).send({
        success: false,
        message: 'Optional heading must be a number between 0 and 360',
      });
    }

    if (speed !== undefined && (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0)) {
      return reply.status(400).send({
        success: false,
        message: 'Optional speed must be a non-negative number',
      });
    }

    if (accuracy !== undefined && (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0)) {
      return reply.status(400).send({
        success: false,
        message: 'Optional accuracy must be a non-negative number',
      });
    }

    if (rideId !== undefined && (typeof rideId !== 'string' || rideId.trim().length === 0)) {
      return reply.status(400).send({
        success: false,
        message: 'Optional rideId must be a non-empty string',
      });
    }

    try {
      const user = req.user as { id: string };
      const updated = await driversService.updateLocation(user.id, {
        latitude,
        longitude,
        heading,
        speed,
        accuracy,
        rideId,
      });

      return reply.send({
        success: true,
        message: 'Location updated',
        data: {
          latitude: updated.currentLatitude,
          longitude: updated.currentLongitude,
          currentLatitude: updated.currentLatitude,
          currentLongitude: updated.currentLongitude,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        message: error.message || 'Failed to update location',
      });
    }
  }

  async selectHub(req: FastifyRequest<any>, reply: FastifyReply) {
    const { hubId } = (req.body as { hubId?: string }) || {};
    if (!hubId) {
      return reply.status(400).send({ success: false, message: 'hubId is required' });
    }

    try {
      const user = req.user as { id: string };
      const updated = await driversService.selectHub(user.id, hubId);
      return reply.send({ success: true, message: 'Hub selected successfully', data: updated });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to select hub' });
    }
  }

  async getAllDrivers(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const filters = req.query as any;
      const drivers = await driversService.getAllDrivers(filters);
      return reply.send({ success: true, data: drivers });
    } catch (error) {
      return reply.status(500).send({ success: false, message: 'Failed to fetch drivers', error: String(error) });
    }
  }

  async verifyDriver(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const { approvalStatus, rejectionReason } = (req.body as any) || {};

    if (!approvalStatus) {
      return reply.status(400).send({ success: false, message: 'approvalStatus is required' });
    }

    try {
      const updated = await driversService.verifyDriver(id, approvalStatus, rejectionReason);
      return reply.send({ success: true, message: `Driver ${approvalStatus}`, data: updated });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to verify driver' });
    }
  }
}

export const driversController = new DriversController();
