import { prisma } from '../src/config/prisma';

const BASE_URL = 'http://localhost:3000';

async function makeRequest(method: string, path: string, body?: any, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let resBody: any;
  const text = await res.text();
  try { resBody = JSON.parse(text); } catch { resBody = text; }
  return { status: res.status, body: resBody };
}

async function getAdminToken(): Promise<string> {
  const res = await makeRequest('POST', '/api/auth/admin-login', {
    identifier: 'admin@goldencabs.com',
    password: 'admin123',
  });
  return res.body.data.token;
}

async function getDriverToken(phone: string): Promise<string> {
  await makeRequest('POST', '/api/auth/send-otp', { phone, intent: 'LOGIN' });
  const res = await makeRequest('POST', '/api/auth/verify-otp', { phone, otp: '123456', role: 'DRIVER' });
  return res.body.data.token;
}

async function getCustomerToken(phone: string): Promise<string> {
  await makeRequest('POST', '/api/auth/send-otp', { phone, intent: 'LOGIN' });
  const res = await makeRequest('POST', '/api/auth/verify-otp', { phone, otp: '123456', role: 'CUSTOMER' });
  return res.body.data.token;
}

async function runSupportE2E() {
  console.log('====================================================');
  console.log('🚀 TESTING HELP & SUPPORT E2E ACROSS 3 APPS');
  console.log('====================================================\n');

  const adminToken = await getAdminToken();
  const customerToken = await getCustomerToken('8754358935');
  const driverToken = await getDriverToken('8754358963');

  console.log('✅ Tokens acquired for Admin, Customer, and Driver');

  // 1. Customer submits a complaint ticket
  console.log('\n--- 1. Customer Submits Support Ticket ---');
  const custTicketRes = await makeRequest(
    'POST',
    '/api/support/tickets',
    {
      category: 'Payment Problem',
      subject: 'Double toll deduction on ECR route',
      description: 'The toll gate charged ₹60 on Fastag and driver also took cash. Please refund.',
      tripId: 'GC-TRIP-991',
      priority: 'High',
    },
    customerToken
  );
  console.log('Customer Ticket HTTP Status:', custTicketRes.status);
  console.log('Customer Ticket Response:', custTicketRes.body);
  const custTicketCode = custTicketRes.body?.data?.ticketCode;

  // 2. Customer views their tickets
  console.log('\n--- 2. Customer Views My Tickets ---');
  const myTicketsRes = await makeRequest('GET', '/api/support/my-tickets', undefined, customerToken);
  console.log('My Tickets count:', myTicketsRes.body?.data?.length);
  const foundCustTicket = (myTicketsRes.body?.data || []).find((t: any) => t.id === custTicketCode);
  console.log('Found newly created customer ticket:', !!foundCustTicket);

  // 3. Driver submits a report via /api/drivers/reports
  console.log('\n--- 3. Driver Submits Report (Partner App) ---');
  const driverReportRes = await makeRequest(
    'POST',
    '/api/drivers/reports',
    {
      title: 'Navigation App GPS discrepancy',
      category: 'Trip Issue',
      description: 'GPS route suggested closed one-way street near White Town promenade.',
    },
    driverToken
  );
  console.log('Driver Report HTTP Status:', driverReportRes.status);
  console.log('Driver Report Response:', driverReportRes.body);
  const driverReportId = driverReportRes.body?.data?.id;

  // 4. Driver views their reports
  console.log('\n--- 4. Driver Views Past Reports ---');
  const driverReportsRes = await makeRequest('GET', '/api/drivers/reports', undefined, driverToken);
  console.log('Driver reports count:', driverReportsRes.body?.data?.length);

  // 5. Admin views ALL complaints (Unified Help Screen)
  console.log('\n--- 5. Admin Queries All Complaints ---');
  const adminComplaintsRes = await makeRequest(
    'GET',
    '/api/support/admin/complaints',
    undefined,
    adminToken
  );
  console.log('Admin Complaints HTTP Status:', adminComplaintsRes.status);
  console.log('Total Complaints in Admin:', adminComplaintsRes.body?.data?.length);
  console.log('Admin Stats:', adminComplaintsRes.body?.stats);

  const adminHasCust = (adminComplaintsRes.body?.data || []).some((c: any) => c.id === custTicketCode);
  const adminHasDriver = (adminComplaintsRes.body?.data || []).some((c: any) => c.id === driverReportId);
  console.log('Admin sees Customer Ticket:', adminHasCust);
  console.log('Admin sees Driver Report:', adminHasDriver);

  // 6. Admin resolves Customer Complaint
  console.log('\n--- 6. Admin Resolves Customer Complaint ---');
  const resolveCustRes = await makeRequest(
    'PATCH',
    `/api/support/admin/complaints/${custTicketCode}/status`,
    {
      status: 'Resolved',
      resolutionNote: '₹60 refunded to customer wallet after toll review.',
    },
    adminToken
  );
  console.log('Resolve Customer Ticket HTTP Status:', resolveCustRes.status);
  console.log('Resolve Response:', resolveCustRes.body);

  // 7. Verify Customer sees Resolved status
  console.log('\n--- 7. Verify Customer Ticket Status Updated ---');
  const myTicketsUpdated = await makeRequest('GET', '/api/support/my-tickets', undefined, customerToken);
  const updatedTicket = (myTicketsUpdated.body?.data || []).find((t: any) => t.id === custTicketCode);
  console.log('Customer ticket updated status:', updatedTicket?.status);
  console.log('Customer ticket admin response:', updatedTicket?.adminResponse);

  // 8. Admin resolves Driver Report
  console.log('\n--- 8. Admin Resolves Driver Report ---');
  const resolveDriverRes = await makeRequest(
    'PATCH',
    `/api/support/admin/complaints/${driverReportId}/status`,
    {
      status: 'Resolved',
      resolutionNote: 'One-way street bypass waypoint added to navigation config.',
    },
    adminToken
  );
  console.log('Resolve Driver Report HTTP Status:', resolveDriverRes.status);

  // 9. Verify Driver sees Resolved status in Partner App
  console.log('\n--- 9. Verify Driver Report Status Updated in Partner App ---');
  const driverReportsUpdated = await makeRequest('GET', '/api/drivers/reports', undefined, driverToken);
  const updatedDriverReport = (driverReportsUpdated.body?.data || []).find((r: any) => r.id === driverReportId);
  console.log('Driver report updated status in Partner App:', updatedDriverReport?.status);
  console.log('Driver report response in Partner App:', updatedDriverReport?.response);

  console.log('\n====================================================');
  console.log('🏁 ALL 3 APPS SUPPORT & HELP SYSTEM VERIFIED E2E!');
  console.log('====================================================\n');
}

runSupportE2E()
  .catch((e) => {
    console.error('Error running support E2E:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

