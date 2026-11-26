import type { FastifyInstance } from 'fastify';
import { notificationsController } from './notifications.controller';
import { authenticate, requireRoles } from '../../middlewares/auth.middleware';

export async function notificationsRoutes(app: FastifyInstance) {
  // Gracefully handle empty JSON body on notification routes (e.g. PATCH /:id/read)
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    try {
      const trimmed = typeof body === 'string' ? body.trim() : '';
      done(null, trimmed ? JSON.parse(trimmed) : {});
    } catch (err: any) {
      done(err, undefined);
    }
  });

  // Device Token routes (Guarded by JWT authentication)
  app.post(
    '/device-token',
    { preHandler: [authenticate] },
    notificationsController.registerToken.bind(notificationsController)
  );
  app.delete(
    '/device-token',
    { preHandler: [authenticate] },
    notificationsController.unregisterToken.bind(notificationsController)
  );

  // User notifications inbox (Guarded by JWT authentication)
  app.get(
    '/',
    { preHandler: [authenticate] },
    notificationsController.getUserNotifications.bind(notificationsController)
  );
  app.patch(
    '/:id/read',
    { preHandler: [authenticate] },
    notificationsController.markAsRead.bind(notificationsController)
  );
  app.patch(
    '/read-all',
    { preHandler: [authenticate] },
    notificationsController.markAllAsRead.bind(notificationsController)
  );
  app.delete(
    '/clear-all',
    { preHandler: [authenticate] },
    notificationsController.clearAllNotifications.bind(notificationsController)
  );
  app.delete(
    '/all',
    { preHandler: [authenticate] },
    notificationsController.clearAllNotifications.bind(notificationsController)
  );
  app.delete(
    '/:id',
    { preHandler: [authenticate] },
    notificationsController.deleteNotification.bind(notificationsController)
  );
  app.delete(
    '/',
    { preHandler: [authenticate] },
    notificationsController.deleteNotifications.bind(notificationsController)
  );

  // Push notification trigger (Restricted to ADMIN / SUPER_ADMIN / ZONE_ADMIN roles)
  app.post(
    '/test',
    { preHandler: [requireRoles(['ADMIN', 'SUPER_ADMIN', 'ZONE_ADMIN'])] },
    notificationsController.sendTestNotification.bind(notificationsController)
  );
  app.post(
    '/send',
    { preHandler: [requireRoles(['ADMIN'])] },
    notificationsController.sendTestNotification.bind(notificationsController)
  );
}
