import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  Min,
  ValidateNested,
} from 'class-validator';

export class InventoryItemDto {
  @IsNotEmpty()
  sku!: string;

  @IsInt()
  @Min(1)
  qty!: number;
}

export class ReserveDto {
  @IsNotEmpty()
  orderId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => InventoryItemDto)
  items!: InventoryItemDto[];

  @IsInt()
  @Min(60)
  ttlSec!: number;
}

export class ReleaseDto {
  @IsNotEmpty()
  reservationId!: string;
}

export class CommitDto {
  @IsNotEmpty()
  reservationId!: string;
}
