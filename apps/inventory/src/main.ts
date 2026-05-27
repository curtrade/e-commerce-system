import { bootstrapService } from '@app/common';
import { Logger } from 'nestjs-pino';
import { AppConfiguration } from './app.configuration';
import { InventoryModule } from './inventory.module';

async function bootstrap() {
  const app = await bootstrapService(InventoryModule, {
    swagger: {
      title: 'Inventory Service',
      description: 'Резерв/release/commit стока с TTL и идемпотентностью',
    },
  });
  const cfg = app.get(AppConfiguration);
  await app.listen(cfg.port, '0.0.0.0');
  app.get(Logger).log(`inventory listening on :${cfg.port}`, 'Bootstrap');
}
void bootstrap();
