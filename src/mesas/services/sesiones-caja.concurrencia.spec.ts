import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SesionesMesaService } from './sesiones-mesa.service';
import { CierresCajaService } from '../../caja/services/cierres-caja.service';
import { ConciliacionCajaService } from '../../caja/services/conciliacion-caja.service';
import { Mesa } from '../entities/mesa.entity';
import { SesionMesa } from '../entities/sesion-mesa.entity';
import { Pedido } from '../../pedidos/entities/pedido.entity';
import { DetallePedido } from '../../pedidos/entities/detalle-pedido.entity';
import { CierreCaja } from '../../caja/entities/cierre-caja.entity';
import { MetodoPago } from '../../pagos/entities/metodo-pago.entity';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
// Mismas primitivas que los otros dos tests de concurrencia del proyecto: una
// sola simulación de lock, no una por módulo.
import {
  cederElControl,
  crearCompuerta,
  crearLockDeFila,
} from '../../common/testing/concurrencia.harness';

/**
 * Sincronización de `PATCH /mesas/pedir-cuenta` con `PATCH /caja/cerrar`
 * (Etapa 7).
 *
 * ALCANCE REAL DE ESTOS TESTS — leer antes de confiar en ellos.
 *
 * Jest acá corre contra mocks, no contra Postgres: estos tests NO ejecutan
 * `SELECT ... FOR UPDATE` ni prueban que Postgres bloquee de verdad. Igual que
 * los tests hermanos de Pagos<->Caja y Pedidos<->Caja, MODELAN dos
 * comportamientos del motor de los que depende el diseño, y verifican que
 * nuestro código actúa bien DADOS esos comportamientos:
 *
 *   1. FOR UPDATE es excluyente: mientras una transacción retiene la fila de
 *      `cierres_caja`, cualquier otra que la pida espera hasta su
 *      commit/rollback (modelado en `crearLockDeFila`, en common/testing).
 *   2. EvalPlanQual (READ COMMITTED): al salir de la espera, Postgres reevalúa
 *      el WHERE contra la versión NUEVA de la fila y la descarta si dejó de
 *      cumplirlo. Modelado reevaluando `cerrado_el IS NULL` recién después de
 *      la espera, nunca antes.
 *
 * Lo que estos tests SÍ prueban de nuestro código: que pedirCuenta pide el
 * lock del cierre y lo sostiene hasta su commit/rollback; que cerrarCaja queda
 * detrás de él y, al avanzar, revalida y aplica la regla C; que en el orden
 * inverso pedirCuenta reevalúa, no encuentra caja abierta y sigue igual sin
 * tocar el snapshot ya persistido; y que sin caja abierta nada de esto cambia
 * el comportamiento del Cliente. La exclusión mutua en sí la garantiza
 * Postgres, no este archivo.
 */

const ABIERTO_EL = new Date('2026-04-01T10:00:00Z');

describe('Concurrencia pedirCuenta <-> cerrarCaja', () => {
  const EFECTIVO = {
    idMetodoPago: 1,
    nombreMetodo: 'Efectivo',
    codigo: 'efectivo',
  };

  interface OpcionesEntorno {
    /** Pausa pedirCuenta justo después de tomar el lock del cierre. */
    pausaCuentaTrasCaja?: ReturnType<typeof crearCompuerta>;
    /** Pausa cerrarCaja justo después de tomar el lock del cierre. */
    pausaCierreTrasLock?: ReturnType<typeof crearCompuerta>;
    /** Sin caja abierta desde el inicio. */
    sinCajaAbierta?: boolean;
    /** Consumo de la sesión (a precio congelado). 0 = sin deuda. */
    consumoSesion?: number;
  }

  const crearEntorno = (opciones: OpcionesEntorno = {}) => {
    const db = {
      cierre: opciones.sinCajaAbierta
        ? null
        : {
            idCierre: 1,
            idUsuario: 7,
            abiertoEl: ABIERTO_EL,
            cerradoEl: null as Date | null,
            montoInicialEfectivo: 200,
          },
      metodos: [EFECTIVO],
      mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.OCUPADA },
      sesion: {
        idSesion: 10,
        idMesa: 1,
        token: 'token-valido',
        abiertaEl: new Date('2026-04-01T10:30:00Z'),
        cerradaEl: null as Date | null,
      },
      cantidadPedidos: 1,
      consumoSesion: opciones.consumoSesion ?? 150,
      pagos: [] as Array<{ idSesion: number; montoPagado: number }>,
      detallesCierre: [] as Array<Record<string, unknown>>,
    };

    const lockCierre = crearLockDeFila();
    const avance = { cuentaPasoCaja: false, cierrePasoLock: false };

    const crearQueryRunner = (quien: 'cuenta' | 'cierre') => {
      // Escrituras no commiteadas: visibles solo dentro de esta transacción.
      const pendientes = {
        mesaEstado: undefined as EstadoMesa | undefined,
        cerradoEl: undefined as Date | undefined,
        detalles: [] as Array<Record<string, unknown>>,
      };
      let tieneLock = false;

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
              if (quien === 'cuenta') {
                avance.cuentaPasoCaja = true;
                await opciones.pausaCuentaTrasCaja?.esperar();
              }
              if (quien === 'cierre') {
                avance.cierrePasoLock = true;
                await opciones.pausaCierreTrasLock?.esperar();
              }
              // EvalPlanQual: `cerrado_el IS NULL` se reevalúa sobre la fila
              // vigente DESPUÉS de la espera. Si el cierre ya commiteó, la
              // fila deja de matchear y el SELECT devuelve null.
              return db.cierre && db.cierre.cerradoEl === null
                ? { ...db.cierre }
                : null;
            }

            if (entidad === SesionMesa) {
              return { ...db.sesion };
            }

            if (entidad === Mesa) {
              return {
                ...db.mesa,
                estado: pendientes.mesaEstado ?? db.mesa.estado,
              };
            }

            if (entidad === MetodoPago) {
              return db.metodos.find((m) => m.codigo === 'efectivo') ?? null;
            }

            return null;
          },
        ),

        count: jest.fn(() => Promise.resolve(db.cantidadPedidos)),

        find: jest.fn((entidad: unknown) => {
          if (entidad === MetodoPago) {
            return Promise.resolve(db.metodos.map((m) => ({ ...m })));
          }
          return Promise.resolve([]);
        }),

        create: jest.fn((_entidad: unknown, datos: unknown) => datos),

        save: jest.fn((filas: unknown) => {
          const lista = Array.isArray(filas) ? filas : [filas];
          pendientes.detalles.push(
            ...(lista as Array<Record<string, unknown>>),
          );
          return Promise.resolve(filas);
        }),

        update: jest.fn(
          (
            entidad: unknown,
            _criterio: unknown,
            valores: Record<string, unknown>,
          ) => {
            if (entidad === Mesa) {
              pendientes.mesaEstado = valores.estado as EstadoMesa;
            } else if (entidad === CierreCaja) {
              pendientes.cerradoEl = valores.cerradoEl as Date;
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

          // evaluarSesionesDelCierre: sesiones abiertas, con su mesa. Lee el
          // estado COMMITEADO (lo que otra transacción ya publicó), que es
          // justo el punto de estos tests.
          qb.getMany = jest.fn(() =>
            Promise.resolve(
              db.sesion.cerradaEl === null
                ? [{ ...db.sesion, mesa: { ...db.mesa } }]
                : [],
            ),
          );

          qb.getRawMany = jest.fn(() => {
            // Consumo de la sesión (calcularTotalAdeudadoPorSesiones).
            if (entidad === DetallePedido) {
              const ids = (parametros.idsSesion as number[]) ?? [];
              return Promise.resolve(
                ids.includes(db.sesion.idSesion) && db.consumoSesion > 0
                  ? [{ idSesion: db.sesion.idSesion, total: db.consumoSesion }]
                  : [],
              );
            }
            // Pagos: sin movimiento en estos tests.
            return Promise.resolve([]);
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
          if (pendientes.mesaEstado !== undefined) {
            db.mesa.estado = pendientes.mesaEstado;
          }
          if (pendientes.cerradoEl && db.cierre) {
            db.cierre.cerradoEl = pendientes.cerradoEl;
          }
          db.detallesCierre.push(...pendientes.detalles);
          soltarLock();
          return Promise.resolve();
        }),
        rollbackTransaction: jest.fn(() => {
          pendientes.mesaEstado = undefined;
          pendientes.cerradoEl = undefined;
          pendientes.detalles.length = 0;
          soltarLock();
          return Promise.resolve();
        }),
        release: jest.fn(),
        manager,
      };
    };

    const dataSourceCuenta = {
      createQueryRunner: jest.fn(() => crearQueryRunner('cuenta')),
    };
    const dataSourceCierre = {
      createQueryRunner: jest.fn(() => crearQueryRunner('cierre')),
    };

    return { db, lockCierre, avance, dataSourceCuenta, dataSourceCierre };
  };

  const montarServicios = async (entorno: ReturnType<typeof crearEntorno>) => {
    const moduloMesas: TestingModule = await Test.createTestingModule({
      providers: [
        SesionesMesaService,
        {
          provide: getRepositoryToken(Mesa),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(SesionMesa),
          useValue: {
            // Resolución del X-Table-Token, fuera de la transacción.
            findOne: jest.fn(() =>
              Promise.resolve(
                entorno.db.sesion.cerradaEl === null
                  ? { ...entorno.db.sesion, mesa: { ...entorno.db.mesa } }
                  : null,
              ),
            ),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        { provide: getRepositoryToken(Pedido), useValue: { count: jest.fn() } },
        { provide: DataSource, useValue: entorno.dataSourceCuenta },
      ],
    }).compile();

    const moduloCaja: TestingModule = await Test.createTestingModule({
      providers: [
        CierresCajaService,
        ConciliacionCajaService,
        {
          provide: getRepositoryToken(CierreCaja),
          useValue: { manager: {}, findOne: jest.fn() },
        },
        { provide: DataSource, useValue: entorno.dataSourceCierre },
      ],
    }).compile();

    return {
      sesiones: moduloMesas.get<SesionesMesaService>(SesionesMesaService),
      caja: moduloCaja.get<CierresCajaService>(CierresCajaService),
    };
  };

  // --- Desenlace 1: gana pedirCuenta ---

  it('gana pedirCuenta: el cierre espera el lock y, al avanzar, bloquea por la regla C', async () => {
    const pausaCuenta = crearCompuerta();
    const entorno = crearEntorno({ pausaCuentaTrasCaja: pausaCuenta });
    const { sesiones, caja } = await montarServicios(entorno);

    // 1. pedirCuenta arranca, toma el lock del cierre y queda pausado ahí.
    const cuenta = sesiones.pedirCuenta('token-valido');
    await cederElControl();
    expect(entorno.lockCierre.titular).toBe('cuenta');

    // 2. cerrarCaja arranca y queda BLOQUEADO pidiendo el mismo lock: todavía
    //    no llegó siquiera a evaluar las sesiones.
    const cierre = caja.cerrarCaja({});
    await cederElControl();
    expect(entorno.avance.cierrePasoLock).toBe(false);
    expect(entorno.db.cierre?.cerradoEl).toBeNull();

    // 3. Se libera pedirCuenta: commitea el cambio de estado y suelta el lock.
    pausaCuenta.abrir();
    const resultado = await cuenta;
    expect(resultado.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);
    expect(entorno.db.mesa.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);

    // 4. Recién ahora avanza el cierre: su revalidación ve la mesa en
    //    cuenta_solicitada CON saldo pendiente -> regla C -> 409.
    await expect(cierre).rejects.toThrow(ConflictException);
    await expect(cierre).rejects.toThrow(/cuenta/i);

    // La caja quedó ABIERTA y sin snapshot parcial.
    expect(entorno.db.cierre?.cerradoEl).toBeNull();
    expect(entorno.db.detallesCierre).toHaveLength(0);
    // El lock quedó libre después de los dos flujos.
    expect(entorno.lockCierre.titular).toBeNull();
  });

  it('gana pedirCuenta pero la sesión no debe nada: el cierre avanza igual (regla A, no C)', async () => {
    const pausaCuenta = crearCompuerta();
    const entorno = crearEntorno({
      pausaCuentaTrasCaja: pausaCuenta,
      consumoSesion: 0,
    });
    const { sesiones, caja } = await montarServicios(entorno);

    const cuenta = sesiones.pedirCuenta('token-valido');
    await cederElControl();
    const cierre = caja.cerrarCaja({});
    await cederElControl();

    pausaCuenta.abrir();
    await cuenta;
    expect(entorno.db.mesa.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);

    // Sin saldo pendiente no hay regla C que aplicar: el cierre se completa.
    const resumen = await cierre;
    expect(resumen.totalEsperado).toBe(200);
    expect(entorno.db.cierre?.cerradoEl).not.toBeNull();
  });

  // --- Desenlace 2: gana cerrarCaja ---

  it('gana cerrarCaja: pedirCuenta espera, reevalúa y continúa sin alterar el snapshot histórico', async () => {
    const pausaCierre = crearCompuerta();
    const entorno = crearEntorno({ pausaCierreTrasLock: pausaCierre });
    const { sesiones, caja } = await montarServicios(entorno);

    // 1. cerrarCaja arranca, toma el lock y queda pausado.
    const cierre = caja.cerrarCaja({});
    await cederElControl();
    expect(entorno.lockCierre.titular).toBe('cierre');

    // 2. pedirCuenta arranca y queda BLOQUEADO en el lock del cierre: no llegó
    //    a tocar la mesa.
    const cuenta = sesiones.pedirCuenta('token-valido');
    await cederElControl();
    expect(entorno.avance.cuentaPasoCaja).toBe(false);
    expect(entorno.db.mesa.estado).toBe(EstadoMesa.OCUPADA);

    // 3. El cierre termina: la mesa todavía estaba OCUPADA, así que fue regla
    //    B (advertencia, no bloqueo) y el turno se cierra.
    pausaCierre.abrir();
    const resumen = await cierre;
    expect(entorno.db.cierre?.cerradoEl).not.toBeNull();
    expect(entorno.db.detallesCierre).toHaveLength(1);
    const snapshot = { ...entorno.db.detallesCierre[0] };

    // 4. pedirCuenta reanuda: al reevaluar ya no hay caja abierta, así que
    //    sigue adelante sin lock y pide la cuenta en el turno siguiente.
    const resultado = await cuenta;
    expect(resultado.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);
    expect(entorno.db.mesa.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);

    // El cierre ya consolidado NO se tocó retroactivamente.
    expect(entorno.db.detallesCierre).toHaveLength(1);
    expect(entorno.db.detallesCierre[0]).toEqual(snapshot);
    expect(resumen.cerradoEl).toEqual(entorno.db.cierre?.cerradoEl);
  });

  // --- Sin caja abierta ---

  it('sin caja abierta, pedirCuenta conserva su comportamiento y no espera a nadie', async () => {
    const entorno = crearEntorno({ sinCajaAbierta: true });
    const { sesiones } = await montarServicios(entorno);

    const resultado = await sesiones.pedirCuenta('token-valido');

    expect(resultado.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);
    expect(entorno.db.mesa.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);
    // Nadie retiene el lock: no había fila de cierre que tomar.
    expect(entorno.lockCierre.titular).toBeNull();
  });

  // --- El lock se libera siempre ---

  it('si pedirCuenta falla con el lock tomado, lo libera y el cierre puede avanzar', async () => {
    const entorno = crearEntorno();
    // Sesión sin consumos: pedirCuenta corta con 409 DESPUÉS de tomar el lock.
    entorno.db.cantidadPedidos = 0;
    entorno.db.consumoSesion = 0;
    const { sesiones, caja } = await montarServicios(entorno);

    await expect(sesiones.pedirCuenta('token-valido')).rejects.toThrow(
      ConflictException,
    );
    expect(entorno.db.mesa.estado).toBe(EstadoMesa.OCUPADA);
    expect(entorno.lockCierre.titular).toBeNull();

    // El lock quedó realmente libre: el cierre posterior lo toma sin esperar.
    const resumen = await caja.cerrarCaja({});
    expect(resumen.totalEsperado).toBe(200);
    expect(entorno.db.cierre?.cerradoEl).not.toBeNull();
  });
});
