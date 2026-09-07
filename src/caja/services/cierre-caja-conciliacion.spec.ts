import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CierresCajaService } from './cierres-caja.service';
import { ConciliacionCajaService } from './conciliacion-caja.service';
import { CierreCaja } from '../entities/cierre-caja.entity';
import { MetodoPago } from '../../pagos/entities/metodo-pago.entity';
import { Pago } from '../../pagos/entities/pago.entity';
import { DetallePedido } from '../../pedidos/entities/detalle-pedido.entity';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';

/**
 * Cierre de caja en 4 pasos (Etapa 6): preview/contexto, reglas A/B/C sobre
 * las sesiones abiertas, y revalidación del cierre definitivo.
 *
 * ALCANCE DE ESTOS TESTS — leer antes de confiar en ellos.
 *
 * El entorno modela la base con objetos en memoria y resuelve cada consulta
 * del service aplicando en JS la MISMA condición que el SQL real (ventana
 * [abiertoEl, hasta] para los pagos, `cerradaEl IS NULL` para las sesiones,
 * los GROUP BY de consumo y pagado por sesión). Verifican las reglas de
 * negocio y qué se persiste, no que el SQL emitido sea correcto ni que
 * Postgres bloquee de verdad — la sincronización con cobros/anulaciones tiene
 * su propio archivo (pagos-caja.concurrencia.spec.ts).
 */

interface FilaPago {
  idPago: number;
  idSesion: number;
  idMetodoPago: number;
  montoPagado: number;
  anuladoEl: Date | null;
  creadoEl: Date;
}

interface FilaSesion {
  idSesion: number;
  idMesa: number;
  abiertaEl: Date;
  cerradaEl: Date | null;
  mesa: { idMesa: number; nombreMesa: string; estado: EstadoMesa };
}

/** Consumo de una sesión: se modela ya agregado (cantidad × precio congelado). */
interface FilaConsumo {
  idSesion: number;
  total: number;
}

const ABIERTO_EL = new Date('2026-03-01T10:00:00Z');

const EFECTIVO = {
  idMetodoPago: 1,
  nombreMetodo: 'Efectivo',
  codigo: 'efectivo',
};
const TARJETA = { idMetodoPago: 2, nombreMetodo: 'Tarjeta', codigo: null };

describe('Cierre de caja — preview, reglas A/B/C y revalidación', () => {
  const sesion = (overrides: Partial<FilaSesion> = {}): FilaSesion => {
    const idMesa = overrides.idMesa ?? 1;
    return {
      idSesion: overrides.idSesion ?? 10,
      idMesa,
      abiertaEl: overrides.abiertaEl ?? new Date('2026-03-01T10:30:00Z'),
      cerradaEl: overrides.cerradaEl ?? null,
      mesa: overrides.mesa ?? {
        idMesa,
        nombreMesa: `Mesa ${idMesa}`,
        estado: EstadoMesa.OCUPADA,
      },
    };
  };

  const pago = (overrides: Partial<FilaPago> = {}): FilaPago => ({
    idPago: overrides.idPago ?? 500,
    idSesion: overrides.idSesion ?? 10,
    idMetodoPago: overrides.idMetodoPago ?? 1,
    montoPagado: overrides.montoPagado ?? 100,
    anuladoEl: overrides.anuladoEl ?? null,
    creadoEl: overrides.creadoEl ?? new Date('2026-03-01T11:00:00Z'),
  });

  interface Db {
    cierre: {
      idCierre: number;
      idUsuario: number;
      abiertoEl: Date;
      cerradoEl: Date | null;
      montoInicialEfectivo: number;
      observacionDiferencia: string | null;
    } | null;
    metodos: Array<{
      idMetodoPago: number;
      nombreMetodo: string;
      codigo: string | null;
    }>;
    pagos: FilaPago[];
    sesiones: FilaSesion[];
    consumos: FilaConsumo[];
    // Lo que el cierre definitivo persistió.
    detallesCierre: Array<Record<string, unknown>>;
  }

  let escrituras: string[];

  const crearDb = (overrides: Partial<Db> = {}): Db => ({
    cierre: {
      idCierre: 1,
      idUsuario: 7,
      abiertoEl: ABIERTO_EL,
      cerradoEl: null,
      montoInicialEfectivo: 200,
      observacionDiferencia: null,
      ...(overrides.cierre ?? {}),
    },
    metodos: overrides.metodos ?? [EFECTIVO, TARJETA],
    pagos: overrides.pagos ?? [],
    sesiones: overrides.sesiones ?? [],
    consumos: overrides.consumos ?? [],
    detallesCierre: [],
  });

  /**
   * Un manager que resuelve las consultas del service contra `db`.
   * `transaccional` marca el del cierre definitivo: solo ese acepta escrituras
   * y las mantiene pendientes hasta el commit simulado.
   */
  const crearManager = (db: Db, transaccional = false) => {
    const pendientes: Array<Record<string, unknown>> = [];
    let cerradoElPendiente: Date | undefined;
    let observacionDiferenciaPendiente: string | null | undefined;

    const manager = {
      findOne: jest.fn((entidad: unknown, opts?: { lock?: unknown }) => {
        if (entidad === CierreCaja) {
          if (opts?.lock) escrituras.push('lock:cierre');
          return Promise.resolve(
            db.cierre && db.cierre.cerradoEl === null ? { ...db.cierre } : null,
          );
        }
        if (entidad === MetodoPago) {
          return Promise.resolve(
            db.metodos.find((m) => m.codigo === 'efectivo') ?? null,
          );
        }
        return Promise.resolve(null);
      }),

      find: jest.fn((entidad: unknown) => {
        if (entidad === MetodoPago) {
          return Promise.resolve(db.metodos.map((m) => ({ ...m })));
        }
        return Promise.resolve([]);
      }),

      create: jest.fn((_entidad: unknown, datos: unknown) => datos),

      save: jest.fn((filas: unknown) => {
        if (!transaccional) {
          throw new Error(
            'El preview NO debe escribir: se llamó manager.save fuera del cierre definitivo.',
          );
        }
        escrituras.push('save:detalle');
        const lista = Array.isArray(filas) ? filas : [filas];
        pendientes.push(...(lista as Array<Record<string, unknown>>));
        return Promise.resolve(filas);
      }),

      update: jest.fn(
        (
          entidad: unknown,
          _criterio: unknown,
          valores: Record<string, unknown>,
        ) => {
          if (!transaccional) {
            throw new Error(
              'El preview NO debe escribir: se llamó manager.update fuera del cierre definitivo.',
            );
          }
          if (entidad === CierreCaja) {
            escrituras.push('update:cerradoEl');
            cerradoElPendiente = valores.cerradoEl as Date;
            observacionDiferenciaPendiente = valores.observacionDiferencia as
              string | null;
          }
          return Promise.resolve({ affected: 1 });
        },
      ),

      createQueryBuilder: jest.fn((entidad: unknown) => {
        const parametros: Record<string, unknown> = {};
        const qb: Record<string, jest.Mock> = {};
        for (const metodo of [
          'innerJoin',
          'innerJoinAndSelect',
          'select',
          'addSelect',
          'where',
          'andWhere',
          'groupBy',
          'orderBy',
          'addOrderBy',
          'withDeleted',
        ]) {
          qb[metodo] = jest.fn((_cond: unknown, params?: object) => {
            if (params) Object.assign(parametros, params);
            return qb;
          });
        }

        // evaluarSesionesDelCierre: sesiones con `cerradaEl IS NULL`.
        qb.getMany = jest.fn(() =>
          Promise.resolve(
            db.sesiones
              .filter((s) => s.cerradaEl === null)
              .map((s) => ({ ...s, mesa: { ...s.mesa } })),
          ),
        );

        qb.getRawMany = jest.fn(() => {
          // calcularDetalle: pagos vigentes por método dentro de la ventana.
          if (entidad === Pago && parametros.hasta !== undefined) {
            const desde = parametros.desde as Date;
            const hasta = parametros.hasta as Date;
            const porMetodo = new Map<number, number>();
            for (const p of db.pagos) {
              if (p.anuladoEl !== null) continue;
              if (p.creadoEl < desde || p.creadoEl > hasta) continue;
              porMetodo.set(
                p.idMetodoPago,
                (porMetodo.get(p.idMetodoPago) ?? 0) + p.montoPagado,
              );
            }
            return Promise.resolve(
              [...porMetodo.entries()].map(([idMetodoPago, total]) => ({
                idMetodoPago,
                total,
              })),
            );
          }

          // calcularTotalPagadoPorSesiones: pagos vigentes por sesión (sin
          // ventana de turno — el saldo de una visita es de toda la visita).
          if (entidad === Pago) {
            const ids = (parametros.idsSesion as number[]) ?? [];
            const porSesion = new Map<number, number>();
            for (const p of db.pagos) {
              if (p.anuladoEl !== null) continue;
              if (!ids.includes(p.idSesion)) continue;
              porSesion.set(
                p.idSesion,
                (porSesion.get(p.idSesion) ?? 0) + p.montoPagado,
              );
            }
            return Promise.resolve(
              [...porSesion.entries()].map(([idSesion, total]) => ({
                idSesion,
                total,
              })),
            );
          }

          // calcularTotalAdeudadoPorSesiones: consumo a precio congelado.
          if (entidad === DetallePedido) {
            const ids = (parametros.idsSesion as number[]) ?? [];
            return Promise.resolve(
              db.consumos
                .filter((c) => ids.includes(c.idSesion))
                .map((c) => ({ idSesion: c.idSesion, total: c.total })),
            );
          }

          return Promise.resolve([]);
        });

        return qb;
      }),
    };

    const commit = () => {
      db.detallesCierre.push(...pendientes);
      if (cerradoElPendiente && db.cierre) {
        db.cierre.cerradoEl = cerradoElPendiente;
        db.cierre.observacionDiferencia =
          observacionDiferenciaPendiente ?? null;
      }
    };
    const rollback = () => {
      pendientes.length = 0;
      cerradoElPendiente = undefined;
      observacionDiferenciaPendiente = undefined;
    };

    return { manager, commit, rollback };
  };

  const montarServicio = async (db: Db) => {
    escrituras = [];

    const previewManager = crearManager(db, false).manager;
    const transaccion = crearManager(db, true);

    const queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(() => {
        escrituras.push('commit');
        transaccion.commit();
        return Promise.resolve();
      }),
      rollbackTransaction: jest.fn(() => {
        escrituras.push('rollback');
        transaccion.rollback();
        return Promise.resolve();
      }),
      release: jest.fn(),
      manager: transaccion.manager,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CierresCajaService,
        ConciliacionCajaService,
        {
          provide: getRepositoryToken(CierreCaja),
          useValue: { manager: previewManager },
        },
        {
          provide: DataSource,
          useValue: { createQueryRunner: jest.fn(() => queryRunner) },
        },
      ],
    }).compile();

    return {
      service: module.get<CierresCajaService>(CierresCajaService),
      queryRunner,
    };
  };

  // --- Preview: no persiste ---

  it('el preview no crea CierreCajaDetalle, no setea cerradoEl y no toca sesiones', async () => {
    const db = crearDb({
      pagos: [pago({ idMetodoPago: 1, montoPagado: 100 })],
      sesiones: [sesion({ idSesion: 10 })],
      consumos: [{ idSesion: 10, total: 100 }],
    });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({
      detalle: [{ idMetodoPago: 1, montoContado: 300 }],
    });

    expect(preview.idCierre).toBe(1);
    expect(db.detallesCierre).toHaveLength(0);
    expect(db.cierre?.cerradoEl).toBeNull();
    expect(db.sesiones[0].cerradaEl).toBeNull();
    // Ni una escritura, ni un lock: el preview es lectura pura.
    expect(escrituras).toEqual([]);
  });

  it('el preview se puede repetir y corregir sin efectos', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const primero = await service.previsualizarCierre({
      detalle: [{ idMetodoPago: 1, montoContado: 250 }],
    });
    const corregido = await service.previsualizarCierre({
      detalle: [{ idMetodoPago: 1, montoContado: 300 }],
    });

    expect(primero.diferenciaTotal).toBe(-50);
    expect(corregido.diferenciaTotal).toBe(0);
    expect(db.detallesCierre).toHaveLength(0);
    expect(db.cierre?.cerradoEl).toBeNull();
  });

  it('sin caja abierta el preview responde 409', async () => {
    const db = crearDb();
    db.cierre = null;
    const { service } = await montarServicio(db);

    await expect(service.previsualizarCierre({})).rejects.toThrow(
      ConflictException,
    );
  });

  // --- Diferencias ---

  it('calcula esperado, verificado y diferencias por método y total', async () => {
    const db = crearDb({
      pagos: [
        pago({ idPago: 1, idMetodoPago: 1, montoPagado: 100 }),
        pago({ idPago: 2, idMetodoPago: 2, montoPagado: 40 }),
      ],
    });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({
      detalle: [
        { idMetodoPago: 1, montoContado: 295 }, // esperado 200 + 100 = 300
        { idMetodoPago: 2, montoContado: 45 }, // esperado 40
      ],
    });

    const efectivo = preview.detalle.find((f) => f.idMetodoPago === 1);
    const tarjeta = preview.detalle.find((f) => f.idMetodoPago === 2);
    expect(efectivo?.montoEsperado).toBe(300);
    expect(efectivo?.diferencia).toBe(-5);
    expect(tarjeta?.montoEsperado).toBe(40);
    expect(tarjeta?.diferencia).toBe(5);

    expect(preview.totalEsperado).toBe(340);
    expect(preview.totalContado).toBe(340);
    expect(preview.diferenciaTotal).toBe(0);
  });

  it('el contexto es el mismo cálculo sin montos: contado y diferencia en null', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const contexto = await service.obtenerContextoCierre();

    expect(contexto.totalEsperado).toBe(300);
    expect(contexto.totalContado).toBeNull();
    expect(contexto.diferenciaTotal).toBeNull();
    expect(contexto.detalle.every((f) => f.montoContado === null)).toBe(true);
    expect(contexto.detalle.every((f) => f.diferencia === null)).toBe(true);
  });

  // --- Reglas A / B / C ---

  it('regla A: sesión activa con saldo 0 permite cerrar, se reporta y NO se libera', async () => {
    const db = crearDb({
      sesiones: [sesion({ idSesion: 10, idMesa: 1 })],
      consumos: [{ idSesion: 10, total: 100 }],
      pagos: [pago({ idSesion: 10, montoPagado: 100 })],
    });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({});
    expect(preview.sesiones[0].clasificacion).toBe('activa_sin_saldo');
    expect(preview.sesiones[0].saldoPendiente).toBe(0);
    expect(preview.sesiones[0].bloqueaCierre).toBe(false);
    expect(preview.resumenSesiones.activasSinSaldo).toBe(1);
    expect(preview.puedeCerrar).toBe(true);

    await service.cerrarCaja({});

    expect(db.cierre?.cerradoEl).not.toBeNull();
    // La sesión sigue abierta: el cierre no libera mesas.
    expect(db.sesiones[0].cerradaEl).toBeNull();
    expect(db.sesiones[0].mesa.estado).toBe(EstadoMesa.OCUPADA);
  });

  it('regla B: mesa OCUPADA con saldo > 0 permite cerrar y la sesión continúa', async () => {
    const db = crearDb({
      sesiones: [sesion({ idSesion: 10, idMesa: 2 })],
      consumos: [{ idSesion: 10, total: 150 }],
    });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({});
    expect(preview.sesiones[0].clasificacion).toBe('ocupada_con_saldo');
    expect(preview.sesiones[0].saldoPendiente).toBe(150);
    expect(preview.sesiones[0].bloqueaCierre).toBe(false);
    expect(preview.resumenSesiones.ocupadasConSaldo).toBe(1);
    expect(preview.puedeCerrar).toBe(true);

    await service.cerrarCaja({});

    expect(db.cierre?.cerradoEl).not.toBeNull();
    expect(db.sesiones[0].cerradaEl).toBeNull();
  });

  it('regla C: mesa CUENTA_SOLICITADA con saldo > 0 bloquea el cierre con 409 y no deja snapshot parcial', async () => {
    const db = crearDb({
      sesiones: [
        sesion({
          idSesion: 10,
          idMesa: 3,
          mesa: {
            idMesa: 3,
            nombreMesa: 'Mesa 3',
            estado: EstadoMesa.CUENTA_SOLICITADA,
          },
        }),
      ],
      consumos: [{ idSesion: 10, total: 80 }],
    });
    const { service, queryRunner } = await montarServicio(db);

    // El preview lo REPORTA, no lanza.
    const preview = await service.previsualizarCierre({});
    expect(preview.sesiones[0].clasificacion).toBe(
      'cuenta_solicitada_con_saldo',
    );
    expect(preview.sesiones[0].bloqueaCierre).toBe(true);
    expect(preview.resumenSesiones.cuentaSolicitadaConSaldo).toBe(1);
    expect(preview.puedeCerrar).toBe(false);

    // El cierre definitivo sí lanza.
    await expect(service.cerrarCaja({})).rejects.toThrow(ConflictException);
    await expect(service.cerrarCaja({})).rejects.toThrow(/Mesa 3/);

    // Nada quedó a medio escribir.
    expect(db.detallesCierre).toHaveLength(0);
    expect(db.cierre?.cerradoEl).toBeNull();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
    expect(escrituras).not.toContain('save:detalle');
    expect(escrituras).not.toContain('commit');
  });

  it('la mezcla de reglas se resume por separado y basta una C para bloquear', async () => {
    const db = crearDb({
      sesiones: [
        sesion({ idSesion: 10, idMesa: 1 }),
        sesion({ idSesion: 11, idMesa: 2 }),
        sesion({
          idSesion: 12,
          idMesa: 3,
          mesa: {
            idMesa: 3,
            nombreMesa: 'Mesa 3',
            estado: EstadoMesa.CUENTA_SOLICITADA,
          },
        }),
      ],
      consumos: [
        { idSesion: 10, total: 50 },
        { idSesion: 11, total: 70 },
        { idSesion: 12, total: 90 },
      ],
      pagos: [pago({ idSesion: 10, montoPagado: 50 })],
    });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({});

    expect(preview.resumenSesiones).toEqual({
      activasSinSaldo: 1,
      ocupadasConSaldo: 1,
      cuentaSolicitadaConSaldo: 1,
    });
    expect(preview.puedeCerrar).toBe(false);
  });

  it('un pago anulado hace reaparecer la deuda y puede convertir una A en C', async () => {
    const db = crearDb({
      sesiones: [
        sesion({
          idSesion: 10,
          idMesa: 3,
          mesa: {
            idMesa: 3,
            nombreMesa: 'Mesa 3',
            estado: EstadoMesa.CUENTA_SOLICITADA,
          },
        }),
      ],
      consumos: [{ idSesion: 10, total: 100 }],
      pagos: [pago({ idSesion: 10, montoPagado: 100, anuladoEl: new Date() })],
    });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({});

    expect(preview.sesiones[0].saldoPendiente).toBe(100);
    expect(preview.puedeCerrar).toBe(false);
  });

  // --- Revalidación del cierre definitivo ---

  it('preview que quedó stale: el cierre definitivo detecta el estado nuevo y bloquea', async () => {
    const db = crearDb({
      sesiones: [sesion({ idSesion: 10, idMesa: 3 })],
      consumos: [{ idSesion: 10, total: 90 }],
    });
    const { service } = await montarServicio(db);

    // Preview con la mesa OCUPADA: regla B, se puede cerrar.
    const preview = await service.previsualizarCierre({});
    expect(preview.puedeCerrar).toBe(true);

    // Entre el preview y el cierre, el cliente pide la cuenta.
    db.sesiones[0].mesa.estado = EstadoMesa.CUENTA_SOLICITADA;

    await expect(service.cerrarCaja({})).rejects.toThrow(ConflictException);
    expect(db.cierre?.cerradoEl).toBeNull();
    expect(db.detallesCierre).toHaveLength(0);
  });

  it('preview que quedó stale en montos: el cierre recalcula el esperado, no reusa el del preview', async () => {
    const db = crearDb({ pagos: [pago({ idPago: 1, montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({});
    expect(preview.totalEsperado).toBe(300);

    // Entra otro cobro después del preview.
    db.pagos.push(
      pago({
        idPago: 2,
        idMetodoPago: 2,
        montoPagado: 60,
        creadoEl: new Date('2026-03-01T11:30:00Z'),
      }),
    );

    const resumen = await service.cerrarCaja({});

    // El snapshot persistido refleja el estado REAL, no el del preview.
    expect(resumen.totalEsperado).toBe(360);
    const tarjeta = resumen.detalle.find((f) => f.idMetodoPago === 2);
    expect(tarjeta?.montoEsperado).toBe(60);
  });

  it('los pagos creados antes del cierre entran al snapshot persistido', async () => {
    const db = crearDb({
      pagos: [
        pago({ idPago: 1, idMetodoPago: 1, montoPagado: 100 }),
        pago({ idPago: 2, idMetodoPago: 2, montoPagado: 40 }),
        // Anulado: no debe contar.
        pago({
          idPago: 3,
          idMetodoPago: 1,
          montoPagado: 25,
          anuladoEl: new Date(),
        }),
        // Anterior a la apertura del turno: fuera de la ventana.
        pago({
          idPago: 4,
          idMetodoPago: 1,
          montoPagado: 999,
          creadoEl: new Date('2026-03-01T09:00:00Z'),
        }),
      ],
    });
    const { service } = await montarServicio(db);

    const resumen = await service.cerrarCaja({
      detalle: [{ idMetodoPago: 1, montoContado: 300 }],
    });

    expect(resumen.totalEsperado).toBe(340);
    expect(db.detallesCierre).toHaveLength(2);
    const efectivoPersistido = db.detallesCierre.find(
      (f) => f.idMetodoPago === 1,
    );
    expect(efectivoPersistido?.montoEsperado).toBe(300);
    expect(efectivoPersistido?.montoContado).toBe(300);
    // Método no contado: se persiste null, no 0.
    const tarjetaPersistida = db.detallesCierre.find(
      (f) => f.idMetodoPago === 2,
    );
    expect(tarjetaPersistida?.montoContado).toBeNull();
  });

  it('el cierre definitivo toma el lock y commitea en el orden esperado', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    await service.cerrarCaja({});

    expect(escrituras).toEqual([
      'lock:cierre',
      'save:detalle',
      'update:cerradoEl',
      'commit',
    ]);
  });

  it('rollback completo si falla algo después del lock', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service, queryRunner } = await montarServicio(db);

    // El método 'efectivo' desapareció durante el turno: falla ANTES de
    // escribir, y el rollback no deja el cierre a medio completar.
    db.metodos = [TARJETA];

    await expect(service.cerrarCaja({})).rejects.toThrow(/efectivo/);

    expect(db.detallesCierre).toHaveLength(0);
    expect(db.cierre?.cerradoEl).toBeNull();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    expect(queryRunner.release).toHaveBeenCalledTimes(1);
  });

  it('sin caja abierta el cierre definitivo sigue respondiendo 409', async () => {
    const db = crearDb();
    db.cierre = null;
    const { service } = await montarServicio(db);

    await expect(service.cerrarCaja({})).rejects.toThrow(ConflictException);
    expect(db.detallesCierre).toHaveLength(0);
  });

  // --- Sesiones que atraviesan turnos ---

  it('una sesión que viene del turno anterior aporta su saldo COMPLETO a las reglas, sin duplicar ingresos del turno', async () => {
    const db = crearDb({
      sesiones: [
        sesion({
          idSesion: 10,
          idMesa: 4,
          abiertaEl: new Date('2026-03-01T09:00:00Z'), // antes de abrir caja
        }),
      ],
      // Consumo total de la visita: 200 (parte del turno anterior).
      consumos: [{ idSesion: 10, total: 200 }],
      pagos: [
        // Pago del turno ANTERIOR: cuenta para el saldo de la visita, pero
        // está fuera de la ventana de este turno.
        pago({
          idPago: 1,
          idSesion: 10,
          montoPagado: 120,
          creadoEl: new Date('2026-03-01T09:30:00Z'),
        }),
      ],
    });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({});

    // Saldo de la VISITA: 200 - 120 = 80 → regla B.
    expect(preview.sesiones[0].saldoPendiente).toBe(80);
    expect(preview.sesiones[0].clasificacion).toBe('ocupada_con_saldo');

    // Pero el arqueo de ESTE turno no cuenta ese pago viejo: solo el fondo
    // inicial. El saldo de la sesión nunca se suma como ingreso.
    expect(preview.totalEsperado).toBe(200);
    expect(
      preview.detalle.find((f) => f.idMetodoPago === 1)?.montoEsperado,
    ).toBe(200);
  });

  // --- Observación de diferencia (Etapa 8) ---

  it('cierre con observación: se persiste tal cual y se devuelve en la respuesta', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const resumen = await service.cerrarCaja({
      observacionDiferencia: 'Faltan Bs 5; se revisó efectivo.',
    });

    expect(resumen.observacionDiferencia).toBe(
      'Faltan Bs 5; se revisó efectivo.',
    );
    expect(db.cierre?.observacionDiferencia).toBe(
      'Faltan Bs 5; se revisó efectivo.',
    );
  });

  it('espacios externos: se aplica trim tanto al persistir como al devolver', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const resumen = await service.cerrarCaja({
      observacionDiferencia: '   Sobran Bs 2   ',
    });

    expect(resumen.observacionDiferencia).toBe('Sobran Bs 2');
    expect(db.cierre?.observacionDiferencia).toBe('Sobran Bs 2');
  });

  it('vacío o solo espacios: se persiste y se devuelve null, no un string vacío', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const resumen = await service.cerrarCaja({
      observacionDiferencia: '   ',
    });

    expect(resumen.observacionDiferencia).toBeNull();
    expect(db.cierre?.observacionDiferencia).toBeNull();
  });

  it('cierre SIN observacionDiferencia en el body sigue funcionando: null, sin romper nada', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const resumen = await service.cerrarCaja({});

    expect(resumen.observacionDiferencia).toBeNull();
    expect(resumen.totalEsperado).toBe(300);
    expect(db.cierre?.cerradoEl).not.toBeNull();
  });

  it('el preview NO persiste la observación: solo la hace eco, normalizada, en la respuesta', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({
      observacionDiferencia: '  Faltan Bs 5  ',
    });

    expect(preview.observacionDiferencia).toBe('Faltan Bs 5');
    // Nada se escribió: mismos guardas que ya prueba "el preview no crea
    // CierreCajaDetalle..." — acá se confirma también para este campo.
    expect(db.cierre?.observacionDiferencia).toBeNull();
    expect(db.detallesCierre).toHaveLength(0);
    expect(escrituras).toEqual([]);
  });

  it('el preview con observación vacía hace eco de null (mismo criterio que el cierre)', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service } = await montarServicio(db);

    const preview = await service.previsualizarCierre({
      observacionDiferencia: '   ',
    });

    expect(preview.observacionDiferencia).toBeNull();
  });

  it('rollback del cierre no deja la observación persistida', async () => {
    const db = crearDb({ pagos: [pago({ montoPagado: 100 })] });
    const { service, queryRunner } = await montarServicio(db);

    // El método 'efectivo' desapareció: falla ANTES de escribir nada.
    db.metodos = [TARJETA];

    await expect(
      service.cerrarCaja({ observacionDiferencia: 'No debería quedar' }),
    ).rejects.toThrow(/efectivo/);

    expect(db.cierre?.observacionDiferencia).toBeNull();
    expect(db.cierre?.cerradoEl).toBeNull();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it('agregar la observación no altera el snapshot financiero (esperado/contado/diferencia)', async () => {
    const db = crearDb({
      pagos: [
        pago({ idPago: 1, idMetodoPago: 1, montoPagado: 100 }),
        pago({ idPago: 2, idMetodoPago: 2, montoPagado: 40 }),
      ],
    });
    const { service } = await montarServicio(db);

    const sinObservacion = await service.cerrarCaja({
      detalle: [
        { idMetodoPago: 1, montoContado: 295 },
        { idMetodoPago: 2, montoContado: 45 },
      ],
    });

    // Reset del turno para comparar en igualdad de condiciones.
    db.cierre = {
      idCierre: 2,
      idUsuario: 7,
      abiertoEl: ABIERTO_EL,
      cerradoEl: null,
      montoInicialEfectivo: 200,
      observacionDiferencia: null,
    };
    db.pagos = [
      pago({ idPago: 3, idMetodoPago: 1, montoPagado: 100 }),
      pago({ idPago: 4, idMetodoPago: 2, montoPagado: 40 }),
    ];

    const conObservacion = await service.cerrarCaja({
      detalle: [
        { idMetodoPago: 1, montoContado: 295 },
        { idMetodoPago: 2, montoContado: 45 },
      ],
      observacionDiferencia: 'Faltan Bs 5; se revisó efectivo.',
    });

    expect(conObservacion.totalEsperado).toBe(sinObservacion.totalEsperado);
    expect(conObservacion.totalContado).toBe(sinObservacion.totalContado);
    expect(conObservacion.detalle.map((f) => f.diferencia)).toEqual(
      sinObservacion.detalle.map((f) => f.diferencia),
    );
    expect(conObservacion.observacionDiferencia).toBe(
      'Faltan Bs 5; se revisó efectivo.',
    );
    expect(sinObservacion.observacionDiferencia).toBeNull();
  });
});
