'use strict';

const { NodeSDK } = require('@opentelemetry/sdk-node');
const {
  getNodeAutoInstrumentations,
} = require('@opentelemetry/auto-instrumentations-node');
const {
  OTLPTraceExporter,
} = require('@opentelemetry/exporter-trace-otlp-http');
const {
  OTLPLogExporter,
} = require('@opentelemetry/exporter-logs-otlp-http');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || 'unknown-service';

// OTLPTraceExporter / OTLPLogExporter без `url` сами читают
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
// а при их отсутствии — OTEL_EXPORTER_OTLP_ENDPOINT (base) и подставляют
// '/v1/traces' / '/v1/logs'. Так конфиг сводится к одной переменной.

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
  }),
  traceExporter: new OTLPTraceExporter(),
  logRecordProcessors: [
    new BatchLogRecordProcessor(new OTLPLogExporter()),
  ],
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs/net/dns шумят на каждый require/connect/lookup и дублируют сигнал,
      // который уже даёт http/pg/ioredis/kafkajs — отключаем.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      '@opentelemetry/instrumentation-net': { enabled: false },
      '@opentelemetry/instrumentation-dns': { enabled: false },
      // Pino: корреляция (trace_id/span_id в записи) + sending в OTel Logs SDK.
      '@opentelemetry/instrumentation-pino': {
        disableLogSending: false,
        disableLogCorrelation: false,
      },
    }),
  ],
});

sdk.start();

const shutdown = async () => {
  try {
    await sdk.shutdown();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('OTEL shutdown failed', err);
  } finally {
    process.exit(0);
  }
};
process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});
