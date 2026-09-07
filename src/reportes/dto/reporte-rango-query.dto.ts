import { IsDateString } from 'class-validator';

// desde/hasta son fechas simples YYYY-MM-DD (sin hora) que representan días
// calendario en TIMEZONE_RESTAURANTE (decisión #19), no instantes UTC.
export class ReporteRangoQueryDto {
  @IsDateString()
  desde: string;

  @IsDateString()
  hasta: string;
}
