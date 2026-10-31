import { FastifyRequest, FastifyReply } from 'fastify';
import { unavailabilityService } from './unavailability.service';
import { prisma } from '../../config/prisma';

export class UnavailabilityController {
  /**
   * Save driver's scheduled unavailable dates
   * POST /api/drivers/unavailability
   */
  async saveDriverSchedule(req: FastifyRequest, reply: FastifyReply) {
    try {
      const user = (req as any).user;
      if (!user) {
        return reply.status(401).send({ success: false, message: 'Unauthorized' });
      }

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: user.id },
      });

      if (!driver) {
        return reply.status(404).send({ success: false, message: 'Driver profile not found' });
      }

      const body = (req.body as any) || {};
      const dates = Array.isArray(body.dates) ? body.dates : [];
      const vehicleId = body.vehicleId && body.vehicleId !== 'default' ? body.vehicleId : driver.assignedVehicleId;
      const reason = body.reason || 'Scheduled Offline';

      const result = await unavailabilityService.saveSchedule(
        driver.id,
        vehicleId,
        dates,
        reason
      );

      return reply.status(200).send({
        success: true,
        message: 'Unavailability schedule saved successfully',
        data: result,
      });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({
        success: false,
        message: err.message || 'Failed to save unavailability schedule',
      });
    }
  }

  /**
   * Get driver's scheduled unavailable dates
   * GET /api/drivers/unavailability
   */
  async getDriverSchedule(req: FastifyRequest, reply: FastifyReply) {
    try {
      const user = (req as any).user;
      if (!user) {
        return reply.status(401).send({ success: false, message: 'Unauthorized' });
      }

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: user.id },
      });

      if (!driver) {
        return reply.status(404).send({ success: false, message: 'Driver profile not found' });
      }

      const query = (req.query as any) || {};
      const vehicleId = query.vehicleId && query.vehicleId !== 'default' ? query.vehicleId : driver.assignedVehicleId;

      const dates = await unavailabilityService.getSchedule(driver.id, vehicleId);

      return reply.status(200).send({
        success: true,
        data: dates,
      });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({
        success: false,
        message: err.message || 'Failed to fetch unavailability schedule',
      });
    }
  }

  /**
   * Remove a specific date from driver's schedule
   * DELETE /api/drivers/unavailability/:date
   */
  async removeDriverDate(req: FastifyRequest, reply: FastifyReply) {
    try {
      const user = (req as any).user;
      if (!user) {
        return reply.status(401).send({ success: false, message: 'Unauthorized' });
      }

      const driver = await prisma.driverProfile.findUnique({
        where: { userId: user.id },
      });

      if (!driver) {
        return reply.status(404).send({ success: false, message: 'Driver profile not found' });
      }

      const { date } = (req.params as any) || {};
      const query = (req.query as any) || {};
      const vehicleId = query.vehicleId && query.vehicleId !== 'default' ? query.vehicleId : driver.assignedVehicleId;

      await unavailabilityService.removeDate(driver.id, vehicleId, date);

      return reply.status(200).send({
        success: true,
        message: `Removed ${date} from unavailability schedule`,
      });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({
        success: false,
        message: err.message || 'Failed to remove date from schedule',
      });
    }
  }

  /**
   * Vehicle-level unavailability
   * GET /api/vehicles/:id/unavailability
   */
  async getVehicleSchedule(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = (req.params as any) || {};
      const dates = await unavailabilityService.getSchedule(null, id);
      return reply.status(200).send({
        success: true,
        data: dates,
      });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({
        success: false,
        message: err.message || 'Failed to fetch vehicle unavailability schedule',
      });
    }
  }

  /**
   * Save vehicle unavailability
   * POST /api/vehicles/:id/unavailability
   */
  async saveVehicleSchedule(req: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = (req.params as any) || {};
      const body = (req.body as any) || {};
      const dates = Array.isArray(body.dates) ? body.dates : [];
      const reason = body.reason || 'Vehicle Scheduled Maintenance';

      const result = await unavailabilityService.saveSchedule(null, id, dates, reason);
      return reply.status(200).send({
        success: true,
        message: 'Vehicle unavailability schedule saved',
        data: result,
      });
    } catch (err: any) {
      req.log.error(err);
      return reply.status(500).send({
        success: false,
        message: err.message || 'Failed to save vehicle schedule',
      });
    }
  }
}

export const unavailabilityController = new UnavailabilityController();

