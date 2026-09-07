import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PedidosService } from './pedidos.service';
import { CierresCajaService } from '../../caja/services/cierres-caja.service';
import { ConciliacionCajaService } from '../../caja/services/conciliacion-caja.service';
import { Pedido } from '../entities/pedido.entity';
import { Producto } from '../../productos/entities/producto.entity';
import { AreaProducto } from '../../productos/entities/area-producto.entity';
import { CierreCaja } from '../../caja/entities/cierre-caja.entity';
import { MetodoPago } from '../../pagos/entities/metodo-pago.entity';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { Mesa } from '../../mesas/entities/mesa.entity';
import { SesionesMesaService } from '../../mesas/services/sesiones-mesa.service';
import { MesasService } from '../../mesas/services/mesas.service';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { EstadoPedido } from '../../common/enums/estado-pedido.enum';
// Mismas primitivas que usa el test de Pagos <-> Caja: una sola simulación de
// lock en todo el proyecto, no una por módulo.
import {
  cederElControl,
  crearCompuerta,
  crearLockDeFila,
} from '../../common/testing/concurrencia.harness';

/**
 * Regla de la Etapa 4A: no se pueden crear pedidos sin una Caja abierta, y esa
 * validación se sincroniza con `cerrarCaja` sobre la MISMA fila de
 * `cierres_caja`.
 *
 * ALCANCE REAL DE ESTOS TESTS — leer antes de confiar en ellos.
 *
 * Jest acá corre contra mocks, no contra Postgres: estos tests NO ejecutan
 * `SELECT ... FOR UPDATE` ni prueban que Postgres bloquee de verdad. Igual que
 * el test hermano de Pagos <-> Caja, MODELAN dos comportamientos del motor de
 * los que depende el diseño y verifican que nuestro código actúa bien DADOS
 * esos comportamientos:
 *
 *   1. FOR UPDATE es excluyente: mientras una transacción retiene la fila de
 *      `cierres_caja`, cualquier otra que la pida espera hasta su
 *      commit/rollback (modelado en `crearLockDeFila`, en common/testing).
 *   2. EvalPlanQual (READ COMMITTED): al salir de la espera, Postgres reevalúa
 *      el WHERE contra la versión NUEVA de la fila y la descarta si dejó de
 *      cumplirlo. Modelado reevaluando `cerrado_el IS NULL` recién después de
 *      la espera, nunca antes.
 *
 * Lo que estos tests SÍ prueban de nuestro código: que crearPedido pide el
 * lock, con el modo correcto y ANTES que el de SesionMesa; que lo sostiene
 * hasta commit/rollback; que responde 409 con el mensaje acordado y sin
 * escribir nada cuando la reevaluación no encuentra caja abierta; que un
 * pedido ya commiteado sobrevive al cierre posterior; y que encontrar la caja
 * cerrada no toca la sesión ni la mesa. La exclusión mutua en sí la garantiza
 * Postgres, no este archivo.
 */

const MENSAJE_CAJA_CERRADA =
  'No se pueden registrar pedidos en este momento porque Caja está cerrada.';

interface FilaPedido {
  idPedido: number;
  idSesion: number;
  nombreComensal: string | null;
  nroOrden: number;
  estado: EstadoPedido;
  creadoEl: Date;
}

interface FilaDetalle {
  idDetalle: number;
  idPedido: number;
  idProducto: number;
  cantidad: number;
  precioActual: number;
  observacion: string | null;
}

describe('Concurrencia Pedidos <-> Caja', () => {
  const ABIERTO_EL = new Date('2026-01-01T12:00:00Z');
  const TOKEN = 'token-valido';

  const AREA_COCINA = {
    idAreaProducto: 1,
    nombreArea: 'Cocina',
    codigo: 'cocina',
  };
  const HAMBURGUESA = {
    idProducto: 7,
    nombreProducto: 'Hamburguesa',
    precio: 50,
    disponible: true,
    idAreaProducto: 1,
    areaProducto: AREA_COCINA,
  };
  const PAPAS = {
    idProducto: 8,
    nombreProducto: 'Papas fritas',
    precio: 20,
    disponible: true,
    idAreaProducto: 1,
    areaProducto: AREA_COCINA,
  };
  const EFECTIVO = {
    idMetodoPago: 1,
    nombreMetodo: 'Efectivo',
    codigo: 'efectivo',
  };

  interface OpcionesEntorno {
    pausaPedidoTrasCaja?: ReturnType<typeof crearCompuerta>;
    pausaCierreTrasLock?: ReturnType<typeof crearCompuerta>;
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
      metodos: [EFECTIVO],
      sesion: {
        idSesion: 10,
        idMesa: 1,
        token: TOKEN,
        abiertaEl: ABIERTO_EL,
        cerradaEl: null as Date | null,
      },
      mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.OCUPADA },
      // Solo lo COMMITEADO es visible para otras transacciones.
      pedidos: [] as FilaPedido[],
      detalles: [] as FilaDetalle[],
      productos: [HAMBURGUESA, PAPAS],
      relojPedidos: 0,
      relojDetalles: 0,
    };

    const lockCierre = crearLockDeFila();
    // Marca hasta dónde llegó cada flujo, para poder afirmar "quedó bloqueado".
    const avance = { pedidoPasoCaja: false, cierrePasoLock: false };

    const crearQueryRunner = (quien: 'pedido' | 'cierre') => {
      // Escrituras no commiteadas: visibles solo dentro de esta transacción.
      const pendientes = {
        pedidos: [] as FilaPedido[],
        detalles: [] as FilaDetalle[],
        detallesCierre: [] as Record<string, unknown>[],
        cerradoEl: undefined as Date | undefined,
      };
      let tieneLock = false;
      let sesionYaConsultada = false;

      const pedidosVisibles = (): FilaPedido[] => [
        ...db.pedidos,
        ...pendientes.pedidos,
      ];
      const detallesVisibles = (): FilaDetalle[] => [
        ...db.detalles,
        ...pendientes.detalles,
      ];

      const armarPedidoConDetalles = (idPedido: number) => {
        const pedido = pedidosVisibles().find((p) => p.idPedido === idPedido);
        if (!pedido) return null;
        return {
          ...pedido,
          detallesPedido: detallesVisibles()
            .filter((detalle) => detalle.idPedido === idPedido)
            .map((detalle) => ({
              ...detalle,
              producto: db.productos.find(
                (producto) => producto.idProducto === detalle.idProducto,
              ),
            })),
        };
      };

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
              // EvalPlanQual: `cerrado_el IS NULL` se reevalúa sobre la fila
              // vigente DESPUÉS de la espera. Si otro cierre commiteó mientras
              // tanto, la fila ya no matchea y el SELECT no devuelve nada.
              if (quien === 'cierre') {
                avance.cierrePasoLock = true;
                await opciones.pausaCierreTrasLock?.esperar();
              }
              return db.cierre.cerradoEl === null ? { ...db.cierre } : null;
            }

            if (entidad === MetodoPago) {
              return db.metodos.find((m) => m.codigo === 'efectivo') ?? null;
            }

            if (entidad === SesionMesa) {
              // Punto de pausa del pedido: ya tiene el lock de caja tomado.
              if (quien === 'pedido' && !sesionYaConsultada) {
                sesionYaConsultada = true;
                avance.pedidoPasoCaja = true;
                await opciones.pausaPedidoTrasCaja?.esperar();
              }
              return { ...db.sesion };
            }

            if (entidad === Pedido) {
              const idPedido = opts?.where?.idPedido as number;
              return armarPedidoConDetalles(idPedido);
            }

            if (entidad === Mesa) {
              return { ...db.mesa };
            }

            return null;
          },
        ),

        find: jest.fn(async (entidad: unknown) => {
          await Promise.resolve();
          if (entidad === MetodoPago) return db.metodos.map((m) => ({ ...m }));
          return [];
        }),

        create: jest.fn((_entidad: unknown, datos: unknown) => datos),

        save: jest.fn(async (filas: unknown) => {
          await Promise.resolve();
          const lista: unknown[] = Array.isArray(filas)
            ? (filas as unknown[])
            : [filas];
          const guardadas = lista.map((fila) => {
            const registro = fila as Record<string, unknown>;

            // INSERT en cierres_caja_detalle (arqueo del turno).
            if (registro.montoEsperado !== undefined) {
              pendientes.detallesCierre.push(registro);
              return fila;
            }

            // INSERT en pedidos. `estado` y `creado_el` los pone la base con
            // sus DEFAULT ('pendiente' y now()): el servicio no los manda, y
            // este mock modela exactamente eso.
            if (registro.nroOrden !== undefined) {
              const pedido: FilaPedido = {
                idPedido: 100 + ++db.relojPedidos,
                idSesion: registro.idSesion as number,
                nombreComensal:
                  (registro.nombreComensal as string | null) ?? null,
                nroOrden: registro.nroOrden as number,
                estado:
                  (registro.estado as EstadoPedido | undefined) ??
                  EstadoPedido.PENDIENTE,
                creadoEl: (registro.creadoEl as Date | undefined) ?? new Date(),
              };
              pendientes.pedidos.push(pedido);
              return pedido;
            }

            // INSERT en detalles_pedidos.
            const detalle: FilaDetalle = {
              idDetalle: 500 + ++db.relojDetalles,
              idPedido: registro.idPedido as number,
              idProducto: registro.idProducto as number,
              cantidad: registro.cantidad as number,
              precioActual: registro.precioActual as number,
              observacion: (registro.observacion as string | null) ?? null,
            };
            pendientes.detalles.push(detalle);
            return detalle;
          });
          return Array.isArray(filas) ? guardadas : guardadas[0];
        }),

        update: jest.fn(
          async (
            entidad: unknown,
            _criterio: Record<string, unknown>,
            valores: Record<string, unknown>,
          ) => {
            await Promise.resolve();
            if (entidad === CierreCaja) {
              pendientes.cerradoEl = valores.cerradoEl as Date;
            }
            return { affected: 1 };
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
            'setLock',
          ]) {
            qb[metodo] = jest.fn((_cond: unknown, params?: object) => {
              if (params) Object.assign(parametros, params);
              return qb;
            });
          }

          // Etapa 6: cerrarCaja revalida las sesiones abiertas (reglas A/B/C)
          // antes de escribir. Este archivo prueba la carrera pedido<->cierre,
          // no esas reglas, y su sesión de prueba no tiene consumo pendiente:
          // devolver [] deja el cierre sin bloqueos. Las reglas A/B/C tienen
          // su propio spec (caja/services/cierre-caja-conciliacion.spec.ts).
          qb.getMany = jest.fn(() => Promise.resolve([]));

          // siguienteNroOrden: MAX(nro_orden) de los pedidos de la sesión.
          qb.getRawOne = jest.fn(() => {
            if (entidad === Pedido) {
              const idSesion = parametros.idSesion as number;
              const nros = pedidosVisibles()
                .filter((pedido) => pedido.idSesion === idSesion)
                .map((pedido) => pedido.nroOrden);
              return Promise.resolve({
                max: nros.length > 0 ? Math.max(...nros) : null,
              });
            }
            return Promise.resolve({ total: 0 });
          });

          // calcularDetalle del cierre: sin pagos en estos tests, el arqueo
          // solo refleja el fondo inicial.
          qb.getRawMany = jest.fn(() => Promise.resolve([]));

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
          db.pedidos.push(...pendientes.pedidos);
          db.detalles.push(...pendientes.detalles);
          if (pendientes.cerradoEl) db.cierre.cerradoEl = pendientes.cerradoEl;
          soltarLock();
          return Promise.resolve();
        }),
        rollbackTransaction: jest.fn(() => {
          pendientes.pedidos.length = 0;
          pendientes.detalles.length = 0;
          pendientes.detallesCierre.length = 0;
          pendientes.cerradoEl = undefined;
          soltarLock();
          return Promise.resolve();
        }),
        release: jest.fn(),
        manager,
      };
    };

    const queryRunnersPedido: ReturnType<typeof crearQueryRunner>[] = [];
    const queryRunnersCierre: ReturnType<typeof crearQueryRunner>[] = [];

    const dataSourcePedidos = {
      createQueryRunner: jest.fn(() => {
        const qr = crearQueryRunner('pedido');
        queryRunnersPedido.push(qr);
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

    // Resolución del X-Table-Token: la hace SesionesMesaService fuera de la
    // transacción, tal cual en producción.
    const obtenerSesionActivaPorToken = jest.fn((token: string) => {
      if (token !== TOKEN || db.sesion.cerradaEl !== null) {
        return Promise.reject(
          new UnauthorizedException('Sesión no encontrada o inválida'),
        );
      }
      return Promise.resolve({ ...db.sesion, mesa: { ...db.mesa } });
    });

    return {
      db,
      lockCierre,
      avance,
      obtenerSesionActivaPorToken,
      queryRunnersPedido,
      queryRunnersCierre,
      dataSourcePedidos,
      dataSourceCierre,
    };
  };

  const montarServicios = async (entorno: ReturnType<typeof crearEntorno>) => {
    const moduloPedidos: TestingModule = await Test.createTestingModule({
      providers: [
        PedidosService,
        {
          provide: getRepositoryToken(Pedido),
          useValue: { manager: {} },
        },
        {
          provide: getRepositoryToken(Producto),
          useValue: {
            // Validación de productos: ocurre ANTES de abrir la transacción.
            find: jest.fn(() =>
              Promise.resolve(entorno.db.productos.map((p) => ({ ...p }))),
            ),
          },
        },
        {
          provide: getRepositoryToken(AreaProducto),
          useValue: { findOne: jest.fn() },
        },
        {
          provide: SesionesMesaService,
          useValue: {
            obtenerSesionActivaPorToken: entorno.obtenerSesionActivaPorToken,
          },
        },
        // No lo usa ningún test de este archivo (son todos sobre
        // crearPedido): solo hace falta para que Nest resuelva el
        // constructor de PedidosService, que ahora también depende de
        // MesasService (obtenerConsumoActualDeMesa, Etapa 5A).
        { provide: MesasService, useValue: { findOne: jest.fn() } },
        { provide: DataSource, useValue: entorno.dataSourcePedidos },
      ],
    }).compile();

    const moduloCaja: TestingModule = await Test.createTestingModule({
      providers: [
        CierresCajaService,
        // Implementación REAL, no un mock: es la fuente única del arqueo
        // (Etapa 6) y no tiene dependencias propias, así que corre contra
        // los mismos managers simulados de este archivo.
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
      pedidos: moduloPedidos.get<PedidosService>(PedidosService),
      caja: moduloCaja.get<CierresCajaService>(CierresCajaService),
    };
  };

  const unItem = [{ idProducto: HAMBURGUESA.idProducto, cantidad: 1 }];

  // --- Regla básica ---

  it('con caja abierta el pedido se crea igual que antes y pide el lock sobre el cierre', async () => {
    const entorno = crearEntorno();
    const { pedidos } = await montarServicios(entorno);

    const respuesta = await pedidos.crearPedido(TOKEN, {
      nombreComensal: 'Juan',
      items: unItem,
    });

    expect(respuesta.nroOrden).toBe(1);
    expect(respuesta.estado).toBe(EstadoPedido.PENDIENTE);
    expect(respuesta.detalles).toHaveLength(1);
    expect(entorno.db.pedidos).toHaveLength(1);
    expect(entorno.db.detalles).toHaveLength(1);

    const manager = entorno.queryRunnersPedido[0].manager;
    expect(manager.findOne).toHaveBeenCalledWith(
      CierreCaja,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    // El lock quedó liberado tras el commit.
    expect(entorno.lockCierre.titular).toBeNull();
  });

  it('sin caja abierta: 409 con el mensaje de Caja cerrada y no se crea Pedido ni DetallePedido', async () => {
    const entorno = crearEntorno();
    entorno.db.cierre.cerradoEl = new Date('2026-01-01T20:00:00Z');
    const { pedidos } = await montarServicios(entorno);

    await expect(pedidos.crearPedido(TOKEN, { items: unItem })).rejects.toThrow(
      ConflictException,
    );
    await expect(pedidos.crearPedido(TOKEN, { items: unItem })).rejects.toThrow(
      MENSAJE_CAJA_CERRADA,
    );

    expect(entorno.db.pedidos).toHaveLength(0);
    expect(entorno.db.detalles).toHaveLength(0);
    // Todo o nada: ni siquiera se llegó a pedir el correlativo ni a insertar.
    const manager = entorno.queryRunnersPedido[0].manager;
    expect(manager.save).not.toHaveBeenCalled();
    expect(
      entorno.queryRunnersPedido[0].rollbackTransaction,
    ).toHaveBeenCalledTimes(1);
  });

  it('el lock del cierre se toma ANTES que el de la sesión (orden global)', async () => {
    const entorno = crearEntorno();
    const { pedidos } = await montarServicios(entorno);

    await pedidos.crearPedido(TOKEN, { items: unItem });

    const llamadas = entorno.queryRunnersPedido[0].manager.findOne.mock.calls;
    const lockCaja = llamadas.findIndex(
      (llamada) => llamada[0] === CierreCaja && llamada[1]?.lock,
    );
    const lockSesion = llamadas.findIndex(
      (llamada) => llamada[0] === SesionMesa && llamada[1]?.lock,
    );
    expect(lockCaja).toBeGreaterThanOrEqual(0);
    expect(lockSesion).toBeGreaterThan(lockCaja);
  });

  it('la mesa con la cuenta ya solicitada se sigue rechazando antes de tocar Caja', async () => {
    const entorno = crearEntorno();
    entorno.db.mesa.estado = EstadoMesa.CUENTA_SOLICITADA;
    const { pedidos } = await montarServicios(entorno);

    await expect(pedidos.crearPedido(TOKEN, { items: unItem })).rejects.toThrow(
      /Ya se solicitó la cuenta/,
    );
    // Ni siquiera se abrió transacción: la regla de Caja no reemplaza ni
    // desplaza a las validaciones que ya existían.
    expect(entorno.queryRunnersPedido).toHaveLength(0);
    expect(entorno.lockCierre.titular).toBeNull();
  });

  // --- Interleaving: gana el Pedido ---

  it('gana el pedido: el cierre espera el lock y el pedido queda creado dentro del turno', async () => {
    const pausaPedido = crearCompuerta();
    const entorno = crearEntorno({ pausaPedidoTrasCaja: pausaPedido });
    const { pedidos, caja } = await montarServicios(entorno);

    // 1. El pedido arranca, toma el lock del cierre y queda pausado ahí.
    const pedido = pedidos.crearPedido(TOKEN, { items: unItem });
    await cederElControl();
    expect(entorno.lockCierre.titular).toBe('pedido');

    // 2. El cierre arranca y queda BLOQUEADO pidiendo el mismo lock.
    const cierre = caja.cerrarCaja({});
    await cederElControl();
    expect(entorno.avance.cierrePasoLock).toBe(false);
    expect(entorno.db.cierre.cerradoEl).toBeNull();

    // 3. Se libera el pedido: commitea y suelta el lock.
    pausaPedido.abrir();
    const respuesta = await pedido;
    expect(respuesta.idPedido).toBeDefined();
    expect(entorno.db.pedidos).toHaveLength(1);

    // 4. Recién ahora avanza el cierre.
    await cierre;
    expect(entorno.db.cierre.cerradoEl).not.toBeNull();

    // El pedido commiteado antes del cierre NO desaparece: el KDS lo sigue
    // viendo igual después de que Caja cerró.
    expect(entorno.db.pedidos).toHaveLength(1);
    expect(entorno.db.detalles).toHaveLength(1);
  });

  // --- Interleaving: gana el Cierre ---

  it('gana el cierre: el pedido espera, reevalúa y se rechaza con 409 sin insertar nada', async () => {
    const pausaCierre = crearCompuerta();
    const entorno = crearEntorno({ pausaCierreTrasLock: pausaCierre });
    const { pedidos, caja } = await montarServicios(entorno);

    // 1. El cierre arranca, toma el lock y queda pausado.
    const cierre = caja.cerrarCaja({});
    await cederElControl();
    expect(entorno.lockCierre.titular).toBe('cierre');

    // 2. El pedido arranca y queda BLOQUEADO en el lock: no llegó siquiera a
    //    mirar la sesión.
    const pedido = pedidos.crearPedido(TOKEN, { items: unItem });
    await cederElControl();
    expect(entorno.avance.pedidoPasoCaja).toBe(false);

    // 3. El cierre termina y commitea cerradoEl.
    pausaCierre.abrir();
    const resumen = await cierre;
    expect(entorno.db.cierre.cerradoEl).not.toBeNull();
    expect(resumen.totalEsperado).toBe(200);

    // 4. El pedido reanuda, reevalúa la fila y ya no encuentra caja abierta.
    await expect(pedido).rejects.toThrow(MENSAJE_CAJA_CERRADA);
    expect(entorno.db.pedidos).toHaveLength(0);
    expect(entorno.db.detalles).toHaveLength(0);
  });

  // --- Rollback con el lock tomado ---

  it('si el pedido falla con el lock tomado: rollback, caja sigue abierta y el lock se libera', async () => {
    const entorno = crearEntorno();
    const { pedidos, caja } = await montarServicios(entorno);

    // La sesión se cierra entre la resolución del token y el recheck bajo el
    // lock: el flujo aborta DESPUÉS de haber tomado el lock de caja.
    entorno.obtenerSesionActivaPorToken.mockResolvedValueOnce({
      ...entorno.db.sesion,
      mesa: { ...entorno.db.mesa },
    });
    entorno.db.sesion.cerradaEl = new Date('2026-01-01T13:00:00Z');

    await expect(pedidos.crearPedido(TOKEN, { items: unItem })).rejects.toThrow(
      UnauthorizedException,
    );

    expect(entorno.db.pedidos).toHaveLength(0);
    expect(entorno.db.detalles).toHaveLength(0);
    expect(entorno.db.cierre.cerradoEl).toBeNull();
    expect(entorno.lockCierre.titular).toBeNull();
    expect(
      entorno.queryRunnersPedido[0].rollbackTransaction,
    ).toHaveBeenCalledTimes(1);

    // El lock quedó realmente libre: un cierre posterior puede tomarlo.
    const resumen = await caja.cerrarCaja({});
    expect(resumen.totalEsperado).toBe(200);
  });

  // --- Sesión ---

  it('encontrar la Caja cerrada NO cierra la sesión, no libera la mesa ni invalida el token', async () => {
    const entorno = crearEntorno();
    entorno.db.cierre.cerradoEl = new Date('2026-01-01T20:00:00Z');
    const { pedidos } = await montarServicios(entorno);

    await expect(pedidos.crearPedido(TOKEN, { items: unItem })).rejects.toThrow(
      MENSAJE_CAJA_CERRADA,
    );

    expect(entorno.db.sesion.cerradaEl).toBeNull();
    expect(entorno.db.mesa.estado).toBe(EstadoMesa.OCUPADA);
    // No se escribió NADA: ni sesión, ni mesa, ni pedido.
    expect(entorno.queryRunnersPedido[0].manager.update).not.toHaveBeenCalled();
    expect(entorno.queryRunnersPedido[0].manager.save).not.toHaveBeenCalled();

    // El token sigue resolviendo a la misma sesión activa (tracking y "mis
    // pedidos" siguen funcionando con Caja cerrada).
    await expect(
      entorno.obtenerSesionActivaPorToken(TOKEN),
    ).resolves.toMatchObject({ idSesion: 10, cerradaEl: null });
  });

  it('una sesión puede atravesar el cambio de turno: 409 con caja cerrada, y vuelve a pedir cuando se abre otra', async () => {
    const entorno = crearEntorno();
    const { pedidos, caja } = await montarServicios(entorno);

    // Turno 1: la sesión pide normalmente.
    const primero = await pedidos.crearPedido(TOKEN, { items: unItem });
    expect(primero.nroOrden).toBe(1);

    // Cierre del turno: la sesión NO se toca.
    await caja.cerrarCaja({});
    expect(entorno.db.sesion.cerradaEl).toBeNull();

    // Entre turnos no se puede pedir.
    await expect(pedidos.crearPedido(TOKEN, { items: unItem })).rejects.toThrow(
      MENSAJE_CAJA_CERRADA,
    );
    expect(entorno.db.pedidos).toHaveLength(1);

    // Se abre un turno nuevo (fila nueva de cierres_caja, la anterior queda
    // cerrada): la MISMA sesión vuelve a poder pedir, y el correlativo sigue.
    entorno.db.cierre = {
      idCierre: 2,
      idUsuario: 1,
      abiertoEl: new Date('2026-01-02T12:00:00Z'),
      cerradoEl: null,
      montoInicialEfectivo: 300,
    };

    const segundo = await pedidos.crearPedido(TOKEN, { items: unItem });
    expect(segundo.nroOrden).toBe(2);
    expect(entorno.db.pedidos).toHaveLength(2);
  });

  // --- Regresiones de creación ---

  it('pedido multi-item con personalización: conserva cantidades, precio congelado y observación', async () => {
    const entorno = crearEntorno();
    const { pedidos } = await montarServicios(entorno);

    const respuesta = await pedidos.crearPedido(TOKEN, {
      items: [
        {
          idProducto: HAMBURGUESA.idProducto,
          cantidad: 2,
          observacion: 'Sin: cebolla\nNota: salsa aparte',
        },
        { idProducto: PAPAS.idProducto, cantidad: 1 },
      ],
    });

    expect(respuesta.detalles).toHaveLength(2);
    const hamburguesa = respuesta.detalles.find(
      (detalle) => detalle.idProducto === HAMBURGUESA.idProducto,
    );
    expect(hamburguesa?.cantidad).toBe(2);
    expect(hamburguesa?.precioActual).toBe(HAMBURGUESA.precio);
    expect(hamburguesa?.observacion).toBe('Sin: cebolla\nNota: salsa aparte');

    const papas = respuesta.detalles.find(
      (detalle) => detalle.idProducto === PAPAS.idProducto,
    );
    expect(papas?.observacion).toBeNull();
    expect(entorno.db.detalles).toHaveLength(2);
  });

  it('el correlativo por sesión y el estado inicial no cambian con la regla nueva', async () => {
    const entorno = crearEntorno();
    const { pedidos } = await montarServicios(entorno);

    const primero = await pedidos.crearPedido(TOKEN, { items: unItem });
    const segundo = await pedidos.crearPedido(TOKEN, { items: unItem });

    expect(primero.nroOrden).toBe(1);
    expect(segundo.nroOrden).toBe(2);
    expect(segundo.estado).toBe(EstadoPedido.PENDIENTE);

    // El servicio no manda `estado` en el INSERT: lo pone el DEFAULT de la
    // columna. La regla de Caja no cambió eso.
    const insertados = entorno.queryRunnersPedido[0].manager.create.mock.calls
      .filter((llamada) => llamada[0] === Pedido)
      .map((llamada) => llamada[1] as Record<string, unknown>);
    expect(insertados[0]?.estado).toBeUndefined();
  });
});
