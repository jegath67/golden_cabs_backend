import crypto from 'crypto';
import { prisma } from '../../config/prisma';
import { notificationsService } from '../notifications/notifications.service';

export interface CreateTicketInput {
  userId: string;
  category: string;
  subject: string;
  description: string;
  tripId?: string;
  priority?: 'High' | 'Medium' | 'Low';
  complaintType?: string;
  againstName?: string;
  againstId?: string;
  zone?: string;
}

export class SupportService {
  async createTicket(input: CreateTicketInput) {
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      include: { driverProfile: true, customerProfile: true },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const id = crypto.randomUUID();
    const isDriver = user.role === 'DRIVER';
    const prefix = isDriver ? 'REP' : 'TCK';
    const randomCode = Math.floor(1000 + Math.random() * 9000);
    const ticketCode = `${prefix}-${randomCode}`;

    const priority = input.priority || 'Medium';
    const complaintType = input.complaintType || (isDriver ? 'Driver' : 'Customer');
    const category = input.category.trim();
    const subject = input.subject.trim();
    const description = input.description.trim();
    const zone = input.zone || 'Puducherry';

    await prisma.$executeRawUnsafe(
      `INSERT INTO "SupportTicket" (
        "id", "ticketCode", "userId", "userName", "userPhone", "userRole",
        "complaintType", "category", "subject", "description", "tripId",
        "againstName", "againstId", "priority", "status", "zone", "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Open', $15, NOW(), NOW())`,
      id,
      ticketCode,
      user.id,
      user.name || (isDriver ? 'Partner Driver' : 'Customer'),
      user.phone || '',
      user.role,
      complaintType,
      category,
      subject,
      description,
      input.tripId || null,
      input.againstName || null,
      input.againstId || null,
      priority,
      zone
    );

    // If driver, sync with DriverReport table for backward compatibility
    if (isDriver && user.driverProfile) {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "DriverReport" (
          "id" TEXT PRIMARY KEY,
          "driverProfileId" TEXT NOT NULL,
          "title" TEXT NOT NULL,
          "category" TEXT NOT NULL,
          "description" TEXT NOT NULL,
          "status" TEXT NOT NULL DEFAULT 'In Progress',
          "response" TEXT,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `).catch(() => {});

      await prisma.$executeRawUnsafe(
        `INSERT INTO "DriverReport" ("id", "driverProfileId", "title", "category", "description", "status", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'In Progress', NOW(), NOW())
         ON CONFLICT ("id") DO NOTHING`,
        ticketCode,
        user.driverProfile.id,
        subject,
        category,
        description
      ).catch(() => {});
    }

    // Notify Admins
    await notificationsService.sendToAdmins({
      title: `🚨 New Support Ticket: ${ticketCode}`,
      message: `${user.name || 'User'} (${user.role}) submitted: ${subject}`,
      type: 'admin_support_ticket',
      data: { ticketId: id, ticketCode, category },
    }).catch(console.error);

    return {
      id,
      ticketCode,
      category,
      subject,
      description,
      status: 'Open',
      priority,
      createdAt: new Date().toISOString(),
    };
  }

  async getMyTickets(userId: string) {
    const tickets = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "SupportTicket" WHERE "userId" = $1 ORDER BY "createdAt" DESC`,
      userId
    );

    return tickets.map((t) => ({
      id: t.ticketCode || t.id,
      dbId: t.id,
      category: t.category,
      subject: t.subject,
      title: t.subject,
      description: t.description,
      bookingId: t.tripId,
      status: t.status,
      priority: t.priority,
      adminResponse: t.resolutionNote,
      response: t.resolutionNote,
      date: t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString(),
      createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : new Date().toISOString(),
      resolvedDate: t.resolvedAt ? new Date(t.resolvedAt).toISOString() : null,
    }));
  }

  async getAllComplaints(filters?: {
    status?: string;
    type?: string;
    priority?: string;
    search?: string;
  }) {
    let whereClauses: string[] = [];
    let params: any[] = [];
    let pIdx = 1;

    if (filters?.status && filters.status !== 'All Status') {
      whereClauses.push(`"status" = $${pIdx++}`);
      params.push(filters.status);
    }

    if (filters?.type && filters.type !== 'All Types') {
      whereClauses.push(`"complaintType" = $${pIdx++}`);
      params.push(filters.type);
    }

    if (filters?.priority && filters.priority !== 'All Priority') {
      whereClauses.push(`"priority" = $${pIdx++}`);
      params.push(filters.priority);
    }

    if (filters?.search && filters.search.trim().length > 0) {
      const q = `%${filters.search.trim()}%`;
      whereClauses.push(`(
        "ticketCode" ILIKE $${pIdx} OR
        "subject" ILIKE $${pIdx} OR
        "description" ILIKE $${pIdx} OR
        "userName" ILIKE $${pIdx} OR
        "userPhone" ILIKE $${pIdx} OR
        COALESCE("tripId", '') ILIKE $${pIdx}
      )`);
      params.push(q);
      pIdx++;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const sql = `SELECT * FROM "SupportTicket" ${whereSql} ORDER BY "createdAt" DESC`;
    const rows = await prisma.$queryRawUnsafe<any[]>(sql, ...params);

    // Get aggregated stats
    const statsRows = await prisma.$queryRawUnsafe<any[]>(`
      SELECT 
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE "status" = 'Open') as open,
        COUNT(*) FILTER (WHERE "status" = 'In Progress') as in_progress,
        COUNT(*) FILTER (WHERE "status" = 'Resolved') as resolved,
        COUNT(*) FILTER (WHERE "status" = 'Closed') as closed
      FROM "SupportTicket"
    `);

    const stats = statsRows[0] || {};

    const formatted = rows.map((r) => {
      const createdDateStr = r.createdAt ? new Date(r.createdAt).toISOString() : '';
      const resolvedDateStr = r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null;

      return {
        id: r.ticketCode || r.id,
        dbId: r.id,
        tripId: r.tripId || 'N/A',
        complaintType: r.complaintType || (r.userRole === 'DRIVER' ? 'Driver' : 'Customer'),
        raisedBy: r.userRole === 'DRIVER' ? 'Driver' : 'Customer',
        complainantName: r.userName,
        complainantPhone: r.userPhone,
        againstName: r.againstName || 'N/A',
        againstId: r.againstId || 'N/A',
        subject: r.subject,
        description: r.description,
        status: r.status,
        priority: r.priority,
        zone: r.zone || 'Puducherry',
        createdDate: createdDateStr,
        resolvedDate: resolvedDateStr,
        resolutionNote: r.resolutionNote || null,
        assignedTo: r.assignedTo || 'Support Team A',
        category: r.category,
      };
    });

    return {
      complaints: formatted,
      stats: {
        total: Number(stats.total || 0),
        open: Number(stats.open || 0),
        inProgress: Number(stats.in_progress || 0),
        resolved: Number(stats.resolved || 0),
        closed: Number(stats.closed || 0),
      },
    };
  }

  async updateComplaintStatus(
    idOrCode: string,
    data: {
      status?: string;
      resolutionNote?: string;
      assignedTo?: string;
      priority?: string;
    }
  ) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM "SupportTicket" WHERE "id" = $1 OR "ticketCode" = $1 LIMIT 1`,
      idOrCode
    );

    if (!rows || rows.length === 0) {
      throw new Error('Support ticket not found');
    }

    const ticket = rows[0];
    const newStatus = data.status || ticket.status;
    const isResolved = newStatus === 'Resolved';
    const resolutionNote = data.resolutionNote !== undefined ? data.resolutionNote : ticket.resolutionNote;
    const assignedTo = data.assignedTo !== undefined ? data.assignedTo : ticket.assignedTo;
    const priority = data.priority !== undefined ? data.priority : ticket.priority;

    await prisma.$executeRawUnsafe(
      `UPDATE "SupportTicket" SET
        "status" = $1,
        "resolutionNote" = $2,
        "assignedTo" = $3,
        "priority" = $4,
        "resolvedAt" = $5,
        "updatedAt" = NOW()
       WHERE "id" = $6`,
      newStatus,
      resolutionNote,
      assignedTo,
      priority,
      isResolved ? new Date() : ticket.resolvedAt,
      ticket.id
    );

    // Sync DriverReport if driver report
    if (ticket.userRole === 'DRIVER') {
      await prisma.$executeRawUnsafe(
        `UPDATE "DriverReport" SET "status" = $1, "response" = $2, "updatedAt" = NOW() WHERE "id" = $3`,
        newStatus,
        resolutionNote,
        ticket.ticketCode
      ).catch(() => {});
    }

    // Send push notification to user
    await notificationsService.sendToUser({
      userId: ticket.userId,
      title: isResolved ? `✅ Ticket Resolved: ${ticket.ticketCode}` : `ℹ️ Ticket Updated: ${ticket.ticketCode}`,
      message: resolutionNote
        ? `Status: ${newStatus}. Note: ${resolutionNote}`
        : `Your support ticket (${ticket.ticketCode}) status was updated to ${newStatus}.`,
      type: 'ticket_update',
      data: { ticketId: ticket.id, ticketCode: ticket.ticketCode, status: newStatus },
      saveToDb: true,
    }).catch(console.error);

    return {
      success: true,
      id: ticket.ticketCode,
      status: newStatus,
      resolutionNote,
      assignedTo,
      priority,
    };
  }
}

export const supportService = new SupportService();

