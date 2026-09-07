import {
  NOTA_MAX_LENGTH,
  ObservacionNotaMaxLengthConstraint,
  extraerContenidoNota,
} from './observacion-nota-max-length.validator';

describe('ObservacionNotaMaxLengthConstraint', () => {
  const constraint = new ObservacionNotaMaxLengthConstraint();
  const validate = (observacion: unknown) => constraint.validate(observacion);

  it('acepta undefined (observacion sigue siendo opcional)', () => {
    expect(validate(undefined)).toBe(true);
  });

  it('acepta null', () => {
    expect(validate(null)).toBe(true);
  });

  it('acepta "Nota: ..." con exactamente 120 caracteres', () => {
    const nota = 'a'.repeat(NOTA_MAX_LENGTH);
    expect(validate(`Nota: ${nota}`)).toBe(true);
  });

  it('rechaza "Nota: ..." con 121 caracteres', () => {
    const nota = 'a'.repeat(NOTA_MAX_LENGTH + 1);
    expect(validate(`Nota: ${nota}`)).toBe(false);
  });

  it('mide la longitud después de trim (espacios externos no cuentan)', () => {
    const nota = 'a'.repeat(NOTA_MAX_LENGTH);
    // Con los espacios crudos, el contenido mide más de 120 — pero después
    // de trim() queda exactamente en el límite y debe aceptarse.
    expect(validate(`Nota:    ${nota}   `)).toBe(true);

    const notaLarga = 'a'.repeat(NOTA_MAX_LENGTH + 1);
    // Acá ni siquiera el trim la salva: sigue pasándose por uno.
    expect(validate(`Nota:  ${notaLarga}  `)).toBe(false);
  });

  it('acepta "Sin: X\\nNota: Y" con Nota <= 120', () => {
    expect(validate('Sin: cebolla, tomate\nNota: salsa aparte')).toBe(true);
  });

  it('rechaza "Sin: X\\nNota: Y" con Nota > 120', () => {
    const nota = 'a'.repeat(NOTA_MAX_LENGTH + 1);
    expect(validate(`Sin: cebolla, tomate\nNota: ${nota}`)).toBe(false);
  });

  it('acepta solo "Sin: ..." sin límite, aunque sea muy largo', () => {
    const listaLarga = Array.from(
      { length: 30 },
      (_, i) => `ingrediente${i}`,
    ).join(', ');
    expect(listaLarga.length).toBeGreaterThan(NOTA_MAX_LENGTH);
    expect(validate(`Sin: ${listaLarga}`)).toBe(true);
  });

  it('acepta texto legacy libre de más de 120 caracteres, sin bloque Nota:', () => {
    const legacy = 'sin cebolla, doble carne, bien picante, '.repeat(5);
    expect(legacy.length).toBeGreaterThan(NOTA_MAX_LENGTH);
    expect(validate(legacy)).toBe(true);
  });

  it('acepta texto legacy normal corto ("sin cebolla, doble carne")', () => {
    expect(validate('sin cebolla, doble carne')).toBe(true);
  });

  it('defaultMessage menciona el límite de 120 caracteres', () => {
    expect(constraint.defaultMessage()).toBe(
      'La indicación adicional (Nota) no puede superar los 120 caracteres.',
    );
  });
});

describe('extraerContenidoNota', () => {
  it('devuelve null si no hay bloque Nota:', () => {
    expect(extraerContenidoNota('Sin: cebolla')).toBeNull();
    expect(extraerContenidoNota('sin cebolla, doble carne')).toBeNull();
  });

  it('devuelve el contenido crudo (sin trim) después de "Nota: "', () => {
    expect(extraerContenidoNota('Nota:  salsa aparte ')).toBe(' salsa aparte ');
  });

  it('devuelve el contenido de Nota cuando va precedido de Sin:', () => {
    expect(
      extraerContenidoNota('Sin: cebolla, tomate\nNota: salsa aparte'),
    ).toBe('salsa aparte');
  });
});
