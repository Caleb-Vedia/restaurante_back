import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDetallePedidoItemDto } from './create-detalle-pedido-item.dto';
import { NOTA_MAX_LENGTH } from './validators/observacion-nota-max-length.validator';

// Confirma que el decorator queda conectado al DTO real tal como lo procesa
// el ValidationPipe global (transform: true) — no solo la unidad aislada
// del validator (ver observacion-nota-max-length.validator.spec.ts).
describe('CreateDetallePedidoItemDto (observacion)', () => {
  const base = { idProducto: 1, cantidad: 1 };

  it('es válido sin observacion', async () => {
    const dto = plainToInstance(CreateDetallePedidoItemDto, { ...base });
    const errores = await validate(dto);
    expect(errores).toHaveLength(0);
  });

  it('es válido con "Sin: X\\nNota: Y" dentro del límite', async () => {
    const dto = plainToInstance(CreateDetallePedidoItemDto, {
      ...base,
      observacion: 'Sin: cebolla, tomate\nNota: salsa aparte',
    });
    const errores = await validate(dto);
    expect(errores).toHaveLength(0);
  });

  it('es válido con texto legacy libre, aunque supere 120 caracteres', async () => {
    const dto = plainToInstance(CreateDetallePedidoItemDto, {
      ...base,
      observacion: 'sin cebolla, doble carne, '.repeat(6),
    });
    const errores = await validate(dto);
    expect(errores).toHaveLength(0);
  });

  it('rechaza una Nota de más de 120 caracteres con el mensaje esperado', async () => {
    const nota = 'a'.repeat(NOTA_MAX_LENGTH + 1);
    const dto = plainToInstance(CreateDetallePedidoItemDto, {
      ...base,
      observacion: `Nota: ${nota}`,
    });
    const errores = await validate(dto);

    expect(errores).toHaveLength(1);
    expect(errores[0].property).toBe('observacion');
    expect(errores[0].constraints).toEqual({
      observacionNotaMaxLength:
        'La indicación adicional (Nota) no puede superar los 120 caracteres.',
    });
  });
});
