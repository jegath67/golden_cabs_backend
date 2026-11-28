// ---------------------------------------------------------------------------
// Verhoeff Checksum Algorithm Implementation
// ---------------------------------------------------------------------------
const verhoeffD: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];

const verhoeffP: number[][] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function validateVerhoeff(numStr: string): boolean {
  if (!numStr || !/^\d+$/.test(numStr)) return false;
  let c = 0;
  const digits = numStr.split('').map(Number).reverse();
  for (let i = 0; i < digits.length; i++) {
    c = verhoeffD[c][verhoeffP[i % 8][digits[i]]];
  }
  return c === 0;
}

// ---------------------------------------------------------------------------
// Aadhaar Normalization & Validation
// ---------------------------------------------------------------------------
export function normalizeAadhaar(value: string | null | undefined): string {
  if (!value) return '';
  return value.toString().replace(/[\s\-]/g, '').trim();
}

export function isValidAadhaar(value: string | null | undefined): boolean {
  if (!value) return false;
  const cleaned = normalizeAadhaar(value);
  if (cleaned.length !== 12 || !/^[2-9]\d{11}$/.test(cleaned)) {
    return false;
  }
  if (/^(\d)\1{11}$/.test(cleaned)) {
    return false;
  }
  return validateVerhoeff(cleaned);
}

// ---------------------------------------------------------------------------
// Driving Licence Normalization & Validation
// ---------------------------------------------------------------------------
export const validIndianStateCodes: Set<string> = new Set([
  'AN', 'AP', 'AR', 'AS', 'BR', 'CG', 'CH', 'CT', 'DD', 'DH', 'DL', 'DN',
  'GA', 'GJ', 'HP', 'HR', 'JH', 'JK', 'KA', 'KL', 'LA', 'LD', 'MH', 'ML',
  'MN', 'MP', 'MZ', 'NL', 'OD', 'OR', 'PB', 'PY', 'RJ', 'SK', 'TG', 'TN',
  'TR', 'TS', 'UA', 'UK', 'UP', 'WB',
]);

export function normalizeDrivingLicense(value: string | null | undefined): string {
  if (!value) return '';
  return value.toString().replace(/[\s\-/]/g, '').toUpperCase().trim();
}

export function isValidDrivingLicense(value: string | null | undefined): boolean {
  if (!value) return false;
  const cleaned = normalizeDrivingLicense(value);

  // Length check: 10 to 16 characters
  if (cleaned.length < 10 || cleaned.length > 16) {
    return false;
  }

  // State code check
  const stateCode = cleaned.substring(0, 2);
  if (!validIndianStateCodes.has(stateCode)) {
    return false;
  }

  // Reject all identical characters
  if (/^([A-Z0-9])\1+$/.test(cleaned)) {
    return false;
  }

  // Reject dummy repeating digits following state code
  if (/^[A-Z]{2}(\d)\1{8,}$/.test(cleaned)) {
    return false;
  }

  // Standard Sarathi 15-char: 2 State + 2 RTO + 4 Year (1960-2029) + 7 Serial
  const isSarathiStandard15 = /^[A-Z]{2}\d{2}(19[6-9]\d|20[0-2]\d)\d{7}$/.test(cleaned);

  // Standard 16-char Sarathi variants
  const isStandard16 =
    /^[A-Z]{2}\d{2}(19[6-9]\d|20[0-2]\d)\d{8}$/.test(cleaned) ||
    /^[A-Z]{2}\d{2}[A-Z](19[6-9]\d|20[0-2]\d)\d{7}$/.test(cleaned);

  // Documented legacy state formats with 4-digit year
  const isLegacyWithYear = /^[A-Z]{2}\d{1,3}(19[6-9]\d|20[0-2]\d)\d{4,7}$/.test(cleaned);

  // General valid legacy format: 2 State + digits & letters, >= 8 digits overall, <= 4 letters
  const digitCount = cleaned.replace(/\D/g, '').length;
  const letterCount = cleaned.replace(/[^A-Z]/g, '').length;
  const isLegacyValid =
    digitCount >= 8 &&
    letterCount <= 4 &&
    /^[A-Z]{2}\d{2}[A-Z0-9]{6,12}$/.test(cleaned);

  return isSarathiStandard15 || isStandard16 || isLegacyWithYear || isLegacyValid;
}
