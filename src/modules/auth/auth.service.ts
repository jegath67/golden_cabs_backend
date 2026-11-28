import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';
import {
  isValidAadhaar,
  isValidDrivingLicense,
  normalizeAadhaar,
  normalizeDrivingLicense,
} from '../../utils/document-validators';

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
 * Strict check for development / test environment OTP.
 * Default is ALWAYS secure/production if NODE_ENV is unset, empty, 'production', 'staging', or 'test'.
 * When ENABLE_TEST_OTP=true is explicitly set, test OTP (123456) is permitted even in production/staging.
 * DISABLE_DEV_OTP=true takes absolute precedence and disables test OTP under all conditions.
 */
export function isDevOtpEnabled(): boolean {
  if (process.env.DISABLE_DEV_OTP === 'true') {
    return false;
  }
  if (process.env.ENABLE_TEST_OTP === 'true') {
    return true;
  }
  const env = (process.env.NODE_ENV || '').trim().toLowerCase();
  return env === 'development';
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
  async sendOtp(phone: string, intent?: 'REGISTER' | 'LOGIN' | 'RESET_PASSWORD' | string, role?: string) {
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
      const existing = await prisma.user.findFirst({
        where: {
          OR: [
            { phone: cleanPhone },
            { phone: `+91${cleanPhone}` },
            { phone: `91${cleanPhone}` },
          ],
        },
      });
      if (existing) {
        throw new Error('This mobile number is already registered. Please login to continue.');
      }
    }

    if (purpose === 'LOGIN') {
      const isDriverRole = role?.toUpperCase() === 'DRIVER';

      if (isDriverRole) {
        const driverUser = await prisma.user.findFirst({
          where: {
            OR: [
              { phone: cleanPhone },
              { phone: `+91${cleanPhone}` },
              { phone: `91${cleanPhone}` },
            ],
          },
          include: { driverProfile: true },
        });

        if (!driverUser || !driverUser.driverProfile) {
          const err: any = new Error('No driver account found with this mobile number. Please register to get started.');
          err.statusCode = 404;
          err.code = 'DRIVER_NOT_FOUND';
          throw err;
        }
      } else {
        const existing = await prisma.user.findFirst({
          where: {
            OR: [
              { phone: cleanPhone },
              { phone: `+91${cleanPhone}` },
              { phone: `91${cleanPhone}` },
            ],
          },
        });
        if (!existing) {
          throw new Error('No account found with this mobile number. Please register to get started.');
        }
      }
    }

    if (purpose === 'RESET_PASSWORD') {
      const existing = await prisma.user.findFirst({
        where: {
          OR: [
            { phone: cleanPhone },
            { phone: `+91${cleanPhone}` },
            { phone: `91${cleanPhone}` },
          ],
        },
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
    name?: string,
    address?: string
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
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `91${cleanPhone}` },
        ],
      },
      include: {
        customerProfile: true,
        driverProfile: true,
      },
    });

    let isNewUser = false;

    // Strict separation for DRIVER role:
    // A driver must NOT be created as a database record upon simple OTP verification.
    // If user does not exist or has no driver profile, return isNewUser: true
    // so controller can generate a short-lived registrationToken.
    if (role === 'DRIVER') {
      if (!user || !user.driverProfile) {
        return {
          user: null,
          isNewUser: true,
          phone: cleanPhone,
          name: name && name.trim().length > 0 ? name.trim() : '',
        };
      }

      // Existing registered driver logging in
      if (name && name.trim().length > 0 && user.name === 'New Driver') {
        user = await prisma.user.update({
          where: { id: user.id },
          data: { name: name.trim() },
          include: {
            customerProfile: true,
            driverProfile: true,
          },
        });
      }

      return {
        user,
        isNewUser: false,
        phone: cleanPhone,
        name: user.name,
      };
    }

    if (!user) {
      isNewUser = true;
      user = await prisma.user.create({
        data: {
          phone: cleanPhone,
          name: name && name.trim().length > 0 ? name.trim() : 'New Customer',
          role: 'CUSTOMER',
          customerProfile: {
            create: {
              ...(address && address.trim().length > 0 ? { address: address.trim() } : {}),
            },
          },
        },
        include: {
          customerProfile: true,
          driverProfile: true,
        },
      });
    } else {
      const updates: any = {};
      if (name && name.trim().length > 0 && user.name === 'New Customer') {
        updates.name = name.trim();
      }
      if (user.phone !== cleanPhone) {
        updates.phone = cleanPhone;
      }
      if (Object.keys(updates).length > 0) {
        await prisma.user.update({
          where: { id: user.id },
          data: updates,
        });
      }

      // If user exists, create or update customerProfile with address if provided
      if (address && address.trim().length > 0) {
        if (!user.customerProfile) {
          await prisma.customerProfile.create({
            data: { userId: user.id, address: address.trim() },
          });
        } else if (!user.customerProfile.address || user.customerProfile.address.trim().length === 0) {
          await prisma.customerProfile.update({
            where: { userId: user.id },
            data: { address: address.trim() },
          });
        }
      } else if (!user.customerProfile) {
        await prisma.customerProfile.create({
          data: { userId: user.id },
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

    // Do not notify admins on raw OTP verification because onboarding is not completed yet.
    // The unified notification will be sent once the driver actually submits their profile/vehicle/documents.

    return {
      user,
      isNewUser,
      phone: cleanPhone,
      name: user.name,
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
      if (upper.includes('RENT') || upper.includes('VEHICLE_ONLY') || upper === 'VEHICLEONLY') normalizedPersona = 'RENTAL';
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

    // Persona changes are restricted to authorized Admin workflow and cannot be mutated silently on login.
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
        role: { in: ['SUPER_ADMIN', 'ADMIN', 'ZONE_ADMIN', 'DISPATCHER'] },
      },
      include: {
        assignedZone: true,
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
        assignedZone: true,
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
    phone?: string;
    gender?: string;
    dob?: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
    profileImage?: string;
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

    if (data.phone !== undefined) {
      const cleanPhone = data.phone.replace(/[^0-9]/g, '');
      if (cleanPhone.length >= 10) {
        const last10 = cleanPhone.slice(-10);
        if (last10 !== user.phone) {
          const existingPhone = await prisma.user.findUnique({ where: { phone: last10 } });
          if (existingPhone && existingPhone.id !== userId) {
            const err: any = new Error('Phone number is already registered with another account');
            err.statusCode = 409;
            throw err;
          }
          userUpdates.phone = last10;
        }
      }
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
    if (data.profileImage !== undefined) profileUpdates.profileImage = data.profileImage ? data.profileImage.trim() : null;
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

  /**
   * Complete atomic Driver Registration after OTP verification.
   * Verifies the short-lived registrationToken, validates mandatory fields,
   * checks for duplicate mobile numbers, and atomically creates the User (isActive: false),
   * DriverProfile (approvalStatus: PENDING, shiftStatus: OFF_SHIFT), Vehicle (PENDING, if applicable),
   * and Wallet records.
   */
  async completeDriverRegistration(
    data: any,
    jwtVerifier: (token: string) => any,
    jwtSigner: (payload: any) => string
  ) {
    const { registrationToken } = data || {};
    if (!registrationToken) {
      const err: any = new Error('Registration token is required. Please verify your mobile number first.');
      err.statusCode = 400;
      throw err;
    }

    let decoded: any;
    try {
      decoded = jwtVerifier(registrationToken);
    } catch (e: any) {
      const err: any = new Error('Invalid or expired registration token. Please verify OTP again.');
      err.statusCode = 401;
      throw err;
    }

    if (decoded.purpose !== 'DRIVER_REGISTRATION' || decoded.role !== 'DRIVER') {
      const err: any = new Error('Invalid token purpose for driver registration');
      err.statusCode = 403;
      throw err;
    }

    const cleanPhone = normalizePhone(decoded.phone);
    if (!cleanPhone || cleanPhone.length < 10) {
      const err: any = new Error('Valid phone number not found in registration token');
      err.statusCode = 400;
      throw err;
    }

    const name = (data.name || decoded.name || '').trim();
    if (!name || name.length < 2) {
      const err: any = new Error('Full name is required for registration');
      err.statusCode = 400;
      throw err;
    }

    let normalizedPersona: 'DRIVE_ONLY' | 'OWN_VEHICLE' | 'RENTAL' = 'DRIVE_ONLY';
    const rawPersona = (data.personaType || '').toUpperCase();
    if (rawPersona === 'OWN_VEHICLE' || rawPersona === 'DRIVER_AND_VEHICLE') {
      normalizedPersona = 'OWN_VEHICLE';
    } else if (rawPersona === 'RENTAL' || rawPersona === 'VEHICLE_ONLY' || rawPersona === 'VEHICLEPROVIDER') {
      normalizedPersona = 'RENTAL';
    }

    const licenseNumber = normalizeDrivingLicense(data.licenseNumber);
    if (normalizedPersona !== 'RENTAL') {
      if (!licenseNumber) {
        const err: any = new Error('Driving licence number is required');
        err.statusCode = 400;
        throw err;
      }
      if (!isValidDrivingLicense(licenseNumber)) {
        const err: any = new Error('Invalid driving licence format (e.g. TN0120230001234 or TN-01-2023-0001234)');
        err.statusCode = 400;
        throw err;
      }
    } else {
      // For RENTAL persona, licence is optional, but if provided, validate format
      if (licenseNumber && !isValidDrivingLicense(licenseNumber)) {
        const err: any = new Error('Invalid driving licence format (e.g. TN0120230001234 or TN-01-2023-0001234)');
        err.statusCode = 400;
        throw err;
      }
    }

    const aadharNumber = normalizeAadhaar(data.aadharNumber || data.aadhaarNumber);
    if (aadharNumber) {
      if (!isValidAadhaar(aadharNumber)) {
        const err: any = new Error('Invalid Aadhaar number format or checksum');
        err.statusCode = 400;
        throw err;
      }
    }

    // Check for duplicate driver registration
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { phone: cleanPhone },
          { phone: `+91${cleanPhone}` },
          { phone: `91${cleanPhone}` },
        ],
      },
      include: { driverProfile: true },
    });

    if (existingUser && existingUser.driverProfile) {
      const err: any = new Error('A driver account with this mobile number already exists. Please login.');
      err.statusCode = 409;
      throw err;
    }

    // Parse vehicle details if provided
    const vehicleData = data.vehicle;
    let vNumber = '';
    if (vehicleData) {
      vNumber = (vehicleData.regNumber || vehicleData.rcNumber || vehicleData.vehicleNumber || '').toUpperCase().trim();
      if (vNumber) {
        const existingVehicle = await prisma.vehicle.findUnique({
          where: { vehicleNumber: vNumber },
        });
        if (existingVehicle) {
          const err: any = new Error(`Vehicle number ${vNumber} is already registered in the system.`);
          err.statusCode = 409;
          throw err;
        }
      }
    }

    // Atomic transaction for Driver creation
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create or update User
      let user: any;
      if (existingUser) {
        user = await tx.user.update({
          where: { id: existingUser.id },
          data: {
            name,
            role: 'DRIVER',
            isActive: false, // Inactive until Admin approval
          },
        });
      } else {
        user = await tx.user.create({
          data: {
            phone: cleanPhone,
            name,
            role: 'DRIVER',
            isActive: false, // Inactive until Admin approval
          },
        });
      }

      // 2. Create Driver Profile
      const driverProfile = await tx.driverProfile.create({
        data: {
          userId: user.id,
          personaType: normalizedPersona,
          approvalStatus: 'PENDING',
          shiftStatus: 'OFF_SHIFT',
          isOnline: false,
          licenseNumber: licenseNumber || null,
          licenseExpiry: data.licenseExpiry || null,
          licenseFront: data.licenseFront || null,
          licenseBack: data.licenseBack || null,
          aadharNumber: aadharNumber || null,
          aadharFront: data.aadharFront || null,
          aadharBack: data.aadharBack || null,
          panNumber: data.panNumber || null,
          panImage: data.panImage || null,
          selfieImage: data.selfieImage || null,
          assignedHubId: data.assignedHubId || null,
        },
      });

      // 3. Create Vehicle if persona requires vehicle or vehicle data is provided
      let createdVehicle: any = null;
      if (vNumber && (normalizedPersona === 'OWN_VEHICLE' || normalizedPersona === 'RENTAL')) {
        let vehicleTypeEnum: any = 'SEDAN';
        const rawType = (vehicleData.vehicleType || vehicleData.seaterType || '').toString().toUpperCase();
        if (rawType.includes('SUV')) vehicleTypeEnum = 'SUV';
        else if (rawType.includes('HATCHBACK')) vehicleTypeEnum = 'HATCHBACK';
        else if (rawType.includes('LUXURY')) vehicleTypeEnum = 'LUXURY';
        else if (rawType.includes('AUTO')) vehicleTypeEnum = 'AUTO';

        let fuelTypeEnum: any = 'PETROL';
        const rawFuel = (vehicleData.fuelType || '').toString().toUpperCase();
        if (rawFuel.includes('DIESEL')) fuelTypeEnum = 'DIESEL';
        else if (rawFuel.includes('ELECTRIC') || rawFuel.includes('EV')) fuelTypeEnum = 'ELECTRIC';
        else if (rawFuel.includes('CNG')) fuelTypeEnum = 'CNG';

        let gearTypeEnum: any = 'MANUAL';
        const rawGear = (vehicleData.gearType || '').toString().toUpperCase();
        if (rawGear.includes('AUTO')) gearTypeEnum = 'AUTOMATIC';

        const rawYear = parseInt(vehicleData.year, 10);
        const yearInt = isNaN(rawYear) || rawYear < 1990 ? new Date().getFullYear() : rawYear;

        const photoUrls: string[] = [];
        if (vehicleData.vehiclePhoto && typeof vehicleData.vehiclePhoto === 'string') {
          photoUrls.push(vehicleData.vehiclePhoto);
        }
        if (Array.isArray(vehicleData.photos)) {
          for (const p of vehicleData.photos) {
            if (p && typeof p === 'string' && !photoUrls.includes(p)) {
              photoUrls.push(p);
            }
          }
        }

        createdVehicle = await tx.vehicle.create({
          data: {
            vehicleNumber: vNumber,
            brand: vehicleData.brand || 'Vehicle',
            model: vehicleData.model || 'Model',
            year: yearInt,
            vehicleType: vehicleTypeEnum,
            category: 'BUDGET',
            fuelType: fuelTypeEnum,
            gearType: gearTypeEnum,
            seatCapacity: parseInt(vehicleData.seaterType, 10) || 4,
            status: 'PENDING',
            isOnline: false,
            rcNumber: vehicleData.rcNumber || vNumber,
            rcExpiry: vehicleData.rcExpiry || null,
            rcFront: vehicleData.rcFront || null,
            rcBack: vehicleData.rcBack || null,
            insuranceNumber: vehicleData.insuranceNumber || null,
            insuranceExpiry: vehicleData.insuranceExpiry || null,
            insuranceDoc: vehicleData.insuranceDoc || null,
            owner: { connect: { id: driverProfile.id } },
            ...(data.assignedHubId ? { assignedHub: { connect: { id: data.assignedHubId } } } : {}),
            ...(photoUrls.length > 0
              ? {
                  photos: {
                    create: photoUrls.map((url, i) => ({
                      photoUrl: url,
                      tag: i === 0 ? 'front' : 'extra',
                    })),
                  },
                }
              : {}),
          },
        });

        if (normalizedPersona === 'OWN_VEHICLE') {
          await tx.driverProfile.update({
            where: { id: driverProfile.id },
            data: { assignedVehicleId: createdVehicle.id },
          });
        }
      }

      // 4. Create Driver Wallet with Bank Details
      const bank = data.bankDetails || {};
      const wallet = await tx.wallet.create({
        data: {
          driverId: driverProfile.id,
          balance: 0,
          bankAccountNumber: bank.bankAccountNumber || bank.accountNo || null,
          bankIfsc: bank.bankIfsc || bank.ifsc || null,
          bankHolderName: bank.bankHolderName || bank.accountHolderName || name,
          bankName: bank.bankName || null,
        },
      });

      return {
        user,
        driverProfile: {
          ...driverProfile,
          assignedVehicleId: createdVehicle && normalizedPersona === 'OWN_VEHICLE' ? createdVehicle.id : null,
        },
        vehicle: createdVehicle,
        wallet,
      };
    });

    // Notify Admin (Unified Single Notification)
    try {
      const vehInfo = result.vehicle
        ? ` with vehicle ${result.vehicle.brand} ${result.vehicle.model} (${result.vehicle.vehicleNumber})`
        : '';
      await notificationsService.sendToAdmins({
        title: '📋 Driver Registration Submitted',
        message: `${name} (${cleanPhone}) registered as ${normalizedPersona}${vehInfo} & submitted documents for Admin approval.`,
        type: 'admin_driver_registered',
        data: {
          driverId: result.driverProfile.id,
          userId: result.user.id,
          ...(result.vehicle?.id ? { vehicleId: result.vehicle.id } : {}),
          personaType: normalizedPersona,
        },
      });
    } catch (notifErr) {
      console.error('[AuthService] Error sending admin notification on driver register:', notifErr);
    }

    // Generate JWT token for newly registered driver (isVerified: false)
    const token = jwtSigner({
      id: result.user.id,
      phone: result.user.phone,
      role: result.user.role,
    });

    return {
      token,
      user: {
        ...result.user,
        driverProfile: result.driverProfile,
      },
      vehicle: result.vehicle,
      isVerified: false,
      approvalStatus: 'PENDING',
    };
  }
}

export const authService = new AuthService();
