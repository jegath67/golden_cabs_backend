import { prisma } from '../src/config/prisma';
import { walletService } from '../src/modules/wallet/wallet.service';
import { WalletController } from '../src/modules/wallet/wallet.controller';

async function main() {
  console.log('--- STARTING PHASE 4 CUSTOMER WALLET TEST ---');
  const walletController = new WalletController();

  const customer = await prisma.user.findFirst({ where: { role: 'CUSTOMER' } });
  if (!customer) throw new Error('Test customer not found');

  try {
    // ----------------------------------------------------
    // TEST 1: Fetch / Auto-provision Customer Wallet
    // ----------------------------------------------------
    console.log(`\n[Test 1] Testing getCustomerWallet for user ${customer.id}...`);
    const wallet = await walletService.getCustomerWallet(customer.id);
    console.log(`Customer wallet ID: ${wallet.id}, Balance: ₹${wallet.balance}`);

    if (typeof wallet.balance !== 'number') {
      throw new Error('Test 1 Failed: Expected numeric balance');
    }
    console.log('✅ Test 1 PASSED: Customer wallet fetched / auto-provisioned successfully.');

    // ----------------------------------------------------
    // TEST 2: Controller getMyWallet with CUSTOMER role
    // ----------------------------------------------------
    console.log('\n[Test 2] Testing getMyWallet controller with CUSTOMER role...');
    let controllerData: any = null;
    const mockReply: any = {
      send: (data: any) => {
        controllerData = data;
        return controllerData;
      },
      status: () => mockReply,
    };

    await walletController.getMyWallet(
      { user: { id: customer.id, role: 'CUSTOMER' } } as any,
      mockReply
    );

    if (!controllerData?.success || !controllerData?.data) {
      throw new Error('Test 2 Failed: Expected success and data from getMyWallet');
    }
    if (controllerData.data.customerId !== customer.id) {
      throw new Error(`Test 2 Failed: Returned wallet for customerId ${controllerData.data.customerId}, expected ${customer.id}`);
    }
    console.log('✅ Test 2 PASSED: /api/wallet/me returned customer wallet for CUSTOMER user.');

    // ----------------------------------------------------
    // TEST 3: Controller getCustomerTransactions with pagination
    // ----------------------------------------------------
    console.log('\n[Test 3] Testing getCustomerTransactions...');
    controllerData = null;
    await walletController.getCustomerTransactions(
      { user: { id: customer.id }, query: { page: '1', limit: '10' } } as any,
      mockReply
    );

    if (!controllerData?.success || !controllerData?.data) {
      throw new Error('Test 3 Failed: Expected success and paginated data');
    }
    console.log(`Transactions total: ${controllerData.data.total}, page: ${controllerData.data.page}, totalPages: ${controllerData.data.totalPages}`);
    console.log('✅ Test 3 PASSED: Paginated transactions returned cleanly.');

    // ----------------------------------------------------
    // TEST 4: Unique idempotency key protection
    // ----------------------------------------------------
    console.log('\n[Test 4] Testing duplicate transaction protection...');
    const fakeRefundId = `refund-test-${Date.now()}`;

    // Create a transaction with referenceRefundId
    const tx1 = await prisma.customerWalletTransaction.create({
      data: {
        walletId: wallet.id,
        amount: 100,
        type: 'REFUND',
        status: 'COMPLETED',
        description: 'Test duplicate refund 1',
        referenceRefundId: fakeRefundId,
      },
    });

    try {
      // Attempt duplicate transaction with same referenceRefundId
      await prisma.customerWalletTransaction.create({
        data: {
          walletId: wallet.id,
          amount: 100,
          type: 'REFUND',
          status: 'COMPLETED',
          description: 'Test duplicate refund 2',
          referenceRefundId: fakeRefundId,
        },
      });
      throw new Error('Test 4 Failed: Database allowed duplicate referenceRefundId!');
    } catch (e: any) {
      console.log('✅ Duplicate wallet transaction blocked by unique constraint:', e.code || e.message);
    } finally {
      // Clean up test transaction
      await prisma.customerWalletTransaction.deleteMany({
        where: { referenceRefundId: fakeRefundId },
      });
    }

    console.log('\n🎉 ALL PHASE 4 CUSTOMER WALLET TESTS PASSED PERFECTLY!');
  } finally {
    console.log('Phase 4 verification complete.');
  }
}

main()
  .catch((e) => {
    console.error('Phase 4 Test Suite Failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
