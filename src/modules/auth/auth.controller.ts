import type { FastifyReply, FastifyRequest } from 'fastify';
import { authService } from './auth.service';

export class AuthController {
  async sendOtp(req: FastifyRequest<any>, reply: FastifyReply) {
    const { phone, intent } = (req.body as any) || {};

    if (!phone) {
      return reply.status(400).send({
        success: false,
        message: 'Phone number is required',
      });
    }

    try {
      const result = await authService.sendOtp(phone, intent);
      return reply.send({
        success: true,
        ...result,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        message: error.message || 'Failed to send OTP',
      });
    }
  }

  async verifyOtp(req: FastifyRequest<any>, reply: FastifyReply) {
    const { phone, otp, role = 'CUSTOMER', name } = (req.body as any) || {};

    if (!phone || !otp) {
      return reply.status(400).send({
        success: false,
        message: 'Phone and OTP are required',
      });
    }

    try {
      const { user, isNewUser } = await authService.verifyOtpAndLogin(
        phone,
        otp,
        role,
        name
      );

      // Generate JWT Token using Fastify JWT instance
      const token = req.server.jwt.sign({
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      return reply.send({
        success: true,
        message: isNewUser ? 'Account created successfully' : 'Login successful',
        data: {
          token,
          user,
          isNewUser,
        },
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        message: error.message || 'OTP verification failed',
      });
    }
  }

  async adminLogin(req: FastifyRequest<any>, reply: FastifyReply) {
    const { identifier, password } = (req.body as any) || {};

    if (!identifier || !password) {
      return reply.status(400).send({
        success: false,
        message: 'Email/Phone and password are required',
      });
    }

    try {
      const user = await authService.adminLogin(identifier, password);

      const token = req.server.jwt.sign({
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      return reply.send({
        success: true,
        message: 'Admin login successful',
        data: {
          token,
          user,
        },
      });
    } catch (error: any) {
      return reply.status(401).send({
        success: false,
        message: error.message || 'Invalid credentials',
      });
    }
  }

  async driverLogin(req: FastifyRequest<any>, reply: FastifyReply) {
    const { phone, password, personaType } = (req.body as any) || {};

    if (!phone || !password) {
      return reply.status(400).send({
        success: false,
        message: 'Phone number and password are required',
      });
    }

    try {
      const user = await authService.driverLogin(phone, password, personaType);

      const token = req.server.jwt.sign({
        id: user.id,
        phone: user.phone,
        role: user.role,
      });

      return reply.send({
        success: true,
        message: 'Driver login successful',
        data: {
          token,
          user: {
            id: user.id,
            name: user.name,
            phone: user.phone,
            role: user.role,
          },
          driverProfile: user.driverProfile,
        },
      });
    } catch (error: any) {
      const message = error.message || 'Driver login failed';
      const statusCode = error.statusCode || (message.includes('required') ? 400 : 401);
      return reply.status(statusCode).send({
        success: false,
        message,
      });
    }
  }

  async resetPassword(req: FastifyRequest<any>, reply: FastifyReply) {
    const { phone, otp, newPassword } = (req.body as any) || {};

    if (!phone || !otp || !newPassword) {
      return reply.status(400).send({
        success: false,
        message: 'Phone number, OTP, and new password are required',
      });
    }

    try {
      const result = await authService.resetPassword(phone, otp, newPassword);
      return reply.send({
        success: true,
        message: result.message || 'Password updated successfully',
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        message: error.message || 'Failed to reset password',
      });
    }
  }

  async getMe(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const userPayload = req.user as { id: string };
      const user = await authService.getUserProfile(userPayload.id);
      if (!user) {
        return reply.status(404).send({
          success: false,
          message: 'User not found',
        });
      }

      return reply.send({
        success: true,
        data: user,
      });
    } catch (error) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to fetch user profile',
        error: String(error),
      });
    }
  }

  async updateProfile(req: FastifyRequest<any>, reply: FastifyReply) {
    const userPayload = req.user as { id: string };
    const body = (req.body as any) || {};

    if (typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({
        success: false,
        message: 'Invalid request body format',
      });
    }

    // Security Guard: Prevent privilege escalation and tampering with system keys
    const sanitizedData = { ...body };
    const forbiddenKeys = ['role', 'isActive', 'rating', 'totalRides', 'phone', 'id', 'passwordHash', 'createdAt', 'updatedAt'];
    for (const key of forbiddenKeys) {
      delete sanitizedData[key];
    }

    try {
      const updatedUser = await authService.updateProfile(userPayload.id, sanitizedData);
      return reply.send({
        success: true,
        message: 'Profile updated successfully',
        data: updatedUser,
      });
    } catch (error: any) {
      const statusCode = error.statusCode || 400;
      return reply.status(statusCode).send({
        success: false,
        message: error.message || 'Failed to update profile',
      });
    }
  }
}

export const authController = new AuthController();
