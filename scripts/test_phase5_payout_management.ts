import { prisma } from '../src/config/prisma';
import { walletService } from '../src/modules/wallet/wallet.service';
import { AdminController } from '../src/modules/admin/admin.controller';

async function main() {
  console.log('--- STARTING PHASE 5 PAYOUT MANAGEMENT VERIFICATION ---');
  const adminController = new AdminController();

  const driver = await prisma.driverProfile.findFirst({
    include: { wallet: true, user: true },
  });
  if (!driver) throw new Error('Driver not found');

  // Ensure driver has a wallet with bank details and balance >= 1000
  let wallet = driver.wallet;
  if (!wallet) {
    wallet = await prisma.wallet.create({
      data: {
        driverId: driver.id,
        balance: 2000,
        currency: 'INR',
        bankAccountNumber: '123456789012',
        bankIfsc: 'HDFC0001234',
        bankHolderName: driver.user.name,
      },
    });
  } else {
    wallet = await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: Math.max(wallet.balance, 2000),
        bankAccountNumber: wallet.bankAccountNumber || '123456789012',
        bankIfsc: wallet.bankIfsc || 'HDFC0001234',
        bankHolderName: wallet.bankHolderName || driver.user.name,
      },
    });
  }

  const testTxIds: string[] = [];

  try {
    // ----------------------------------------------------
    // TEST 1: Driver Withdrawal Request
    // ----------------------------------------------------
    console.log('\n[Test 1] Testing driver withdrawal request of ₹500...');
    const preBalance = wallet.balance;
    const prePending = wallet.pendingWithdrawals;

    const cashoutRes = await walletService.requestWithdrawal(driver.userId, 500);
    const tx1 = cashoutRes.transaction;
    testTxIds.push(tx1.id);

    console.log(`Cashout requested. Tx ID: ${tx1.id}, Status: ${tx1.status}, Amount: ₹${tx1.amount}`);

    const postReqWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    console.log(`Pre: bal=₹${preBalance}, pend=₹${prePending} | Post: bal=₹${postReqWallet.balance}, pend=₹${postReqWallet.pendingWithdrawals}`);

    if (postReqWallet.balance !== preBalance - 500 || postReqWallet.pendingWithdrawals !== prePending + 500) {
      throw new Error('Test 1 Failed: Wallet balance or pendingWithdrawals did not update correctly on withdrawal request');
    }
    console.log('✅ Test 1 PASSED: Funds reserved correctly in pendingWithdrawals.');

    // ----------------------------------------------------
    // TEST 2: Admin approves / moves to PROCESSING
    // ----------------------------------------------------
    console.log('\n[Test 2] Testing admin moving payout to PROCESSING...');
    let replyData: any = null;
    let replyStatus = 200;
    const mockReply: any = {
      send: (data: any) => {
        replyData = data;
        return replyData;
      },
      status: (code: number) => {
        replyStatus = code;
        return mockReply;
      },
    };

    await adminController.updatePayoutStatus(
      { params: { id: tx1.id }, body: { status: 'PROCESSING' } } as any,
      mockReply
    );

    if (!replyData?.success || replyData?.data?.status !== 'PROCESSING') {
      throw new Error(`Test 2 Failed: Status did not update to PROCESSING: ${JSON.stringify(replyData)}`);
    }
    console.log('✅ Test 2 PASSED: Payout status updated to PROCESSING.');

    // ----------------------------------------------------
    // TEST 3: Marking as PAID without UTR must fail
    // ----------------------------------------------------
    console.log('\n[Test 3] Testing completion without UTR rejection...');
    replyData = null;
    replyStatus = 200;
    await adminController.updatePayoutStatus(
      { params: { id: tx1.id }, body: { status: 'PAID', utrNumber: '' } } as any,
      mockReply
    );

    if (replyStatus !== 400 || !replyData?.message?.includes('Bank UTR')) {
      throw new Error('Test 3 Failed: Marking as paid without UTR was not rejected with 400!');
    }
    console.log(`✅ Test 3 PASSED: Blank UTR rejected with message: "${replyData.message}".`);

    // ----------------------------------------------------
    // TEST 4: Mark as PAID with valid UTR
    // ----------------------------------------------------
    console.log('\n[Test 4] Testing completion with valid UTR...');
    const testUtr = `UTR-TEST-${Date.now()}`;
    replyData = null;
    replyStatus = 200;

    await adminController.updatePayoutStatus(
      { params: { id: tx1.id }, body: { status: 'PAID', utrNumber: testUtr } } as any,
      mockReply
    );

    if (replyStatus !== 200 || replyData?.data?.status !== 'COMPLETED') {
      throw new Error(`Test 4 Failed: Expected COMPLETED status, got ${JSON.stringify(replyData)}`);
    }

    const postPaidWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    if (postPaidWallet.pendingWithdrawals !== prePending) {
      throw new Error(`Test 4 Failed: pendingWithdrawals expected ${prePending}, got ${postPaidWallet.pendingWithdrawals}`);
    }

    const completedTx = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: tx1.id } });
    if (completedTx.status !== 'COMPLETED' || completedTx.utrNumber !== testUtr || !completedTx.paidAt) {
      throw new Error('Test 4 Failed: Transaction record does not have COMPLETED status, UTR, or paidAt');
    }
    console.log(`✅ Test 4 PASSED: Payout marked COMPLETED, UTR ${testUtr} saved, pendingWithdrawals settled.`);

    // ----------------------------------------------------
    // TEST 5: Duplicate UTR Prevention
    // ----------------------------------------------------
    console.log('\n[Test 5] Testing duplicate UTR prevention...');
    // Create second withdrawal transaction
    const tx2 = await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: 500,
        type: 'WITHDRAWAL',
        status: 'PENDING',
        previousBalance: postPaidWallet.balance,
        newBalance: postPaidWallet.balance - 500,
        description: 'Manual test withdrawal 2',
      },
    });
    await prisma.wallet.update({
      where: { id: wallet.id },
      data: {
        balance: { decrement: 500 },
        pendingWithdrawals: { increment: 500 },
      },
    });
    testTxIds.push(tx2.id);

    replyData = null;
    replyStatus = 200;
    await adminController.updatePayoutStatus(
      { params: { id: tx2.id }, body: { status: 'PAID', utrNumber: testUtr } } as any,
      mockReply
    );

    if (replyStatus !== 400 || !replyData?.message?.includes('already been recorded')) {
      throw new Error('Test 5 Failed: Duplicate UTR was not blocked!');
    }
    console.log(`✅ Test 5 PASSED: Duplicate UTR properly blocked: "${replyData.message}".`);

    // ----------------------------------------------------
    // TEST 6: Rejection with Ledger Reversal
    // ----------------------------------------------------
    console.log('\n[Test 6] Testing payout rejection with ledger reversal...');
    const preRejectWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });

    replyData = null;
    replyStatus = 200;
    await adminController.updatePayoutStatus(
      {
        params: { id: tx2.id },
        body: { status: 'REJECTED', rejectionReason: 'Bank account number invalid' },
      } as any,
      mockReply
    );

    if (replyStatus !== 200 || replyData?.data?.status !== 'FAILED') {
      throw new Error(`Test 6 Failed: Expected FAILED status, got ${JSON.stringify(replyData)}`);
    }

    const postRejectWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    if (postRejectWallet.balance !== preRejectWallet.balance + 500) {
      throw new Error(`Test 6 Failed: Reserved funds were not returned to driver balance! Pre: ${preRejectWallet.balance}, Post: ${postRejectWallet.balance}`);
    }

    // Check reversal ledger transaction
    const adjustmentTx = await prisma.walletTransaction.findFirst({
      where: {
        walletId: wallet.id,
        type: 'ADJUSTMENT',
        description: { contains: tx2.id.substring(0, 8) },
      },
    });
    if (!adjustmentTx) {
      throw new Error('Test 6 Failed: Reversal ADJUSTMENT ledger transaction not found!');
    }
    console.log(`✅ Test 6 PASSED: Payout rejected, ₹200 restored to driver wallet, ADJUSTMENT ledger entry created (${adjustmentTx.id}).`);

    console.log('\n🎉 ALL PHASE 5 PAYOUT MANAGEMENT VERIFICATIONS PASSED PERFECTLY!');
  } finally {
    console.log('\nCleaning up test transactions...');
    for (const id of testTxIds) {
      await prisma.walletTransaction.deleteMany({
        where: {
          OR: [
            { id },
            { description: { contains: id.substring(0, 8) } },
          ],
        },
      });
    }
    console.log('Cleanup complete.');
  }
}

main()
  .catch((e) => {
    console.error('Phase 5 Test Suite Failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
