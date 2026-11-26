import { Server as SocketIOServer, Socket } from 'socket.io';
import type { Server as HttpServer } from 'http';
import { prisma } from '../../config/prisma';
import { locationCacheService, DriverLocationData } from '../drivers/location-cache.service';
import { TripStatus, UserRole } from '../../generated/prisma/enums';

export interface AuthenticatedUser {
  id: string; // User.id
  phone: string;
  role: UserRole;
}

export interface AuthenticatedSocket extends Socket {
  data: {
    user: AuthenticatedUser;
  };
}

export interface DriverLocationPayload {
  updateId?: string;
  latitude: number;
  longitude: number;
  heading?: number;
  speed?: number;
  accuracy?: number;
  rideId?: string;
  timestamp?: number;
  clientTimestamp?: number;
}

export class SocketService {
  private io: SocketIOServer | null = null;
  private readonly ACTIVE_TRACKING_STATUSES: TripStatus[] = [
    TripStatus.SEARCHING,
    TripStatus.ACCEPTED,
    TripStatus.EN_ROUTE,
    TripStatus.ARRIVED,
    TripStatus.ONGOING,
  ];

  private readonly ADMIN_ROLES: UserRole[] = [
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.ZONE_ADMIN,
    UserRole.DISPATCHER,
  ];

  /**
   * Initializes the Socket.IO server on top of Fastify's HTTP server.
   */
  init(server: HttpServer, jwtVerifier: (token: string) => any) {
    if (this.io) {
      console.warn('[Socket.IO] Server is already initialized.');
      return this.io;
    }

    this.io = new SocketIOServer(server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: 20000,
      pingInterval: 10000,
      transports: ['websocket', 'polling'],
    });

    // ─────────────────────────────────────────────────────────────
    // 1. HANDSHAKE AUTHENTICATION MIDDLEWARE
    // ─────────────────────────────────────────────────────────────
    this.io.use(async (socket, next) => {
      try {
        const authHeader = socket.handshake.headers?.authorization;
        let token =
          socket.handshake.auth?.token ||
          (authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader) ||
          (socket.handshake.query?.token as string | undefined);

        if (!token) {
          return next(new Error('Unauthorized: Authentication token is missing'));
        }

        token = String(token).trim();
        if (token.startsWith('Bearer ')) {
          token = token.slice(7).trim();
        }

        const decoded = (await jwtVerifier(token)) as { id?: string; phone?: string; role?: string };
        if (!decoded || !decoded.id) {
          return next(new Error('Unauthorized: Invalid token payload'));
        }

        (socket as AuthenticatedSocket).data.user = {
          id: decoded.id,
          phone: decoded.phone || '',
          role: decoded.role as UserRole,
        };

        return next();
      } catch (err: any) {
        console.warn(`[Socket.IO] Auth handshake rejected for socket ${socket.id}: ${err.message}`);
        return next(new Error('Unauthorized: ' + (err.message || 'Token verification failed')));
      }
    });

    // ─────────────────────────────────────────────────────────────
    // 2. SOCKET CONNECTION & EVENT DISPATCHING
    // ─────────────────────────────────────────────────────────────
    this.io.on('connection', (rawSocket) => {
      const socket = rawSocket as AuthenticatedSocket;
      const user = socket.data.user;

      console.log(`[Socket.IO] Client connected: ${socket.id} (User: ${user.id}, Role: ${user.role})`);

      // ── Event: join_ride_tracking (Customer / Assigned Driver / Admin) ──
      socket.on(
        'join_ride_tracking',
        async (
          payload: { rideId?: string },
          callback?: (res: { success: boolean; error?: string; room?: string; rideId?: string; status?: string }) => void
        ) => {
          try {
            if (!payload || !payload.rideId) {
              return callback?.({ success: false, error: 'rideId is required' });
            }

            const cleanRideId = String(payload.rideId).replace(/^#/, '').trim();
            const ride = await prisma.ride.findFirst({
              where: {
                OR: [{ id: cleanRideId }, { bookingCode: cleanRideId }],
              },
              select: {
                id: true,
                bookingCode: true,
                customerId: true,
                driverId: true,
                status: true,
              },
            });

            if (!ride) {
              return callback?.({ success: false, error: `Ride ${payload.rideId} not found` });
            }

            // Verify active ride status
            if (!this.ACTIVE_TRACKING_STATUSES.includes(ride.status)) {
              return callback?.({
                success: false,
                error: `Ride is ${ride.status.toLowerCase()}. Live tracking is only available for active rides.`,
              });
            }

            // Strict Ride Authorization Check
            let isAuthorized = false;

            if (this.ADMIN_ROLES.includes(user.role)) {
              isAuthorized = true;
            } else if (user.role === UserRole.CUSTOMER) {
              // Customer must be the owner of the ride
              if (ride.customerId === user.id) {
                isAuthorized = true;
              }
            } else if (user.role === UserRole.DRIVER) {
              // Driver must be assigned to this ride
              const driverId = await locationCacheService.getDriverIdForUser(user.id);
              if (driverId && ride.driverId === driverId) {
                isAuthorized = true;
              }
            }

            if (!isAuthorized) {
              console.warn(
                `[Socket.IO] Unauthorized join_ride_tracking attempt by user ${user.id} (${user.role}) for ride ${ride.id}`
              );
              return callback?.({
                success: false,
                error: 'Forbidden: You are not authorized to track this ride',
              });
            }

            const roomName = `ride_${ride.id}`;
            await socket.join(roomName);
            console.log(`[Socket.IO] Socket ${socket.id} (User: ${user.id}) joined room ${roomName}`);

            callback?.({
              success: true,
              room: roomName,
              rideId: ride.id,
              status: ride.status,
            });

            // Immediately emit last-known driver location to newly joined socket if available
            if (ride.driverId) {
              const lastLoc = await locationCacheService.getDriverLocation(ride.driverId);
              if (lastLoc) {
                socket.emit('driver_location_pushed', {
                  driverId: ride.driverId,
                  rideId: ride.id,
                  latitude: lastLoc.latitude,
                  longitude: lastLoc.longitude,
                  heading: 0,
                  speed: 0,
                  accuracy: 0,
                  timestamp: Date.now(),
                  isInitial: true,
                });
              }
            }
          } catch (err: any) {
            console.error('[Socket.IO] Error in join_ride_tracking:', err);
            callback?.({ success: false, error: err.message || 'Internal server error' });
          }
        }
      );

      // ── Event: leave_ride_tracking ──
      socket.on(
        'leave_ride_tracking',
        async (payload: { rideId?: string }, callback?: (res: { success: boolean }) => void) => {
          try {
            if (payload?.rideId) {
              const cleanRideId = String(payload.rideId).replace(/^#/, '').trim();
              await socket.leave(`ride_${cleanRideId}`);
            }
            callback?.({ success: true });
          } catch (_) {
            callback?.({ success: false });
          }
        }
      );

      // ── Event: join_admin_fleet (Authorized Staff & Admins Only) ──
      socket.on('join_admin_fleet', async (_payload: any, callback?: (res: { success: boolean; error?: string; room?: string }) => void) => {
        try {
          if (!this.ADMIN_ROLES.includes(user.role)) {
            console.warn(`[Socket.IO] Unauthorized join_admin_fleet attempt by user ${user.id} (${user.role})`);
            return callback?.({
              success: false,
              error: 'Forbidden: Admin authorization required',
            });
          }

          const roomName = 'admin_live_fleet';
          await socket.join(roomName);
          console.log(`[Socket.IO] Admin ${user.id} (${user.role}) joined ${roomName}`);

          callback?.({ success: true, room: roomName });
        } catch (err: any) {
          callback?.({ success: false, error: err.message || 'Internal server error' });
        }
      });

      // ── Event: leave_admin_fleet ──
      socket.on('leave_admin_fleet', async (_payload: any, callback?: (res: { success: boolean }) => void) => {
        try {
          await socket.leave('admin_live_fleet');
          callback?.({ success: true });
        } catch (_) {
          callback?.({ success: false });
        }
      });

      // ── Event: driver_location_update (Driver GPS Ingestion) ──
      socket.on(
        'driver_location_update',
        async (
          data: DriverLocationPayload,
          callback?: (res: {
            success: boolean;
            error?: string;
            version?: number;
            timestamp?: number;
            duplicate?: boolean;
            stale?: boolean;
          }) => void
        ) => {
          try {
            if (user.role !== UserRole.DRIVER) {
              return callback?.({
                success: false,
                error: 'Forbidden: Only drivers can stream GPS location',
              });
            }

            if (
              !data ||
              typeof data.latitude !== 'number' ||
              typeof data.longitude !== 'number' ||
              isNaN(data.latitude) ||
              isNaN(data.longitude)
            ) {
              return callback?.({ success: false, error: 'Valid latitude and longitude are required' });
            }

            if (data.latitude < -90 || data.latitude > 90 || data.longitude < -180 || data.longitude > 180) {
              return callback?.({ success: false, error: 'Coordinates out of realistic geographic bounds' });
            }

            // Resolve driverProfile.id using multi-tier cache
            const driverId = await locationCacheService.getDriverIdForUser(user.id);
            if (!driverId) {
              return callback?.({ success: false, error: 'Driver profile not found' });
            }

            let cleanRideId: string | undefined;
            if (data.rideId && String(data.rideId).trim().length > 0) {
              cleanRideId = String(data.rideId).replace(/^#/, '').trim();
              // Validate driver ownership of active ride
              await locationCacheService.validateActiveRide(cleanRideId, driverId);
            }

            // MANDATORY REQUIREMENT 1 & 5:
            // Reuse existing LocationCacheService (handles deduplication, versioning, Redis, and 5s batch DB flush)
            const cached = await locationCacheService.saveDriverLocation(driverId, {
              userId: user.id,
              updateId: data.updateId,
              latitude: data.latitude,
              longitude: data.longitude,
              heading: data.heading,
              speed: data.speed,
              accuracy: data.accuracy,
              rideId: cleanRideId,
              clientTimestamp: data.clientTimestamp ?? data.timestamp,
              timestamp: data.timestamp,
            });

            // Suppress broadcast for duplicate or stale packets (Conditions 6 & 7)
            if (!cached.isDuplicate && !cached.isStale) {
              // Broadcast real-time location to authorized room subscribers
              this.broadcastDriverLocation(driverId, cached);
            }

            callback?.({
              success: true,
              version: cached.version,
              timestamp: cached.updatedAt,
              duplicate: !!cached.isDuplicate,
              stale: !!cached.isStale,
            });
          } catch (err: any) {
            console.error(`[Socket.IO] Error in driver_location_update from user ${user.id}:`, err);
            callback?.({ success: false, error: err.message || 'Failed to process location update' });
          }
        }
      );

      socket.on('disconnect', (reason) => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id} (User: ${user.id}, Reason: ${reason})`);
      });
    });

    console.log('🚀 [Socket.IO] Real-time tracking server initialized and listening.');
    return this.io;
  }

  /**
   * Broadcasts a validated driver location to the ride room and admin fleet room.
   * Can be invoked from the Socket handler OR from the HTTP fallback endpoint (/api/drivers/location).
   */
  broadcastDriverLocation(driverId: string, locationData: DriverLocationData) {
    if (!this.io) return;

    const payload = {
      driverId,
      rideId: locationData.rideId,
      latitude: locationData.latitude,
      longitude: locationData.longitude,
      heading: locationData.heading ?? 0,
      speed: locationData.speed ?? 0,
      accuracy: locationData.accuracy ?? 0,
      timestamp: locationData.updatedAt,
      version: locationData.version,
    };

    // 1. If assigned to an active ride, stream to that ride's isolated room
    if (locationData.rideId) {
      this.io.to(`ride_${locationData.rideId}`).emit('driver_location_pushed', payload);
    }

    // 2. Stream to authorized admin fleet room
    this.io.to('admin_live_fleet').emit('fleet_driver_location', {
      ...payload,
      userId: locationData.userId,
    });
  }

  /**
   * Broadcasts ride status transitions (e.g. ACCEPTED, ARRIVED, ONGOING, COMPLETED, CANCELLED).
   */
  broadcastRideStatus(rideId: string, status: TripStatus, data?: any) {
    if (!this.io) return;

    const cleanRideId = String(rideId).replace(/^#/, '').trim();
    const payload = {
      rideId: cleanRideId,
      status,
      data,
      timestamp: Date.now(),
    };

    this.io.to(`ride_${cleanRideId}`).emit('ride_status_updated', payload);
    this.io.to('admin_live_fleet').emit('fleet_ride_status_updated', payload);
  }

  /**
   * Broadcasts driver shift/online/availability status transitions.
   * Emitted to authorized admin fleet room.
   */
  broadcastDriverStatus(driverData: {
    driverId: string;
    userId: string;
    isOnline: boolean;
    shiftStatus: 'ON_SHIFT' | 'OFF_SHIFT' | string;
    personaType?: string;
    approvalStatus?: string;
    assignedVehicleId?: string | null;
    driver?: any;
  }) {
    if (!this.io) return;

    const payload = {
      ...driverData,
      timestamp: Date.now(),
    };

    this.io.to('admin_live_fleet').emit('driver_status_updated', payload);
    console.log(
      `[Socket.IO] Broadcasted driver_status_updated to admin_live_fleet for driver ${driverData.driverId} (isOnline: ${driverData.isOnline}, shiftStatus: ${driverData.shiftStatus})`
    );
  }

  /**
   * Broadcasts driver idle delay warning to the ride tracking room and admin fleet room.
   */
  broadcastDriverIdleAlert(rideId: string, payload: any) {
    if (!this.io) return;
    const cleanRideId = String(rideId).replace(/^#/, '').trim();
    this.io.to(`ride_${cleanRideId}`).emit('driver_idle_warning', payload);
    this.io.to('admin_live_fleet').emit('driver_idle_alert', payload);
  }

  /**
   * Returns the underlying SocketIOServer instance.
   */
  getIO(): SocketIOServer | null {
    return this.io;
  }

  /**
   * Graceful shutdown of Socket.IO server.
   */
  async close(): Promise<void> {
    if (this.io) {
      await new Promise<void>((resolve) => {
        this.io?.close(() => {
          resolve();
        });
      });
      this.io = null;
      console.log('[Socket.IO] Server closed cleanly.');
    }
  }
}

export const socketService = new SocketService();
