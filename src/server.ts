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
import { pricingSlabsRoutes } from './modules/pricing-slabs/pricing-slabs.routes';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { favoritesRoutes } from './modules/favorites/favorites.routes';
import { schedulerService } from './modules/scheduler/scheduler.service';
import { initRedis, isRedisAvailable, disconnectRedis } from './config/redis';
import { locationCacheService } from './modules/drivers/location-cache.service';
import { socketService } from './modules/socket/socket.service';
import { isCloudinaryConfigured, uploadBufferToCloudinary } from './config/cloudinary';

const uploadsDir = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(process.cwd(), 'uploads');
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

// Public image and document upload endpoint with size & MIME validation
const MAX_UPLOAD_SIZE_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB || '10', 10);
const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

function detectMimeAndExtension(buffer: Buffer): { mime: string; ext: string } | null {
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { mime: 'application/pdf', ext: '.pdf' };
  }
  return null;
}

app.post('/api/upload', async (req, reply) => {
  try {
    const body = (req.body as any) || {};
    let base64Data = body.base64 || body.file;

    if (!base64Data || typeof base64Data !== 'string') {
      return reply.status(400).send({ success: false, message: 'Base64 image or document data is required' });
    }

    // Strip data URI prefix if present (e.g. data:image/jpeg;base64,...)
    if (base64Data.includes(';base64,')) {
      base64Data = base64Data.split(';base64,')[1];
    }

    const buffer = Buffer.from(base64Data, 'base64');

    // 1. Validate empty payload
    if (buffer.length === 0) {
      return reply.status(400).send({ success: false, message: 'Uploaded file payload is empty' });
    }

    // 2. Validate max upload size
    if (buffer.length > MAX_UPLOAD_SIZE_BYTES) {
      return reply.status(413).send({
        success: false,
        message: `File size (${(buffer.length / (1024 * 1024)).toFixed(2)} MB) exceeds maximum allowed limit of ${MAX_UPLOAD_SIZE_MB} MB`,
      });
    }

    // 3. Validate real MIME type via magic bytes
    const detected = detectMimeAndExtension(buffer);
    if (!detected) {
      return reply.status(400).send({
        success: false,
        message: 'Unsupported file format. Only JPEG, PNG, WebP, and PDF documents are permitted.',
      });
    }

    // 4. Generate collision-resistant secure filename
    // 4. Generate collision-resistant secure filename
    const uniqueName = `doc_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${detected.ext}`;
    const destinationPath = path.join(uploadsDir, uniqueName);

    fs.writeFileSync(destinationPath, buffer);

    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const host = req.headers.host || 'localhost:3000';
    let fileUrl = `${protocol}://${host}/uploads/${uniqueName}`;

    // 5. Permanent Cloudinary storage upload if configured
    if (isCloudinaryConfigured()) {
      try {
        const publicId = uniqueName.replace(/\.[^/.]+$/, '');
        const cloudResult = await uploadBufferToCloudinary(buffer, {
          folder: 'golden_cabs/uploads',
          publicId,
          resourceType: detected.mime === 'application/pdf' ? 'raw' : 'image',
        });
        if (cloudResult && cloudResult.url) {
          fileUrl = cloudResult.url;
        }
      } catch (cloudErr) {
        console.error('[Upload] Cloudinary upload error, using local fallback:', cloudErr);
      }
    }

    return reply.send({
      success: true,
      message: 'File uploaded successfully',
      data: {
        filename: uniqueName,
        url: fileUrl,
        sizeBytes: buffer.length,
        sizeKb: Math.round(buffer.length / 1024),
        mimeType: detected.mime,
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
      redis: isRedisAvailable() ? 'Connected' : 'In-Memory Cache (Active)',
      locationCacheSync: 'Active (5s interval)',
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
app.register(pricingSlabsRoutes, { prefix: '/api/pricing-slabs' });
app.register(paymentsRoutes, { prefix: '/api/payments' });
app.register(favoritesRoutes, { prefix: '/api/customer/favorites' });

const start = async () => {
  try {
    // Initialize Firebase Admin (Safe fallback if credentials missing)
    initFirebase();

    // Initialize Redis (Safe non-blocking fallback to in-memory if standalone Redis is absent)
    initRedis();

    // Initialize background batch sync for real-time driver GPS locations (flushes dirty coords every 5s)
    locationCacheService.init(5000);

    const PORT = Number(process.env.PORT) || 3000;

    await app.listen({
      port: PORT,
      host: '0.0.0.0',
    });

    // Initialize real-time Socket.IO server on Fastify HTTP server with JWT verification
    socketService.init(app.server, (token: string) => app.jwt.verify(token));

    // Initialize background daily scheduler (midnight vehicle reset, etc.)
    schedulerService.init();

    console.log(`🚀 Golden Cabs Backend running on http://0.0.0.0:${PORT}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

// Graceful shutdown handling
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
signals.forEach((signal) => {
  process.on(signal, async () => {
    console.log(`\nReceived ${signal}. Gracefully shutting down...`);
    try {
      await socketService.close();
      const shutdownRes = await locationCacheService.destroy(10000);
      if (!shutdownRes.success) {
        console.warn(`[Shutdown] Completed with ${shutdownRes.unflushedCount} unflushed location records.`);
      }
      await disconnectRedis();
      await app.close();
      console.log('Server and location cache shut down cleanly.');
      process.exit(0);
    } catch (err) {
      console.error('Error during shutdown:', err);
      process.exit(1);
    }
  });
});

start();