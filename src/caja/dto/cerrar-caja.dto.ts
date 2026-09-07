import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { MontoContadoItemDto } from './monto-contado-item.dto';

// Mismo tope que NOTA_MAX_LENGTH (Pedidos): "texto breve", una sola línea de
// explicación, no un campo libre sin límite.
export const OBSERVACION_DIFERENCIA_MAX_LENGTH = 120;

// Contrato COMPARTIDO por PATCH /caja/cerrar y POST /caja/cierre/preview
// (ver CierresCajaService.previsualizarCierre): el mismo body sirve para
// previsualizar y para cerrar de verdad, así que este DTO no puede tener
// reglas distintas entre uno y otro. `observacionDiferencia` no es
// obligatoria ni siquiera cuando la diferencia da distinto de 0 — la Etapa 8
// la deja opcional a propósito, sin convertirla en requisito.
export class CerrarCajaDto {
  // Opcional: se puede cerrar caja sin declarar conteo (todos los
  // montoContado quedan en null y el arqueo queda pendiente).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MontoContadoItemDto)
  detalle?: MontoContadoItemDto[];

  // Explicación breve de la diferencia del arqueo (ej. "Faltan Bs 5; se
  // revisó efectivo."). Se trimea y, si queda vacía, se guarda como `null`
  // (ver ConciliacionCajaService.resolverObservacionDiferencia) — por eso acá
  // no hace falta `@IsNotEmpty()`: un string de solo espacios es válido en el
  // DTO y se normaliza más abajo, en el service, no en la validación.
  @IsOptional()
  @IsString()
  @MaxLength(OBSERVACION_DIFERENCIA_MAX_LENGTH)
  observacionDiferencia?: string;
}
