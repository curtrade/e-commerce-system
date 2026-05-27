import { bootstrapService } from '@app/common';
import { Logger } from 'nestjs-pino';
import { AppConfiguration } from './app.configuration';
import { OrdersModule } from './orders.module';

async function bootstrap() {
  const app = await bootstrapService(OrdersModule, {
    swagger: {
      title: 'Orders Service',
      description:
        'Saga-оркестратор: создание заказов, резерв → оплата → подтверждение',
    },
  });
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Logger).log(`orders listening on :${cfg.port}`, 'Bootstrap');
}
void bootstrap();
