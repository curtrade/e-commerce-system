import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '.prisma/client-orders';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(err: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw err;
    }
    const res = host.switchToHttp().getResponse<Response>();

    switch (err.code) {
      case 'P2002': {
        const exc = new ConflictException('Resource already exists');
        res.status(HttpStatus.CONFLICT).json(exc.getResponse());
        return;
      }
      case 'P2025': {
        const exc = new NotFoundException('Resource not found');
        res.status(HttpStatus.NOT_FOUND).json(exc.getResponse());
        return;
      }
      case 'P2003': {
        const exc = new BadRequestException('Related resource missing');
        res.status(HttpStatus.BAD_REQUEST).json(exc.getResponse());
        return;
      }
      case 'P2014': {
        const exc = new BadRequestException('Invalid relation');
        res.status(HttpStatus.BAD_REQUEST).json(exc.getResponse());
        return;
      }
      default: {
        // Log the raw Prisma error server-side; never leak code/meta to the client.
        this.logger.error(
          `Unhandled Prisma error ${err.code}: ${err.message}`,
          err.stack,
        );
        res
          .status(HttpStatus.INTERNAL_SERVER_ERROR)
          .json({ statusCode: 500, message: 'Database error' });
      }
    }
  }
}
