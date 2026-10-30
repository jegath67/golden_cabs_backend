import type { FastifyReply, FastifyRequest } from 'fastify';
import { advertisingPartnersService } from './advertising-partners.service';

export class AdvertisingPartnersController {
  async getAllPartners(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const partners = await advertisingPartnersService.getAllPartners();
      return reply.send({
        success: true,
        data: partners,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to fetch advertising partners',
        error: error.message || String(error),
      });
    }
  }

  async getPartnerById(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    try {
      const partner = await advertisingPartnersService.getPartnerById(id);
      if (!partner) {
        return reply.status(404).send({
          success: false,
          message: 'Partner not found',
        });
      }
      return reply.send({
        success: true,
        data: partner,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to fetch partner',
        error: error.message || String(error),
      });
    }
  }

  async createPartner(req: FastifyRequest<any>, reply: FastifyReply) {
    const body = (req.body as any) || {};
    const { name, companyName, businessType, phone, email } = body;

    if (!name || !companyName || !phone || !email) {
      return reply.status(400).send({
        success: false,
        message: 'Contact person name, company name, phone, and email are required.',
      });
    }

    try {
      const created = await advertisingPartnersService.createPartner({
        name: name.trim(),
        companyName: companyName.trim(),
        businessType: (businessType || 'Other Business').trim(),
        phone: phone.trim(),
        email: email.trim().toLowerCase(),
        status: body.status || 'Active',
        notes: body.notes,
      });

      return reply.status(201).send({
        success: true,
        message: 'Advertising partner created successfully',
        data: created,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to create advertising partner',
        error: error.message || String(error),
      });
    }
  }

  async updatePartner(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };
    const body = (req.body as any) || {};

    try {
      const updated = await advertisingPartnersService.updatePartner(id, body);
      return reply.send({
        success: true,
        message: 'Advertising partner updated successfully',
        data: updated,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to update advertising partner',
        error: error.message || String(error),
      });
    }
  }

  async deletePartner(req: FastifyRequest<any>, reply: FastifyReply) {
    const { id } = req.params as { id: string };

    try {
      await advertisingPartnersService.deletePartner(id);
      return reply.send({
        success: true,
        message: 'Advertising partner deleted successfully',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: 'Failed to delete advertising partner',
        error: error.message || String(error),
      });
    }
  }
}

export const advertisingPartnersController = new AdvertisingPartnersController();

