import { ClsStore } from 'nestjs-cls';

export interface TraceStore extends ClsStore {
  traceId: string;
}
