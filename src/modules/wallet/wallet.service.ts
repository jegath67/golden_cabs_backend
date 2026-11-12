import { prisma } from '../../config/prisma';
import { platformSettingsService } from '../settings/platform-settings.service';
import {
  resolveRideCommissionFromRecord,
  getLedgerTxMapForRides,
} from '../pricing-slabs/pricing-slabs.service';

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
    let totalGrossEarnings = 0;
    const distinctCommissionRates = new Set<number>();

    const configuredPercent = await platformSettingsService.getCommissionPercent();
    const txByRideId = await getLedgerTxMapForRides(rides.map((r) => r.id));

    for (const r of rides) {
      const resolved = resolveRideCommissionFromRecord(
        r,
        configuredPercent,
        txByRideId.get(r.id)
      );
      const fare = resolved.fare;
      const commission = resolved.commissionAmount;
      const net = resolved.driverAmount;

      totalGrossEarnings += resolved.grossFare;
      totalCompanyCommission += commission;
      if (resolved.commissionPercent != null) {
        distinctCommissionRates.add(resolved.commissionPercent);
      }

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

    const fmtPct = (v: number) => (v % 1 === 0 ? String(v) : v.toFixed(1));
    let effectiveCommissionPercent = configuredPercent;
    let commissionPercentLabel = `${fmtPct(configuredPercent)}%`;
    if (rides.length > 0 && distinctCommissionRates.size === 1) {
      const single = Array.from(distinctCommissionRates)[0]!;
      effectiveCommissionPercent = single;
      commissionPercentLabel = `${fmtPct(single)}%`;
    } else if (totalGrossEarnings > 0 && distinctCommissionRates.size > 1) {
      effectiveCommissionPercent = Math.round((totalCompanyCommission / totalGrossEarnings) * 1000) / 10;
      commissionPercentLabel = `${fmtPct(effectiveCommissionPercent)}% Avg`;
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
    const hasLinkedBank = Boolean(wallet.bankAccountNumber && wallet.bankIfsc);

    const isCashoutEligible =
      wallet.balance >= 500 &&
      availableCashoutBalance >= 500 &&
      outstandingDues === 0 &&
      hasLinkedBank;

    return {
      walletId: wallet.id,
      driverId: driver.id,
      balance: Math.round(wallet.balance * 100) / 100,
      lifetimeEarnings: Math.round(wallet.lifetimeEarnings * 100) / 100,
      totalGrossEarnings: Math.round(totalGrossEarnings * 100) / 100,
      todayEarnings: Math.round(todayEarnings * 100) / 100,
      weeklyEarnings: Math.round(weeklyEarnings * 100) / 100,
      monthlyEarnings: Math.round(monthlyEarnings * 100) / 100,
      cashRideCollections: Math.round(totalCashCollections * 100) / 100,
      onlineRideEarnings: Math.round(totalOnlineEarnings * 100) / 100,
      companyCommission: Math.round(totalCompanyCommission * 100) / 100,
      commissionPercent: commissionPercentLabel,
      effectiveCommissionPercent,
      commissionRate: Math.round((effectiveCommissionPercent / 100) * 10000) / 10000,
      outstandingCompanyDues: outstandingDues,
      availableCashoutBalance,
      pendingCashoutAmount: Math.round(wallet.pendingWithdrawals * 100) / 100,
      totalAmountPaidOut: Math.round(totalPaidOut * 100) / 100,
      completedRidesCount: rides.length,
      isCashoutEligible,
      hasLinkedBank,
      bankDetails: {
        bankName: wallet.bankName,
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
      bankName: tx.bankName ?? driver.wallet?.bankName ?? null,
      bankAccountNumber: tx.bankAccountNumber ?? driver.wallet?.bankAccountNumber ?? null,
      bankIfsc: tx.bankIfsc ?? driver.wallet?.bankIfsc ?? null,
      bankHolderName: tx.bankHolderName ?? driver.wallet?.bankHolderName ?? null,
    }));
  }

  private validateBankDetailsInput(data: {
    bankName?: string;
    bankAccountNumber: string;
    bankIfsc: string;
    bankHolderName: string;
  }) {
    const holder = String(data.bankHolderName || '').trim();
    const acct = String(data.bankAccountNumber || '').replace(/\s+/g, '').trim();
    const ifsc = String(data.bankIfsc || '').trim().toUpperCase();
    const bankName = data.bankName !== undefined ? String(data.bankName || '').trim() : undefined;

    if (holder.length < 2) {
      throw new Error('Account holder name is required');
    }
    if (bankName !== undefined && bankName.length > 0 && bankName.length < 2) {
      throw new Error('Bank name must be at least 2 characters');
    }
    if (!/^\d{9,18}$/.test(acct)) {
      throw new Error('Account number must be 9 to 18 digits');
    }
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
      throw new Error('Invalid IFSC code format (e.g. SBIN0001234)');
    }

    return {
      bankHolderName: holder,
      bankAccountNumber: acct,
      bankIfsc: ifsc,
      ...(bankName ? { bankName } : {}),
    };
  }

  async updateBankDetails(
    userId: string,
    data: {
      bankName?: string;
      bankAccountNumber: string;
      bankIfsc: string;
      bankHolderName: string;
    }
  ) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: { wallet: true },
    });
    if (!driver) throw new Error('Driver not found');

    const clean = this.validateBankDetailsInput(data);

    if (driver.wallet) {
      const activeWithdrawal = await prisma.walletTransaction.findFirst({
        where: {
          walletId: driver.wallet.id,
          type: 'WITHDRAWAL',
          status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] },
        },
      });
      if (activeWithdrawal) {
        throw new Error(
          'Cannot change bank details while a payout request is pending or processing'
        );
      }
    }

    return prisma.wallet.upsert({
      where: { driverId: driver.id },
      update: clean,
      create: {
        driverId: driver.id,
        balance: 0.0,
        lifetimeEarnings: 0.0,
        pendingWithdrawals: 0.0,
        ...clean,
      },
    });
  }

  async requestWithdrawal(userId: string, amount: number) {
    const driver = await prisma.driverProfile.findUnique({
      where: { userId },
      include: { wallet: true },
    });

    if (!driver) throw new Error('Driver profile not found');

    // Ensure wallet record exists before row-locking
    if (!driver.wallet) {
      await prisma.wallet.create({
        data: {
          driverId: driver.id,
          balance: 0.0,
          lifetimeEarnings: 0.0,
          pendingWithdrawals: 0.0,
        },
      });
    }

    const rawNum = Number(amount);
    if (!Number.isFinite(rawNum) || rawNum <= 0) {
      throw new Error('Valid withdrawal amount is required');
    }
    const cleanAmount = Math.round(rawNum * 100) / 100;
    if (cleanAmount < 500) {
      throw new Error('Minimum cashout amount is ₹500');
    }

    return prisma.$transaction(async (tx) => {
      // Acquire exclusive row lock on this driver's wallet to serialize concurrent withdrawal attempts
      const lockedWallets = await tx.$queryRaw<any[]>`
        SELECT * FROM "Wallet" WHERE "driverId" = ${driver.id} FOR UPDATE
      `;
      const liveWallet = lockedWallets[0];
      if (!liveWallet) throw new Error('Driver wallet not found');

      if (!liveWallet.bankAccountNumber || !liveWallet.bankIfsc) {
        throw new Error('Please link your bank account before requesting cashout');
      }

      if (Number(liveWallet.balance) < 0) {
        throw new Error('Cannot request cashout while outstanding company dues exist');
      }

      // Prevent duplicate active withdrawal requests
      const activePending = await tx.walletTransaction.findFirst({
        where: {
          walletId: liveWallet.id,
          type: 'WITHDRAWAL',
          status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] },
        },
      });
      if (activePending) {
        throw new Error(
          'You already have an active cashout request in progress. Please wait for it to be settled.'
        );
      }

      // Available balance validation inside lock
      const available = Math.round(Number(liveWallet.balance) * 100) / 100;
      if (cleanAmount > available) {
        throw new Error(`Requested amount ₹${cleanAmount} exceeds available balance ₹${available}`);
      }

      // Weekly cashout limit using actual successful payment date (paidAt) when present
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
          OR: [
            { paidAt: { gte: startOfCurrentWeek } },
            { AND: [{ paidAt: null }, { createdAt: { gte: startOfCurrentWeek } }] },
          ],
        },
      });
      if (paidThisWeek) {
        throw new Error(
          'Weekly cashout limit reached. Only one cashout is allowed per settlement week.'
        );
      }

      const prevBal = available;
      const newBal = Math.round((prevBal - cleanAmount) * 100) / 100;

      // Conditional balance update as secondary defense
      const conditionalUpd = await tx.wallet.updateMany({
        where: {
          id: liveWallet.id,
          balance: { gte: cleanAmount },
        },
        data: {
          balance: newBal,
          pendingWithdrawals:
            Math.round((Number(liveWallet.pendingWithdrawals) + cleanAmount) * 100) / 100,
        },
      });
      if (conditionalUpd.count !== 1) {
        throw new Error('Insufficient wallet balance for withdrawal');
      }

      const updatedWallet = await tx.wallet.findUnique({
        where: { id: liveWallet.id },
      });

      const acctSuffix = String(liveWallet.bankAccountNumber).slice(-4);
      const transaction = await tx.walletTransaction.create({
        data: {
          walletId: liveWallet.id,
          amount: cleanAmount,
          type: 'WITHDRAWAL',
          status: 'PENDING',
          previousBalance: prevBal,
          newBalance: newBal,
          bankName: liveWallet.bankName || null,
          bankAccountNumber: liveWallet.bankAccountNumber,
          bankIfsc: liveWallet.bankIfsc,
          bankHolderName: liveWallet.bankHolderName || null,
          description: `Weekly cashout request to A/C ****${acctSuffix}`,
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

  async getCustomerTransactions(userId: string, page = 1, limit = 20) {
    const wallet = await this.getCustomerWallet(userId);
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      prisma.customerWalletTransaction.findMany({
        where: { walletId: wallet.id },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.customerWalletTransaction.count({
        where: { walletId: wallet.id },
      }),
    ]);

    return {
      walletId: wallet.id,
      balance: wallet.balance,
      transactions,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }
}

export const walletService = new WalletService();
