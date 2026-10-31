import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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
import { zonesRoutes } from './modules/zones/zones.routes';
import { exploreRoutes } from './modules/explore/explore.routes';
import { eliteCarsRoutes } from './modules/elite-cars/elite-cars.routes';
import { bannersRoutes } from './modules/banners/banners.routes';
import { advertisingPartnersRoutes } from './modules/advertising-partners/advertising-partners.routes';
import { supportRoutes } from './modules/support/support.routes';
import { unavailabilityRoutes } from './modules/unavailability/unavailability.routes';
import { schedulerService } from './modules/scheduler/scheduler.service';

const uploadsDir = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const app = Fastify({
  logger: true,
  bodyLimit: 35 * 1024 * 1024, // 35 MB to comfortably accept document & photo uploads
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

// Serve uploaded document and profile images
app.get('/uploads/:filename', async (req, reply) => {
  const { filename } = req.params as { filename: string };
  const safeFilename = path.basename(filename);
  const filePath = path.join(uploadsDir, safeFilename);

  if (!fs.existsSync(filePath)) {
    return reply.status(404).send({ success: false, message: 'File not found' });
  }

  const ext = path.extname(safeFilename).toLowerCase();
  let contentType = 'application/octet-stream';
  if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
  else if (ext === '.png') contentType = 'image/png';
  else if (ext === '.webp') contentType = 'image/webp';
  else if (ext === '.gif') contentType = 'image/gif';
  else if (ext === '.pdf') contentType = 'application/pdf';

  const stream = fs.createReadStream(filePath);
  return reply.type(contentType).send(stream);
});

// Public image upload endpoint (accepts base64 or file buffer payload)
app.post('/api/upload', async (req, reply) => {
  try {
    const body = (req.body as any) || {};
    let base64Data = body.base64 || body.file;
    let originalName = body.filename || 'upload.jpg';

    if (!base64Data || typeof base64Data !== 'string') {
      return reply.status(400).send({ success: false, message: 'Base64 image data is required' });
    }

    // Strip data URI prefix if present (e.g. data:image/jpeg;base64,...)
    if (base64Data.includes(';base64,')) {
      base64Data = base64Data.split(';base64,')[1];
    }

    const ext = path.extname(originalName) || '.jpg';
    const uniqueName = `doc_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    const destinationPath = path.join(uploadsDir, uniqueName);

    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(destinationPath, buffer);

    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = req.headers.host || 'localhost:3000';
    const fileUrl = `${protocol}://${host}/uploads/${uniqueName}`;

    return reply.send({
      success: true,
      message: 'File uploaded successfully',
      data: {
        filename: uniqueName,
        url: fileUrl,
      },
    });
  } catch (error: any) {
    return reply.status(500).send({
      success: false,
      message: error?.message || 'File upload failed',
    });
  }
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
app.register(zonesRoutes, { prefix: '/api/zones' });
app.register(exploreRoutes, { prefix: '/api/explore' });
app.register(eliteCarsRoutes, { prefix: '/api/elite-cars' });
app.register(bannersRoutes, { prefix: '/api/banners' });
app.register(advertisingPartnersRoutes, { prefix: '/api/advertising-partners' });
app.register(supportRoutes, { prefix: '/api/support' });
app.register(unavailabilityRoutes, { prefix: '/api' });

const start = async () => {
  try {
    // Initialize Firebase Admin (Safe fallback if credentials missing)
    initFirebase();

    await app.listen({
      port: 3000,
      host: '0.0.0.0',
    });

    // Initialize background daily scheduler (midnight vehicle reset, etc.)
    schedulerService.init();

    console.log('🚀 Golden Cabs Backend running on http://localhost:3000');
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

start();