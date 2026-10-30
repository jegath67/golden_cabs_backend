import { FastifyRequest, FastifyReply } from 'fastify';
import { bannersService } from './banners.service';

export class BannersController {
  async getAllBanners(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { target, status } = req.query as {
        target?: string;
        status?: string;
      };
      const banners = await bannersService.getAllBanners(target, status);
      return reply.send({
        success: true,
        data: banners,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch banners',
      });
    }
  }

  async getCampaignHistory(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const history = await bannersService.getCampaignHistory();
      return reply.send({
        success: true,
        data: history,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch campaign history',
      });
    }
  }

  async getBannerById(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const banner = await bannersService.getBannerById(id);
      if (!banner) {
        return reply.status(404).send({
          success: false,
          message: 'Banner not found',
        });
      }
      return reply.send({
        success: true,
        data: banner,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to fetch banner',
      });
    }
  }

  async createBanner(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const body = req.body as any;
      if (!body.title) {
        return reply.status(400).send({
          success: false,
          message: 'Banner title is required',
        });
      }
      const banner = await bannersService.createBanner(body);
      return reply.status(201).send({
        success: true,
        message: 'Banner created successfully',
        data: banner,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to create banner',
      });
    }
  }

  async updateBanner(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const body = req.body as any;
      const banner = await bannersService.updateBanner(id, body);
      return reply.send({
        success: true,
        message: 'Banner updated successfully',
        data: banner,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to update banner',
      });
    }
  }

  async deleteBanner(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      await bannersService.deleteBanner(id);
      return reply.send({
        success: true,
        message: 'Banner deleted successfully',
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to delete banner',
      });
    }
  }
}

export const bannersController = new BannersController();
