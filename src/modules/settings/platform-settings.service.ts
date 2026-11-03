import { prisma } from '../../config/prisma';

export class PlatformSettingsService {
  private static readonly COMMISSION_KEY = 'PLATFORM_COMMISSION_PERCENT';
  private static readonly DEFAULT_COMMISSION = 20.0;

  /**
   * Get configured commission percentage (e.g. 20.0 for 20%)
   */
  async getCommissionPercent(): Promise<number> {
    try {
      const setting = await prisma.platformSetting.findUnique({
        where: { key: PlatformSettingsService.COMMISSION_KEY },
      });
      if (!setting) return PlatformSettingsService.DEFAULT_COMMISSION;

      const parsed = parseFloat(setting.value);
      if (isNaN(parsed) || parsed < 0 || parsed > 50) {
        return PlatformSettingsService.DEFAULT_COMMISSION;
      }
      return parsed;
    } catch {
      return PlatformSettingsService.DEFAULT_COMMISSION;
    }
  }

  /**
   * Get commission as multiplier rate (e.g. 0.20 for 20%)
   */
  async getCommissionRate(): Promise<number> {
    const percent = await this.getCommissionPercent();
    return Math.round((percent / 100) * 1000) / 1000;
  }

  /**
   * Update configured commission percentage with strict validation
   */
  async setCommissionPercent(percent: number): Promise<number> {
    if (typeof percent !== 'number' || isNaN(percent) || !isFinite(percent)) {
      throw new Error('Invalid commission percentage. Must be a valid number.');
    }

    if (percent < 0) {
      throw new Error('Commission percentage cannot be negative.');
    }

    if (percent > 50) {
      throw new Error('Commission percentage cannot exceed 50%.');
    }

    const rounded = Math.round(percent * 100) / 100;

    await prisma.platformSetting.upsert({
      where: { key: PlatformSettingsService.COMMISSION_KEY },
      create: {
        key: PlatformSettingsService.COMMISSION_KEY,
        value: rounded.toString(),
        description: 'Platform commission percentage deducted from completed driver rides',
      },
      update: {
        value: rounded.toString(),
      },
    });

    return rounded;
  }
}

export const platformSettingsService = new PlatformSettingsService();

