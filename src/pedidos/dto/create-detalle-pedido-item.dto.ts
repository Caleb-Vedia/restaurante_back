import { IsInt, IsOptional, IsPositive, IsString, Min } from 'class-validator';
import { IsObservacionNotaMaxLength } from './validators/observacion-nota-max-length.validator';

export class CreateDetallePedidoItemDto {
  @IsInt()
  @IsPositive()
  idProducto: number;

  @IsInt()
  @Min(1)
  cantidad: number;

  @IsOptional()
  @IsString()
  @IsObservacionNotaMaxLength()
  observacion?: string;
}
