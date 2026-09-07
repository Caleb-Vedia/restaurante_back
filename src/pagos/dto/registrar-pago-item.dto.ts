import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Min,
} from 'class-validator';

export class RegistrarPagoItemDto {
  @IsInt()
  @IsPositive()
  idMetodoPago: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  montoPagado: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nroRecibo?: string;
}
