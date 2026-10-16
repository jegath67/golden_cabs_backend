import type { FastifyInstance } from 'fastify';
import { authController } from './auth.controller';
import { authenticate } from '../../middlewares/auth.middleware';

export async function authRoutes(app: FastifyInstance) {
  // Public routes
  app.post('/send-otp', authController.sendOtp.bind(authController));
  app.post('/verify-otp', authController.verifyOtp.bind(authController));
  app.post('/admin-login', authController.adminLogin.bind(authController));
  app.post('/driver-login', authController.driverLogin.bind(authController));
  app.post('/reset-password', authController.resetPassword.bind(authController));

  // Protected routes
  app.get('/me', { preHandler: [authenticate] }, authController.getMe.bind(authController));
  app.put('/profile', { preHandler: [authenticate] }, authController.updateProfile.bind(authController));
}
