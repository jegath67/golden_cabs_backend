import { prisma } from '../../config/prisma';
import { formatPlaceResponse } from '../explore/explore.controller';

export type FavoriteType = 'CAR' | 'EXPLORE';

export class FavoritesService {
  async getFavorites(customerId: string) {
    const favorites = await prisma.customerFavorite.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
    });

    const carIds = favorites
      .filter((f) => f.itemType === 'CAR')
      .map((f) => f.itemId);
    const exploreIds = favorites
      .filter((f) => f.itemType === 'EXPLORE')
      .map((f) => f.itemId);

    let cars: any[] = [];
    if (carIds.length > 0) {
      cars = await prisma.eliteCar.findMany({
        where: { id: { in: carIds } },
      });
    }

    let explorePlaces: any[] = [];
    if (exploreIds.length > 0) {
      const places = await prisma.explorePlace.findMany({
        where: { id: { in: exploreIds } },
      });
      explorePlaces = places.map((p) => formatPlaceResponse(p));
    }

    return {
      cars,
      explore: explorePlaces,
      favoriteRecords: favorites.map((f) => ({
        id: f.id,
        itemType: f.itemType,
        itemId: f.itemId,
        createdAt: f.createdAt,
      })),
    };
  }

  async addFavorite(customerId: string, itemType: FavoriteType, itemId: string) {
    if (!['CAR', 'EXPLORE'].includes(itemType)) {
      throw new Error(`Invalid itemType: ${itemType}. Must be CAR or EXPLORE.`);
    }
    if (!itemId || typeof itemId !== 'string' || itemId.trim() === '') {
      throw new Error('itemId is required.');
    }

    const trimmedId = itemId.trim();

    // Catalog existence validation
    if (itemType === 'CAR') {
      const car = await prisma.eliteCar.findUnique({
        where: { id: trimmedId },
        select: { id: true },
      });
      if (!car) {
        const err: any = new Error(`EliteCar with ID ${trimmedId} not found in catalog.`);
        err.statusCode = 404;
        throw err;
      }
    } else if (itemType === 'EXPLORE') {
      const place = await prisma.explorePlace.findUnique({
        where: { id: trimmedId },
        select: { id: true },
      });
      if (!place) {
        const err: any = new Error(`ExplorePlace with ID ${trimmedId} not found in catalog.`);
        err.statusCode = 404;
        throw err;
      }
    }

    const record = await prisma.customerFavorite.upsert({
      where: {
        customerId_itemType_itemId: {
          customerId,
          itemType: itemType as any,
          itemId: trimmedId,
        },
      },
      create: {
        customerId,
        itemType: itemType as any,
        itemId: trimmedId,
      },
      update: {},
    });

    return record;
  }

  async removeFavorite(customerId: string, itemType: FavoriteType, itemId: string) {
    if (!['CAR', 'EXPLORE'].includes(itemType)) {
      throw new Error(`Invalid itemType: ${itemType}. Must be CAR or EXPLORE.`);
    }
    if (!itemId || typeof itemId !== 'string' || itemId.trim() === '') {
      throw new Error('itemId is required.');
    }

    const trimmedId = itemId.trim();

    const result = await prisma.customerFavorite.deleteMany({
      where: {
        customerId,
        itemType: itemType as any,
        itemId: trimmedId,
      },
    });

    return { count: result.count };
  }
}

export const favoritesService = new FavoritesService();
