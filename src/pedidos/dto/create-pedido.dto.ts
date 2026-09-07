import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { CreateDetallePedidoItemDto } from './create-detalle-pedido-item.dto';

export class CreatePedidoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nombreComensal?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateDetallePedidoItemDto)
  items: CreateDetallePedidoItemDto[];
}
