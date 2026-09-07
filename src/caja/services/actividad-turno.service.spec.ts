import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ActividadTurnoService } from './actividad-turno.service';
import { CierreCaja } from '../entities/cierre-caja.entity';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { Pedido } from '../../pedidos/entities/pedido.entity';
import { DetallePedido } from '../../pedidos/entities/detalle-pedido.entity';
import { Pago } from '../../pagos/entities/pago.entity';
import { EstadoPedido } from '../../common/enums/estado-pedido.enum';

/**
 * Actividad del turno (Etapa 5B), READ-ONLY.
 *
 * El entorno modela la base con arrays en memoria y resuelve las consultas
 * del service filtrando esos arrays con las MISMAS condiciones que el SQL
 * real: la ventana [abiertoEl, ahora] para pedidos/pagos, la intersección de
 * sesiones con el turno, y el GROUP BY del total por visita. Así los tests
 * verifican las reglas de negocio (qué entra en la ventana, qué se excluye,
 * qué cuenta como ingreso) sin depender de Postgres.
 *
 * Los repos mockeados NO exponen save/update/delete a propósito: si el
 * service intentara escribir algo, reventaría en vez de pasar en silencio.
 */

const ABIERTO_EL = new Date('2026-01-02T10:00:00Z');
const ANTES_DEL_TURNO = new Date('2026-01-02T09:00:00Z');

interface FilaPedido {
  idPedido: number;
  idSesion: number;
  nroOrden: number;
  nombreComensal: string | null;
  estado: EstadoPedido;
  creadoEl: Date;
  detallesPedido: Array<Partial<DetallePedido>>;
}

interface FilaPago {
  idPago: number;
  idSesion: number;
  idMetodoPago: number;
  nroRecibo: string | null;
  montoPagado: number;
  anuladoEl: Date | null;
  creadoEl: Date;
  metodoPago: { nombreMetodo: string };
}

interface FilaSesion {
  idSesion: number;
  idMesa: number;
  abiertaEl: Date;
  cerradaEl: Date | null;
  mesa: { idMesa: number; nombreMesa: string };
}

describe('ActividadTurnoService', () => {
  const detalle = (
    overrides: Partial<DetallePedido> & { nombreProducto?: string } = {},
  ): Partial<DetallePedido> => ({
    idDetalle: overrides.idDetalle ?? 500,
    idProducto: overrides.idProducto ?? 7,
    cantidad: overrides.cantidad ?? 1,
    precioActual: overrides.precioActual ?? 25,
    observacion: overrides.observacion ?? null,
    producto: {
      nombreProducto: overrides.nombreProducto ?? 'Sopa de Maní',
    } as DetallePedido['producto'],
  });

  const pedido = (overrides: Partial<FilaPedido> = {}): FilaPedido => ({
    idPedido: overrides.idPedido ?? 1,
    idSesion: overrides.idSesion ?? 10,
    nroOrden: overrides.nroOrden ?? 1,
    nombreComensal: overrides.nombreComensal ?? null,
    estado: overrides.estado ?? EstadoPedido.PENDIENTE,
    creadoEl: overrides.creadoEl ?? new Date('2026-01-02T10:30:00Z'),
    detallesPedido: overrides.detallesPedido ?? [detalle()],
  });

  const pago = (overrides: Partial<FilaPago> = {}): FilaPago => ({
    idPago: overrides.idPago ?? 1000,
    idSesion: overrides.idSesion ?? 10,
    idMetodoPago: overrides.idMetodoPago ?? 1,
    nroRecibo: overrides.nroRecibo ?? null,
    montoPagado: overrides.montoPagado ?? 25,
    anuladoEl: overrides.anuladoEl ?? null,
    creadoEl: overrides.creadoEl ?? new Date('2026-01-02T11:00:00Z'),
    metodoPago: overrides.metodoPago ?? { nombreMetodo: 'Efectivo' },
  });

  const sesion = (overrides: Partial<FilaSesion> = {}): FilaSesion => {
    const idMesa = overrides.idMesa ?? 1;
    return {
      idSesion: overrides.idSesion ?? 10,
      idMesa,
      abiertaEl: overrides.abiertaEl ?? new Date('2026-01-02T10:15:00Z'),
      cerradaEl: overrides.cerradaEl ?? null,
      mesa: overrides.mesa ?? { idMesa, nombreMesa: `Mesa ${idMesa}` },
    };
  };

  interface Db {
    cierre: {
      idCierre: number;
      idUsuario: number;
      abiertoEl: Date;
      cerradoEl: Date | null;
      montoInicialEfectivo: number;
    } | null;
    sesiones: FilaSesion[];
    pedidos: FilaPedido[];
    pagos: FilaPago[];
  }

  // Cuenta las consultas emitidas, para poder afirmar que el costo no crece
  // con la cantidad de sesiones (control de N+1).
  let queriesEmitidas: string[];

  const montarServicio = async (db: Db): Promise<ActividadTurnoService> => {
    queriesEmitidas = [];

    const enVentana = (fecha: Date, desde: Date, hasta: Date) =>
      fecha >= desde && fecha <= hasta;

    // Modela el QueryBuilder de buscarSesionesDelTurno: aplica la condición
    // de intersección `cerradaEl IS NULL OR cerradaEl >= :desde`.
    const sesionQueryBuilder = () => {
      let desde: Date;
      const qb: Record<string, jest.Mock> = {};
      for (const metodo of [
        'innerJoinAndSelect',
        'withDeleted',
        'orderBy',
        'addOrderBy',
      ]) {
        qb[metodo] = jest.fn(() => qb);
      }
      qb.where = jest.fn((_cond: string, params: { desde: Date }) => {
        desde = params.desde;
        return qb;
      });
      qb.getMany = jest.fn(() => {
        queriesEmitidas.push('sesiones');
        return Promise.resolve(
          db.sesiones
            .filter((s) => s.cerradaEl === null || s.cerradaEl >= desde)
            .sort(
              (a, b) =>
                a.abiertaEl.getTime() - b.abiertaEl.getTime() ||
                a.idSesion - b.idSesion,
            )
            .map((s) => ({ ...s })),
        );
      });
      return qb;
    };

    // Modela el GROUP BY de calcularTotalAdeudadoPorSesiones: suma
    // cantidad * precioActual de TODOS los pedidos de cada sesión, sin filtro
    // de fecha (consumo completo de la visita, a precios congelados).
    const detalleQueryBuilder = () => {
      let idsSesion: number[] = [];
      const qb: Record<string, jest.Mock> = {};
      for (const metodo of ['innerJoin', 'select', 'addSelect', 'groupBy']) {
        qb[metodo] = jest.fn(() => qb);
      }
      qb.where = jest.fn((_cond: string, params: { idsSesion: number[] }) => {
        idsSesion = params.idsSesion;
        return qb;
      });
      qb.getRawMany = jest.fn(() => {
        queriesEmitidas.push('totales');
        const totales = new Map<number, number>();
        for (const p of db.pedidos) {
          if (!idsSesion.includes(p.idSesion)) continue;
          const suma = p.detallesPedido.reduce(
            (acc, d) => acc + (d.cantidad ?? 0) * (d.precioActual ?? 0),
            0,
          );
          totales.set(p.idSesion, (totales.get(p.idSesion) ?? 0) + suma);
        }
        return Promise.resolve(
          [...totales.entries()].map(([idSesion, total]) => ({
            idSesion,
            total,
          })),
        );
      });
      return qb;
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ActividadTurnoService,
        {
          provide: getRepositoryToken(CierreCaja),
          useValue: {
            findOne: jest.fn(() => {
              queriesEmitidas.push('cierre');
              return Promise.resolve(
                db.cierre && db.cierre.cerradoEl === null
                  ? { ...db.cierre }
                  : null,
              );
            }),
          },
        },
        {
          provide: getRepositoryToken(SesionMesa),
          useValue: { createQueryBuilder: jest.fn(() => sesionQueryBuilder()) },
        },
        {
          provide: getRepositoryToken(Pedido),
          useValue: {
            manager: {
              createQueryBuilder: jest.fn(() => detalleQueryBuilder()),
            },
            find: jest.fn(
              (opts: {
                where: {
                  idSesion: { _value: number[] };
                  creadoEl: { _value: [Date, Date] };
                };
              }) => {
                queriesEmitidas.push('pedidos');
                const ids = opts.where.idSesion._value;
                const [desde, hasta] = opts.where.creadoEl._value;
                return Promise.resolve(
                  db.pedidos
                    .filter(
                      (p) =>
                        ids.includes(p.idSesion) &&
                        enVentana(p.creadoEl, desde, hasta),
                    )
                    .sort((a, b) => a.creadoEl.getTime() - b.creadoEl.getTime())
                    .map((p) => ({ ...p })),
                );
              },
            ),
          },
        },
        {
          provide: getRepositoryToken(Pago),
          useValue: {
            find: jest.fn(
              (opts: {
                where: {
                  idSesion: { _value: number[] };
                  creadoEl: { _value: [Date, Date] };
                };
              }) => {
                queriesEmitidas.push('pagos');
                const ids = opts.where.idSesion._value;
                const [desde, hasta] = opts.where.creadoEl._value;
                return Promise.resolve(
                  db.pagos
                    .filter(
                      (p) =>
                        ids.includes(p.idSesion) &&
                        enVentana(p.creadoEl, desde, hasta),
                    )
                    .sort(
                      (a, b) =>
                        a.creadoEl.getTime() - b.creadoEl.getTime() ||
                        a.idPago - b.idPago,
                    )
                    .map((p) => ({ ...p })),
                );
              },
            ),
          },
        },
      ],
    }).compile();

    return module.get<ActividadTurnoService>(ActividadTurnoService);
  };

  const cajaAbierta = () => ({
    idCierre: 1,
    idUsuario: 1,
    abiertoEl: ABIERTO_EL,
    cerradoEl: null,
    montoInicialEfectivo: 200,
  });

  // --- Sin caja abierta ---

  it('sin caja abierta → 409 con el patrón de error del módulo, sin consultar nada más', async () => {
    const service = await montarServicio({
      cierre: null,
      sesiones: [sesion()],
      pedidos: [pedido()],
      pagos: [pago()],
    });

    await expect(service.obtenerActividadDelTurno()).rejects.toThrow(
      ConflictException,
    );
    await expect(service.obtenerActividadDelTurno()).rejects.toThrow(
      /No hay ningún cierre de caja abierto/,
    );
    // Ni sesiones, ni pedidos, ni pagos: corta en el primer chequeo. (Se
    // invocó dos veces arriba, así que solo se comprueba QUÉ se consultó.)
    expect([...new Set(queriesEmitidas)]).toEqual(['cierre']);
  });

  it('caja ya cerrada (cerradoEl con fecha) → también 409', async () => {
    const service = await montarServicio({
      cierre: { ...cajaAbierta(), cerradoEl: new Date() },
      sesiones: [],
      pedidos: [],
      pagos: [],
    });

    await expect(service.obtenerActividadDelTurno()).rejects.toThrow(
      ConflictException,
    );
  });

  // --- Turno vacío ---

  it('caja abierta sin actividad → respuesta vacía válida (no error)', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [],
      pedidos: [],
      pagos: [],
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.idCierre).toBe(1);
    expect(resultado.abiertoEl).toEqual(ABIERTO_EL);
    expect(resultado.sesiones).toEqual([]);
    expect(resultado.totalIngresosTurno).toBe(0);
    expect(resultado.generadoEl).toBeInstanceOf(Date);
  });

  // --- Agrupación por visita ---

  it('dos visitas distintas de la MISMA mesa son dos filas separadas, cada una con lo suyo', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [
        sesion({
          idSesion: 10,
          idMesa: 1,
          abiertaEl: new Date('2026-01-02T10:05:00Z'),
          cerradaEl: new Date('2026-01-02T11:00:00Z'),
        }),
        sesion({
          idSesion: 11,
          idMesa: 1,
          abiertaEl: new Date('2026-01-02T11:30:00Z'),
          cerradaEl: null,
        }),
      ],
      pedidos: [
        pedido({
          idPedido: 1,
          idSesion: 10,
          creadoEl: new Date('2026-01-02T10:10:00Z'),
          detallesPedido: [detalle({ cantidad: 1, precioActual: 25 })],
        }),
        pedido({
          idPedido: 2,
          idSesion: 11,
          creadoEl: new Date('2026-01-02T11:40:00Z'),
          detallesPedido: [detalle({ cantidad: 2, precioActual: 40 })],
        }),
      ],
      pagos: [
        pago({
          idPago: 1000,
          idSesion: 10,
          montoPagado: 25,
          creadoEl: new Date('2026-01-02T11:00:00Z'),
        }),
      ],
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.sesiones).toHaveLength(2);

    const [primera, segunda] = resultado.sesiones;
    expect(primera.idSesion).toBe(10);
    expect(primera.idMesa).toBe(1);
    expect(primera.nombreMesa).toBe('Mesa 1');
    expect(primera.cerradaEl).toEqual(new Date('2026-01-02T11:00:00Z'));
    expect(primera.pedidos.map((p) => p.idPedido)).toEqual([1]);
    expect(primera.pagos.map((p) => p.idPago)).toEqual([1000]);
    expect(primera.totalSesion).toBe(25);

    expect(segunda.idSesion).toBe(11);
    expect(segunda.idMesa).toBe(1);
    expect(segunda.cerradaEl).toBeNull();
    expect(segunda.pedidos.map((p) => p.idPedido)).toEqual([2]);
    expect(segunda.pagos).toEqual([]);
    expect(segunda.totalSesion).toBe(80);

    // Los ingresos del turno son los pagos vigentes, NO la suma de consumos.
    expect(resultado.totalIngresosTurno).toBe(25);
  });

  // --- Intersección de la ventana ---

  it('excluye las sesiones cerradas ANTES de abrir la caja actual', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [
        // Visita completa del turno anterior: abrió y cerró antes de las 10:00.
        sesion({
          idSesion: 9,
          idMesa: 2,
          abiertaEl: new Date('2026-01-02T08:00:00Z'),
          cerradaEl: new Date('2026-01-02T09:30:00Z'),
        }),
        sesion({ idSesion: 10, idMesa: 1 }),
      ],
      pedidos: [pedido({ idSesion: 10 })],
      pagos: [],
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.sesiones.map((s) => s.idSesion)).toEqual([10]);
  });

  it('incluye y marca las sesiones que atraviesan turnos (abiertas antes, cerradas durante o aún activas)', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [
        // Abrió antes del turno, cerró dentro.
        sesion({
          idSesion: 8,
          idMesa: 3,
          abiertaEl: ANTES_DEL_TURNO,
          cerradaEl: new Date('2026-01-02T10:20:00Z'),
        }),
        // Abrió antes del turno, sigue activa.
        sesion({
          idSesion: 9,
          idMesa: 4,
          abiertaEl: ANTES_DEL_TURNO,
          cerradaEl: null,
        }),
        // Nació en este turno.
        sesion({
          idSesion: 10,
          idMesa: 1,
          abiertaEl: new Date('2026-01-02T10:15:00Z'),
        }),
      ],
      pedidos: [],
      pagos: [],
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.sesiones.map((s) => s.idSesion)).toEqual([8, 9, 10]);
    expect(resultado.sesiones.map((s) => s.comenzoEnTurnoAnterior)).toEqual([
      true,
      true,
      false,
    ]);
  });

  // --- Ventana de pedidos y pagos ---

  it('pedidos anteriores al turno NO aparecen en pedidos[], pero sí cuentan en totalSesion', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [
        sesion({ idSesion: 9, idMesa: 4, abiertaEl: ANTES_DEL_TURNO }),
      ],
      pedidos: [
        // Turno anterior: 1 x 25 = 25.
        pedido({
          idPedido: 1,
          idSesion: 9,
          creadoEl: new Date('2026-01-02T09:10:00Z'),
          detallesPedido: [detalle({ cantidad: 1, precioActual: 25 })],
        }),
        // Este turno: 2 x 40 = 80.
        pedido({
          idPedido: 2,
          idSesion: 9,
          creadoEl: new Date('2026-01-02T10:30:00Z'),
          detallesPedido: [detalle({ cantidad: 2, precioActual: 40 })],
        }),
      ],
      pagos: [],
    });

    const resultado = await service.obtenerActividadDelTurno();
    const [fila] = resultado.sesiones;

    // Solo el pedido de la ventana.
    expect(fila.pedidos.map((p) => p.idPedido)).toEqual([2]);
    // Pero el consumo es el de la visita COMPLETA: 25 + 80.
    expect(fila.totalSesion).toBe(105);
  });

  it('pagos previos al turno no aparecen ni cuentan como ingreso del turno', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [
        sesion({ idSesion: 9, idMesa: 4, abiertaEl: ANTES_DEL_TURNO }),
      ],
      pedidos: [pedido({ idSesion: 9, creadoEl: ANTES_DEL_TURNO })],
      pagos: [
        pago({
          idPago: 900,
          idSesion: 9,
          montoPagado: 500,
          creadoEl: new Date('2026-01-02T09:20:00Z'),
        }),
        pago({
          idPago: 1000,
          idSesion: 9,
          montoPagado: 25,
          creadoEl: new Date('2026-01-02T10:45:00Z'),
        }),
      ],
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.sesiones[0].pagos.map((p) => p.idPago)).toEqual([1000]);
    expect(resultado.totalIngresosTurno).toBe(25);
  });

  it('distingue pagos vigentes de anulados: los anulados siguen visibles pero no suman ingreso', async () => {
    const anuladoEl = new Date('2026-01-02T12:00:00Z');
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [sesion({ idSesion: 10 })],
      pedidos: [],
      pagos: [
        pago({ idPago: 1000, idSesion: 10, montoPagado: 60, anuladoEl }),
        pago({ idPago: 1001, idSesion: 10, montoPagado: 40 }),
      ],
    });

    const resultado = await service.obtenerActividadDelTurno();
    const [fila] = resultado.sesiones;

    // Los dos siguen visibles, con su anuladoEl.
    expect(fila.pagos.map((p) => p.idPago)).toEqual([1000, 1001]);
    expect(fila.pagos[0].anuladoEl).toEqual(anuladoEl);
    expect(fila.pagos[1].anuladoEl).toBeNull();
    // Solo el vigente cuenta como ingreso.
    expect(resultado.totalIngresosTurno).toBe(40);
  });

  it('los ingresos del turno nunca salen de totalSesion (consumo sin cobrar no es ingreso)', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [sesion({ idSesion: 10 })],
      pedidos: [
        pedido({
          idSesion: 10,
          detallesPedido: [detalle({ cantidad: 3, precioActual: 100 })],
        }),
      ],
      pagos: [],
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.sesiones[0].totalSesion).toBe(300);
    // Mesa consumiendo, todavía sin cobrar: cero ingresos.
    expect(resultado.totalIngresosTurno).toBe(0);
  });

  // --- Contenido de los pedidos ---

  it('totalSesion usa el precio CONGELADO del detalle, no el vigente del producto', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [sesion({ idSesion: 10 })],
      pedidos: [
        pedido({
          idSesion: 10,
          detallesPedido: [
            // El producto hoy vale 30; se pidió a 25.
            detalle({ cantidad: 2, precioActual: 25, nombreProducto: 'Sopa' }),
          ],
        }),
      ],
      pagos: [],
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.sesiones[0].totalSesion).toBe(50);
    expect(resultado.sesiones[0].pedidos[0].detalles[0].precioActual).toBe(25);
  });

  it('la observacion de los pedidos viaja literal, sin parsear', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [sesion({ idSesion: 10 })],
      pedidos: [
        pedido({
          idSesion: 10,
          detallesPedido: [
            detalle({ observacion: 'Sin: perejil\nNota: salsa aparte' }),
          ],
        }),
      ],
      pagos: [],
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.sesiones[0].pedidos[0].detalles[0].observacion).toBe(
      'Sin: perejil\nNota: salsa aparte',
    );
  });

  it('cada pedido conserva el contrato PedidoResponse (nroOrden, estado, detalles con nombre y cantidad)', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [sesion({ idSesion: 10 })],
      pedidos: [
        pedido({
          idPedido: 5,
          idSesion: 10,
          nroOrden: 2,
          nombreComensal: 'Juan',
          estado: EstadoPedido.LISTO,
          detallesPedido: [
            detalle({
              idDetalle: 500,
              idProducto: 7,
              cantidad: 1,
              precioActual: 25,
              nombreProducto: 'Sopa de Maní',
            }),
          ],
        }),
      ],
      pagos: [],
    });

    const resultado = await service.obtenerActividadDelTurno();
    const [primerPedido] = resultado.sesiones[0].pedidos;

    expect(primerPedido).toEqual({
      idPedido: 5,
      nroOrden: 2,
      nombreComensal: 'Juan',
      estado: EstadoPedido.LISTO,
      creadoEl: new Date('2026-01-02T10:30:00Z'),
      detalles: [
        {
          idDetalle: 500,
          idProducto: 7,
          nombreProducto: 'Sopa de Maní',
          cantidad: 1,
          precioActual: 25,
          observacion: null,
        },
      ],
    });
  });

  // --- Coste de consultas / escrituras ---

  it('no hay N+1: la cantidad de consultas no crece con la cantidad de sesiones', async () => {
    const muchasSesiones = Array.from({ length: 12 }, (_, indice) =>
      sesion({ idSesion: 100 + indice, idMesa: indice + 1 }),
    );
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: muchasSesiones,
      pedidos: muchasSesiones.map((s, indice) =>
        pedido({ idPedido: indice + 1, idSesion: s.idSesion }),
      ),
      pagos: muchasSesiones.map((s, indice) =>
        pago({ idPago: 1000 + indice, idSesion: s.idSesion }),
      ),
    });

    const resultado = await service.obtenerActividadDelTurno();

    expect(resultado.sesiones).toHaveLength(12);
    // 4 consultas fijas: cierre + sesiones + pedidos + pagos + totales.
    expect(queriesEmitidas.sort()).toEqual([
      'cierre',
      'pagos',
      'pedidos',
      'sesiones',
      'totales',
    ]);
  });

  it('es READ-ONLY: los repos mockeados no tienen save/update/delete y la lectura igual resuelve', async () => {
    const service = await montarServicio({
      cierre: cajaAbierta(),
      sesiones: [sesion({ idSesion: 10 })],
      pedidos: [pedido({ idSesion: 10 })],
      pagos: [pago({ idSesion: 10 })],
    });

    // Si el service intentara escribir, explotaría acá (`.save is not a
    // function`) en lugar de resolver.
    await expect(service.obtenerActividadDelTurno()).resolves.toBeDefined();
  });
});
