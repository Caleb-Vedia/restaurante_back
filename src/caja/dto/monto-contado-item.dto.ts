import { IsInt, IsNumber, IsOptional, IsPositive, Min } from 'class-validator';

export class MontoContadoItemDto {
  @IsInt()
  @IsPositive()
  idMetodoPago: number;

  // Opcional: un método que no se contó queda con montoContado = null (sin
  // diferencia calculable), no con 0 — 0 significaría "conté y no había nada".
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  montoContado?: number;
}
