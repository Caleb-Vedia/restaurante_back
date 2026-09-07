import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Tope de caracteres para el contenido de "Otra indicación" (el bloque
 * `Nota:` que arma el frontend de Personalización) — NO para `observacion`
 * completo, que también puede traer el bloque `Sin: ...` con la lista de
 * ingredientes quitados. Ver auditoría: un `@MaxLength(120)` sobre
 * `observacion` entero limitaría incorrectamente ese bloque `Sin:`.
 */
export const NOTA_MAX_LENGTH = 120;

/**
 * Reconoce el formato que arma `buildObservacion` en el frontend (ver
 * sistema_restaurante_frontend/src/hooks/useCreateOrder.js), de forma
 * puramente SINTÁCTICA — nunca interpreta el contenido de la nota:
 *
 *   Nota: <texto>
 *   Sin: <ingrediente, ingrediente>\nNota: <texto>
 *
 * El bloque `Nota:`, cuando existe, es siempre el último (o el único) de la
 * cadena — el generador nunca agrega nada después. Por eso matchear desde
 * "Nota: " hasta el final del string (`$`, sin flag `m`, o sea fin de TODO
 * el string) alcanza para capturar exactamente su contenido.
 *
 * Devuelve el contenido crudo (sin trim) después de `Nota: ` si el string
 * matchea el formato reconocido, o `null` si no lo reconoce — en ese caso
 * (solo `Sin: ...`, texto legacy libre, o cualquier otra cosa) no hay nada
 * que validar acá, y el string se deja pasar tal cual llegó.
 */
const FORMATO_CON_NOTA = /^(?:Sin: [^\n]+\n)?Nota: ([\s\S]*)$/;

export function extraerContenidoNota(observacion: string): string | null {
  const match = FORMATO_CON_NOTA.exec(observacion);
  return match ? match[1] : null;
}

/**
 * Válido si:
 *   - `observacion` no reconoce el formato `Nota:` (solo `Sin:`, texto
 *     legacy libre, o cualquier otra cosa) — no se aplica ningún límite.
 *   - o el contenido de la Nota, después de `trim()`, mide 120 caracteres
 *     o menos.
 *
 * `@IsOptional()` en el DTO ya hace que class-validator salte este
 * validator entero cuando `observacion` es `undefined`/`null`; el chequeo
 * de tipo acá es solo defensivo para que la función siga siendo segura de
 * llamar de forma aislada (ver los tests unitarios de este archivo).
 */
@ValidatorConstraint({ name: 'observacionNotaMaxLength', async: false })
export class ObservacionNotaMaxLengthConstraint implements ValidatorConstraintInterface {
  validate(observacion: unknown): boolean {
    if (typeof observacion !== 'string') return true;

    const contenidoNota = extraerContenidoNota(observacion);
    if (contenidoNota === null) return true;

    return contenidoNota.trim().length <= NOTA_MAX_LENGTH;
  }

  defaultMessage(): string {
    return `La indicación adicional (Nota) no puede superar los ${NOTA_MAX_LENGTH} caracteres.`;
  }
}

export function IsObservacionNotaMaxLength(
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [],
      validator: ObservacionNotaMaxLengthConstraint,
    });
  };
}
