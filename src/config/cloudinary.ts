import { v2 as cloudinary, type UploadApiResponse, type UploadApiErrorResponse } from 'cloudinary';

const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
  console.log(`[Cloudinary] Initialized with cloud: ${cloudName}`);
} else {
  console.warn('[Cloudinary] Missing credentials, uploads will fallback to local disk.');
}

export const isCloudinaryConfigured = (): boolean => {
  return Boolean(cloudName && apiKey && apiSecret);
};

export interface CloudinaryUploadResult {
  url: string;
  publicId: string;
  bytes: number;
  format: string;
}

/**
 * Upload a Buffer directly to Cloudinary using upload_stream.
 */
export const uploadBufferToCloudinary = (
  buffer: Buffer,
  options?: {
    folder?: string;
    publicId?: string;
    resourceType?: 'image' | 'raw' | 'auto';
  }
): Promise<CloudinaryUploadResult> => {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder: options?.folder || 'golden_cabs',
      public_id: options?.publicId,
      resource_type: options?.resourceType || 'auto',
    };

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
        if (error || !result) {
          return reject(error || new Error('Cloudinary upload failed with empty result'));
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          bytes: result.bytes,
          format: result.format,
        });
      }
    );

    stream.end(buffer);
  });
};

export { cloudinary };
