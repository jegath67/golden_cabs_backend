import type { FastifyInstance } from 'fastify';
import { walletController } from './wallet.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function walletRoutes(app: FastifyInstance) {
  app.get(
    '/me',
    { preHandler: [requireRoles(['DRIVER'])] },
    walletController.getMyWallet.bind(walletController)
  );

  app.put(
    '/bank-details',
    { preHandler: [requireRoles(['DRIVER'])] },
    walletController.updateBankDetails.bind(walletController)
  );

  app.post(
    '/withdraw',
    { preHandler: [requireRoles(['DRIVER'])] },
    walletController.requestWithdrawal.bind(walletController)
  );
}
