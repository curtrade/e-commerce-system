import type { PgService, RedisService, KafkaProducerService } from '@app/common';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

/** Build a fully-typed `QueryResult` for mocks — avoids `as never` casts. */
export function pgResult<R extends QueryResultRow = QueryResultRow>(
  rows: R[] = [],
): QueryResult<R> {
  return {
    rows,
    rowCount: rows.length,
    command: '',
    oid: 0,
    fields: [],
  };
}

export interface MockPg {
  service: PgService;
  query: jest.Mock<Promise<QueryResult<QueryResultRow>>, [string, unknown[]?]>;
  withTransaction: jest.Mock;
  txClientQuery: jest.Mock<
    Promise<QueryResult<QueryResultRow>>,
    [string, unknown[]?]
  >;
}

export function createMockPg(): MockPg {
  const txClientQuery = jest.fn() as MockPg['txClientQuery'];
  txClientQuery.mockResolvedValue(pgResult());

  const withTransaction = jest.fn(async (fn: (c: PoolClient) => unknown) =>
    fn({ query: txClientQuery } as unknown as PoolClient),
  );

  const query = jest.fn() as MockPg['query'];
  query.mockResolvedValue(pgResult());

  const service = { query, withTransaction } as unknown as PgService;
  return { service, query, withTransaction, txClientQuery };
}

export interface MockRedis {
  service: RedisService;
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock;
  claimIdempotency: jest.Mock<Promise<boolean>, [string, number]>;
}

export function createMockRedis(): MockRedis {
  const get = jest.fn() as MockRedis['get'];
  get.mockResolvedValue(null);
  const set = jest.fn().mockResolvedValue('OK');
  const claimIdempotency = jest.fn() as MockRedis['claimIdempotency'];
  claimIdempotency.mockResolvedValue(true);

  const raw = jest.fn(() => ({ get, set }));
  const service = { raw, claimIdempotency } as unknown as RedisService;
  return { service, get, set, claimIdempotency };
}

export interface MockKafkaProducer {
  service: KafkaProducerService;
  send: jest.Mock<Promise<void>, [string, string, unknown]>;
}

export function createMockKafkaProducer(): MockKafkaProducer {
  const send = jest.fn() as MockKafkaProducer['send'];
  send.mockResolvedValue(undefined);
  const service = { send } as unknown as KafkaProducerService;
  return { service, send };
}
