import { prisma } from '../../config/prisma';

export class AdvertisingPartnersService {
  async getAllPartners() {
    const count = await prisma.advertisingPartner.count();
    if (count === 0) {
      await this.seedDefaultPartners();
    }
    return prisma.advertisingPartner.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async getPartnerById(id: string) {
    return prisma.advertisingPartner.findUnique({
      where: { id },
    });
  }

  async createPartner(data: {
    name: string;
    companyName: string;
    businessType: string;
    phone: string;
    email: string;
    status?: string;
    notes?: string;
  }) {
    return prisma.advertisingPartner.create({
      data: {
        name: data.name,
        companyName: data.companyName,
        businessType: data.businessType,
        phone: data.phone,
        email: data.email,
        status: data.status || 'Active',
        notes: data.notes || '',
        totalAds: 0,
        activeAds: 0,
      },
    });
  }

  async updatePartner(
    id: string,
    data: {
      name?: string;
      companyName?: string;
      businessType?: string;
      phone?: string;
      email?: string;
      status?: string;
      notes?: string;
      totalAds?: number;
      activeAds?: number;
    }
  ) {
    return prisma.advertisingPartner.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.companyName !== undefined && { companyName: data.companyName }),
        ...(data.businessType !== undefined && { businessType: data.businessType }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.notes !== undefined && { notes: data.notes }),
        ...(data.totalAds !== undefined && { totalAds: data.totalAds }),
        ...(data.activeAds !== undefined && { activeAds: data.activeAds }),
      },
    });
  }

  async deletePartner(id: string) {
    return prisma.advertisingPartner.delete({
      where: { id },
    });
  }

  private async seedDefaultPartners() {
    const defaultPartners = [
      {
        id: 'ADP-101',
        name: 'Karthik Raja',
        companyName: 'Apollo Hospitals & Diagnostics',
        businessType: 'Healthcare & Pharma',
        phone: '+91 98401 23456',
        email: 'ads@apollohospitals.com',
        status: 'Active',
        notes: 'Quarterly cab passenger banner & push campaign agreement.',
        totalAds: 6,
        activeAds: 2,
      },
      {
        id: 'ADP-102',
        name: 'Anandh Swaminathan',
        companyName: 'Express Avenue Mall',
        businessType: 'Retail & E-commerce',
        phone: '+91 97910 88234',
        email: 'marketing@expressavenue.in',
        status: 'Active',
        notes: 'Weekend shopping festival discounts sponsor.',
        totalAds: 4,
        activeAds: 1,
      },
      {
        id: 'ADP-103',
        name: 'Meera Sundar',
        companyName: 'TVS Mobility & Motors',
        businessType: 'Automotive & Transport',
        phone: '+91 98842 11900',
        email: 'partnerships@tvsmobility.com',
        status: 'Active',
        notes: 'EV car launch promotional awareness campaign.',
        totalAds: 3,
        activeAds: 1,
      },
      {
        id: 'ADP-104',
        name: 'Vikram Rathore',
        companyName: 'Casagrand Real Estate',
        businessType: 'Real Estate & Construction',
        phone: '+91 99620 44551',
        email: 'promotions@casagrand.co.in',
        status: 'Inactive',
        notes: 'Completed luxury apartments campaign.',
        totalAds: 5,
        activeAds: 0,
      },
    ];

    for (const p of defaultPartners) {
      await prisma.advertisingPartner.create({ data: p });
    }
  }
}

export const advertisingPartnersService = new AdvertisingPartnersService();

