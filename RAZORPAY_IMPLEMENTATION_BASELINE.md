# RAZORPAY_IMPLEMENTATION_BASELINE.md

## Scope & Inspected Repositories
- **Customer App:** `D:\flutter projects\golden_cabs` (`Flutter 3.47.5`, `Dart 3.13.4`, `sdk: ^3.7.2`)
- **Driver / Partner App:** `D:\flutter projects\golden_cabs_partner_final`
- **Admin Web App:** `D:\flutter projects\golden_cabs_admin`
- **Backend:** `D:\flutter projects\golden_cabs_backend` (Fastify 5, TypeScript, Prisma 7, PostgreSQL)

## Baseline Findings (Before Changes)

1. **Customer App (`golden_cabs`):**
   - Booking creates `Ride` via `BookingRepository.requestRide` (`POST /api/rides/request`), passing `paymentMethod` (`CASH`, `UPI`, `CARD`, `WALLET`).
   - On trip completion, `RideTrackingScreen` transitions to `PaymentScreen`.
   - `PaymentScreen` currently supports `cash` (navigates to `InvoiceScreen`) and shows an `"Online Payment Pending"` modal for `upi` alongside external URL scheme buttons (`googlepay://`, `phonepe://`, `upi://pay`).
   - `pubspec.yaml` contains **no** `razorpay_flutter` SDK and **no** backend order/verification/status calls exist.

2. **Backend (`golden_cabs_backend`):**
   - Existing `FareBreakdown` preserves `commissionPercent`, `commissionAmount`, `driverAmount`, and `pricingSlabId` calculated via Pricing Slab rules (`pricing-slabs.service.ts` + `rides.service.ts`). Default global fallback commission is `20%`, overridden per active `PricingSlab`.
   - Existing `PaymentsModule` (`src/modules/payments/`) exposes `GET /api/payments/gateway-status`, `POST /api/payments/razorpay/verify`, and `POST /api/payments/razorpay/webhook`, with HMAC signature verification and idempotent delayed wallet settlement (`settleCompletedRideWalletInTx`), **but lacks**:
     - `razorpay` SDK and Razorpay Orders API (`POST /api/payments/razorpay/order`)
     - Dedicated `PaymentTransaction` + webhook event persistence (gateway refs currently sit inside `Ride.stops` JSON)
     - `.env.example` / `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` environment configuration (currently `.env` only has `DATABASE_URL`, `NODE_ENV`)
     - `GET /api/payments/ride/:rideId/status` for safe client polling/refresh and `payment.failed` webhook handling.
   - `Wallet` and `WalletTransaction` implement Cash commission debit (`COMMISSION`), verified Online net driver earning (`EARNING`), and withdrawal/payout workflows (`WITHDRAWAL`).

3. **Driver App (`golden_cabs_partner_final`):**
   - Connects live via `HttpWalletRepositoryImpl` (`/api/wallet/me`, `/api/wallet/dashboard`, `/api/wallet/payouts`, `/api/wallet/withdraw`, `/api/wallet/bank-details`).
   - Displays persisted `FareBreakdown` (`TripFareBreakdownCard`) and dynamic commission rates (`EarningsScreen`), `TripSummaryScreen` refresh button, and history (`HistoryScreen`).
   - Minor UI encoding bug spotted in `history_trip_card.dart` (`â‚¹₹` duplicate rupee prefix).

4. **Admin App (`golden_cabs_admin`):**
   - `PaymentHistory` (`lib/screens/payment_screen.dart`) fetches `GET /api/admin/payments` and displays Cash/UPI/Card rows with Gross Fare, Platform Commission, Driver Share, and status.
   - Currently lacks actual Razorpay `PaymentTransaction` order/payment IDs, gateway statuses (`FAILED`, `AUTHORIZED`, `CAPTURED`), and dedicated status filter options for Failed/Refunded payments.
