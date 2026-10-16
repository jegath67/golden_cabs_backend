import { prisma } from '../../config/prisma';

export class WalletService {
  async getDriverWallet(userId: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        wallet: {
          include: {
            transactions: {
              orderBy: { createdAt: 'desc' },
              take: 20,
            },
          },
        },
      },
    });

    if (!driver || !driver.wallet) {
      throw new Error('Driver wallet not found');
    }

    return driver.wallet;
  }

  async updateBankDetails(
    userId: string,
    data: { bankAccountNumber: string; bankIfsc: string; bankHolderName: string }
  ) {
    const driver = await prisma.driverProfile.findUnique({ where: { userId } });
    if (!driver) throw new Error('Driver not found');

    return prisma.wallet.update({
      where: { driverId: driver.id },
      data: {
        bankAccountNumber: data.bankAccountNumber,
        bankIfsc: data.bankIfsc.toUpperCase(),
        bankHolderName: data.bankHolderName,
      },
    });
  }

  async requestWithdrawal(userId: string, amount: number) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: { wallet: true },
    });

    if (!driver || !driver.wallet) throw new Error('Driver wallet not found');
    if (amount <= 0) throw new Error('Invalid withdrawal amount');
    if (driver.wallet.balance < amount) throw new Error('Insufficient wallet balance');

    return prisma.$transaction([
      prisma.wallet.update({
        where: { id: driver.wallet.id },
        data: {
          balance: { decrement: amount },
          pendingWithdrawals: { increment: amount },
        },
      }),
      prisma.walletTransaction.create({
        data: {
          walletId: driver.wallet.id,
          amount,
          type: 'WITHDRAWAL',
          status: 'PENDING',
          description: `Withdrawal request for ₹${amount}`,
        },
      }),
    ]);
  }

  async getCustomerWallet(userId: string) {
    let wallet = await prisma.customerWallet.findUnique({
      where: { customerId: userId },
      include: {
        transactions: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!wallet) {
      wallet = await prisma.customerWallet.create({
        data: { customerId: userId, balance: 0.0 },
        include: { transactions: true },
      });
    }

    return wallet;
  }
}

export const walletService = new WalletService();
