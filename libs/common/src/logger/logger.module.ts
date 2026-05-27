import { LoggerModule, Params } from 'nestjs-pino';
import { randomUUID } from 'crypto';
import type { IncomingMessage } from 'http';

// Единая конфигурация pino для всех микросервисов. Корреляция с OTel
// (поля trace_id/span_id) и отправка логов в OTLP включаются автоматически
// через @opentelemetry/instrumentation-pino, поднимаемый в tracing.js.
export const AppLoggerModule = LoggerModule.forRoot({
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? 'info',
    // x-request-id из заголовка или новый UUID, чтобы привязывать
    // несколько строк одного запроса даже без OTel-контекста.
    genReqId: (req: IncomingMessage) => {
      const headerId = req.headers['x-request-id'];
      if (typeof headerId === 'string' && headerId.length > 0) return headerId;
      if (Array.isArray(headerId) && headerId[0]) return headerId[0];
      return randomUUID();
    },
    customProps: () => ({ service: process.env.OTEL_SERVICE_NAME }),
    // /health и /healthz регулярно дёргают k8s/docker — не засоряем логи.
    autoLogging: {
      ignore: (req) => {
        const url = req.url ?? '';
        return url === '/health' || url === '/healthz';
      },
    },
    // Никакого pino-pretty: в контейнерах нужна структурная JSON-строка,
    // её парсит Loki/Collector. Локально читаем через `docker logs … | jq`.
  } satisfies Params['pinoHttp'],
});
