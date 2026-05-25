import { HttpStatus, Logger } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '.prisma/client-payments';
import { PrismaExceptionFilter } from './prisma-exception.filter';

function makePrismaError(
  code: string,
  message = 'prisma error',
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: '6.0.0',
  });
}

function makeHost(type = 'http'): { host: ArgumentsHost; json: jest.Mock; status: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    getType: () => type,
    switchToHttp: () => ({ getResponse: () => ({ status, json }) }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

describe('PrismaExceptionFilter', () => {
  let filter: PrismaExceptionFilter;

  beforeEach(() => {
    filter = new PrismaExceptionFilter();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('P2002 → 409 Conflict', () => {
    const { host, status, json } = makeHost();
    filter.catch(makePrismaError('P2002'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: 'Resource already exists' }),
    );
  });

  it('P2025 → 404 Not Found', () => {
    const { host, status, json } = makeHost();
    filter.catch(makePrismaError('P2025'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, message: 'Resource not found' }),
    );
  });

  it('P2003 → 400 Bad Request (related resource missing)', () => {
    const { host, status, json } = makeHost();
    filter.catch(makePrismaError('P2003'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'Related resource missing' }),
    );
  });

  it('P2014 → 400 Bad Request (invalid relation)', () => {
    const { host, status, json } = makeHost();
    filter.catch(makePrismaError('P2014'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'Invalid relation' }),
    );
  });

  it('non-HTTP context → rethrows the error', () => {
    const { host } = makeHost('rpc');
    const err = makePrismaError('P2002');
    expect(() => filter.catch(err, host)).toThrow(err);
  });

  it('unknown code → 500 with generic message, logs raw error', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'error');
    const { host, status, json } = makeHost();
    filter.catch(makePrismaError('P2024', 'timeout exceeded'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Database error' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('P2024'),
      expect.anything(),
    );
  });
});
