import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsPositive,
  ValidateNested,
} from 'class-validator';
import { RegistrarPagoItemDto } from './registrar-pago-item.dto';

export class RegistrarPagoDto {
  @IsInt()
  @IsPositive()
  idMesa: number;

  // Varios ítems permiten pago mixto (ej. parte efectivo, parte tarjeta) en un
  // solo registro. La suma debe cubrir exacto el total adeudado (decisión #18).
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RegistrarPagoItemDto)
  pagos: RegistrarPagoItemDto[];
}
