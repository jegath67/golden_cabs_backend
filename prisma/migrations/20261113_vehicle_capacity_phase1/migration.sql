-- GOLDEN CABS – PHASE 1: HARDENED THREE-FIELD ATOMIC VEHICLE CAPACITY MIGRATION
-- TRANSACTION-SAFE, TRANSACTION-LOCAL LOCK-PROTECTED, IDEMPOTENT, ZERO OVERWRITE RISK

BEGIN;

-- 1. Prevent connection pile-up: fail fast if locks cannot be acquired within 5s (transaction-local)
SET LOCAL lock_timeout = '5s';

-- 2. Additive columns for Vehicle
ALTER TABLE "Vehicle" 
  ADD COLUMN IF NOT EXISTS "serviceCategory" TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS "vehicleClass" TEXT,
  ADD COLUMN IF NOT EXISTS "passengerCapacity" INTEGER,
  ADD COLUMN IF NOT EXISTS "driverSeatCount" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "totalCapacity" INTEGER,
  ADD COLUMN IF NOT EXISTS "capacityVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "capacityVerificationSource" TEXT,
  ADD COLUMN IF NOT EXISTS "capacityVerifiedAt" TIMESTAMP(3);

-- 3. Additive columns for PricingSlab
ALTER TABLE "PricingSlab" 
  ADD COLUMN IF NOT EXISTS "serviceCategory" TEXT NOT NULL DEFAULT 'NORMAL',
  ADD COLUMN IF NOT EXISTS "vehicleClass" TEXT,
  ADD COLUMN IF NOT EXISTS "passengerCapacity" INTEGER;

-- 4. Composite resolution index (Standard CREATE INDEX inside transaction)
CREATE INDEX IF NOT EXISTS "PricingSlab_serviceCategory_vehicleClass_idx" 
  ON "PricingSlab"("serviceCategory", "vehicleClass");

-- 5. Complete Schema Assertion and Three-Field Classification Block
DO $$
DECLARE
  v_rec RECORD;
  v_existing RECORD;
  v_idx_count INTEGER := 0;
  v_unclassified_count INTEGER := 0;
  v_already_classified_count INTEGER := 0;
  v_updated_count INTEGER := 0;
  v_final_elite_count INTEGER := 0;
  v_final_hatchback_count INTEGER := 0;
  v_final_sedan_count INTEGER := 0;
  v_final_suv_count INTEGER := 0;
  v_total_verified INTEGER := 0;
BEGIN
  -- =========================================================================
  -- PHASE 0: COMPLETE STRICT SCHEMA ASSERTIONS (CURRENT_SCHEMA)
  -- =========================================================================

  -- 0A. Validate Vehicle Columns (8 columns)

  -- 1. Vehicle.serviceCategory (TEXT, NOT NULL, DEFAULT 'NORMAL'::text)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'Vehicle' 
      AND column_name = 'serviceCategory' AND data_type = 'text' AND is_nullable = 'NO' 
      AND column_default = '''NORMAL''::text'
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: Vehicle.serviceCategory does not match expected definition (TEXT, NOT NULL, DEFAULT ''NORMAL''::text)';
  END IF;

  -- 2. Vehicle.vehicleClass (TEXT, nullable, DEFAULT NULL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'Vehicle' 
      AND column_name = 'vehicleClass' AND data_type = 'text' AND is_nullable = 'YES' 
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: Vehicle.vehicleClass does not match expected definition (TEXT, nullable, DEFAULT NULL)';
  END IF;

  -- 3. Vehicle.passengerCapacity (INTEGER, nullable, DEFAULT NULL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'Vehicle' 
      AND column_name = 'passengerCapacity' AND data_type = 'integer' AND is_nullable = 'YES' 
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: Vehicle.passengerCapacity does not match expected definition (INTEGER, nullable, DEFAULT NULL)';
  END IF;

  -- 4. Vehicle.driverSeatCount (INTEGER, NOT NULL, DEFAULT 1)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'Vehicle' 
      AND column_name = 'driverSeatCount' AND data_type = 'integer' AND is_nullable = 'NO' 
      AND column_default = '1'
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: Vehicle.driverSeatCount does not match expected definition (INTEGER, NOT NULL, DEFAULT 1)';
  END IF;

  -- 5. Vehicle.totalCapacity (INTEGER, nullable, DEFAULT NULL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'Vehicle' 
      AND column_name = 'totalCapacity' AND data_type = 'integer' AND is_nullable = 'YES' 
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: Vehicle.totalCapacity does not match expected definition (INTEGER, nullable, DEFAULT NULL)';
  END IF;

  -- 6. Vehicle.capacityVerified (BOOLEAN, NOT NULL, DEFAULT false)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'Vehicle' 
      AND column_name = 'capacityVerified' AND data_type = 'boolean' AND is_nullable = 'NO' 
      AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: Vehicle.capacityVerified does not match expected definition (BOOLEAN, NOT NULL, DEFAULT false)';
  END IF;

  -- 7. Vehicle.capacityVerificationSource (TEXT, nullable, DEFAULT NULL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'Vehicle' 
      AND column_name = 'capacityVerificationSource' AND data_type = 'text' AND is_nullable = 'YES' 
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: Vehicle.capacityVerificationSource does not match expected definition (TEXT, nullable, DEFAULT NULL)';
  END IF;

  -- 8. Vehicle.capacityVerifiedAt (TIMESTAMP WITHOUT TIME ZONE, nullable, DEFAULT NULL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'Vehicle' 
      AND column_name = 'capacityVerifiedAt' AND data_type = 'timestamp without time zone' AND is_nullable = 'YES' 
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: Vehicle.capacityVerifiedAt does not match expected definition (TIMESTAMP WITHOUT TIME ZONE, nullable, DEFAULT NULL)';
  END IF;

  -- 0B. Validate PricingSlab Columns (3 columns)

  -- 9. PricingSlab.serviceCategory (TEXT, NOT NULL, DEFAULT 'NORMAL'::text)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'PricingSlab' 
      AND column_name = 'serviceCategory' AND data_type = 'text' AND is_nullable = 'NO' 
      AND column_default = '''NORMAL''::text'
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: PricingSlab.serviceCategory does not match expected definition (TEXT, NOT NULL, DEFAULT ''NORMAL''::text)';
  END IF;

  -- 10. PricingSlab.vehicleClass (TEXT, nullable, DEFAULT NULL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'PricingSlab' 
      AND column_name = 'vehicleClass' AND data_type = 'text' AND is_nullable = 'YES' 
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: PricingSlab.vehicleClass does not match expected definition (TEXT, nullable, DEFAULT NULL)';
  END IF;

  -- 11. PricingSlab.passengerCapacity (INTEGER, nullable, DEFAULT NULL)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() AND table_name = 'PricingSlab' 
      AND column_name = 'passengerCapacity' AND data_type = 'integer' AND is_nullable = 'YES' 
      AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'Schema Assertion Failed: PricingSlab.passengerCapacity does not match expected definition (INTEGER, nullable, DEFAULT NULL)';
  END IF;

  -- 0C. Validate Index Definition on PricingSlab (Strict Catalog Assertion)
  SELECT COUNT(*) INTO v_idx_count
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indrelid
  JOIN pg_class ic ON ic.oid = i.indexrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a1 ON a1.attrelid = c.oid AND a1.attnum = i.indkey[0]
  JOIN pg_attribute a2 ON a2.attrelid = c.oid AND a2.attnum = i.indkey[1]
  WHERE n.nspname = current_schema()
    AND c.relname = 'PricingSlab'
    AND ic.relname = 'PricingSlab_serviceCategory_vehicleClass_idx'
    AND i.indnatts = 2
    AND i.indnkeyatts = 2
    AND a1.attname = 'serviceCategory'
    AND a2.attname = 'vehicleClass'
    AND i.indisunique = false
    AND i.indpred IS NULL
    AND i.indisvalid = true
    AND i.indisready = true;

  IF v_idx_count <> 1 THEN
    RAISE EXCEPTION 'Schema Assertion Failed: PricingSlab index on (serviceCategory, vehicleClass) was not created properly or fails catalog validation (unique, partial, invalid, included columns, or wrong column order)';
  END IF;

  -- =========================================================================
  -- PHASE A: PRE-VALIDATE AUDITED PRICING SLAB RECORDS
  -- =========================================================================

  CREATE TEMPORARY TABLE _target_slabs (
    id TEXT PRIMARY KEY,
    expected_type TEXT,
    target_service TEXT,
    target_class TEXT,
    target_pax INTEGER
  ) ON COMMIT DROP;

  INSERT INTO _target_slabs (id, expected_type, target_service, target_class, target_pax) VALUES
    -- Premium Slabs (2 rows -> ELITE / LUXURY / 4 Pax)
    ('a0df59e9-3e7a-4402-89cb-a92c337d4a97', 'Premium',   'ELITE',  'LUXURY',    4),
    ('546a4015-6c5a-455e-90e1-26555333d5bc', 'Premium',   'ELITE',  'LUXURY',    4),

    -- Hatchback Slabs (4 rows -> NORMAL / HATCHBACK / 4 Pax)
    ('54a11c3b-e8ce-4631-99b6-b73acbbe23d1', 'Hatchback', 'NORMAL', 'HATCHBACK', 4),
    ('b50fbe2a-e0d6-46f5-83c8-9fbe0386bafc', 'Hatchback', 'NORMAL', 'HATCHBACK', 4),
    ('1701b590-2ffe-4821-a0f8-09c1d509786c', 'Hatchback', 'NORMAL', 'HATCHBACK', 4),
    ('78027dee-21cc-4433-bf91-4d2bfd129bf7', 'Hatchback', 'NORMAL', 'HATCHBACK', 4),

    -- Sedan Slabs (5 rows -> NORMAL / SEDAN / 4 Pax)
    ('104fc5d7-af3e-4e63-93a9-e8c6f548d1b8', 'Sedan',     'NORMAL', 'SEDAN',     4),
    ('9c978439-5b69-4a73-a299-5e4bac811c02', 'Sedan',     'NORMAL', 'SEDAN',     4),
    ('2b92738d-729c-462f-8c3e-fba88f3a1e3b', 'Sedan',     'NORMAL', 'SEDAN',     4),
    ('419aa8bc-1fe0-4f09-90ed-2bf233aadd9d', 'Sedan',     'NORMAL', 'SEDAN',     4),
    ('6853c383-7835-4fb7-8036-ea602deea61c', 'Sedan',     'NORMAL', 'SEDAN',     4),

    -- SUV Slabs (4 rows -> NORMAL / SUV / 6 Pax)
    ('cf9904e6-a30c-42f3-9d12-59343471f883', 'SUV',       'NORMAL', 'SUV',       6),
    ('5ffb6e8b-5636-4744-bdbf-88cf96f9cc15', 'SUV',       'NORMAL', 'SUV',       6),
    ('6ddf7550-e345-4bd8-b4c0-228f07cca9ed', 'SUV',       'NORMAL', 'SUV',       6),
    ('a90baa8c-2727-49d8-8bf3-a198d4ad0d82', 'SUV',       'NORMAL', 'SUV',       6);

  FOR v_rec IN SELECT * FROM _target_slabs LOOP
    SELECT id, "vehicleType", "serviceCategory", "vehicleClass", "passengerCapacity"
    INTO v_existing
    FROM "PricingSlab"
    WHERE id = v_rec.id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Precondition Failed: Audited PricingSlab ID % is missing from database', v_rec.id;
    END IF;

    IF v_existing."vehicleType" <> v_rec.expected_type THEN
      RAISE EXCEPTION 'Precondition Failed: PricingSlab ID % expected vehicleType % but found %', 
        v_rec.id, v_rec.expected_type, v_existing."vehicleType";
    END IF;

    -- Strict Three-Field Classification Evaluation
    IF v_existing."serviceCategory" = v_rec.target_service 
       AND v_existing."vehicleClass" = v_rec.target_class 
       AND v_existing."passengerCapacity" = v_rec.target_pax THEN
      v_already_classified_count := v_already_classified_count + 1;
    ELSIF v_existing."serviceCategory" = 'NORMAL' 
       AND v_existing."vehicleClass" IS NULL 
       AND v_existing."passengerCapacity" IS NULL THEN
      v_unclassified_count := v_unclassified_count + 1;
    ELSE
      RAISE EXCEPTION 'Conflicting Classification on PricingSlab ID %: current=(serviceCategory=%, vehicleClass=%, passengerCapacity=%), target=(%, %, %)',
        v_rec.id, v_existing."serviceCategory", v_existing."vehicleClass", v_existing."passengerCapacity",
        v_rec.target_service, v_rec.target_class, v_rec.target_pax;
    END IF;
  END LOOP;

  -- =========================================================================
  -- PHASE B: UPDATE ONLY STRICT UNCLASSIFIED RECORDS
  -- =========================================================================
  IF v_unclassified_count > 0 THEN
    UPDATE "PricingSlab" s
    SET "serviceCategory" = t.target_service,
        "vehicleClass" = t.target_class,
        "passengerCapacity" = t.target_pax
    FROM _target_slabs t
    WHERE s.id = t.id
      AND s."serviceCategory" = 'NORMAL'
      AND s."vehicleClass" IS NULL
      AND s."passengerCapacity" IS NULL;

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    IF v_updated_count <> v_unclassified_count THEN
      RAISE EXCEPTION 'Atomic guard failure: expected to update % records, but updated %',
        v_unclassified_count, v_updated_count;
    END IF;
  END IF;

  -- =========================================================================
  -- PHASE C: POST-UPDATE ATOMIC AUDIT BY CATEGORY
  -- =========================================================================
  SELECT COUNT(*) INTO v_final_elite_count
  FROM "PricingSlab" s JOIN _target_slabs t ON s.id = t.id
  WHERE s."serviceCategory" = 'ELITE' AND s."vehicleClass" = 'LUXURY' AND s."passengerCapacity" = 4;

  SELECT COUNT(*) INTO v_final_hatchback_count
  FROM "PricingSlab" s JOIN _target_slabs t ON s.id = t.id
  WHERE s."serviceCategory" = 'NORMAL' AND s."vehicleClass" = 'HATCHBACK' AND s."passengerCapacity" = 4;

  SELECT COUNT(*) INTO v_final_sedan_count
  FROM "PricingSlab" s JOIN _target_slabs t ON s.id = t.id
  WHERE s."serviceCategory" = 'NORMAL' AND s."vehicleClass" = 'SEDAN' AND s."passengerCapacity" = 4;

  SELECT COUNT(*) INTO v_final_suv_count
  FROM "PricingSlab" s JOIN _target_slabs t ON s.id = t.id
  WHERE s."serviceCategory" = 'NORMAL' AND s."vehicleClass" = 'SUV' AND s."passengerCapacity" = 6;

  IF v_final_elite_count <> 2 THEN
    RAISE EXCEPTION 'Post-validation failure: Expected 2 ELITE/LUXURY slabs, found %', v_final_elite_count;
  END IF;
  IF v_final_hatchback_count <> 4 THEN
    RAISE EXCEPTION 'Post-validation failure: Expected 4 NORMAL/HATCHBACK slabs, found %', v_final_hatchback_count;
  END IF;
  IF v_final_sedan_count <> 5 THEN
    RAISE EXCEPTION 'Post-validation failure: Expected 5 NORMAL/SEDAN slabs, found %', v_final_sedan_count;
  END IF;
  IF v_final_suv_count <> 4 THEN
    RAISE EXCEPTION 'Post-validation failure: Expected 4 NORMAL/SUV slabs, found %', v_final_suv_count;
  END IF;

  v_total_verified := v_final_elite_count + v_final_hatchback_count + v_final_sedan_count + v_final_suv_count;
  IF v_total_verified <> 15 THEN
    RAISE EXCEPTION 'Post-validation failure: Expected 15 verified slabs, found %', v_total_verified;
  END IF;

  RAISE NOTICE 'SUCCESS: All 15 PricingSlabs verified and classified (Updated: %, Already Classified: %).',
    v_updated_count, v_already_classified_count;
END $$;

COMMIT;
