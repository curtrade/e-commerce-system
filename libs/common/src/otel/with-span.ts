import {
  Span,
  SpanStatusCode,
  context as otelContext,
  propagation,
  trace,
} from '@opentelemetry/api';

export interface WithSpanOptions {
  /** W3C traceparent header value to restore as parent context. */
  parentTraceparent?: string | null;
}

export async function withSpan<T>(
  tracerName: string,
  spanName: string,
  fn: (span: Span) => Promise<T>,
  options: WithSpanOptions = {},
): Promise<T> {
  const tracer = trace.getTracer(tracerName);
  const parentCtx = options.parentTraceparent
    ? propagation.extract(otelContext.active(), {
        traceparent: options.parentTraceparent,
      })
    : otelContext.active();

  return tracer.startActiveSpan(spanName, {}, parentCtx, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: (err as Error).message,
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Snapshot current OTel context as a W3C traceparent string so it can be
 * persisted (e.g. into an outbox row) and restored later via `withSpan`'s
 * `parentTraceparent` option.
 */
export function captureTraceparent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(otelContext.active(), carrier);
  return carrier.traceparent ?? null;
}
