import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { ReporteRangoQueryDto } from './reporte-rango-query.dto';

export class PlatosMasVendidosQueryDto extends ReporteRangoQueryDto {
  // Si no viene, el service aplica el default (10).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limite?: number;
}
