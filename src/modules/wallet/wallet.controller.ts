import type { FastifyReply, FastifyRequest } from 'fastify';
import { walletService } from './wallet.service';

export class WalletController {
  async getMyWallet(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string; role?: string };

    try {
      if (user.role === 'CUSTOMER') {
        const wallet = await walletService.getCustomerWallet(user.id);
        return reply.send({ success: true, data: wallet });
      }

      const wallet = await walletService.getDriverWallet(user.id);
      return reply.send({ success: true, data: wallet });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to fetch wallet' });
    }
  }

  async updateBankDetails(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const { bankAccountNumber, bankIfsc, bankHolderName } = (req.body as any) || {};

    if (!bankAccountNumber || !bankIfsc || !bankHolderName) {
      return reply.status(400).send({
        success: false,
        message: 'bankAccountNumber, bankIfsc, and bankHolderName are required',
      });
    }

    try {
      const updated = await walletService.updateBankDetails(user.id, {
        bankAccountNumber,
        bankIfsc,
        bankHolderName,
      });
      return reply.send({ success: true, message: 'Bank details updated', data: updated });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to update bank details' });
    }
  }

  async requestWithdrawal(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const { amount } = (req.body as any) || {};

    if (!amount || amount <= 0) {
      return reply.status(400).send({ success: false, message: 'Valid amount is required' });
    }

    try {
      await walletService.requestWithdrawal(user.id, amount);
      return reply.send({ success: true, message: 'Withdrawal request submitted successfully' });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to submit withdrawal' });
    }
  }
}

export const walletController = new WalletController();
