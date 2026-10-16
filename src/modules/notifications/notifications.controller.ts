import type { FastifyReply, FastifyRequest } from 'fastify';
import { notificationsService } from './notifications.service';

export class NotificationsController {
  async registerToken(req: FastifyRequest<any>, reply: FastifyReply) {
    const userId = (req.user as any)?.id;
    const { fcmToken, platform } = (req.body as any) || {};

    if (!userId) {
      return reply.status(401).send({
        success: false,
        message: 'Unauthorized: Missing authenticated user ID',
      });
    }

    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        message: 'fcmToken is required',
      });
    }

    const validPlatforms = ['android', 'ios', 'web'];
    const safePlatform = validPlatforms.includes(platform?.toLowerCase())
      ? platform.toLowerCase()
      : 'android';

    try {
      const record = await notificationsService.registerDeviceToken(
        userId,
        fcmToken.trim(),
        safePlatform
      );
      return reply.send({
        success: true,
        message: 'Device token registered successfully',
        data: record,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to register device token',
        error: error.message || String(error),
      });
    }
  }

  async unregisterToken(req: FastifyRequest<any>, reply: FastifyReply) {
    const userId = (req.user as any)?.id;
    const { fcmToken } = (req.body as any) || {};

    if (!userId) {
      return reply.status(401).send({
        success: false,
        message: 'Unauthorized: Missing authenticated user ID',
      });
    }

    if (!fcmToken || typeof fcmToken !== 'string' || fcmToken.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        message: 'fcmToken is required',
      });
    }

    try {
      await notificationsService.unregisterDeviceToken(fcmToken.trim(), userId);
      return reply.send({
        success: true,
        message: 'Device token removed successfully',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to remove device token',
        error: error.message || String(error),
      });
    }
  }

  async getUserNotifications(req: FastifyRequest<any>, reply: FastifyReply) {
    const userId = (req.user as any)?.id;
    const { page, limit } = (req.query as any) || {};

    if (!userId) {
      return reply.status(401).send({
        success: false,
        message: 'Unauthorized: Missing authenticated user ID',
      });
    }

    const pageNum = parseInt(page || '1', 10);
    const limitNum = parseInt(limit || '20', 10);

    try {
      const result = await notificationsService.getUserNotifications(
        userId,
        pageNum,
        limitNum
      );
      return reply.send({
        success: true,
        data: result,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to fetch notifications',
        error: error.message || String(error),
      });
    }
  }

  async markAsRead(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const userId = (req.user as any)?.id;

    if (!userId) {
      return reply.status(401).send({
        success: false,
        message: 'Unauthorized: Missing authenticated user ID',
      });
    }

    try {
      await notificationsService.markAsRead(id, userId);
      return reply.send({
        success: true,
        message: 'Notification marked as read',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to mark as read',
        error: error.message || String(error),
      });
    }
  }

  async markAllAsRead(req: FastifyRequest<any>, reply: FastifyReply) {
    const userId = (req.user as any)?.id;

    if (!userId) {
      return reply.status(401).send({
        success: false,
        message: 'Unauthorized: Missing authenticated user ID',
      });
    }

    try {
      await notificationsService.markAllAsRead(userId);
      return reply.send({
        success: true,
        message: 'All notifications marked as read',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to mark notifications as read',
        error: error.message || String(error),
      });
    }
  }

  async sendTestNotification(req: FastifyRequest<any>, reply: FastifyReply) {
    const {
      userId,
      target,
      audience,
      title,
      message,
      type,
      data,
      isScheduled,
      scheduledAt,
    } = (req.body as any) || {};

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        message: 'Notification title is required',
      });
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      return reply.status(400).send({
        success: false,
        message: 'Notification message body is required',
      });
    }

    const effectiveAudience = audience?.toLowerCase() || (userId || target ? 'specific' : 'both');

    try {
      const result = await notificationsService.sendAudienceNotification({
        audience: effectiveAudience,
        target: target || userId,
        userId: userId || target,
        title: title.trim(),
        message: message.trim(),
        type: type || 'general',
        data,
        isScheduled: Boolean(isScheduled),
        scheduledAt,
      });

      if (!result.success) {
        return reply.status(400).send(result);
      }

      return reply.send({
        success: true,
        message: result.message,
        data: result.data,
        result: result.data,
      });
    } catch (error: any) {
      console.error('[NotificationsController] sendTestNotification error:', error);
      return reply.status(500).send({
        success: false,
        message: error?.message || 'Failed to send notification',
      });
    }
  }

  async deleteNotification(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const userId = (req.user as any)?.id;

    if (!userId) {
      return reply.status(401).send({
        success: false,
        message: 'Unauthorized: Missing authenticated user ID',
      });
    }

    try {
      await notificationsService.deleteNotification(id, userId);
      return reply.send({
        success: true,
        message: 'Notification deleted successfully',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to delete notification',
        error: error.message || String(error),
      });
    }
  }

  async deleteNotifications(req: FastifyRequest<any>, reply: FastifyReply) {
    const { ids } = (req.body as any) || {};
    const userId = (req.user as any)?.id;

    if (!userId) {
      return reply.status(401).send({
        success: false,
        message: 'Unauthorized: Missing authenticated user ID',
      });
    }

    try {
      if (Array.isArray(ids) && ids.length > 0) {
        await notificationsService.deleteNotifications(ids, userId);
      }
      return reply.send({
        success: true,
        message: 'Notifications deleted successfully',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to delete notifications',
        error: error.message || String(error),
      });
    }
  }
}

export const notificationsController = new NotificationsController();
