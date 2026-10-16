import path from 'path';
import fs from 'fs';
import { initializeApp, cert, type App } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

let firebaseApp: App | null = null;

export const initFirebase = (): App | null => {
  if (firebaseApp) return firebaseApp;

  try {
    // 1. Check for raw JSON string in environment variable
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      firebaseApp = initializeApp({
        credential: cert(serviceAccount),
      });
      console.log('✅ Firebase Admin initialized via environment JSON.');
      return firebaseApp;
    }

    // 2. Check for service account file path
    const serviceAccountPath =
      process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
      path.join(process.cwd(), 'firebase-service-account.json');

    if (fs.existsSync(serviceAccountPath)) {
      firebaseApp = initializeApp({
        credential: cert(serviceAccountPath),
      });
      console.log(`✅ Firebase Admin initialized from ${serviceAccountPath}`);
      return firebaseApp;
    }

    console.warn(
      '⚠️ Firebase service account not found. Notifications will run in MOCK mode until firebase-service-account.json is added.'
    );
    return null;
  } catch (error) {
    console.error('❌ Failed to initialize Firebase Admin:', error);
    return null;
  }
};

export const getFirebaseMessaging = (): Messaging | null => {
  const app = initFirebase();
  return app ? getMessaging(app) : null;
};
