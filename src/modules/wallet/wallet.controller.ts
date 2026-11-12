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

  async getDashboard(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };

    try {
      const dashboard = await walletService.getEarningsDashboard(user.id);
      return reply.send({ success: true, data: dashboard });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to fetch earnings dashboard' });
    }
  }

  async getCashouts(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };

    try {
      const cashouts = await walletService.getCashoutHistory(user.id);
      return reply.send({ success: true, data: cashouts });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to fetch cashout history' });
    }
  }

  async updateBankDetails(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const { bankName, bankAccountNumber, bankIfsc, bankHolderName } = (req.body as any) || {};

    if (!bankAccountNumber || !bankIfsc || !bankHolderName) {
      return reply.status(400).send({
        success: false,
        message: 'bankAccountNumber, bankIfsc, and bankHolderName are required',
      });
    }

    try {
      const updated = await walletService.updateBankDetails(user.id, {
        ...(bankName !== undefined ? { bankName } : {}),
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

    const numAmount = Number(amount);
    if (!numAmount || isNaN(numAmount) || numAmount <= 0) {
      return reply.status(400).send({ success: false, message: 'Valid amount is required' });
    }

    try {
      const res = await walletService.requestWithdrawal(user.id, numAmount);
      return reply.send({ success: true, message: 'Cashout request submitted successfully', data: res });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to submit cashout' });
    }
  }

  async getCustomerWallet(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    try {
      const wallet = await walletService.getCustomerWallet(user.id);
      return reply.send({ success: true, data: wallet });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to fetch customer wallet' });
    }
  }

  async getCustomerTransactions(req: FastifyRequest<any>, reply: FastifyReply) {
    const user = req.user as { id: string };
    const { page, limit } = (req.query as any) || {};
    try {
      const result = await walletService.getCustomerTransactions(
        user.id,
        page ? Number(page) : 1,
        limit ? Number(limit) : 20
      );
      return reply.send({ success: true, data: result });
    } catch (error: any) {
      return reply.status(400).send({ success: false, message: error.message || 'Failed to fetch customer transactions' });
    }
  }
}

export const walletController = new WalletController();
