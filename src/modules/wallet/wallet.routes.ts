import type { FastifyInstance } from 'fastify';
import { walletController } from './wallet.controller';
import { requireRoles } from '../../middlewares/auth.middleware';

export async function walletRoutes(app: FastifyInstance) {
  app.get(
    '/me',
    { preHandler: [requireRoles(['DRIVER', 'CUSTOMER'])] },
    walletController.getMyWallet.bind(walletController)
  );

  app.get(
    '/customer',
    { preHandler: [requireRoles(['CUSTOMER'])] },
    walletController.getCustomerWallet.bind(walletController)
  );

  app.get(
    '/customer/transactions',
    { preHandler: [requireRoles(['CUSTOMER'])] },
    walletController.getCustomerTransactions.bind(walletController)
  );

  app.get(
    '/dashboard',
    { preHandler: [requireRoles(['DRIVER'])] },
    walletController.getDashboard.bind(walletController)
  );

  app.get(
    '/payouts',
    { preHandler: [requireRoles(['DRIVER'])] },
    walletController.getCashouts.bind(walletController)
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
