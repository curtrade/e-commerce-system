import { HttpStatus, Logger } from '@nestjs/common';
import { ArgumentsHost } from '@nestjs/common';
import {
  PrismaClientKnownRequestError,
  PrismaClientUnknownRequestError,
} from '@prisma/client/runtime/library';
import { PrismaExceptionFilter } from './prisma-exception.filter';

function makeKnownError(
  code: string,
  message = 'prisma error',
): PrismaClientKnownRequestError {
  return new PrismaClientKnownRequestError(message, {
    code,
    clientVersion: '6.0.0',
  });
}

function makeUnknownError(message = 'unknown prisma error'): PrismaClientUnknownRequestError {
  return new PrismaClientUnknownRequestError(message, {
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
    filter.catch(makeKnownError('P2002'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 409, message: 'Resource already exists' }),
    );
  });

  it('P2025 → 404 Not Found', () => {
    const { host, status, json } = makeHost();
    filter.catch(makeKnownError('P2025'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, message: 'Resource not found' }),
    );
  });

  it('P2003 → 400 Bad Request (related resource missing)', () => {
    const { host, status, json } = makeHost();
    filter.catch(makeKnownError('P2003'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'Related resource missing' }),
    );
  });

  it('P2014 → 400 Bad Request (invalid relation)', () => {
    const { host, status, json } = makeHost();
    filter.catch(makeKnownError('P2014'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, message: 'Invalid relation' }),
    );
  });

  it('unknown known-error code → 500 + logs raw error', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'error');
    const { host, status, json } = makeHost();
    filter.catch(makeKnownError('P2024', 'timeout exceeded'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Database error' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('P2024'),
      expect.anything(),
    );
  });

  it('PrismaClientUnknownRequestError → 500 + logs raw error', () => {
    const logSpy = jest.spyOn(Logger.prototype, 'error');
    const { host, status, json } = makeHost();
    filter.catch(makeUnknownError('connection reset'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith({ statusCode: 500, message: 'Database error' });
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('connection reset'),
      expect.anything(),
    );
  });

  it('non-HTTP context → rethrows the error', () => {
    const { host } = makeHost('rpc');
    const err = makeKnownError('P2002');
    expect(() => filter.catch(err, host)).toThrow(err);
  });

  it('non-HTTP context → rethrows unknown error', () => {
    const { host } = makeHost('rpc');
    const err = makeUnknownError();
    expect(() => filter.catch(err, host)).toThrow(err);
  });
});
