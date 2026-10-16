import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import { prisma } from './config/prisma';
import { initFirebase } from './config/firebase';
import { authRoutes } from './modules/auth/auth.routes';
import { adminRoutes } from './modules/admin/admin.routes';
import { notificationsRoutes } from './modules/notifications/notifications.routes';
import { hubsRoutes } from './modules/hubs/hubs.routes';
import { vehiclesRoutes } from './modules/vehicles/vehicles.routes';
import { driversRoutes } from './modules/drivers/drivers.routes';
import { ridesRoutes } from './modules/rides/rides.routes';
import { walletRoutes } from './modules/wallet/wallet.routes';
import { couponsRoutes } from './modules/coupons/coupons.routes';
import { refundsRoutes } from './modules/refunds/refunds.routes';
import { reviewsRoutes } from './modules/reviews/reviews.routes';

const app = Fastify({
  logger: true,
});

// Register CORS plugin
app.register(fastifyCors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});

// Register JWT plugin
app.register(fastifyJwt, {
  secret: process.env.JWT_SECRET || 'golden_cabs_super_secret_jwt_key_2026',
});

// Health check endpoint
app.get('/health', async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      success: true,
      message: 'Golden Cabs Backend is running',
      database: 'Connected to PostgreSQL',
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    return {
      success: false,
      message: 'Database connection failed',
      error: String(error),
    };
  }
});

// Register Module Routes
app.register(authRoutes, { prefix: '/api/auth' });
app.register(adminRoutes, { prefix: '/api/admin' });
app.register(notificationsRoutes, { prefix: '/api/notifications' });
app.register(hubsRoutes, { prefix: '/api/hubs' });
app.register(vehiclesRoutes, { prefix: '/api/vehicles' });
app.register(driversRoutes, { prefix: '/api/drivers' });
app.register(ridesRoutes, { prefix: '/api/rides' });
app.register(walletRoutes, { prefix: '/api/wallet' });
app.register(couponsRoutes, { prefix: '/api/coupons' });
app.register(refundsRoutes, { prefix: '/api/refunds' });
app.register(reviewsRoutes, { prefix: '/api' });

const start = async () => {
  try {
    // Initialize Firebase Admin (Safe fallback if credentials missing)
    initFirebase();

    await app.listen({
      port: 3000,
      host: '0.0.0.0',
    });

    console.log('🚀 Golden Cabs Backend running on http://localhost:3000');
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

start();