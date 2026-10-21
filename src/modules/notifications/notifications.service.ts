import { prisma } from '../../config/prisma';
import { getFirebaseMessaging } from '../../config/firebase';

export interface SendNotificationInput {
  userId: string;
  title: string;
  message: string;
  type?: string;
  data?: Record<string, string>;
  saveToDb?: boolean;
}

export interface SendAudienceNotificationInput {
  audience?: 'customer' | 'driver' | 'both' | 'all' | 'specific' | string;
  target?: string;
  userId?: string;
  title: string;
  message: string;
  type?: string;
  data?: Record<string, string>;
  isScheduled?: boolean;
  scheduledAt?: string | Date;
}

export class NotificationsService {
  /**
   * Register or update a user's FCM device token
   */
  async registerDeviceToken(userId: string, fcmToken: string, platform = 'android') {
    return prisma.deviceToken.upsert({
      where: { fcmToken },
      update: {
        userId,
        platform,
        isActive: true,
        lastUsedAt: new Date(),
      },
      create: {
        userId,
        fcmToken,
        platform,
        isActive: true,
      },
    });
  }

  /**
   * Deactivate or delete device token on logout
   */
  async unregisterDeviceToken(fcmToken: string, userId?: string) {
    try {
      return await prisma.deviceToken.deleteMany({
        where: {
          fcmToken,
          ...(userId ? { userId } : {}),
        },
      });
    } catch {
      // Ignored if already removed
      return null;
    }
  }

  /**
   * Send Push Notification to a user (and all their logged-in devices)
   */
  async sendToUser({
    userId,
    title,
    message,
    type = 'general',
    data,
    saveToDb = true,
  }: SendNotificationInput) {
    let savedNotification = null;

    // 1. Save in database for user notification inbox
    if (saveToDb) {
      savedNotification = await prisma.notification.create({
        data: {
          userId,
          title,
          message,
          type,
          data: data ? (data as any) : undefined,
        },
      });
    }

    // 2. Fetch active device tokens
    const tokens = await prisma.deviceToken.findMany({
      where: {
        userId,
        isActive: true,
      },
      select: { fcmToken: true },
    });

    if (tokens.length === 0) {
      return { success: true, delivered: 0, reason: 'No active device tokens found' };
    }

    const messaging = getFirebaseMessaging();
    if (!messaging) {
      console.log(`[MOCK PUSH] Sent to User ${userId}: "${title}" - "${message}"`);
      return { success: true, delivered: tokens.length, mock: true, notification: savedNotification };
    }

    const fcmTokens = tokens.map((t) => t.fcmToken);

    try {
      const response = await messaging.sendEachForMulticast({
        tokens: fcmTokens,
        notification: {
          title,
          body: message,
        },
        data: {
          ...(data || {}),
          type,
          notificationId: savedNotification?.id || '',
        },
        android: {
          priority: 'high',
          notification: {
            sound: 'default',
            channelId: 'golden_cabs_channel',
          },
        },
      });

      // Cleanup expired or unregistered tokens
      const failedTokens: string[] = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const errCode = resp.error?.code;
          if (
            errCode === 'messaging/registration-token-not-registered' ||
            errCode === 'messaging/invalid-registration-token'
          ) {
            const tokenToDrop = fcmTokens[idx];
            if (tokenToDrop) {
              failedTokens.push(tokenToDrop);
            }
          }
        }
      });

      if (failedTokens.length > 0) {
        await prisma.deviceToken.deleteMany({
          where: { fcmToken: { in: failedTokens } },
        });
      }

      return {
        success: true,
        delivered: response.successCount,
        failed: response.failureCount,
        notification: savedNotification,
      };
    } catch (error) {
      console.error('Error sending FCM push:', error);
      return { success: false, error: String(error) };
    }
  }

  /**
   * Send Push Notification to an audience (customer, driver, both, or specific user)
   */
  async sendAudienceNotification({
    audience = 'both',
    target,
    userId,
    title,
    message,
    type = 'general',
    data,
    isScheduled = false,
    scheduledAt,
  }: SendAudienceNotificationInput) {
    const identifier = target || userId;
    let targetUsers: Array<{ id: string; name: string; role: string }> = [];

    // 1. Identify recipient users based on audience or specific target
    if (identifier || audience === 'specific') {
      if (!identifier) {
        return {
          success: false,
          message: 'Target identifier (user ID or phone number) is required for specific audience.',
          data: { delivered: 0, failed: 0, recipientsCount: 0, deviceTokensCount: 0 },
        };
      }

      const user = await prisma.user.findFirst({
        where: {
          OR: [{ id: identifier }, { phone: identifier }, { email: identifier }],
        },
        select: { id: true, name: true, role: true },
      });

      if (!user) {
        return {
          success: false,
          message: `User with ID/Phone/Email '${identifier}' not found.`,
          data: { delivered: 0, failed: 0, recipientsCount: 0, deviceTokensCount: 0 },
        };
      }
      targetUsers = [user];
    } else if (audience === 'customer') {
      targetUsers = await prisma.user.findMany({
        where: { role: 'CUSTOMER', isActive: true },
        select: { id: true, name: true, role: true },
      });
    } else if (audience === 'driver') {
      targetUsers = await prisma.user.findMany({
        where: { role: 'DRIVER', isActive: true },
        select: { id: true, name: true, role: true },
      });
    } else {
      // 'both' or 'all'
      targetUsers = await prisma.user.findMany({
        where: { role: { in: ['CUSTOMER', 'DRIVER'] }, isActive: true },
        select: { id: true, name: true, role: true },
      });
    }

    if (targetUsers.length === 0) {
      return {
        success: true,
        message: `No active users found for audience: ${audience}`,
        data: {
          audience,
          recipientsCount: 0,
          deviceTokensCount: 0,
          delivered: 0,
          failed: 0,
        },
      };
    }

    const targetUserIds = targetUsers.map((u) => u.id);

    // 2. Persist in-app notifications to PostgreSQL inbox
    try {
      await prisma.notification.createMany({
        data: targetUserIds.map((uid) => ({
          userId: uid,
          title,
          message,
          type: type || 'general',
          data: data ? (data as any) : undefined,
        })),
      });
    } catch (dbErr) {
      console.error('[NotificationsService] Error saving notifications to DB:', dbErr);
    }

    // 3. Fetch active device tokens
    const tokens = await prisma.deviceToken.findMany({
      where: {
        userId: { in: targetUserIds },
        isActive: true,
      },
      select: { fcmToken: true, userId: true },
    });

    const uniqueTokens = Array.from(new Set(tokens.map((t) => t.fcmToken)));

    if (uniqueTokens.length === 0) {
      return {
        success: true,
        message: `Notification saved to inbox for ${targetUsers.length} user(s), but no active devices are registered.`,
        data: {
          audience,
          recipientsCount: targetUsers.length,
          deviceTokensCount: 0,
          delivered: 0,
          failed: 0,
        },
      };
    }

    // 4. Dispatch via Firebase Admin SDK
    const messaging = getFirebaseMessaging();
    if (!messaging) {
      console.log(
        `[MOCK PUSH] Audience: ${audience} (${uniqueTokens.length} devices) - "${title}": "${message}"`
      );
      return {
        success: true,
        message: `Notification saved for ${targetUsers.length} user(s). (Mock mode - Firebase Admin not configured)`,
        data: {
          audience,
          recipientsCount: targetUsers.length,
          deviceTokensCount: uniqueTokens.length,
          delivered: uniqueTokens.length,
          failed: 0,
          mock: true,
        },
      };
    }

    let totalDelivered = 0;
    let totalFailed = 0;
    const failedTokensToDrop: string[] = [];

    const BATCH_SIZE = 500;
    for (let i = 0; i < uniqueTokens.length; i += BATCH_SIZE) {
      const batchTokens = uniqueTokens.slice(i, i + BATCH_SIZE);
      try {
        const response = await messaging.sendEachForMulticast({
          tokens: batchTokens,
          notification: {
            title,
            body: message,
          },
          data: {
            ...(data || {}),
            title,
            message,
            type: type || 'general',
          },
          android: {
            priority: 'high',
            notification: {
              sound: 'default',
              channelId: 'golden_cabs_channel',
            },
          },
        });

        totalDelivered += response.successCount;
        totalFailed += response.failureCount;

        response.responses.forEach((resp, idx) => {
          if (!resp.success) {
            const errCode = resp.error?.code;
            if (
              errCode === 'messaging/registration-token-not-registered' ||
              errCode === 'messaging/invalid-registration-token'
            ) {
              const badToken = batchTokens[idx];
              if (badToken) {
                failedTokensToDrop.push(badToken);
              }
            }
          }
        });
      } catch (batchErr) {
        console.error('[NotificationsService] Batch multicast error:', batchErr);
        totalFailed += batchTokens.length;
      }
    }

    // 5. Clean up expired/unregistered FCM tokens from database
    if (failedTokensToDrop.length > 0) {
      try {
        await prisma.deviceToken.deleteMany({
          where: { fcmToken: { in: failedTokensToDrop } },
        });
        console.log(`[FCM Cleanup] Pruned ${failedTokensToDrop.length} stale device token(s).`);
      } catch (pruneErr) {
        console.error('[FCM Cleanup Error]:', pruneErr);
      }
    }

    return {
      success: true,
      message: `Notification sent to ${totalDelivered} device(s) (${totalFailed} failed, ${targetUsers.length} inboxes updated).`,
      data: {
        audience,
        recipientsCount: targetUsers.length,
        deviceTokensCount: uniqueTokens.length,
        delivered: totalDelivered,
        failed: totalFailed,
      },
    };
  }

  /**
   * Get user's notifications list
   */
  async getUserNotifications(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [items, total, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.notification.count({ where: { userId } }),
      prisma.notification.count({ where: { userId, isRead: false } }),
    ]);

    return {
      items,
      notifications: items,
      total,
      unreadCount,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Mark a notification as read
   */
  async markAsRead(notificationId: string, userId: string) {
    return prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true },
    });
  }

  /**
   * Mark all notifications as read for a user
   */
  async markAllAsRead(userId: string) {
    return prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }

  /**
   * Delete a notification for a user
   */
  async deleteNotification(notificationId: string, userId: string) {
    return prisma.notification.deleteMany({
      where: { id: notificationId, userId },
    });
  }

  /**
   * Delete multiple notifications for a user
   */
  async deleteNotifications(notificationIds: string[], userId: string) {
    return prisma.notification.deleteMany({
      where: {
        id: { in: notificationIds },
        userId,
      },
    });
  }
}

export const notificationsService = new NotificationsService();
