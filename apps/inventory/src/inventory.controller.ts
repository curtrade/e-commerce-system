import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
} from '@nestjs/common';
import { CommitDto, ReleaseDto, ReserveDto } from './dto/reserve.dto';
import { InventoryService } from './inventory.service';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('reserve')
  @HttpCode(201)
  reserve(
    @Body() dto: ReserveDto,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    if (!idemKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }
    return this.inventory.reserve(dto, idemKey);
  }

  @Post('release')
  @HttpCode(200)
  release(@Body() dto: ReleaseDto) {
    return this.inventory.release(dto);
  }

  @Post('commit')
  @HttpCode(200)
  commit(@Body() dto: CommitDto) {
    return this.inventory.commit(dto);
  }
}
