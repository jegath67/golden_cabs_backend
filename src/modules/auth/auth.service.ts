import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { prisma } from '../../config/prisma';

export type OtpPurpose = 'LOGIN' | 'REGISTER' | 'RESET_PASSWORD';

export interface OtpRecord {
  otp: string;
  expiresAt: number;
  purpose: OtpPurpose;
  attempts: number;
  createdAt: number;
}

// In-memory OTP cache for demo/testing (in production, integrate SMS gateway e.g. Fast2SMS / Twilio)
const otpStore = new Map<string, OtpRecord>();

// In-memory rate limiter tracking timestamps of OTP requests per normalized phone
const otpRequestTimestamps = new Map<string, number[]>();

/**
 * Normalizes phone numbers:
 * - Trims whitespace and removes common formatting characters (spaces, dashes, parens)
 * - Strips +91 or 91 country code when 10 digits follow
 * - Strips leading 0 when 10 digits follow
 */
export function normalizePhone(phone: string): string {
  if (!phone || typeof phone !== 'string') return '';
  let clean = phone.trim().replace(/[\s\-\(\)]/g, '');
  if (clean.startsWith('+91') && clean.length === 13) {
    clean = clean.slice(3);
  } else if (clean.startsWith('91') && clean.length === 12) {
    clean = clean.slice(2);
  } else if (clean.startsWith('0') && clean.length === 11) {
    clean = clean.slice(1);
  }
  return clean;
}

/**
 * Strict check for development environment.
 * Default is ALWAYS secure/production if NODE_ENV is unset, empty, 'production', 'staging', or 'test'.
 * Development test OTP is ONLY permitted when NODE_ENV is explicitly 'development'
 * and not overridden by DISABLE_DEV_OTP=true.
 */
export function isDevOtpEnabled(): boolean {
  const env = (process.env.NODE_ENV || '').trim().toLowerCase();
  if (env !== 'development') {
    return false;
  }
  if (process.env.DISABLE_DEV_OTP === 'true') {
    return false;
  }
  return true;
}

export class AuthService {
  /**
   * Helper to inspect OTP record state in tests
   */
  getOtpRecord(phone: string) {
    return otpStore.get(normalizePhone(phone));
  }

  /**
   * Helper to clear OTP store and rate limit counters in tests
   */
  clearOtpStore() {
    otpStore.clear();
    otpRequestTimestamps.clear();
  }

  /**
   * Rate limit check for OTP issuance:
   * Production: max 3 requests per 60 seconds per phone.
   * Development: relaxed to 50 requests per 60 seconds to allow rapid automated test suites.
   */
  private checkOtpRateLimit(cleanPhone: string) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = isDevOtpEnabled() ? 50 : 3;

    const timestamps = (otpRequestTimestamps.get(cleanPhone) || []).filter(
      (ts) => now - ts < windowMs
    );

    if (timestamps.length >= maxRequests) {
      const err: any = new Error('Too many OTP requests. Please wait before trying again.');
      err.statusCode = 429;
      throw err;
    }

    timestamps.push(now);
    otpRequestTimestamps.set(cleanPhone, timestamps);
  }

  /**
   * Generate and send OTP to phone.
   * Securely binds OTP to the requested purpose (LOGIN, REGISTER, or RESET_PASSWORD).
   * Uses cryptographically secure random numbers outside development.
   * Never logs raw OTP or full phone number.
   * Never exposes devOtp in production responses.
   */
  async sendOtp(phone: string, intent?: 'REGISTER' | 'LOGIN' | 'RESET_PASSWORD' | string) {
    if (!phone || typeof phone !== 'string' || phone.trim().length === 0) {
      const err: any = new Error('Phone number is required');
      err.statusCode = 400;
      throw err;
    }

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      const err: any = new Error('Valid 10-digit mobile number is required');
      err.statusCode = 400;
      throw err;
    }

    // Enforce rate limiting per phone number
    this.checkOtpRateLimit(cleanPhone);

    // Normalize purpose/intent
    let purpose: OtpPurpose = 'LOGIN';
    if (intent) {
      const upper = intent.toUpperCase().replace('-', '_');
      if (upper.includes('RESET') || upper.includes('PASSWORD')) {
        purpose = 'RESET_PASSWORD';
      } else if (upper.includes('REG')) {
        purpose = 'REGISTER';
      } else if (upper.includes('LOG')) {
        purpose = 'LOGIN';
      }
    }

    if (purpose === 'REGISTER') {
      const existing = await prisma.user.findUnique({
        where: { phone: cleanPhone },
      });
      if (existing) {
        throw new Error('This mobile number is already registered. Please login to continue.');
      }
    }

    if (purpose === 'LOGIN') {
      const existing = await prisma.user.findUnique({
        where: { phone: cleanPhone },
      });
      if (!existing) {
        throw new Error('No account found with this mobile number. Please register to get started.');
      }
    }

    if (purpose === 'RESET_PASSWORD') {
      const existing = await prisma.user.findUnique({
        where: { phone: cleanPhone },
        include: { driverProfile: true },
      });
      if (!existing) {
        throw new Error('No account found with this mobile number. Please register to get started.');
      }
      if (existing.role === 'DRIVER') {
        if (!existing.isActive) {
          throw new Error('Account is inactive or suspended. Please contact support.');
        }
        if (existing.driverProfile?.approvalStatus === 'REJECTED') {
          const reason = existing.driverProfile.rejectionReason
            ? ` Reason: ${existing.driverProfile.rejectionReason}`
            : '';
          throw new Error(`Driver account has been rejected.${reason}`);
        }
      }
    }

    // Generate 6-digit OTP: fixed '123456' ONLY when explicitly in development mode;
    // in all other modes (production, staging, unset NODE_ENV), generate a cryptographically uniform 6-digit OTP.
    const otp = isDevOtpEnabled()
      ? '123456'
      : crypto.randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    otpStore.set(cleanPhone, {
      otp,
      expiresAt,
      purpose,
      attempts: 0,
      createdAt: Date.now(),
    });

    // Non-sensitive operational logging (never log OTP or unmasked phone number)
    const maskedPhone =
      cleanPhone.length >= 4 ? `${'*'.repeat(Math.max(0, cleanPhone.length - 4))}${cleanPhone.slice(-4)}` : '****';
    console.log(`[AUTH] OTP requested for phone ${maskedPhone} (purpose: ${purpose})`);

    return {
      phone: cleanPhone,
      message: 'OTP sent successfully',
      // In development mode only: return devOtp so local testing is effortless
      ...(isDevOtpEnabled() ? { devOtp: otp } : {}),
    };
  }

  /**
   * Verify OTP and Login / Register Customer or Driver.
   * Enforces matching OTP record, expiry, purpose binding, and one-time use.
   */
  async verifyOtpAndLogin(
    phone: string,
    otp: string,
    role: 'CUSTOMER' | 'DRIVER' = 'CUSTOMER',
    name?: string
  ) {
    if (!phone || !otp) {
      const err: any = new Error('Phone and OTP are required');
      err.statusCode = 400;
      throw err;
    }

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      const err: any = new Error('Valid 10-digit mobile number is required');
      err.statusCode = 400;
      throw err;
    }

    // 1. Verify OTP record exists and is not expired
    const record = otpStore.get(cleanPhone);
    if (!record || record.expiresAt <= Date.now()) {
      otpStore.delete(cleanPhone);
      throw new Error('Invalid or expired OTP');
    }

    // 2. Purpose binding check: login/register must not consume an OTP issued for reset password
    if (record.purpose !== 'LOGIN' && record.purpose !== 'REGISTER') {
      throw new Error('OTP is not valid for login. Please request a new OTP.');
    }

    // 3. Brute force / attempt counter protection
    record.attempts += 1;
    if (record.attempts > 5) {
      otpStore.delete(cleanPhone);
      throw new Error('Too many failed OTP attempts. Please request a new OTP.');
    }

    const cleanOtp = otp ? otp.trim() : '';

    // Enforce OTP match against the stored record.
    // Development mode may accept '123456' if explicitly enabled,
    // but in all other modes (production, staging, unset NODE_ENV), only the stored unexpired OTP matches.
    const isRecordMatch = record.otp === cleanOtp;
    const isDevBypass = isDevOtpEnabled() && cleanOtp === '123456';
    const isValid = isRecordMatch || isDevBypass;

    if (!isValid) {
      throw new Error('Invalid or expired OTP');
    }

    // Clear OTP after successful verification (one-time use)
    otpStore.delete(cleanPhone);

    // 4. Find or create user
    let user = await prisma.user.findUnique({
      where: { phone: cleanPhone },
      include: {
        customerProfile: true,
        driverProfile: true,
      },
    });

    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      user = await prisma.user.create({
        data: {
          phone: cleanPhone,
          name: name || (role === 'DRIVER' ? 'New Driver' : 'New Customer'),
          role,
          customerProfile:
            role === 'CUSTOMER'
              ? {
                  create: {},
                }
              : undefined,
          driverProfile:
            role === 'DRIVER'
              ? {
                  create: {
                    personaType: 'DRIVE_ONLY',
                    wallet: {
                      create: {
                        balance: 0,
                      },
                    },
                  },
                }
              : undefined,
        },
        include: {
          customerProfile: true,
          driverProfile: true,
        },
      });
    } else {
      // If user exists but role profile is missing, create it
      if (role === 'CUSTOMER' && !user.customerProfile) {
        await prisma.customerProfile.create({
          data: { userId: user.id },
        });
      } else if (role === 'DRIVER' && !user.driverProfile) {
        await prisma.driverProfile.create({
          data: {
            userId: user.id,
            personaType: 'DRIVE_ONLY',
            wallet: {
              create: {
                balance: 0,
              },
            },
          },
        });
      }

      // Re-fetch complete user
      user = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        include: {
          customerProfile: true,
          driverProfile: true,
        },
      });
    }

    return {
      user,
      isNewUser,
    };
  }

  /**
   * Verified OTP-based Password Setup and Reset.
   * Atomic verification: verifies phone ownership, checks purpose, enforces rate limits,
   * consumes OTP (one-time use), validates password policy, and updates bcrypt hash.
   */
  async resetPassword(phone: string, otp: string, newPassword: string) {
    if (!phone || !otp || !newPassword) {
      const err: any = new Error('Phone number, OTP, and new password are required');
      err.statusCode = 400;
      throw err;
    }

    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      const err: any = new Error('Valid 10-digit mobile number is required');
      err.statusCode = 400;
      throw err;
    }

    // Password policy check: minimum 6 characters, maximum 128 characters
    if (typeof newPassword !== 'string' || newPassword.trim().length < 6) {
      const err: any = new Error('Password must be at least 6 characters');
      err.statusCode = 400;
      throw err;
    }
    if (newPassword.length > 128) {
      const err: any = new Error('Password exceeds maximum allowed length');
      err.statusCode = 400;
      throw err;
    }

    // 1. Check OTP record
    const record = otpStore.get(cleanPhone);
    if (!record || record.expiresAt <= Date.now()) {
      otpStore.delete(cleanPhone);
      const err: any = new Error('Invalid or expired OTP');
      err.statusCode = 400;
      throw err;
    }

    // 2. Strict purpose binding: must be RESET_PASSWORD
    if (record.purpose !== 'RESET_PASSWORD') {
      const err: any = new Error('OTP was not issued for password reset. Please request a new OTP.');
      err.statusCode = 400;
      throw err;
    }

    // 3. Brute force / attempt counter protection
    record.attempts += 1;
    if (record.attempts > 5) {
      otpStore.delete(cleanPhone);
      const err: any = new Error('Too many failed OTP attempts. Please request a new OTP.');
      err.statusCode = 400;
      throw err;
    }

    const cleanOtp = otp.trim();
    const isRecordMatch = record.otp === cleanOtp;
    const isDevBypass = isDevOtpEnabled() && cleanOtp === '123456';
    const isValid = isRecordMatch || isDevBypass;

    if (!isValid) {
      const err: any = new Error('Invalid or expired OTP');
      err.statusCode = 400;
      throw err;
    }

    // 4. Consume OTP immediately (one-time use, cannot be reused)
    otpStore.delete(cleanPhone);

    // 5. Verify user existence & eligibility (never create unknown accounts)
    const user = await prisma.user.findUnique({
      where: { phone: cleanPhone },
      include: { driverProfile: true },
    });

    if (!user) {
      const err: any = new Error('No account found with this mobile number');
      err.statusCode = 404;
      throw err;
    }

    if (!user.isActive) {
      const err: any = new Error('Account is inactive or suspended. Please contact support.');
      err.statusCode = 403;
      throw err;
    }

    // If driver, check driver profile & approval status
    if (user.role === 'DRIVER') {
      if (!user.driverProfile) {
        const err: any = new Error('Driver profile not found');
        err.statusCode = 400;
        throw err;
      }
      if (user.driverProfile.approvalStatus === 'REJECTED') {
        const reason = user.driverProfile.rejectionReason ? ` Reason: ${user.driverProfile.rejectionReason}` : '';
        const err: any = new Error(`Driver account has been rejected.${reason}`);
        err.statusCode = 403;
        throw err;
      }
    }

    // 6. Hash new password with project's established work factor (10)
    const cleanNewPassword = newPassword.trim();
    const hashedPassword = await bcrypt.hash(cleanNewPassword, 10);

    // 7. Persist password hash safely
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hashedPassword },
    });

    // Operational logging: never log password, hash, or unmasked phone
    const maskedPhone =
      cleanPhone.length >= 4 ? `${'*'.repeat(Math.max(0, cleanPhone.length - 4))}${cleanPhone.slice(-4)}` : '****';
    console.log(`[AUTH] Password successfully updated for user with phone ${maskedPhone}`);

    return {
      success: true,
      message: 'Password updated successfully',
    };
  }

  /**
   * Driver Login for all 3 Personas (Own Vehicle, Drive Only, Rental)
   * Strictly enforces password verification and APPROVED status.
   * Never auto-creates unknown drivers or auto-approves accounts.
   * Lazy migration removed: accounts without passwordHash are rejected with HTTP 401.
   */
  async driverLogin(phone: string, password?: string, personaType?: string) {
    if (!phone || !password || typeof password !== 'string' || password.trim().length === 0) {
      const err: any = new Error('Phone number and password are required');
      err.statusCode = 400;
      throw err;
    }

    const cleanPhone = normalizePhone(phone);
    const cleanPassword = password.trim();

    let normalizedPersona: 'DRIVE_ONLY' | 'OWN_VEHICLE' | 'RENTAL' = 'OWN_VEHICLE';
    if (personaType) {
      const upper = personaType.toUpperCase().replace('-', '_');
      if (upper.includes('RENT')) normalizedPersona = 'RENTAL';
      else if (upper.includes('DRIVE_ONLY') || upper === 'DRIVEONLY') normalizedPersona = 'DRIVE_ONLY';
      else normalizedPersona = 'OWN_VEHICLE';
    }

    const user = await prisma.user.findUnique({
      where: { phone: cleanPhone },
      include: {
        driverProfile: {
          include: {
            assignedVehicle: true,
            wallet: true,
          },
        },
      },
    });

    // 1. Enforce registered driver existence and role (never auto-create or elevate unknown accounts)
    if (!user || user.role !== 'DRIVER' || !user.driverProfile) {
      const err: any = new Error('Invalid credentials');
      err.statusCode = 401;
      throw err;
    }

    // 2. Enforce active account status
    if (!user.isActive) {
      const err: any = new Error('Account is inactive or suspended. Please contact support.');
      err.statusCode = 401;
      throw err;
    }

    // 3. Enforce admin approval status (strictly prevent unapproved/rejected drivers from obtaining active sessions)
    if (user.driverProfile.approvalStatus !== 'APPROVED') {
      if (user.driverProfile.approvalStatus === 'REJECTED') {
        const reason = user.driverProfile.rejectionReason ? ` Reason: ${user.driverProfile.rejectionReason}` : '';
        const err: any = new Error(`Driver account has been rejected.${reason}`);
        err.statusCode = 401;
        throw err;
      }
      const err: any = new Error('Driver account is pending admin approval.');
      err.statusCode = 401;
      throw err;
    }

    // 4. Enforce password verification
    // Lazy migration removed: If passwordHash is missing or null, reject login with HTTP 401
    // and a safe message directing the driver to the verified password setup/reset flow.
    if (!user.passwordHash) {
      const err: any = new Error(
        'Password not set up for this account. Please set up your password using OTP verification.'
      );
      err.statusCode = 401;
      throw err;
    }

    const isMatch = await bcrypt.compare(cleanPassword, user.passwordHash);
    if (!isMatch) {
      const err: any = new Error('Invalid credentials');
      err.statusCode = 401;
      throw err;
    }

    // 5. Update personaType if provided, without modifying approvalStatus
    if (personaType && user.driverProfile.personaType !== normalizedPersona) {
      await prisma.driverProfile.update({
        where: { id: user.driverProfile.id },
        data: { personaType: normalizedPersona },
      });
      user.driverProfile.personaType = normalizedPersona;
    }

    return user;
  }

  /**
   * Admin / Dispatcher Login via Password
   */
  async adminLogin(identifier: string, password: string) {
    const cleanId = identifier ? identifier.trim() : '';
    const normalizedPhone = normalizePhone(cleanId);

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: cleanId.toLowerCase() },
          { phone: cleanId },
          ...(normalizedPhone ? [{ phone: normalizedPhone }] : []),
        ],
        role: { in: ['ADMIN', 'DISPATCHER'] },
      },
    });

    if (!user || !user.passwordHash) {
      throw new Error('Invalid credentials');
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      throw new Error('Invalid credentials');
    }

    return user;
  }

  /**
   * Get user details by ID
   */
  async getUserProfile(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      include: {
        customerProfile: true,
        driverProfile: {
          include: {
            wallet: true,
            assignedVehicle: true,
            assignedHub: true,
          },
        },
      },
    });
  }

  /**
   * Update authenticated customer or user profile.
   * Only allows safe, non-privileged fields.
   */
  async updateProfile(userId: string, data: {
    name?: string;
    email?: string;
    gender?: string;
    dob?: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
  }) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { customerProfile: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const userUpdates: any = {};

    if (data.name !== undefined) {
      const trimmed = data.name.trim();
      if (!trimmed) throw new Error('Name cannot be empty');
      userUpdates.name = trimmed;
    }

    if (data.email !== undefined) {
      const trimmedEmail = data.email ? data.email.trim().toLowerCase() : '';
      if (trimmedEmail) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(trimmedEmail)) {
          throw new Error('Invalid email address format');
        }
        if (trimmedEmail !== user.email) {
          const existing = await prisma.user.findUnique({ where: { email: trimmedEmail } });
          if (existing && existing.id !== userId) {
            const err: any = new Error('Email is already registered with another account');
            err.statusCode = 409;
            throw err;
          }
        }
        userUpdates.email = trimmedEmail;
      } else {
        userUpdates.email = null;
      }
    }

    const profileUpdates: any = {};
    if (data.gender !== undefined) profileUpdates.gender = data.gender ? data.gender.trim() : null;
    if (data.dob !== undefined) profileUpdates.dob = data.dob ? data.dob.trim() : null;
    if ((data as any).emergencyContact !== undefined) profileUpdates.emergencyContact = (data as any).emergencyContact ? (data as any).emergencyContact.trim() : null;
    if (data.address !== undefined) {
      profileUpdates.address = data.address ? data.address.trim() : null;
    } else if (data.city || data.state || data.pincode) {
      const parts = [data.city, data.state, data.pincode].filter(Boolean);
      profileUpdates.address = parts.join(', ');
    }

    return prisma.$transaction(async (tx) => {
      if (Object.keys(userUpdates).length > 0) {
        await tx.user.update({
          where: { id: userId },
          data: userUpdates,
        });
      }

      if (Object.keys(profileUpdates).length > 0) {
        await tx.customerProfile.upsert({
          where: { userId },
          create: {
            userId,
            ...profileUpdates,
          },
          update: profileUpdates,
        });
      }

      return tx.user.findUnique({
        where: { id: userId },
        include: {
          customerProfile: true,
          driverProfile: true,
        },
      });
    });
  }
}

export const authService = new AuthService();
