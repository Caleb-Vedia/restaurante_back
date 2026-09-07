import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PagosService } from './pagos.service';
import { CierresCajaService } from '../../caja/services/cierres-caja.service';
import { ConciliacionCajaService } from '../../caja/services/conciliacion-caja.service';
import { Pago } from '../entities/pago.entity';
import { MetodoPago } from '../entities/metodo-pago.entity';
import { CierreCaja } from '../../caja/entities/cierre-caja.entity';
import { CierreCajaDetalle } from '../../caja/entities/cierre-caja-detalle.entity';
import { Mesa } from '../../mesas/entities/mesa.entity';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { DetallePedido } from '../../pedidos/entities/detalle-pedido.entity';
import { MesasService } from '../../mesas/services/mesas.service';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
// Las tres primitivas de simulación (compuerta, cesión de control y lock de
// fila excluyente) viven en common/testing y las comparte el test equivalente
// de Pedidos <-> Caja: una sola simulación de lock para todo el proyecto.
import {
  cederElControl,
  crearCompuerta,
  crearLockDeFila,
} from '../../common/testing/concurrencia.harness';

/**
 * Sincronización de registrarPago y anularPago con cerrarCaja, y garantía
 * temporal de `Pago.creadoEl` respecto de la ventana del turno.
 *
 * ALCANCE REAL DE ESTOS TESTS — leer antes de confiar en ellos.
 *
 * Jest acá corre contra mocks, no contra Postgres: estos tests NO ejecutan
 * `SELECT ... FOR UPDATE` ni prueban que Postgres bloquee de verdad. Lo que
 * hacen es MODELAR tres comportamientos del motor de los que depende el
 * diseño, y verificar que nuestro código actúa bien DADOS esos comportamientos:
 *
 *   1. FOR UPDATE es excluyente: mientras una transacción retiene la fila de
 *      `cierres_caja`, cualquier otra que la pida espera hasta su
 *      commit/rollback (modelado en `crearLockDeFila`).
 *   2. EvalPlanQual (READ COMMITTED): cuando la espera termina porque la otra
 *      transacción actualizó la fila, Postgres reevalúa el WHERE contra la
 *      versión NUEVA y descarta la fila si dejó de cumplirlo. Modelado
 *      reevaluando la condición al salir de la espera, nunca antes.
 *   3. `DEFAULT now()` es `transaction_timestamp()`, o sea el instante en que
 *      arrancó la transacción y no el del INSERT (modelado con `inicioTx`).
 *
 * Lo que estos tests SÍ prueban de nuestro código: que el lock se pide, con el
 * modo correcto y en el orden correcto (CierreCaja antes que SesionMesa); que
 * se sostiene hasta commit/rollback; que el cobro se rechaza y la anulación da
 * 409 cuando la reevaluación encuentra el turno cerrado; que el arqueo suma
 * los pagos commiteados dentro de la ventana y excluye los anulados; y que el
 * `creadoEl` que persiste el servicio ya no es el del inicio de la
 * transacción. La exclusión mutua en sí la garantiza Postgres, no este archivo.
 */

interface FilaPago {
  idPago: number;
  idSesion: number;
  idMetodoPago: number;
  montoPagado: number;
  nroRecibo: string | null;
  anuladoEl: Date | null;
  creadoEl: Date;
}

describe('Concurrencia Pagos <-> Caja', () => {
  const ABIERTO_EL = new Date('2026-01-01T12:00:00Z');
  const EFECTIVO = {
    idMetodoPago: 1,
    nombreMetodo: 'Efectivo',
    codigo: 'efectivo',
  };
  const TARJETA = {
    idMetodoPago: 2,
    nombreMetodo: 'Tarjeta',
    codigo: null,
  };

  interface OpcionesEntorno {
    totalAdeudado?: number;
    pausaCobroTrasCaja?: ReturnType<typeof crearCompuerta>;
    pausaCierreTrasLock?: ReturnType<typeof crearCompuerta>;
    pausaAnulacionTrasCaja?: ReturnType<typeof crearCompuerta>;
    /** Modela el `transaction_timestamp()` de la transacción de cobro. */
    inicioTxCobro?: Date;
  }

  const crearEntorno = (opciones: OpcionesEntorno = {}) => {
    const db = {
      cierre: {
        idCierre: 1,
        idUsuario: 1,
        abiertoEl: ABIERTO_EL,
        cerradoEl: null as Date | null,
        montoInicialEfectivo: 200,
      },
      metodos: [EFECTIVO, TARJETA],
      // Solo lo COMMITEADO es visible para otras transacciones.
      pagos: [] as FilaPago[],
      detallesCierre: [] as CierreCajaDetalle[],
      sesion: { idSesion: 10, idMesa: 1, cerradaEl: null as Date | null },
      otraSesionActiva: null as { idSesion: number; idMesa: number } | null,
      mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.OCUPADA },
      totalAdeudado: opciones.totalAdeudado ?? 100,
      relojPagos: 0,
    };

    const lockCierre = crearLockDeFila();
    // Marca hasta dónde llegó cada flujo, para poder afirmar "quedó bloqueado".
    const avance = {
      cobroPasoCaja: false,
      cierrePasoLock: false,
      anulacionPasoCaja: false,
    };

    const crearQueryRunner = (quien: 'cobro' | 'cierre' | 'anulacion') => {
      // Escrituras no commiteadas: visibles solo dentro de esta transacción.
      const pendientes = {
        pagos: [] as FilaPago[],
        detalles: [] as CierreCajaDetalle[],
        cerradoEl: undefined as Date | undefined,
        anulados: new Map<number, Date>(),
        sesionCerradaEl: undefined as Date | null | undefined,
        mesaEstado: undefined as EstadoMesa | undefined,
      };
      let tieneLock = false;
      // Modela `transaction_timestamp()`: se fija al abrir la transacción, no
      // en cada statement. Los tests del límite inferior lo adelantan a un
      // instante ANTERIOR a la apertura de caja.
      const inicioTx = opciones.inicioTxCobro ?? new Date();

      // Un pago anulado dentro de esta transacción ya se ve anulado acá, pero
      // todavía no para las demás (eso llega recién con el commit).
      const pagosVisibles = (): FilaPago[] => [
        ...db.pagos.map((pago) => {
          const anuladoEl = pendientes.anulados.get(pago.idPago);
          return anuladoEl ? { ...pago, anuladoEl } : pago;
        }),
        ...pendientes.pagos,
      ];

      const sesionVisible = () => ({
        ...db.sesion,
        cerradaEl:
          pendientes.sesionCerradaEl !== undefined
            ? pendientes.sesionCerradaEl
            : db.sesion.cerradaEl,
      });

      const manager = {
        findOne: jest.fn(
          async (
            entidad: unknown,
            opts?: { where?: Record<string, unknown>; lock?: unknown },
          ) => {
            if (entidad === CierreCaja) {
              if (opts?.lock) {
                await lockCierre.adquirir(quien);
                tieneLock = true;
              }
              // EvalPlanQual: se reevalúa `cerrado_el IS NULL` sobre la fila
              // vigente DESPUÉS de la espera. Si otro cierre commiteó, la fila
              // ya no matchea y el SELECT no devuelve nada.
              if (quien === 'cierre') {
                avance.cierrePasoLock = true;
                await opciones.pausaCierreTrasLock?.esperar();
              }
              return db.cierre.cerradoEl === null ? { ...db.cierre } : null;
            }

            if (entidad === MetodoPago) {
              return db.metodos.find((m) => m.codigo === 'efectivo') ?? null;
            }

            if (entidad === Pago) {
              const where = opts?.where ?? {};
              return (
                pagosVisibles().find((p) => p.idPago === where.idPago) ?? null
              );
            }

            if (entidad === Mesa) {
              return { ...db.mesa };
            }

            if (entidad === SesionMesa) {
              if (quien === 'cobro' && !avance.cobroPasoCaja) {
                avance.cobroPasoCaja = true;
                await opciones.pausaCobroTrasCaja?.esperar();
              }
              const where = opts?.where ?? {};
              // "¿otra sesión activa en la misma mesa?" (idSesion viene como
              // Not(...) junto con cerradaEl IsNull()).
              if (
                where.idSesion !== undefined &&
                where.cerradaEl !== undefined
              ) {
                return db.otraSesionActiva ? { ...db.otraSesionActiva } : null;
              }
              if (where.idSesion !== undefined) {
                return sesionVisible();
              }
              const sesion = sesionVisible();
              return sesion.cerradaEl === null
                ? { ...sesion, mesa: db.mesa }
                : null;
            }

            return null;
          },
        ),

        find: jest.fn(async (entidad: unknown) => {
          await Promise.resolve();
          if (entidad === MetodoPago) return db.metodos.map((m) => ({ ...m }));
          if (entidad === Pago) {
            return pagosVisibles().map((pago) => ({
              ...pago,
              metodoPago:
                db.metodos.find((m) => m.idMetodoPago === pago.idMetodoPago) ??
                EFECTIVO,
            }));
          }
          return [];
        }),

        create: jest.fn((_entidad: unknown, datos: unknown) => datos),

        save: jest.fn(async (filas: unknown) => {
          await Promise.resolve();
          const lista: unknown[] = Array.isArray(filas)
            ? (filas as unknown[])
            : [filas];
          const guardadas: unknown[] = lista.map((fila) => {
            const registro = fila as Record<string, unknown>;
            if (registro.montoEsperado !== undefined) {
              pendientes.detalles.push(fila as CierreCajaDetalle);
              return fila;
            }
            // INSERT en pagos. Si el servicio provee `creadoEl`, ese valor
            // manda (es el arreglo de la Etapa 3B). Si no lo provee, se cae al
            // `DEFAULT now()` de la columna, que en Postgres es
            // `transaction_timestamp()`: el INICIO de la transacción, acá
            // modelado con el instante en que se abrió este queryRunner.
            const pago: FilaPago = {
              idPago: 1000 + ++db.relojPagos,
              idSesion: registro.idSesion as number,
              idMetodoPago: registro.idMetodoPago as number,
              montoPagado: registro.montoPagado as number,
              nroRecibo: (registro.nroRecibo as string | null) ?? null,
              anuladoEl: null,
              creadoEl: (registro.creadoEl as Date | undefined) ?? inicioTx,
            };
            pendientes.pagos.push(pago);
            return pago;
          });
          return Array.isArray(filas) ? guardadas : guardadas[0];
        }),

        update: jest.fn(
          async (
            entidad: unknown,
            criterio: Record<string, unknown>,
            valores: Record<string, unknown>,
          ) => {
            await Promise.resolve();
            if (entidad === CierreCaja) {
              pendientes.cerradoEl = valores.cerradoEl as Date;
            } else if (entidad === Pago) {
              pendientes.anulados.set(
                criterio.idPago as number,
                valores.anuladoEl as Date,
              );
            } else if (entidad === SesionMesa) {
              pendientes.sesionCerradaEl = valores.cerradaEl as Date | null;
            } else if (entidad === Mesa) {
              pendientes.mesaEstado = valores.estado as EstadoMesa;
            }
            return { affected: 1 };
          },
        ),

        createQueryBuilder: jest.fn((entidad: unknown) => {
          const parametros: Record<string, unknown> = {};
          const qb: Record<string, jest.Mock> = {};
          let pideLock = false;
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
          qb.setLock = jest.fn(() => {
            pideLock = true;
            return qb;
          });

          // Etapa 6: cerrarCaja revalida las sesiones abiertas (reglas A/B/C)
          // antes de escribir. En este archivo no hay ninguna sesión abierta
          // que evaluar —los tests son sobre la sincronización pagos<->caja—
          // así que devolver [] deja el cierre sin bloqueos y las aserciones
          // de arqueo intactas. Las reglas A/B/C tienen su propio spec
          // (cierre-caja-conciliacion.spec.ts).
          qb.getMany = jest.fn(() => Promise.resolve([]));

          // anularPago: ventana de turno que contiene a pago.creadoEl, con
          // FOR UPDATE. Devuelve el turno abierto O el cerrado que lo contenga.
          qb.getOne = jest.fn(async () => {
            if (pideLock) {
              await lockCierre.adquirir(quien);
              tieneLock = true;
            }
            if (quien === 'anulacion') {
              avance.anulacionPasoCaja = true;
              await opciones.pausaAnulacionTrasCaja?.esperar();
            }
            // EvalPlanQual: la condición se reevalúa sobre la fila vigente al
            // salir de la espera, no sobre la que había al pedirla.
            const creadoEl = parametros.creadoEl as Date;
            const dentro =
              db.cierre.abiertoEl <= creadoEl &&
              (db.cierre.cerradoEl === null || db.cierre.cerradoEl >= creadoEl);
            return dentro ? { ...db.cierre } : null;
          });

          qb.getRawOne = jest.fn(() => {
            if (entidad === DetallePedido) {
              return Promise.resolve({ total: db.totalAdeudado });
            }
            // calcularTotalPagado: pagos vigentes de la sesión.
            const total = pagosVisibles()
              .filter(
                (p) =>
                  p.idSesion === db.sesion.idSesion && p.anuladoEl === null,
              )
              .reduce((acc, p) => acc + p.montoPagado, 0);
            return Promise.resolve({ total });
          });

          // calcularDetalle: suma por método dentro de la ventana del turno.
          // Lee db.pagos (lo COMMITEADO) en el momento del statement, igual que
          // un snapshot nuevo de READ COMMITTED.
          qb.getRawMany = jest.fn(() => {
            const desde = parametros.desde as Date;
            const hasta = parametros.hasta as Date;
            const porMetodo = new Map<number, number>();
            for (const pago of pagosVisibles()) {
              if (pago.anuladoEl !== null) continue;
              if (pago.creadoEl < desde || pago.creadoEl > hasta) continue;
              porMetodo.set(
                pago.idMetodoPago,
                (porMetodo.get(pago.idMetodoPago) ?? 0) + pago.montoPagado,
              );
            }
            return Promise.resolve(
              [...porMetodo.entries()].map(([idMetodoPago, total]) => ({
                idMetodoPago,
                total,
              })),
            );
          });

          return qb;
        }),
      };

      const soltarLock = () => {
        if (tieneLock) {
          lockCierre.liberar(quien);
          tieneLock = false;
        }
      };

      return {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(() => {
          db.pagos.push(...pendientes.pagos);
          db.detallesCierre.push(...pendientes.detalles);
          if (pendientes.cerradoEl) db.cierre.cerradoEl = pendientes.cerradoEl;
          for (const [idPago, anuladoEl] of pendientes.anulados) {
            const fila = db.pagos.find((p) => p.idPago === idPago);
            if (fila) fila.anuladoEl = anuladoEl;
          }
          if (pendientes.sesionCerradaEl !== undefined) {
            db.sesion.cerradaEl = pendientes.sesionCerradaEl;
          }
          if (pendientes.mesaEstado !== undefined) {
            db.mesa.estado = pendientes.mesaEstado;
          }
          soltarLock();
          return Promise.resolve();
        }),
        rollbackTransaction: jest.fn(() => {
          pendientes.pagos.length = 0;
          pendientes.detalles.length = 0;
          pendientes.cerradoEl = undefined;
          pendientes.anulados.clear();
          pendientes.sesionCerradaEl = undefined;
          pendientes.mesaEstado = undefined;
          soltarLock();
          return Promise.resolve();
        }),
        release: jest.fn(),
        manager,
      };
    };

    const queryRunnersCobro: ReturnType<typeof crearQueryRunner>[] = [];
    const queryRunnersCierre: ReturnType<typeof crearQueryRunner>[] = [];

    // registrarPago y anularPago comparten el mismo PagosService (y su
    // DataSource), así que el test declara cuál de los dos va a invocar.
    let rolPagos: 'cobro' | 'anulacion' = 'cobro';

    const dataSourceCobro = {
      createQueryRunner: jest.fn(() => {
        const qr = crearQueryRunner(rolPagos);
        queryRunnersCobro.push(qr);
        return qr;
      }),
    };
    const dataSourceCierre = {
      createQueryRunner: jest.fn(() => {
        const qr = crearQueryRunner('cierre');
        queryRunnersCierre.push(qr);
        return qr;
      }),
    };

    const cerrarSesionActiva = jest.fn().mockResolvedValue({
      idMesa: 1,
      nombreMesa: 'Mesa 1',
      estado: EstadoMesa.LIBRE,
      sesionActiva: null,
    });

    return {
      db,
      lockCierre,
      avance,
      cerrarSesionActiva,
      queryRunnersCobro,
      queryRunnersCierre,
      dataSourceCobro,
      dataSourceCierre,
      usarRolPagos: (rol: 'cobro' | 'anulacion') => {
        rolPagos = rol;
      },
    };
  };

  const montarServicios = async (entorno: ReturnType<typeof crearEntorno>) => {
    const moduloPagos: TestingModule = await Test.createTestingModule({
      providers: [
        PagosService,
        {
          provide: getRepositoryToken(Pago),
          useValue: {
            manager: {},
            // Lectura preliminar de anularPago (sin lock, fuera de la
            // transacción): solo ubica la ventana de turno del pago.
            findOne: jest.fn(
              (opts: { where: { idPago: number } }): Promise<unknown> =>
                Promise.resolve(
                  entorno.db.pagos.find(
                    (p) => p.idPago === opts.where.idPago,
                  ) ?? null,
                ),
            ),
            update: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(SesionMesa),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: MesasService,
          useValue: {
            cerrarSesionActiva: entorno.cerrarSesionActiva,
            // Relectura del estado real de la mesa cuando la liberación falla.
            findOne: jest.fn().mockResolvedValue({
              ...entorno.db.mesa,
              sesionActiva: { idSesion: 10, abiertaEl: ABIERTO_EL },
            }),
          },
        },
        { provide: DataSource, useValue: entorno.dataSourceCobro },
      ],
    }).compile();

    const moduloCaja: TestingModule = await Test.createTestingModule({
      providers: [
        CierresCajaService,
        // Se provee la implementación REAL, no un mock: es la fuente única
        // del arqueo (Etapa 6) y no tiene dependencias propias, así que
        // sigue corriendo contra los mismos managers simulados de este
        // archivo. Mockearla haría que estos tests dejaran de verificar el
        // cálculo que efectivamente se persiste.
        ConciliacionCajaService,
        {
          provide: getRepositoryToken(CierreCaja),
          useValue: {
            manager: {},
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        { provide: DataSource, useValue: entorno.dataSourceCierre },
      ],
    }).compile();

    return {
      pagos: moduloPagos.get<PagosService>(PagosService),
      caja: moduloCaja.get<CierresCajaService>(CierresCajaService),
    };
  };

  // --- Registro normal (regresiones) ---

  it('con caja abierta el cobro sigue funcionando y pide el lock sobre el cierre', async () => {
    const entorno = crearEntorno();
    const { pagos } = await montarServicios(entorno);

    const resultado = await pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });

    expect(resultado.totalPagado).toBe(100);
    expect(resultado.mesaLiberada).toBe(true);
    expect(entorno.db.pagos).toHaveLength(1);

    const manager = entorno.queryRunnersCobro[0].manager;
    expect(manager.findOne).toHaveBeenCalledWith(
      CierreCaja,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    // El lock quedó liberado tras el commit.
    expect(entorno.lockCierre.titular).toBeNull();
  });

  it('el lock del cierre se toma ANTES que el de la sesión (orden global)', async () => {
    const entorno = crearEntorno();
    const { pagos } = await montarServicios(entorno);

    await pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });

    const llamadas = entorno.queryRunnersCobro[0].manager.findOne.mock.calls;
    const primerLock = llamadas.findIndex(
      (llamada) => llamada[0] === CierreCaja && llamada[1]?.lock,
    );
    const lockSesion = llamadas.findIndex(
      (llamada) => llamada[0] === SesionMesa && llamada[1]?.lock,
    );
    expect(primerLock).toBeGreaterThanOrEqual(0);
    expect(lockSesion).toBeGreaterThan(primerLock);
  });

  it('sin caja abierta el cobro se sigue rechazando con 409 y no inserta nada', async () => {
    const entorno = crearEntorno();
    entorno.db.cierre.cerradoEl = new Date('2026-01-01T20:00:00Z');
    const { pagos } = await montarServicios(entorno);

    await expect(
      pagos.registrarPago({
        idMesa: 1,
        pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
      }),
    ).rejects.toThrow(/No hay un cierre de caja abierto/);

    expect(entorno.db.pagos).toHaveLength(0);
  });

  // --- Interleaving: gana el cobro ---

  it('gana el cobro: el cierre espera el lock y el pago QUEDA en el snapshot del arqueo', async () => {
    const pausaCobro = crearCompuerta();
    const entorno = crearEntorno({ pausaCobroTrasCaja: pausaCobro });
    const { pagos, caja } = await montarServicios(entorno);

    // 1. El cobro arranca, toma el lock del cierre y queda pausado ahí.
    const cobro = pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });
    await cederElControl();
    expect(entorno.lockCierre.titular).toBe('cobro');

    // 2. El cierre arranca y queda BLOQUEADO pidiendo el mismo lock.
    const cierre = caja.cerrarCaja({});
    await cederElControl();
    expect(entorno.avance.cierrePasoLock).toBe(false);
    expect(entorno.db.cierre.cerradoEl).toBeNull();

    // 3. Se libera el cobro: commitea y suelta el lock.
    pausaCobro.abrir();
    const resultadoCobro = await cobro;
    expect(resultadoCobro.totalPagado).toBe(100);
    expect(entorno.db.pagos).toHaveLength(1);

    // 4. Recién ahora avanza el cierre, y su suma ve el pago commiteado.
    const resumen = await cierre;
    const filaEfectivo = resumen.detalle.find((f) => f.idMetodoPago === 1);
    // fondo inicial 200 + los 100 recién cobrados
    expect(filaEfectivo?.montoEsperado).toBe(300);
    expect(resumen.totalEsperado).toBe(300);
    expect(entorno.db.cierre.cerradoEl).not.toBeNull();
    // El pago cae dentro de la ventana [abiertoEl, cerradoEl] del turno.
    expect(entorno.db.pagos[0].creadoEl >= entorno.db.cierre.abiertoEl).toBe(
      true,
    );
    expect(entorno.db.pagos[0].creadoEl <= resumen.cerradoEl).toBe(true);
  });

  // --- Interleaving: gana el cierre ---

  it('gana el cierre: el cobro espera, reevalúa y se rechaza sin insertar el pago', async () => {
    const pausaCierre = crearCompuerta();
    const entorno = crearEntorno({ pausaCierreTrasLock: pausaCierre });
    const { pagos, caja } = await montarServicios(entorno);

    // 1. El cierre arranca, toma el lock y queda pausado.
    const cierre = caja.cerrarCaja({});
    await cederElControl();
    expect(entorno.lockCierre.titular).toBe('cierre');

    // 2. El cobro arranca y queda BLOQUEADO en el lock del cierre: no llegó
    //    siquiera a mirar la sesión.
    const cobro = pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });
    await cederElControl();
    expect(entorno.avance.cobroPasoCaja).toBe(false);

    // 3. El cierre termina y commitea cerradoEl.
    pausaCierre.abrir();
    const resumen = await cierre;
    expect(entorno.db.cierre.cerradoEl).not.toBeNull();
    // Arqueo sin movimiento: solo el fondo inicial en efectivo.
    expect(resumen.totalEsperado).toBe(200);

    // 4. El cobro reanuda, reevalúa la fila y ya no encuentra caja abierta.
    await expect(cobro).rejects.toThrow(/No hay un cierre de caja abierto/);
    expect(entorno.db.pagos).toHaveLength(0);
  });

  // --- Rollback con el lock tomado ---

  it('si el cobro falla con el lock tomado: rollback, caja sigue abierta y el lock se libera', async () => {
    const entorno = crearEntorno();
    const { pagos, caja } = await montarServicios(entorno);

    // Monto que no cubre el total exacto -> 409 después de tomar el lock.
    await expect(
      pagos.registrarPago({
        idMesa: 1,
        pagos: [{ idMetodoPago: 1, montoPagado: 40 }],
      }),
    ).rejects.toThrow(ConflictException);

    expect(entorno.db.pagos).toHaveLength(0);
    expect(entorno.db.cierre.cerradoEl).toBeNull();
    expect(entorno.lockCierre.titular).toBeNull();
    expect(
      entorno.queryRunnersCobro[0].rollbackTransaction,
    ).toHaveBeenCalledTimes(1);

    // El lock quedó realmente libre: un cierre posterior puede tomarlo.
    const resumen = await caja.cerrarCaja({});
    expect(resumen.totalEsperado).toBe(200);
  });

  // --- Regresiones de cobro ---

  it('cobro dividido en dos métodos sigue funcionando y el arqueo los separa', async () => {
    const entorno = crearEntorno();
    const { pagos, caja } = await montarServicios(entorno);

    const resultado = await pagos.registrarPago({
      idMesa: 1,
      pagos: [
        { idMetodoPago: 1, montoPagado: 60 },
        { idMetodoPago: 2, montoPagado: 40 },
      ],
    });

    expect(resultado.totalPagado).toBe(100);
    expect(entorno.db.pagos).toHaveLength(2);

    const resumen = await caja.cerrarCaja({});
    expect(
      resumen.detalle.find((f) => f.idMetodoPago === 1)?.montoEsperado,
    ).toBe(260);
    expect(
      resumen.detalle.find((f) => f.idMetodoPago === 2)?.montoEsperado,
    ).toBe(40);
    expect(resumen.totalEsperado).toBe(300);
  });

  it('la liberación de mesa post-cobro conserva su comportamiento (fuera de la transacción)', async () => {
    const entorno = crearEntorno();
    entorno.cerrarSesionActiva.mockRejectedValue(
      new ConflictException('No se puede liberar la mesa'),
    );
    const { pagos } = await montarServicios(entorno);

    const resultado = await pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });

    // El cobro ya commiteó: no se revierte porque falle la liberación.
    expect(resultado.mesaLiberada).toBe(false);
    expect(entorno.db.pagos).toHaveLength(1);
    expect(entorno.lockCierre.titular).toBeNull();
  });

  // --- Snapshot del cierre ---

  // --- Etapa 3B, problema 1: anularPago <-> cerrarCaja ---

  it('gana la anulación: el cierre espera el lock y su snapshot ya excluye el pago anulado', async () => {
    const pausaAnulacion = crearCompuerta();
    const entorno = crearEntorno({ pausaAnulacionTrasCaja: pausaAnulacion });
    const { pagos, caja } = await montarServicios(entorno);

    await pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });
    const idPago = entorno.db.pagos[0].idPago;

    // 1. La anulación arranca, toma el lock del turno y queda pausada ahí.
    entorno.usarRolPagos('anulacion');
    const anulacion = pagos.anularPago(idPago);
    await cederElControl();
    expect(entorno.lockCierre.titular).toBe('anulacion');

    // 2. El cierre queda BLOQUEADO: no puede cerrar por debajo de la anulación.
    const cierre = caja.cerrarCaja({});
    await cederElControl();
    expect(entorno.avance.cierrePasoLock).toBe(false);
    expect(entorno.db.cierre.cerradoEl).toBeNull();

    // 3. Se libera la anulación: commitea y suelta el lock.
    pausaAnulacion.abrir();
    const anulado = await anulacion;
    expect(anulado.anuladoEl).not.toBeNull();
    expect(entorno.db.pagos[0].anuladoEl).not.toBeNull();

    // 4. El cierre avanza y su snapshot NO cuenta el pago anulado.
    const resumen = await cierre;
    expect(
      resumen.detalle.find((f) => f.idMetodoPago === 1)?.montoEsperado,
    ).toBe(200);
    expect(resumen.totalEsperado).toBe(200);
  });

  it('gana el cierre: la anulación espera, reevalúa y devuelve 409 dejando el pago vigente', async () => {
    const pausaCierre = crearCompuerta();
    const entorno = crearEntorno({ pausaCierreTrasLock: pausaCierre });
    const { pagos, caja } = await montarServicios(entorno);

    await pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });
    const idPago = entorno.db.pagos[0].idPago;

    // 1. El cierre toma el lock y queda pausado.
    const cierre = caja.cerrarCaja({});
    await cederElControl();
    expect(entorno.lockCierre.titular).toBe('cierre');

    // 2. La anulación queda BLOQUEADA pidiendo el mismo lock.
    entorno.usarRolPagos('anulacion');
    const anulacion = pagos.anularPago(idPago);
    await cederElControl();
    expect(entorno.avance.anulacionPasoCaja).toBe(false);

    // 3. El cierre commitea: el pago pasa a ser histórico.
    pausaCierre.abrir();
    const resumen = await cierre;
    expect(resumen.totalEsperado).toBe(300);

    // 4. La anulación reevalúa la ventana, ahora cerrada, y se rechaza.
    await expect(anulacion).rejects.toThrow(/turno de caja ya cerrado/);
    expect(entorno.db.pagos[0].anuladoEl).toBeNull();
    // El snapshot histórico no se tocó.
    expect(entorno.db.detallesCierre).toHaveLength(2);
  });

  // --- Etapa 3B, problema 2: límite inferior creadoEl >= abiertoEl ---

  it('cobro cuya transacción arrancó ANTES de la apertura: creadoEl queda >= abiertoEl', async () => {
    // transaction_timestamp() de la tx de cobro: una hora antes de abrir caja.
    const inicioTxCobro = new Date(ABIERTO_EL.getTime() - 3_600_000);
    const entorno = crearEntorno({ inicioTxCobro });
    const { pagos } = await montarServicios(entorno);

    await pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });

    const pago = entorno.db.pagos[0];
    // Antes de la Etapa 3B, creadoEl era exactamente inicioTxCobro y caía
    // fuera de la ventana del turno.
    expect(pago.creadoEl.getTime()).not.toBe(inicioTxCobro.getTime());
    expect(pago.creadoEl.getTime()).toBeGreaterThanOrEqual(
      entorno.db.cierre.abiertoEl.getTime(),
    );
  });

  it('ese mismo pago entra al snapshot cuando después se cierra la caja', async () => {
    const entorno = crearEntorno({
      inicioTxCobro: new Date(ABIERTO_EL.getTime() - 3_600_000),
    });
    const { pagos, caja } = await montarServicios(entorno);

    await pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });

    const resumen = await caja.cerrarCaja({});
    expect(
      resumen.detalle.find((f) => f.idMetodoPago === 1)?.montoEsperado,
    ).toBe(300);
    const pago = entorno.db.pagos[0];
    expect(pago.creadoEl >= entorno.db.cierre.abiertoEl).toBe(true);
    expect(pago.creadoEl <= resumen.cerradoEl).toBe(true);
  });

  it('cobro dividido: todos los pagos comparten el mismo creadoEl dentro de la ventana', async () => {
    const entorno = crearEntorno({
      inicioTxCobro: new Date(ABIERTO_EL.getTime() - 3_600_000),
    });
    const { pagos, caja } = await montarServicios(entorno);

    await pagos.registrarPago({
      idMesa: 1,
      pagos: [
        { idMetodoPago: 1, montoPagado: 60 },
        { idMetodoPago: 2, montoPagado: 40 },
      ],
    });

    const [uno, dos] = entorno.db.pagos;
    // Un cobro dividido es UNA operación: mismo instante para ambos pagos.
    expect(uno.creadoEl.getTime()).toBe(dos.creadoEl.getTime());

    const resumen = await caja.cerrarCaja({});
    for (const pago of entorno.db.pagos) {
      expect(pago.creadoEl >= entorno.db.cierre.abiertoEl).toBe(true);
      expect(pago.creadoEl <= resumen.cerradoEl).toBe(true);
    }
    expect(resumen.totalEsperado).toBe(300);
  });

  it('cerrarCaja conserva su snapshot: una fila por método y montoContado/diferencia', async () => {
    const entorno = crearEntorno();
    const { pagos, caja } = await montarServicios(entorno);

    await pagos.registrarPago({
      idMesa: 1,
      pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
    });

    const resumen = await caja.cerrarCaja({
      detalle: [{ idMetodoPago: 1, montoContado: 290 }],
    });

    expect(resumen.detalle).toHaveLength(2);
    const efectivo = resumen.detalle.find((f) => f.idMetodoPago === 1);
    expect(efectivo?.montoEsperado).toBe(300);
    expect(efectivo?.montoContado).toBe(290);
    expect(efectivo?.diferencia).toBe(-10);
    const tarjeta = resumen.detalle.find((f) => f.idMetodoPago === 2);
    expect(tarjeta?.montoEsperado).toBe(0);
    expect(tarjeta?.montoContado).toBeNull();
    expect(tarjeta?.diferencia).toBeNull();
    expect(resumen.totalContado).toBe(290);
    // Las filas de detalle quedaron persistidas por el commit.
    expect(entorno.db.detallesCierre).toHaveLength(2);
  });
});
