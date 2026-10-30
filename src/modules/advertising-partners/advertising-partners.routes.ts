import type { FastifyInstance } from 'fastify';
import { advertisingPartnersController } from './advertising-partners.controller';

export async function advertisingPartnersRoutes(app: FastifyInstance) {
  app.get('/', advertisingPartnersController.getAllPartners.bind(advertisingPartnersController));
  app.get('/:id', advertisingPartnersController.getPartnerById.bind(advertisingPartnersController));
  app.post('/', advertisingPartnersController.createPartner.bind(advertisingPartnersController));
  app.put('/:id', advertisingPartnersController.updatePartner.bind(advertisingPartnersController));
  app.delete('/:id', advertisingPartnersController.deletePartner.bind(advertisingPartnersController));
}

