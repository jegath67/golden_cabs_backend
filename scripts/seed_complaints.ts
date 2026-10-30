import { prisma } from '../src/config/prisma';

async function seedBaselineComplaints() {
  const existing = await prisma.$queryRawUnsafe<any[]>('SELECT COUNT(*) as count FROM "SupportTicket"');
  if (Number(existing[0]?.count || 0) > 0) {
    console.log('Support tickets already present in database:', existing[0]?.count);
    return;
  }

  // Find admin or sample customer/driver
  const user = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  const userId = user ? user.id : 'system-admin';

  const baseline = [
    {
      id: 'cmp-001',
      ticketCode: 'CMP-001',
      userId,
      userName: 'Rajesh Kumar',
      userPhone: '+91 9876543210',
      userRole: 'CUSTOMER',
      complaintType: 'Driver',
      category: 'Safety',
      subject: 'Rash Driving',
      description: 'Driver was driving very rashly and overspeeding. Made me uncomfortable throughout the journey.',
      tripId: 'TRIP12345',
      againstName: 'Vijay (Driver)',
      againstId: 'DRV001',
      priority: 'High',
      status: 'Open',
      zone: 'Chennai',
      assignedTo: 'Support Team A',
    },
    {
      id: 'cmp-002',
      ticketCode: 'CMP-002',
      userId,
      userName: 'Murugan (Driver)',
      userPhone: '+91 8765432109',
      userRole: 'DRIVER',
      complaintType: 'Customer',
      category: 'Behavior',
      subject: 'Rude Behavior',
      description: 'Customer was very rude and used abusive language when asked to wear seatbelt.',
      tripId: 'TRIP12346',
      againstName: 'Priya Sharma',
      againstId: 'CUST001',
      priority: 'Medium',
      status: 'In Progress',
      zone: 'Coimbatore',
      assignedTo: 'Support Team B',
    },
    {
      id: 'cmp-003',
      ticketCode: 'CMP-003',
      userId,
      userName: 'Lakshmi Devi',
      userPhone: '+91 7654321098',
      userRole: 'CUSTOMER',
      complaintType: 'Driver',
      category: 'Vehicle',
      subject: 'Vehicle Cleanliness',
      description: 'The vehicle was not clean. Seats were dirty and there was bad smell inside the car.',
      tripId: 'TRIP12347',
      againstName: 'Kumar (Driver)',
      againstId: 'DRV002',
      priority: 'Low',
      status: 'Resolved',
      zone: 'Madurai',
      assignedTo: 'Support Team A',
      resolutionNote: 'Vehicle inspected and driver issued a formal warning. Car was thoroughly cleaned and sanitized.',
      resolvedAt: new Date(),
    },
    {
      id: 'cmp-004',
      ticketCode: 'CMP-004',
      userId,
      userName: 'Senthil (Driver)',
      userPhone: '+91 6543210987',
      userRole: 'DRIVER',
      complaintType: 'Customer',
      category: 'Payment',
      subject: 'Payment Dispute',
      description: 'Customer refusing to pay the fare. Says the amount is too high.',
      tripId: 'TRIP12348',
      againstName: 'Arjun Reddy',
      againstId: 'CUST002',
      priority: 'High',
      status: 'Open',
      zone: 'Chennai',
      assignedTo: 'Support Team C',
    },
    {
      id: 'cmp-005',
      ticketCode: 'CMP-005',
      userId,
      userName: 'Anitha',
      userPhone: '+91 5432109876',
      userRole: 'CUSTOMER',
      complaintType: 'Driver',
      category: 'Route',
      subject: 'Wrong Route',
      description: 'Driver took a longer route unnecessarily, increasing fare by 30%.',
      tripId: 'TRIP12349',
      againstName: 'Ramesh (Driver)',
      againstId: 'DRV003',
      priority: 'Medium',
      status: 'In Progress',
      zone: 'Trichy',
      assignedTo: 'Support Team B',
    },
  ];

  for (const b of baseline) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SupportTicket" (
        "id", "ticketCode", "userId", "userName", "userPhone", "userRole",
        "complaintType", "category", "subject", "description", "tripId",
        "againstName", "againstId", "priority", "status", "zone", "assignedTo",
        "resolutionNote", "resolvedAt", "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW(), NOW())
      ON CONFLICT ("id") DO NOTHING`,
      b.id,
      b.ticketCode,
      b.userId,
      b.userName,
      b.userPhone,
      b.userRole,
      b.complaintType,
      b.category,
      b.subject,
      b.description,
      b.tripId,
      b.againstName,
      b.againstId,
      b.priority,
      b.status,
      b.zone,
      b.assignedTo,
      b.resolutionNote || null,
      b.resolvedAt || null
    );
  }

  console.log('Seeded baseline complaints successfully');
}

seedBaselineComplaints()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

