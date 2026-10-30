import { prisma } from '../src/config/prisma';

async function checkState() {
  const users = await prisma.user.findMany({
    select: { id: true, name: true, phone: true, role: true, isActive: true },
  });
  console.log('--- ALL USERS ---');
  console.table(users);

  const drivers = await prisma.driverProfile.findMany({
    include: {
      user: { select: { id: true, name: true, phone: true, isActive: true } },
      assignedVehicle: { select: { id: true, model: true, vehicleNumber: true, status: true, isOnline: true } },
      ownedVehicles: { select: { id: true, model: true, vehicleNumber: true, status: true, isOnline: true } },
    },
  });
  console.log('--- ALL DRIVERS ---');
  for (const d of drivers) {
    console.log({
      id: d.id,
      name: d.user?.name,
      phone: d.user?.phone,
      persona: d.personaType,
      approvalStatus: d.approvalStatus,
      isOnline: d.isOnline,
      shiftStatus: d.shiftStatus,
      isActive: d.user?.isActive,
      assignedVehicle: d.assignedVehicle ? `${d.assignedVehicle.model} (${d.assignedVehicle.status}, online=${d.assignedVehicle.isOnline})` : null,
      ownedCount: d.ownedVehicles?.length,
    });
  }

  const vehicles = await prisma.vehicle.findMany({
    include: {
      assignedDriver: { select: { id: true, user: { select: { name: true } } } },
      owner: { select: { id: true, user: { select: { name: true } } } },
    },
  });
  console.log('--- ALL VEHICLES ---');
  for (const v of vehicles) {
    console.log({
      id: v.id,
      model: v.model,
      vehicleNumber: v.vehicleNumber,
      status: v.status,
      isOnline: v.isOnline,
      category: v.category,
      assignedDriver: v.assignedDriver?.user?.name || null,
      owner: v.owner?.user?.name || null,
    });
  }
}

checkState()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

