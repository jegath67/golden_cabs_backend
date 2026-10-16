import { prisma } from '../../config/prisma';

export class HubsService {
  async getAllHubs(city = 'Puducherry') {
    return prisma.hub.findMany({
      where: { city, isActive: true },
      include: {
        _count: {
          select: {
            assignedDrivers: true,
            stationedVehicles: true,
          },
        },
      },
    });
  }

  async getHubById(id: string) {
    return prisma.hub.findUnique({
      where: { id },
      include: {
        assignedDrivers: {
          include: {
            user: { select: { name: true, phone: true } },
          },
        },
        stationedVehicles: true,
      },
    });
  }

  async createHub(data: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters?: number;
    city?: string;
  }) {
    return prisma.hub.create({
      data: {
        name: data.name,
        latitude: data.latitude,
        longitude: data.longitude,
        radiusMeters: data.radiusMeters || 500,
        city: data.city || 'Puducherry',
      },
    });
  }

  /**
   * Find nearest hub using Haversine formula
   */
  async findNearestHub(lat: number, lng: number) {
    const hubs = await prisma.hub.findMany({ where: { isActive: true } });

    if (hubs.length === 0) return null;

    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const earthRadiusKm = 6371;

    let nearestHub = null;
    let shortestDistance = Infinity;

    for (const hub of hubs) {
      const dLat = toRad(hub.latitude - lat);
      const dLng = toRad(hub.longitude - lng);
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat)) * Math.cos(toRad(hub.latitude)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distanceKm = earthRadiusKm * c;

      if (distanceKm < shortestDistance) {
        shortestDistance = distanceKm;
        nearestHub = { ...hub, distanceKm: Math.round(distanceKm * 100) / 100 };
      }
    }

    return nearestHub;
  }
}

export const hubsService = new HubsService();
