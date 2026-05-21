import 'nestjs-cls';

export const TRACE_ID_KEY = 'traceId' as const;

declare module 'nestjs-cls' {
  interface ClsStore {
    traceId?: string;
  }
}
