import { prisma } from '../../config/prisma';
import { platformSettingsService } from '../settings/platform-settings.service';

export class WalletService {
  async getDriverWallet(userId: string) {
    let driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        wallet: {
          include: {
            transactions: {
              orderBy: { createdAt: 'desc' },
              take: 50,
            },
          },
        },
      },
    });

    if (!driver) {
      throw new Error('Driver profile not found');
    }

    if (!driver.wallet) {
      const newWallet = await prisma.wallet.create({
        data: {
          driverId: driver.id,
          balance: 0.0,
          lifetimeEarnings: 0.0,
          pendingWithdrawals: 0.0,
        },
        include: {
          transactions: true,
        },
      });
      return newWallet;
    }

    return driver.wallet;
  }

  async getEarningsDashboard(userId: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: {
        wallet: {
          include: {
            transactions: {
              orderBy: { createdAt: 'desc' },
              take: 50,
            },
          },
        },
      },
    });

    if (!driver) throw new Error('Driver profile not found');

    let wallet = driver.wallet;
    if (!wallet) {
      wallet = await prisma.wallet.create({
        data: {
          driverId: driver.id,
          balance: 0.0,
          lifetimeEarnings: 0.0,
          pendingWithdrawals: 0.0,
        },
        include: {
          transactions: true,
        },
      });
    }

    // Date boundaries
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Fetch completed rides for driver
    const rides = await prisma.ride.findMany({
      where: {
        driverId: driver.id,
        status: 'COMPLETED',
      },
      include: {
        fareBreakdown: true,
      },
      orderBy: { completedAt: 'desc' },
    });

    let todayEarnings = 0;
    let weeklyEarnings = 0;
    let monthlyEarnings = 0;
    let totalCashCollections = 0;
    let totalOnlineEarnings = 0;
    let totalCompanyCommission = 0;

    const commissionRate = await platformSettingsService.getCommissionRate();
    const configuredPercent = await platformSettingsService.getCommissionPercent();

    for (const r of rides) {
      const fare = r.fareBreakdown?.totalFare ?? r.finalFare ?? r.estimatedFare ?? 0;
      const discount = r.fareBreakdown?.discountAmount ?? 0;
      const gross = fare + discount;
      const commission = Math.round(gross * commissionRate * 100) / 100;
      const net = Math.round((gross - commission) * 100) / 100;

      totalCompanyCommission += commission;

      if (r.paymentMethod === 'CASH') {
        totalCashCollections += fare;
      } else {
        totalOnlineEarnings += net;
      }

      const completedDate = r.completedAt || r.createdAt;
      if (completedDate >= startOfToday) {
        todayEarnings += net;
      }
      if (completedDate >= startOfWeek) {
        weeklyEarnings += net;
      }
      if (completedDate >= startOfMonth) {
        monthlyEarnings += net;
      }
    }

    // Aggregated payouts
    const completedPayouts = await prisma.walletTransaction.aggregate({
      where: {
        walletId: wallet.id,
        type: 'WITHDRAWAL',
        status: 'COMPLETED',
      },
      _sum: { amount: true },
    });
    const totalPaidOut = completedPayouts._sum.amount || 0;

    const outstandingDues = wallet.balance < 0 ? Math.round(Math.abs(wallet.balance) * 100) / 100 : 0;
    const availableCashoutBalance = Math.max(0, Math.round(wallet.balance * 100) / 100);

    const isCashoutEligible =
      wallet.balance >= 500 &&
      availableCashoutBalance >= 500 &&
      outstandingDues === 0 &&
      Boolean(wallet.bankAccountNumber && wallet.bankIfsc);

    return {
      walletId: wallet.id,
      driverId: driver.id,
      balance: wallet.balance,
      lifetimeEarnings: wallet.lifetimeEarnings,
      todayEarnings: Math.round(todayEarnings * 100) / 100,
      weeklyEarnings: Math.round(weeklyEarnings * 100) / 100,
      monthlyEarnings: Math.round(monthlyEarnings * 100) / 100,
      cashRideCollections: Math.round(totalCashCollections * 100) / 100,
      onlineRideEarnings: Math.round(totalOnlineEarnings * 100) / 100,
      companyCommission: Math.round(totalCompanyCommission * 100) / 100,
      commissionPercent: `${configuredPercent}%`,
      commissionRate,
      outstandingCompanyDues: outstandingDues,
      availableCashoutBalance,
      pendingCashoutAmount: wallet.pendingWithdrawals,
      totalAmountPaidOut: Math.round(totalPaidOut * 100) / 100,
      completedRidesCount: rides.length,
      isCashoutEligible,
      bankDetails: {
        bankAccountNumber: wallet.bankAccountNumber,
        bankIfsc: wallet.bankIfsc,
        bankHolderName: wallet.bankHolderName,
      },
      recentTransactions: wallet.transactions || [],
    };
  }

  async getCashoutHistory(userId: string) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: { wallet: true },
    });

    if (!driver || !driver.wallet) throw new Error('Driver wallet not found');

    const txs = await prisma.walletTransaction.findMany({
      where: {
        walletId: driver.wallet.id,
        type: 'WITHDRAWAL',
      },
      orderBy: { createdAt: 'desc' },
    });

    return txs.map((tx) => ({
      id: tx.id,
      amount: tx.amount,
      status: tx.status,
      utrNumber: tx.utrNumber,
      rejectionReason: tx.rejectionReason,
      paidAt: tx.paidAt,
      createdAt: tx.createdAt,
      description: tx.description,
      previousBalance: tx.previousBalance,
      newBalance: tx.newBalance,
      bankAccountNumber: driver.wallet?.bankAccountNumber,
      bankIfsc: driver.wallet?.bankIfsc,
      bankHolderName: driver.wallet?.bankHolderName,
    }));
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
        bankAccountNumber: data.bankAccountNumber.trim(),
        bankIfsc: data.bankIfsc.trim().toUpperCase(),
        bankHolderName: data.bankHolderName.trim(),
      },
    });
  }

  async requestWithdrawal(userId: string, amount: number) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: { wallet: true },
    });

    if (!driver || !driver.wallet) throw new Error('Driver wallet not found');
    if (!amount || isNaN(amount) || amount < 500) {
      throw new Error('Minimum cashout amount is ₹500');
    }

    if (!driver.wallet.bankAccountNumber || !driver.wallet.bankIfsc) {
      throw new Error('Please link your bank account before requesting cashout');
    }

    if (driver.wallet.balance < 0) {
      throw new Error('Cannot request cashout while outstanding company dues exist');
    }

    return prisma.$transaction(async (tx) => {
      // 1. Concurrency-safe check: Re-fetch latest wallet state inside the transaction
      const liveWallet = await tx.wallet.findUnique({
        where: { id: driver.wallet!.id },
      });
      if (!liveWallet) throw new Error('Driver wallet not found');

      if (liveWallet.balance < 0) {
        throw new Error('Cannot request cashout while outstanding company dues exist');
      }

      // 1. Prevent concurrent / duplicate pending cashout requests
      const activePending = await tx.walletTransaction.findFirst({
        where: {
          walletId: liveWallet.id,
          type: 'WITHDRAWAL',
          status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] },
        },
      });
      if (activePending) {
        throw new Error('You already have an active cashout request in progress. Please wait for it to be settled.');
      }

      // 2. Available balance validation
      const available = Math.round(liveWallet.balance * 100) / 100;
      if (amount > available) {
        throw new Error(`Requested amount ₹${amount} exceeds available balance ₹${available}`);
      }

      // 3. Weekly cashout limit: Only 1 successful cashout permitted per settlement week (Mon 00:00 - Sun 23:59)
      const now = new Date();
      const currentDay = now.getDay();
      const diffToMonday = (currentDay + 6) % 7;
      const startOfCurrentWeek = new Date(now);
      startOfCurrentWeek.setDate(now.getDate() - diffToMonday);
      startOfCurrentWeek.setHours(0, 0, 0, 0);

      const paidThisWeek = await tx.walletTransaction.findFirst({
        where: {
          walletId: liveWallet.id,
          type: 'WITHDRAWAL',
          status: 'COMPLETED',
          createdAt: { gte: startOfCurrentWeek },
        },
      });
      if (paidThisWeek) {
        throw new Error('Weekly cashout limit reached. Only one cashout is allowed per settlement week.');
      }

      const prevBal = liveWallet.balance;
      const newBal = Math.round((prevBal - amount) * 100) / 100;

      const updatedWallet = await tx.wallet.update({
        where: { id: liveWallet.id },
        data: {
          balance: { decrement: amount },
          pendingWithdrawals: { increment: amount },
        },
      });

      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: liveWallet.id,
          amount,
          type: 'WITHDRAWAL',
          status: 'PENDING',
          previousBalance: prevBal,
          newBalance: newBal,
          description: `Weekly cashout request to A/C ****${liveWallet.bankAccountNumber?.slice(-4)}`,
        },
      });

      return { wallet: updatedWallet, transaction };
    });
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
