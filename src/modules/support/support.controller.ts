import type { FastifyReply, FastifyRequest } from 'fastify';
import { supportService } from './support.service';

export class SupportController {
  /**
   * Customer / Driver creates a support ticket / complaint
   */
  async createTicket(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const user = req.user as { id: string };
      const body = (req.body as any) || {};
      const { category, subject, description, tripId, priority, complaintType, againstName, againstId, zone } = body;

      if (!category || !subject || !description) {
        return reply.status(400).send({
          success: false,
          message: 'Category, subject, and description are required',
        });
      }

      const ticket = await supportService.createTicket({
        userId: user.id,
        category,
        subject,
        description,
        tripId,
        priority,
        complaintType,
        againstName,
        againstId,
        zone,
      });

      return reply.status(201).send({
        success: true,
        message: 'Support ticket submitted successfully',
        data: ticket,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        message: error.message || 'Failed to submit support ticket',
      });
    }
  }

  /**
   * Logged-in user gets their own tickets
   */
  async getMyTickets(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const user = req.user as { id: string };
      const tickets = await supportService.getMyTickets(user.id);
      return reply.send({
        success: true,
        data: tickets,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to retrieve tickets',
      });
    }
  }

  /**
   * Admin lists all complaints
   */
  async getAllComplaints(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const filters = (req.query as any) || {};

      const result = await supportService.getAllComplaints(filters);
      return reply.send({
        success: true,
        data: result.complaints,
        stats: result.stats,
      });
    } catch (error: any) {
      return reply.status(500).send({
        success: false,
        message: error.message || 'Failed to retrieve complaints',
      });
    }
  }

  /**
   * Admin updates complaint status / resolution note / assignment
   */
  async updateComplaintStatus(req: FastifyRequest<any>, reply: FastifyReply) {
    try {
      const { id } = req.params as { id: string };
      const body = (req.body as any) || {};

      const updated = await supportService.updateComplaintStatus(id, body);
      return reply.send({
        success: true,
        message: 'Complaint updated successfully',
        data: updated,
      });
    } catch (error: any) {
      return reply.status(400).send({
        success: false,
        message: error.message || 'Failed to update complaint',
      });
    }
  }
}

export const supportController = new SupportController();
