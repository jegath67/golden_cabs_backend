import {
  isValidAadhaar,
  normalizeAadhaar,
  isValidDrivingLicense,
  normalizeDrivingLicense,
} from '../src/utils/document-validators';
import { authService } from '../src/modules/auth/auth.service';

async function runTests() {
  console.log('Running Backend Document Validation Tests...\n');
  let passed = 0;
  let total = 0;

  function assert(condition: boolean, desc: string) {
    total++;
    if (condition) {
      console.log(`✓ ${desc}`);
      passed++;
    } else {
      console.error(`✗ FAILED: ${desc}`);
      process.exitCode = 1;
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Aadhaar Normalization & Verhoeff Checksum Validation
  // ---------------------------------------------------------------------------
  console.log('--- 1. Aadhaar Validation ---');
  // 367598342159 is a valid 12-digit Aadhaar matching Verhoeff check digit 9
  assert(isValidAadhaar('367598342159'), 'Valid 12-digit Aadhaar passes checksum');
  assert(isValidAadhaar('3675 9834 2159'), 'Aadhaar with spaces passes via normalization');
  assert(isValidAadhaar('3675-9834-2159'), 'Aadhaar with hyphens passes via normalization');
  assert(normalizeAadhaar(' 3675 9834 2159 ') === '367598342159', 'normalizeAadhaar removes all spaces');

  // Negative checks
  assert(!isValidAadhaar('367598342150'), 'Incorrect check digit is rejected');
  assert(!isValidAadhaar('367598342519'), 'Transposed adjacent digits (21 -> 251) rejected');
  assert(!isValidAadhaar('012345678901'), 'Aadhaar starting with 0 is rejected');
  assert(!isValidAadhaar('123456789012'), 'Aadhaar starting with 1 is rejected');
  assert(!isValidAadhaar('222222222222'), 'All-identical digits Aadhaar is rejected');
  assert(!isValidAadhaar('3675983421'), 'Aadhaar with length < 12 is rejected');
  assert(!isValidAadhaar('3675983421599'), 'Aadhaar with length > 12 is rejected');
  assert(!isValidAadhaar(''), 'Empty Aadhaar string is rejected');
  assert(!isValidAadhaar(null), 'Null Aadhaar is rejected');

  // ---------------------------------------------------------------------------
  // 2. Driving Licence Normalization & Format Validation
  // ---------------------------------------------------------------------------
  console.log('\n--- 2. Driving Licence Validation ---');
  // Valid Sarathi standard (15-character: 2 state + 2 RTO + 4 year + 7 digits)
  assert(isValidDrivingLicense('TN0120230001234'), 'Valid Sarathi 15-char DL is accepted');
  assert(isValidDrivingLicense('DL0420110012345'), 'Valid Delhi DL is accepted');
  assert(isValidDrivingLicense('KA0520180009876'), 'Valid Karnataka DL is accepted');
  assert(isValidDrivingLicense('MH1220190005555'), 'Valid Maharashtra DL is accepted');

  // Formatting with spaces and hyphens
  assert(isValidDrivingLicense('TN-01-2023-0001234'), 'DL with hyphens passes via normalization');
  assert(isValidDrivingLicense('TN 01 2023 0001234'), 'DL with spaces passes via normalization');
  assert(isValidDrivingLicense('TN/01/2023/0001234'), 'DL with slashes passes via normalization');
  assert(normalizeDrivingLicense(' tn-01 2023-0001234 ') === 'TN0120230001234', 'normalizeDrivingLicense uppercases and cleans');

  // 16-character Sarathi variants
  assert(isValidDrivingLicense('MH12201500012345'), 'Valid 16-character DL is accepted');
  assert(isValidDrivingLicense('DL01C20180001234'), 'Valid DL with category letter is accepted');

  // Documented legacy formats
  assert(isValidDrivingLicense('TN011999001234'), 'Documented legacy DL with 4-digit year is accepted');
  assert(isValidDrivingLicense('KL072005012345'), 'Valid legacy Kerala DL is accepted');

  // Negative checks
  assert(!isValidDrivingLicense('TNABCDEFGHIJKL'), 'Overly permissive random letter sequence is rejected');
  assert(!isValidDrivingLicense('TN000000000000'), 'Dummy all-zero repeating DL is rejected');
  assert(!isValidDrivingLicense('ZZ0120230001234'), 'Invalid state code ZZ is rejected');
  assert(!isValidDrivingLicense('990120230001234'), 'Numeric non-state prefix is rejected');
  assert(!isValidDrivingLicense('TN01'), 'Too short DL (< 10 chars) is rejected');
  assert(!isValidDrivingLicense('TN01202300012345678'), 'Too long DL (> 16 chars) is rejected');
  assert(!isValidDrivingLicense(''), 'Empty DL is rejected');
  assert(!isValidDrivingLicense(null), 'Null DL is rejected');

  // ---------------------------------------------------------------------------
  // 3. AuthService completeDriverRegistration Integration
  // ---------------------------------------------------------------------------
  console.log('\n--- 3. Registration Service Validation ---');

  // Mock JWT functions
  const mockVerify = (token: string) => {
    if (token === 'valid_token') {
      return {
        phone: '9876543210',
        purpose: 'DRIVER_REGISTRATION',
        role: 'DRIVER',
        name: 'Valid Driver',
      };
    }
    throw new Error('Invalid registration token');
  };
  const mockSign = (payload: any) => 'mock_jwt_token';

  // Test 3a: DRIVE_ONLY with missing DL fails
  try {
    await authService.completeDriverRegistration(
      {
        registrationToken: 'valid_token',
        name: 'Valid Driver',
        personaType: 'DRIVE_ONLY',
        licenseNumber: '',
        aadharNumber: '367598342159',
      },
      mockVerify,
      mockSign
    );
    assert(false, 'Should have thrown error for missing DL in DRIVE_ONLY');
  } catch (err: any) {
    assert(
      err.statusCode === 400 && err.message.includes('licence number is required'),
      'Missing DL in DRIVE_ONLY throws 400 licence required'
    );
  }

  // Test 3b: DRIVE_ONLY with invalid DL format fails
  try {
    await authService.completeDriverRegistration(
      {
        registrationToken: 'valid_token',
        name: 'Valid Driver',
        personaType: 'DRIVE_ONLY',
        licenseNumber: 'TNABCDEFGHIJKL', // loose regex should fail
        aadharNumber: '367598342159',
      },
      mockVerify,
      mockSign
    );
    assert(false, 'Should have thrown error for invalid DL format');
  } catch (err: any) {
    assert(
      err.statusCode === 400 && err.message.includes('Invalid driving licence format'),
      'Invalid DL format throws 400 Invalid driving licence format'
    );
  }

  // Test 3c: DRIVE_ONLY with invalid Aadhaar checksum fails
  try {
    await authService.completeDriverRegistration(
      {
        registrationToken: 'valid_token',
        name: 'Valid Driver',
        personaType: 'DRIVE_ONLY',
        licenseNumber: 'TN0120230001234',
        aadharNumber: '367598342150', // bad check digit
      },
      mockVerify,
      mockSign
    );
    assert(false, 'Should have thrown error for invalid Aadhaar checksum');
  } catch (err: any) {
    assert(
      err.statusCode === 400 && err.message.includes('Invalid Aadhaar number'),
      'Invalid Aadhaar checksum throws 400 Invalid Aadhaar number'
    );
  }

  console.log(`\n========================================`);
  console.log(`Backend Document Validation Tests: ${passed}/${total} passed`);
  console.log(`========================================\n`);

  if (passed !== total) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unhandled error in tests:', err);
  process.exit(1);
});
