import type { FastifyReply, FastifyRequest } from 'fastify';
import { ridesService, parseScheduledPickupTime, type EstimateFareInput } from './rides.service';
import { driverAvailabilityService } from './driver-availability.service';
import { prisma } from '../../config/prisma';

export class RidesController {
  async checkAvailability(req: FastifyRequest<any>, reply: FastifyReply) {
    const query = (req.query as any) || {};
    const body = (req.body as any) || {};

    const pickupLat = Number(query.pickupLat ?? body.pickupLat);
    const pickupLng = Number(query.pickupLng ?? body.pickupLng);
    const dropLatRaw = query.dropLat ?? body.dropLat;
    const dropLngRaw = query.dropLng ?? body.dropLng;
    const tripType = query.tripType ?? body.tripType;
    const customTripType = query.customTripType ?? body.customTripType;
    const scheduledAtRaw = query.scheduledAt ?? body.scheduledAt;

    if (isNaN(pickupLat) || isNaN(pickupLng)) {
      return reply.status(400).send({
        success: false,
        message: 'Valid pickupLat and pickupLng are required',
      });
    }

    const dropLat = dropLatRaw !== undefined && !isNaN(Number(dropLatRaw)) ? Number(dropLatRaw) : undefined;
    const dropLng = dropLngRaw !== undefined && !isNaN(Number(dropLngRaw)) ? Number(dropLngRaw) : undefined;

    let scheduledAt: Date | null = null;
    let isScheduled = false;
    if (
      scheduledAtRaw !== undefined &&
      scheduledAtRaw !== null &&
      String(scheduledAtRaw).trim().length > 0 &&
      String(scheduledAtRaw).trim() !== 'Pick-up now'
    ) {
      const parsed = parseScheduledPickupTime(String(scheduledAtRaw).trim());
      if (!parsed || isNaN(parsed.getTime())) {
        return reply.status(400).send({
          success: false,
          message: `Invalid scheduled pickup time format: "${scheduledAtRaw}".`,
        });
      }
      scheduledAt = parsed;
      isScheduled = true;
    }

    try {
      const availability = await driverAvailabilityService.checkCategoryAvailability({
        pickupLat,
        pickupLng,
        dropLat,
        dropLng,
        tripType,
        customTripType,
        isScheduled,
        scheduledAt,
      });

      return reply.send({
        success: true,
        data: availability,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to check driver availability',
        error: String(error?.message || error),
      });
    }
  }

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

    // Explicit allowlist of public customer booking fields — never forward internal service flags
    // such as skipAvailabilityCheck from HTTP request bodies.
    const sanitizedPayload = {
      pickupLocation: body.pickupLocation,
      pickupAddress: body.pickupAddress,
      pickupLat: body.pickupLat,
      pickupLng: body.pickupLng,
      dropLocation: body.dropLocation,
      dropAddress: body.dropAddress,
      dropLat: body.dropLat,
      dropLng: body.dropLng,
      distanceKm: body.distanceKm,
      tripType: body.tripType,
      customTripType: body.customTripType,
      isElite: body.isElite,
      category: body.category,
      paymentMethod: body.paymentMethod,
      couponCode: body.couponCode,
      scheduledAt: body.scheduledAt,
      requestedSeats: body.requestedSeats,
      seatCapacity: body.seatCapacity,
      requestedVehicle: body.requestedVehicle,
      vehicleType: body.vehicleType,
      zone: body.zone,
      carName: body.carName,
      tollCharge: body.tollCharge,
      additionalStops: body.additionalStops,
      stops: Array.isArray(body.stops)
        ? body.stops
        : body.stops && Array.isArray(body.stops.additionalStops)
          ? body.stops.additionalStops
          : undefined,
      riderName: body.riderName,
      riderPhone: body.riderPhone,
      skipAvailabilityCheck: false,
    };

    try {
      const ride = await ridesService.requestRide(user.id, sanitizedPayload);
      return reply.send({ success: true, message: 'Ride requested successfully', data: ride });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        code: error.code || 'BAD_REQUEST',
        message: error.message || 'Failed to request ride',
      });
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

  async declineRide(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const { id } = req.params as { id: string };
    const body = (req.body as any) || {};
    const reason = body.reason || body.cancelReason;

    try {
      const result = await ridesService.declineRide(user.id, id, reason);
      return reply.send({ success: true, message: result.message, data: result });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to decline ride' });
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

  async getCancellationQuote(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    try {
      const quote = await ridesService.getCancellationQuote(id);
      return reply.send({ success: true, data: quote });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to get cancellation quote' });
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
    const { switchToCash } = (req.body as any) || {};

    try {
      const completed = await ridesService.completeRide(id, { switchToCash: Boolean(switchToCash) });
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
