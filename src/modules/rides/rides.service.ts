import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';
import { TripStatus } from '../../generated/prisma/client';

export interface EstimateFareInput {
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
  tripType?: 'DAILY' | 'RENTAL' | 'OUTSTATION' | 'ONE_WAY' | 'ROUND_TRIP';
  category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
}

export class RidesService {
  /**
   * Calculate distance between two coordinates using Haversine formula
   */
  calculateDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (value: number) => (value * Math.PI) / 180;
    const R = 6371; // Earth radius in KM
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const dist = R * c;
    return Math.max(1, Math.round(dist * 10) / 10);
  }

  /**
   * Estimate ride fare
   */
  async estimateFare(input: EstimateFareInput) {
    const distanceKm = this.calculateDistanceKm(
      input.pickupLat,
      input.pickupLng,
      input.dropLat,
      input.dropLng
    );

    // Rate configurations based on vehicle category
    let ratePerKm = 14.0;
    let baseFare = 50.0;

    if (input.category === 'PREMIUM') {
      ratePerKm = 18.0;
      baseFare = 80.0;
    } else if (input.category === 'LUXURY') {
      ratePerKm = 24.0;
      baseFare = 150.0;
    }

    let driverBata = 0;
    if (input.tripType === 'OUTSTATION' || input.tripType === 'ROUND_TRIP') {
      driverBata = 300.0;
    }

    const calculatedFare = baseFare + distanceKm * ratePerKm + driverBata;
    const totalFare = Math.round(calculatedFare);

    return {
      distanceKm,
      pricePerKm: ratePerKm,
      baseFare,
      driverBata,
      estimatedFare: totalFare,
    };
  }

  /**
   * Customer requests a new ride
   */
  async requestRide(customerId: string, data: {
    pickupLocation: string;
    pickupAddress?: string;
    pickupLat: number;
    pickupLng: number;
    dropLocation: string;
    dropAddress?: string;
    dropLat: number;
    dropLng: number;
    tripType?: 'DAILY' | 'RENTAL' | 'OUTSTATION' | 'ONE_WAY' | 'ROUND_TRIP';
    category?: 'BUDGET' | 'PREMIUM' | 'LUXURY';
    paymentMethod?: 'CASH' | 'UPI' | 'CARD' | 'WALLET';
    couponCode?: string;
    scheduledAt?: string;
    requestedSeats?: string;
    seatCapacity?: number;
    requestedVehicle?: string;
    carName?: string;
  }) {
    const fareEstimate = await this.estimateFare({
      pickupLat: data.pickupLat,
      pickupLng: data.pickupLng,
      dropLat: data.dropLat,
      dropLng: data.dropLng,
      tripType: data.tripType,
      category: data.category,
    });

    let discountAmount = 0.0;
    let finalEstimatedFare = fareEstimate.estimatedFare;

    if (data.couponCode) {
      const { couponsService } = await import('../coupons/coupons.service');
      const couponResult = await couponsService.validateAndApplyCoupon(
        data.couponCode,
        fareEstimate.estimatedFare
      );
      discountAmount = couponResult.discountAmount;
      finalEstimatedFare = couponResult.finalFare;
    }

    const bookingCode = `GC-${Math.floor(100000 + Math.random() * 900000)}`;
    const startOtp = Math.floor(1000 + Math.random() * 9000).toString();

    const isScheduledBooking = !!(data.scheduledAt && data.scheduledAt.trim().length > 0 && data.scheduledAt !== 'Pick-up now');
    const seatCap = data.seatCapacity || (data.requestedSeats?.includes('6') || data.requestedVehicle?.includes('6') ? 6 : 4);
    const reqVehicle = data.requestedVehicle || data.requestedSeats || data.carName || (seatCap === 6 ? '6 Seater Cab' : '4 Seater Cab');

    const ride = await prisma.$transaction(async (tx) => {
      if (data.couponCode) {
        const { couponsService } = await import('../coupons/coupons.service');
        await couponsService.consumeCoupon(data.couponCode, tx);
      }

      return tx.ride.create({
        data: {
          bookingCode,
          customerId,
          tripType: data.tripType || 'DAILY',
          status: 'SEARCHING',
          pickupLocation: data.pickupLocation,
          pickupAddress: data.pickupAddress,
          pickupLat: data.pickupLat,
          pickupLng: data.pickupLng,
          dropLocation: data.dropLocation,
          dropAddress: data.dropAddress,
          dropLat: data.dropLat,
          dropLng: data.dropLng,
          distanceKm: fareEstimate.distanceKm,
          estimatedFare: finalEstimatedFare,
          startOtp,
          paymentMethod: data.paymentMethod || 'CASH',
          stops: {
            ...(data.couponCode
              ? { couponCode: data.couponCode.trim().toUpperCase(), couponRestored: false }
              : {}),
            scheduledAt: isScheduledBooking ? data.scheduledAt!.trim() : null,
            isScheduled: isScheduledBooking,
            seatCapacity: seatCap,
            requestedVehicle: reqVehicle,
          },
          fareBreakdown: {
            create: {
              distanceKm: fareEstimate.distanceKm,
              pricePerKm: fareEstimate.pricePerKm,
              baseFare: fareEstimate.baseFare,
              driverBata: fareEstimate.driverBata,
              discountAmount,
              totalFare: finalEstimatedFare,
            },
          },
        },
        include: {
          customer: { select: { id: true, name: true, phone: true } },
          fareBreakdown: true,
        },
      });
    });

    // Notify online drivers in the vicinity
    const onlineDrivers = await prisma.driverProfile.findMany({
      where: {
        isOnline: true,
        shiftStatus: 'ON_SHIFT',
        approvalStatus: 'APPROVED',
      },
      select: { userId: true },
    });

    for (const driver of onlineDrivers) {
      notificationsService.sendToUser({
        userId: driver.userId,
        title: '🚖 New Ride Request Available!',
        message: `${data.pickupLocation} ➔ ${data.dropLocation} (₹${fareEstimate.estimatedFare})`,
        type: 'ride_request',
        data: {
          rideId: ride.id,
          bookingCode: ride.bookingCode,
          pickupLocation: ride.pickupLocation,
          dropLocation: ride.dropLocation,
          distance: `${ride.distanceKm} km`,
          estimatedFare: `₹${fareEstimate.estimatedFare}`,
          tripType: ride.tripType,
          paymentMethod: ride.paymentMethod,
          customerName: ride.customer?.name || 'Customer',
          customerPhone: ride.customer?.phone || '',
        },
      }).catch((e) => console.error('Driver notification error:', e));
    }

    return ride;
  }

  /**
   * Driver accepts a ride
   */
  async acceptRide(driverUserId: string, rideId: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId: driverUserId },
      include: { assignedVehicle: true },
    });

    if (!driver || driver.approvalStatus !== 'APPROVED') {
      throw new Error('Driver is not verified or approved');
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) throw new Error('Ride not found');
    if (ride.status !== 'SEARCHING' && !(ride.status === 'ACCEPTED' && ride.driverId === driver.id)) {
      throw new Error('Ride is no longer available');
    }

    const updatedRide = await prisma.ride.update({
      where: { id: rideId },
      data: {
        driverId: driver.id,
        vehicleId: driver.assignedVehicleId,
        status: 'ACCEPTED',
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        driver: {
          include: {
            user: { select: { name: true, phone: true } },
            assignedVehicle: true,
          },
        },
        fareBreakdown: true,
      },
    });

    // Notify Customer that driver accepted
    notificationsService.sendToUser({
      userId: ride.customerId,
      title: '✅ Ride Accepted by Driver!',
      message: `${updatedRide.driver?.user.name || 'Your driver'} is on the way. Start OTP: ${ride.startOtp}`,
      type: 'ride_accepted',
      data: { rideId: ride.id, startOtp: ride.startOtp },
    }).catch((e) => console.error('Customer notification error:', e));

    return updatedRide;
  }

  /**
   * Driver updates intermediate status: EN_ROUTE or ARRIVED, or cancel ride
   */
  async updateStatus(
    rideId: string,
    status: 'EN_ROUTE' | 'ARRIVED' | 'CANCELLED',
    actorRole: 'CUSTOMER' | 'DRIVER' | 'ADMIN',
    cancelReason?: string
  ) {
    const ride = await prisma.ride.findFirst({
      where: {
        OR: [{ id: rideId }, { bookingCode: rideId }],
      },
    });
    if (!ride) throw new Error('Ride not found');

    // Idempotency: If ride is already cancelled, return cleanly without duplicate operations
    if (status === 'CANCELLED' && ride.status === 'CANCELLED') {
      return ride;
    }

    if (ride.status === 'COMPLETED') {
      throw new Error('Cannot change status of an already completed ride');
    }

    let updated: any;

    if (status === 'CANCELLED') {
      const metadata = (ride.stops as any) || {};
      const couponCode = metadata.couponCode;
      const alreadyRestored = metadata.couponRestored === true;

      updated = await prisma.$transaction(async (tx) => {
        // Idempotently restore coupon usage if not already restored
        if (couponCode && !alreadyRestored) {
          const { couponsService } = await import('../coupons/coupons.service');
          await couponsService.restoreCoupon(couponCode, tx);
        }

        return tx.ride.update({
          where: { id: ride.id },
          data: {
            status: 'CANCELLED',
            cancelReason,
            cancelledBy: actorRole.toLowerCase(),
            stops: couponCode ? { ...metadata, couponRestored: true } : ride.stops as any,
          },
          include: {
            customer: true,
            driver: { include: { user: true } },
          },
        });
      });
    } else {
      updated = await prisma.ride.update({
        where: { id: ride.id },
        data: { status },
        include: {
          customer: true,
          driver: { include: { user: true } },
        },
      });
    }

    // Notify other party
    if (status === 'ARRIVED') {
      notificationsService.sendToUser({
        userId: ride.customerId,
        title: '📍 Driver Has Arrived!',
        message: 'Your cab is waiting at the pickup location. Share OTP to start trip.',
        type: 'driver_arrived',
        data: { rideId },
      }).catch((e) => console.error(e));
    } else if (status === 'CANCELLED') {
      const recipientId = actorRole === 'DRIVER' ? ride.customerId : updated.driver?.userId;
      if (recipientId) {
        notificationsService.sendToUser({
          userId: recipientId,
          title: '❌ Ride Cancelled',
          message: cancelReason ? `Reason: ${cancelReason}` : 'Ride has been cancelled.',
          type: 'ride_cancelled',
          data: { rideId },
        }).catch((e) => console.error(e));
      }
    }

    return updated;
  }

  /**
   * Start ride using OTP verification
   */
  async startRide(rideId: string, enteredOtp: string, driverUserId?: string) {
    if (!enteredOtp || typeof enteredOtp !== 'string' || enteredOtp.trim().length === 0) {
      throw new Error('Start OTP is required');
    }

    const ride = await prisma.ride.findUnique({ where: { id: rideId } });
    if (!ride) throw new Error('Ride not found');

    if (driverUserId) {
      const driver = await prisma.driverProfile.findUnique({
        where: { userId: driverUserId },
      });
      if (!driver) {
        throw new Error('Driver profile not found');
      }
      if (ride.driverId !== driver.id) {
        throw new Error('Unauthorized: You are not the assigned driver for this ride');
      }
    }

    const validStatuses = ['ACCEPTED', 'EN_ROUTE', 'ARRIVED'];
    if (!validStatuses.includes(ride.status)) {
      throw new Error(`Cannot start ride with current status: ${ride.status}. Ride must be ACCEPTED, EN_ROUTE, or ARRIVED.`);
    }

    if (ride.startOtp !== enteredOtp.trim()) {
      throw new Error('Invalid OTP. Please check with customer.');
    }

    const updated = await prisma.ride.update({
      where: { id: rideId },
      data: {
        status: 'ONGOING',
        startedAt: new Date(),
      },
    });

    notificationsService.sendToUser({
      userId: ride.customerId,
      title: '🚗 Trip Started!',
      message: 'Have a safe journey with Golden Cabs.',
      type: 'trip_started',
      data: { rideId },
    }).catch((e) => console.error(e));

    return updated;
  }

  /**
   * Complete ride, calculate final fare, and credit driver wallet atomically.
   * Payout Policy: Platform absorbs customer coupon discounts.
   * Driver receives 80% commission based on the Gross Trip Fare.
   */
  async completeRide(rideId: string) {
    const updatedRide = await prisma.$transaction(async (tx) => {
      const ride = await tx.ride.findUnique({
        where: { id: rideId },
        include: {
          fareBreakdown: true,
          driver: { include: { wallet: true } },
        },
      });

      if (!ride) throw new Error('Ride not found');
      if (ride.status === 'COMPLETED') throw new Error('Ride is already completed');

      // Gross Fare Calculation: Total trip fare before promo discounts
      const customerPayable = ride.fareBreakdown ? ride.fareBreakdown.totalFare : ride.estimatedFare;
      const discountAmount = ride.fareBreakdown ? ride.fareBreakdown.discountAmount : 0;
      const grossTripFare = customerPayable + discountAmount;

      const finalFare = customerPayable;
      const completedAt = new Date();

      const updated = await tx.ride.update({
        where: { id: rideId },
        data: {
          status: 'COMPLETED',
          finalFare,
          completedAt,
          paymentStatus: 'PAID',
        },
        include: {
          customer: true,
          driver: { include: { user: true } },
          fareBreakdown: true,
        },
      });

      // Credit driver's wallet: 80% of Gross Trip Fare (Platform absorbs discount subsidy)
      if (ride.driver?.wallet) {
        const driverEarnings = Math.round(grossTripFare * 0.8 * 100) / 100;
        await tx.wallet.update({
          where: { id: ride.driver.wallet.id },
          data: {
            balance: { increment: driverEarnings },
            lifetimeEarnings: { increment: driverEarnings },
          },
        });

        await tx.walletTransaction.create({
          data: {
            walletId: ride.driver.wallet.id,
            amount: driverEarnings,
            type: 'EARNING',
            status: 'COMPLETED',
            description: `Earnings for trip ${ride.bookingCode} (Gross: ₹${grossTripFare}, Subsidy: ₹${discountAmount})`,
            referenceRideId: ride.id,
          },
        });
      }

      // Update customer and driver total rides
      await tx.customerProfile.updateMany({
        where: { userId: ride.customerId },
        data: { totalRides: { increment: 1 } },
      });

      if (ride.driverId) {
        await tx.driverProfile.update({
          where: { id: ride.driverId },
          data: { totalRides: { increment: 1 } },
        });
      }

      return updated;
    });

    // Send notifications to Customer and Driver
    notificationsService.sendToUser({
      userId: updatedRide.customerId,
      title: '🏁 Trip Completed!',
      message: `Total Fare: ₹${updatedRide.finalFare}. Thank you for choosing Golden Cabs!`,
      type: 'trip_completed',
      data: { rideId, amount: String(updatedRide.finalFare) },
    }).catch((e) => console.error(e));

    if (updatedRide.driver?.userId) {
      const grossFare = (updatedRide.fareBreakdown?.totalFare || 0) + (updatedRide.fareBreakdown?.discountAmount || 0);
      const driverPay = Math.round(grossFare * 0.8 * 100) / 100;
      notificationsService.sendToUser({
        userId: updatedRide.driver.userId,
        title: '💰 Trip Earnings Credited!',
        message: `₹${driverPay} has been added to your wallet for trip ${updatedRide.bookingCode}.`,
        type: 'wallet_credited',
        data: { rideId },
      }).catch((e) => console.error(e));
    }

    return updatedRide;
  }

  async getRideById(rideId: string) {
    return prisma.ride.findFirst({
      where: {
        OR: [{ id: rideId }, { bookingCode: rideId }],
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        driver: {
          include: {
            user: { select: { name: true, phone: true } },
            assignedVehicle: true,
          },
        },
        vehicle: true,
        fareBreakdown: true,
      },
    });
  }

  async getCustomerRides(customerId: string) {
    return prisma.ride.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: {
        driver: {
          include: {
            user: { select: { name: true, phone: true } },
            assignedVehicle: true,
          },
        },
        fareBreakdown: true,
      },
    });
  }

  async getDriverRides(driverUserId: string) {
    const driver = await prisma.driverProfile.findUnique({ where: { userId: driverUserId } });
    if (!driver) return [];

    const rides = await prisma.ride.findMany({
      where: { driverId: driver.id },
      orderBy: { createdAt: 'desc' },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        fareBreakdown: true,
      },
    });

    return rides.map(({ startOtp, ...safeRide }) => safeRide);
  }

  /**
   * Rides waiting for drivers to accept
   */
  async getAvailableRides(limit = 20, driverUserId?: string) {
    let driverProfileId: string | undefined;
    if (driverUserId) {
      const dp = await prisma.driverProfile.findUnique({
        where: { userId: driverUserId },
        select: { id: true },
      });
      driverProfileId = dp?.id;
    }

    const orConditions: Array<{ status: TripStatus; driverId?: string | null }> = [
      { status: TripStatus.SEARCHING, driverId: null },
    ];
    if (driverProfileId) {
      orConditions.push({ status: TripStatus.SEARCHING, driverId: driverProfileId });
    } else {
      orConditions.push({ status: TripStatus.SEARCHING });
      orConditions.push({ status: TripStatus.ACCEPTED });
    }

    // Only return live requests created within the last 15 minutes
    const freshnessCutoff = new Date(Date.now() - 15 * 60 * 1000);

    const rides = await prisma.ride.findMany({
      where: {
        OR: orConditions,
        createdAt: { gte: freshnessCutoff },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        fareBreakdown: true,
      },
    });

    return rides.map((r) => ({
      id: r.id,
      bookingCode: r.bookingCode,
      customerName: r.customer?.name || 'Customer',
      customerPhone: r.customer?.phone || '',
      customerRating: 4.8,
      pickupLocation: r.pickupLocation,
      pickupAddress: r.pickupAddress || r.pickupLocation,
      dropLocation: r.dropLocation,
      dropAddress: r.dropAddress || r.dropLocation,
      distance: `${r.distanceKm} km`,
      distanceKm: r.distanceKm,
      estimatedFare: `₹ ${Math.round(r.fareBreakdown?.totalFare ?? r.estimatedFare ?? 0)}`,
      fareAmount: r.fareBreakdown?.totalFare ?? r.estimatedFare ?? 0,
      paymentMethod: r.paymentMethod,
      tripType: r.tripType,
      status: r.status,
      date: r.createdAt ? r.createdAt.toISOString() : new Date().toISOString(),
      time: r.createdAt
        ? new Date(r.createdAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        : 'Now',
      pickupLat: r.pickupLat,
      pickupLng: r.pickupLng,
      dropLat: r.dropLat,
      dropLng: r.dropLng,
      createdAt: r.createdAt,
    }));
  }
}

export const ridesService = new RidesService();
