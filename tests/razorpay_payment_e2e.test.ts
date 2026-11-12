import 'dotenv/config';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { prisma } from '../src/config/prisma';
import { paymentsService, RazorpayClientLike } from '../src/modules/payments/payments.service';
import { ridesService } from '../src/modules/rides/rides.service';
import { adminController } from '../src/modules/admin/admin.controller';
import { PricingSlabsService } from '../src/modules/pricing-slabs/pricing-slabs.service';

function makeMockReply() {
  let code = 200;
  let body: any = null;
  const reply: any = {
    status(c: number) {
      code = c;
      return reply;
    },
    send(b: any) {
      body = b;
      return reply;
    },
    getCode: () => code,
    getBody: () => body,
  };
  return reply;
}

async function run() {
  const stamp = Date.now().toString();
  const prevKeyId = process.env.RAZORPAY_KEY_ID;
  const prevKeySecret = process.env.RAZORPAY_KEY_SECRET;
  const prevWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  const createdRideIds: string[] = [];
  let custAId = '';
  let custBId = '';
  let drvUserId = '';
  let drvProfileId = '';
  let slabId = '';

  const slabService = new PricingSlabsService();
  const testZone = `QA_RZP_${stamp}`;

  try {
    // 1. Check blocked behavior cleanly when keys are absent
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;

    const gwBlocked = paymentsService.getGatewayStatus();
    assert.equal(gwBlocked.blocked, true, 'Gateway must report blocked when keys missing');

    // Seed users, driver + wallet, customer, and 20% pricing slab
    const custA = await prisma.user.create({
      data: { phone: `9800${stamp.slice(-6)}`, name: 'QA Cust A', email: `qa_a_${stamp}@test.local`, role: 'CUSTOMER' },
    });
    const custB = await prisma.user.create({
      data: { phone: `9801${stamp.slice(-6)}`, name: 'QA Cust B', email: `qa_b_${stamp}@test.local`, role: 'CUSTOMER' },
    });
    const drvUser = await prisma.user.create({
      data: { phone: `9802${stamp.slice(-6)}`, name: 'QA Driver', role: 'DRIVER' },
    });
    const drv = await prisma.driverProfile.create({
      data: { userId: drvUser.id, personaType: 'OWN_VEHICLE', approvalStatus: 'APPROVED' },
    });
    custAId = custA.id;
    custBId = custB.id;
    drvUserId = drvUser.id;
    drvProfileId = drv.id;

    // 20% slab: 2km included base = ₹100, perKm = ₹25 -> 18km trip = 100 + 16*25 = ₹500 (20% = ₹100, driver = ₹400)
    const slab = await slabService.createSlab({
      name: `QA RZP Slab ${stamp}`,
      category: 'BUDGET',
      vehicleType: 'Sedan',
      rideType: 'Local One Way',
      zone: testZone,
      baseFare: 100,
      baseKm: 2,
      perKmRate: 25,
      perMinRate: 0,
      commissionPercent: 20,
      isActive: true,
    });
    slabId = slab.id;

    const ride1 = await ridesService.requestRide(custA.id, {
      pickupLocation: 'Point A',
      pickupLat: 11.93,
      pickupLng: 79.83,
      dropLocation: 'Point B',
      dropLat: 12.05,
      dropLng: 79.92,
      distanceKm: 18,
      customTripType: 'Local One Way',
      carName: 'Sedan',
      paymentMethod: 'UPI',
      zone: testZone,
    });
    createdRideIds.push(ride1.id);
    const fare1 = ride1.estimatedFare;
    assert(fare1 > 0, 'Calculated backend fare must be positive');
    const paise1 = Math.round(fare1 * 100);
    const comm1 = Math.round(fare1 * 0.2 * 100) / 100;
    const net1 = Math.round((fare1 - comm1) * 100) / 100;

    // Ensure order creation is blocked when secrets missing
    let orderBlockedErr: any = null;
    try {
      await paymentsService.createRazorpayOrder({ customerId: custA.id, rideIdentifier: ride1.id });
    } catch (e) {
      orderBlockedErr = e;
    }
    assert.equal(orderBlockedErr?.blocked, true, 'createRazorpayOrder must fail blocked when keys missing');

    // Configure scoped test keys & fake Razorpay Order client
    process.env.RAZORPAY_KEY_ID = 'rzp_test_qa_key';
    process.env.RAZORPAY_KEY_SECRET = 'qa_secret_value_123';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'qa_webhook_secret_456';

    let orderSeq = 0;
    const mockGateway: RazorpayClientLike = {
      orders: {
        async create(params) {
          orderSeq++;
          return {
            id: `order_qa_${stamp}_${orderSeq}`,
            amount: params.amount,
            currency: params.currency,
            receipt: params.receipt,
            status: 'created',
          };
        },
      },
    };
    paymentsService.setRazorpayClientForTesting(mockGateway);

    // 2. Ownership failure test
    await assert.rejects(
      () => paymentsService.createRazorpayOrder({ customerId: custB.id, rideIdentifier: ride1.id }),
      (err: any) => err?.statusCode === 403
    );

    // 3. Valid Razorpay order creation + idempotent reuse
    const createdOrder = await paymentsService.createRazorpayOrder({
      customerId: custA.id,
      rideIdentifier: ride1.id,
      paymentMethod: 'UPI',
    });
    assert.equal(createdOrder.amountPaise, paise1);
    assert.equal(createdOrder.amountInr, fare1);
    assert.equal(createdOrder.currency, 'INR');
    assert.equal(createdOrder.keyId, 'rzp_test_qa_key');
    assert.equal(createdOrder.reused, false);

    const reusedOrder = await paymentsService.createRazorpayOrder({
      customerId: custA.id,
      rideIdentifier: ride1.id,
      paymentMethod: 'UPI',
    });
    assert.equal(reusedOrder.orderId, createdOrder.orderId, 'Duplicate open order must be reused idempotently');
    assert.equal(reusedOrder.reused, true);
    assert.equal(orderSeq, 1, 'Razorpay Orders API must only be invoked once for open order');
    console.log('✅ Test 1-3: Missing credentials blocked, ownership enforced, backend ₹500 order & idempotent reuse passed');

    // 4. Complete Ride1 with pending online payment -> wallet NOT credited
    await prisma.ride.update({ where: { id: ride1.id }, data: { driverId: drv.id, status: 'ONGOING' } });
    const completedRide1 = await ridesService.completeRide(ride1.id);
    assert.equal(completedRide1.paymentStatus, 'PENDING');
    let wallet = await prisma.wallet.findUnique({ where: { driverId: drv.id } });
    assert.equal(wallet, null, 'Wallet must not be credited before verified payment');

    // 5. Invalid signature / wrong order / cross-ride check
    const pay1 = `pay_qa_1_${stamp}`;
    await assert.rejects(
      () =>
        paymentsService.verifyClientRazorpayPayment({
          customerId: custA.id,
          rideIdentifier: ride1.id,
          razorpayOrderId: createdOrder.orderId,
          razorpayPaymentId: pay1,
          razorpaySignature: 'bad_sig_xyz',
        }),
      (err: any) => err?.statusCode === 400
    );
    const failedTx = await prisma.paymentTransaction.findUnique({
      where: { razorpayOrderId: createdOrder.orderId },
    });
    assert.equal(failedTx?.status, 'FAILED', 'Bad signature must mark tx FAILED cleanly');

    await assert.rejects(
      () =>
        paymentsService.verifyClientRazorpayPayment({
          customerId: custA.id,
          rideIdentifier: ride1.id,
          razorpayOrderId: 'order_non_existent',
          razorpayPaymentId: pay1,
          razorpaySignature: 'sig',
        }),
      (err: any) => err?.statusCode === 404
    );

    // Reset tx back to CREATED to test payment.authorized webhook first
    await prisma.paymentTransaction.update({
      where: { id: failedTx!.id },
      data: { status: 'CREATED', verificationStatus: 'UNVERIFIED', failureReason: null, failedAt: null },
    });

    // 6. Webhook: invalid signature -> 401; payment.authorized -> AUTHORIZED only (no wallet credit)
    await assert.rejects(
      () =>
        paymentsService.handleRazorpayWebhookPayload({
          rawBody: '{}',
          signatureHeader: 'wrong',
        }),
      (err: any) => err?.statusCode === 401
    );

    const authBodyObj = {
      id: `evt_auth_${stamp}`,
      event: 'payment.authorized',
      payload: { payment: { entity: { id: pay1, order_id: createdOrder.orderId, method: 'upi', amount: paise1, currency: 'INR' } } },
    };
    const authRaw = JSON.stringify(authBodyObj);
    const authSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(authRaw).digest('hex');
    const authRes = await paymentsService.handleRazorpayWebhookPayload({
      rawBody: authRaw,
      signatureHeader: authSig,
      eventIdHeader: authBodyObj.id,
      parsedBody: authBodyObj,
    });
    assert.equal((authRes as any).settledNow, false);
    wallet = await prisma.wallet.findUnique({ where: { driverId: drv.id } });
    assert.equal(wallet, null, 'AUTHORIZED event must NOT credit driver wallet');

    // 7. Client signature verification settles Ride1 ONCE (₹500 -> ₹400 driver net, ₹100 commission)
    const validSig1 = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${createdOrder.orderId}|${pay1}`)
      .digest('hex');
    const verify1 = await paymentsService.verifyClientRazorpayPayment({
      customerId: custA.id,
      rideIdentifier: ride1.id,
      razorpayOrderId: createdOrder.orderId,
      razorpayPaymentId: pay1,
      razorpaySignature: validSig1,
      paymentMethod: 'UPI',
    });
    assert.equal(verify1.settledNow, true);
    assert.equal(verify1.driverNetEarnings, net1);
    assert.equal(verify1.companyCommission, comm1);

    wallet = await prisma.wallet.findUnique({ where: { driverId: drv.id } });
    assert.equal(wallet?.balance, net1);

    // Duplicate client verify & delayed webhook arrive after verify -> idempotent (no duplicate credit)
    const verifyDup = await paymentsService.verifyClientRazorpayPayment({
      customerId: custA.id,
      rideIdentifier: ride1.id,
      razorpayOrderId: createdOrder.orderId,
      razorpayPaymentId: pay1,
      razorpaySignature: validSig1,
    });
    assert.equal(verifyDup.settledNow, false);

    const capBody1 = {
      id: `evt_cap1_${stamp}`,
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: pay1,
            order_id: createdOrder.orderId,
            method: 'upi',
            amount: paise1,
            currency: 'INR',
            notes: { rideId: ride1.id },
          },
        },
      },
    };
    const capRaw1 = JSON.stringify(capBody1);
    const capSig1 = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(capRaw1).digest('hex');
    const capRes1 = await paymentsService.handleRazorpayWebhookPayload({
      rawBody: capRaw1,
      signatureHeader: capSig1,
      eventIdHeader: capBody1.id,
      parsedBody: capBody1,
    });
    assert.equal((capRes1 as any).settledNow, false);

    // Duplicate webhook event ID
    const capDup = await paymentsService.handleRazorpayWebhookPayload({
      rawBody: capRaw1,
      signatureHeader: capSig1,
      eventIdHeader: capBody1.id,
      parsedBody: capBody1,
    });
    assert.equal((capDup as any).duplicateEvent, true);
    wallet = await prisma.wallet.findUnique({ where: { driverId: drv.id } });
    assert.equal(wallet?.balance, net1, `Balance must still be ₹${net1}`);
    console.log('✅ Test 4-7: Invalid sig, AUTHORIZED hold, 20% commission split, and verify->webhook idempotency passed');

    // 8. Reverse order: Webhook arrives BEFORE client verification on Ride2, plus wrong currency rejection
    const ride2 = await ridesService.requestRide(custA.id, {
      pickupLocation: 'Point X',
      pickupLat: 11.93,
      pickupLng: 79.83,
      dropLocation: 'Point Y',
      dropLat: 12.05,
      dropLng: 79.92,
      distanceKm: 18,
      customTripType: 'Local One Way',
      carName: 'Sedan',
      paymentMethod: 'UPI',
      zone: testZone,
    });
    createdRideIds.push(ride2.id);
    await prisma.ride.update({ where: { id: ride2.id }, data: { driverId: drv.id, status: 'ONGOING' } });
    await ridesService.completeRide(ride2.id);

    const order2 = await paymentsService.createRazorpayOrder({ customerId: custA.id, rideIdentifier: ride2.id });
    const pay2 = `pay_qa_2_${stamp}`;

    // Wrong currency USD rejected
    const badCurBody = {
      id: `evt_usd_${stamp}`,
      event: 'payment.captured',
      payload: { payment: { entity: { id: pay2, order_id: order2.orderId, amount: 50000, currency: 'USD', notes: { rideId: ride2.id } } } },
    };
    const badCurRaw = JSON.stringify(badCurBody);
    const badCurSig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(badCurRaw).digest('hex');
    await assert.rejects(
      () =>
        paymentsService.handleRazorpayWebhookPayload({
          rawBody: badCurRaw,
          signatureHeader: badCurSig,
          eventIdHeader: badCurBody.id,
          parsedBody: badCurBody,
        }),
      (err: any) => err?.statusCode === 400
    );

    // Valid webhook arrives FIRST
    const capBody2 = {
      id: `evt_cap2_${stamp}`,
      event: 'payment.captured',
      payload: { payment: { entity: { id: pay2, order_id: order2.orderId, method: 'card', amount: paise1, currency: 'INR', notes: { rideId: ride2.id } } } },
    };
    const capRaw2 = JSON.stringify(capBody2);
    const capSig2 = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(capRaw2).digest('hex');
    const wh2 = await paymentsService.handleRazorpayWebhookPayload({
      rawBody: capRaw2,
      signatureHeader: capSig2,
      eventIdHeader: capBody2.id,
      parsedBody: capBody2,
    });
    assert.equal((wh2 as any).settledNow, true);

    // Client verify arrives SECOND -> idempotent
    const validSig2 = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!)
      .update(`${order2.orderId}|${pay2}`)
      .digest('hex');
    const cv2 = await paymentsService.verifyClientRazorpayPayment({
      customerId: custA.id,
      rideIdentifier: ride2.id,
      razorpayOrderId: order2.orderId,
      razorpayPaymentId: pay2,
      razorpaySignature: validSig2,
    });
    assert.equal(cv2.settledNow, false);
    wallet = await prisma.wallet.findUnique({ where: { driverId: drv.id } });
    const afterTwoOnline = Math.round((net1 + net1) * 100) / 100;
    assert.equal(wallet?.balance, afterTwoOnline, `Two online rides must equal ${afterTwoOnline}`);

    // Cross-ride attach attempt: try attaching pay2 to Ride3 (must fail 409)
    const ride3 = await ridesService.requestRide(custA.id, {
      pickupLocation: 'Point M',
      pickupLat: 11.93,
      pickupLng: 79.83,
      dropLocation: 'Point N',
      dropLat: 12.05,
      dropLng: 79.92,
      distanceKm: 18,
      customTripType: 'Local One Way',
      carName: 'Sedan',
      paymentMethod: 'UPI',
      zone: testZone,
    });
    createdRideIds.push(ride3.id);
    const order3 = await paymentsService.createRazorpayOrder({ customerId: custA.id, rideIdentifier: ride3.id });
    const crossSig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!).update(`${order3.orderId}|${pay2}`).digest('hex');
    await assert.rejects(
      () =>
        paymentsService.verifyClientRazorpayPayment({
          customerId: custA.id,
          rideIdentifier: ride3.id,
          razorpayOrderId: order3.orderId,
          razorpayPaymentId: pay2,
          razorpaySignature: crossSig,
        }),
      (err: any) => err?.statusCode === 409
    );

    // Payment failure webhook on Ride3
    const failBody3 = {
      id: `evt_fail3_${stamp}`,
      event: 'payment.failed',
      payload: { payment: { entity: { id: `pay_fail_${stamp}`, order_id: order3.orderId, method: 'upi', error_description: 'UPI pin expired' } } },
    };
    const failRaw3 = JSON.stringify(failBody3);
    const failSig3 = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(failRaw3).digest('hex');
    const failRes3 = await paymentsService.handleRazorpayWebhookPayload({
      rawBody: failRaw3,
      signatureHeader: failSig3,
      eventIdHeader: failBody3.id,
      parsedBody: failBody3,
    });
    assert.equal((failRes3 as any).status, 'FAILED');

    // 9. Cash ride regression + Admin getPayments check
    const cashRide = await ridesService.requestRide(custA.id, {
      pickupLocation: 'Point P',
      pickupLat: 11.93,
      pickupLng: 79.83,
      dropLocation: 'Point Q',
      dropLat: 12.05,
      dropLng: 79.92,
      distanceKm: 18,
      customTripType: 'Local One Way',
      carName: 'Sedan',
      paymentMethod: 'CASH',
      zone: testZone,
    });
    createdRideIds.push(cashRide.id);
    await prisma.ride.update({ where: { id: cashRide.id }, data: { driverId: drv.id, status: 'ONGOING' } });
    await ridesService.completeRide(cashRide.id);
    wallet = await prisma.wallet.findUnique({ where: { driverId: drv.id } });
    const expectedAfterCash = Math.round((afterTwoOnline - comm1) * 100) / 100;
    assert.equal(wallet?.balance, expectedAfterCash, `Cash @ 20% deducts ₹${comm1} dues -> ₹${expectedAfterCash}`);

    const adminRep = makeMockReply();
    await adminController.getPayments({ query: { status: 'FAILED' } } as any, adminRep);
    assert.equal(adminRep.getCode(), 200);
    const failedRows = adminRep.getBody().data.payments as any[];
    assert(failedRows.some((p) => p.rideId === ride3.id && p.gatewayStatus === 'FAILED'));

    const adminAll = makeMockReply();
    await adminController.getPayments({ query: {} } as any, adminAll);
    const ride1Row = (adminAll.getBody().data.payments as any[]).find((p) => p.rideId === ride1.id);
    assert.equal(ride1Row.razorpayOrderId, createdOrder.orderId);
    assert.equal(ride1Row.razorpayPaymentId, pay1);

    // 10. DB rollback verification on transaction error
    const ride4 = await ridesService.requestRide(custA.id, {
      pickupLocation: 'Point R',
      pickupLat: 11.93,
      pickupLng: 79.83,
      dropLocation: 'Point S',
      dropLat: 12.05,
      dropLng: 79.92,
      distanceKm: 18,
      customTripType: 'Local One Way',
      carName: 'Sedan',
      paymentMethod: 'UPI',
      zone: testZone,
    });
    createdRideIds.push(ride4.id);
    await prisma.ride.update({ where: { id: ride4.id }, data: { driverId: drv.id, status: 'ONGOING' } });
    await ridesService.completeRide(ride4.id);
    const origSettle = ridesService.settleCompletedRideWalletInTx.bind(ridesService);
    (ridesService as any).settleCompletedRideWalletInTx = async () => {
      throw new Error('Simulated allocation failure');
    };
    const order4 = await paymentsService.createRazorpayOrder({ customerId: custA.id, rideIdentifier: ride4.id });
    const pay4 = `pay_qa_4_${stamp}`;
    const sig4 = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!).update(`${order4.orderId}|${pay4}`).digest('hex');
    await assert.rejects(
      () =>
        paymentsService.verifyClientRazorpayPayment({
          customerId: custA.id,
          rideIdentifier: ride4.id,
          razorpayOrderId: order4.orderId,
          razorpayPaymentId: pay4,
          razorpaySignature: sig4,
        }),
      /Simulated allocation failure/
    );
    (ridesService as any).settleCompletedRideWalletInTx = origSettle;
    const ride4AfterRollback = await prisma.ride.findUnique({ where: { id: ride4.id } });
    const order4AfterRollback = await prisma.paymentTransaction.findUnique({ where: { razorpayOrderId: order4.orderId } });
    assert.equal(ride4AfterRollback?.paymentStatus, 'PENDING', 'Ride status must roll back on wallet allocation failure');
    assert.equal(order4AfterRollback?.status, 'CREATED', 'PaymentTransaction status must roll back cleanly');

    console.log('✅ Test 8-10: Webhook->Verify order, cross-ride block, FAILED webhook, Cash regression, Admin getPayments, & TX rollback passed!');
    console.log('\n🎉 ALL 10 RAZORPAY BACKEND E2E & FINANCIAL TESTS PASSED!');
  } finally {
    paymentsService.setRazorpayClientForTesting(null);
    if (prevKeyId === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = prevKeyId;
    if (prevKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = prevKeySecret;
    if (prevWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
    else process.env.RAZORPAY_WEBHOOK_SECRET = prevWebhookSecret;

    if (drvProfileId) {
      const w = await prisma.wallet.findUnique({ where: { driverId: drvProfileId } });
      if (w) {
        await prisma.walletTransaction.deleteMany({ where: { walletId: w.id } });
        await prisma.wallet.delete({ where: { id: w.id } });
      }
    }
    for (const rid of createdRideIds) {
      await prisma.gatewayWebhookEvent.deleteMany({
        where: { paymentTransaction: { rideId: rid } },
      });
      await prisma.paymentTransaction.deleteMany({ where: { rideId: rid } });
      await prisma.fareBreakdown.deleteMany({ where: { rideId: rid } });
      await prisma.ride.deleteMany({ where: { id: rid } });
    }
    await prisma.gatewayWebhookEvent.deleteMany({
      where: { eventId: { contains: stamp } },
    });
    if (slabId) await prisma.pricingSlab.deleteMany({ where: { id: slabId } });
    if (drvProfileId) await prisma.driverProfile.deleteMany({ where: { id: drvProfileId } });
    if (drvUserId) await prisma.user.deleteMany({ where: { id: drvUserId } });
    if (custAId) await prisma.user.deleteMany({ where: { id: custAId } });
    if (custBId) await prisma.user.deleteMany({ where: { id: custBId } });
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
