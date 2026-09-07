import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PagosService } from './pagos.service';
import { Pago } from '../entities/pago.entity';
import { MetodoPago } from '../entities/metodo-pago.entity';
import { CierreCaja } from '../../caja/entities/cierre-caja.entity';
import { Mesa } from '../../mesas/entities/mesa.entity';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { DetallePedido } from '../../pedidos/entities/detalle-pedido.entity';
import { Pedido } from '../../pedidos/entities/pedido.entity';
import { MesasService } from '../../mesas/services/mesas.service';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { aCentavos } from '../../common/utils/dinero.util';

describe('PagosService', () => {
  let service: PagosService;
  // Mocks tipados como jest.Mock (no como métodos de Repository<T>) para
  // que @typescript-eslint/unbound-method no los marque como falso positivo.
  let managerFindOneMock: jest.Mock;
  let managerFindMock: jest.Mock;
  let managerSaveMock: jest.Mock;
  let commitMock: jest.Mock;
  let rollbackMock: jest.Mock;
  let cerrarSesionActivaMock: jest.Mock;
  let mesasFindOneMock: jest.Mock;

  // Totales que devuelve el saldo compartido (saldo-sesion.util).
  let totalAdeudado: number;
  let totalPagado: number;
  let hayCajaAbierta: boolean;

  const mesa = { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.OCUPADA };

  const sesion = () =>
    ({
      idSesion: 10,
      idMesa: 1,
      token: 'token-abc',
      abiertaEl: new Date('2026-01-01T12:00:00Z'),
      cerradaEl: null,
      mesa,
    }) as unknown as SesionMesa;

  const metodoEfectivo = {
    idMetodoPago: 1,
    nombreMetodo: 'Efectivo',
  } as MetodoPago;

  const queryBuilderMock = (total: number) => {
    const qb: Record<string, jest.Mock> = {};
    qb.innerJoin = jest.fn(() => qb);
    qb.select = jest.fn(() => qb);
    qb.where = jest.fn(() => qb);
    qb.andWhere = jest.fn(() => qb);
    qb.getRawOne = jest.fn(() => Promise.resolve({ total }));
    return qb;
  };

  const crearQueryBuilder = (entidad: unknown) =>
    entidad === DetallePedido
      ? queryBuilderMock(totalAdeudado)
      : queryBuilderMock(totalPagado);

  beforeEach(async () => {
    totalAdeudado = 100;
    totalPagado = 0;
    hayCajaAbierta = true;

    managerFindOneMock = jest.fn((entidad: unknown) => {
      if (entidad === CierreCaja) {
        return Promise.resolve(hayCajaAbierta ? { idCierre: 1 } : null);
      }
      if (entidad === SesionMesa) return Promise.resolve(sesion());
      return Promise.resolve(null);
    });

    managerFindMock = jest.fn((entidad: unknown) => {
      if (entidad === MetodoPago) return Promise.resolve([metodoEfectivo]);
      // buscarPagosResponse: los pagos ya guardados, con su método cargado.
      return Promise.resolve([
        {
          idPago: 100,
          idSesion: 10,
          idMetodoPago: 1,
          metodoPago: metodoEfectivo,
          nroRecibo: null,
          montoPagado: 100,
          anuladoEl: null,
          creadoEl: new Date('2026-01-01T13:00:00Z'),
        },
      ]);
    });

    managerSaveMock = jest.fn((filas: unknown) => Promise.resolve(filas));
    commitMock = jest.fn();
    rollbackMock = jest.fn();

    const manager = {
      findOne: managerFindOneMock,
      find: managerFindMock,
      save: managerSaveMock,
      create: jest.fn((_entidad: unknown, datos: unknown) => datos),
      createQueryBuilder: jest.fn(crearQueryBuilder),
    };

    const dataSourceMock = {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: commitMock,
        rollbackTransaction: rollbackMock,
        release: jest.fn(),
        manager,
      })),
    };

    cerrarSesionActivaMock = jest.fn();
    mesasFindOneMock = jest.fn(() =>
      Promise.resolve({ ...mesa, sesionActiva: null }),
    );

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PagosService,
        {
          provide: getRepositoryToken(Pago),
          useValue: {
            manager: {
              findOne: managerFindOneMock,
              find: managerFindMock,
              createQueryBuilder: jest.fn(crearQueryBuilder),
            },
            findOne: jest.fn(),
            find: jest.fn(),
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
            cerrarSesionActiva: cerrarSesionActivaMock,
            findOne: mesasFindOneMock,
          },
        },
        { provide: DataSource, useValue: dataSourceMock },
      ],
    }).compile();

    service = module.get<PagosService>(PagosService);
  });

  // Regresión de la extracción a saldo-sesion.util: el contrato de
  // GET /pagos/total/:idMesa no cambió.
  describe('obtenerTotalDeMesa — regresión del cálculo extraído', () => {
    it('devuelve adeudado, pagado y saldo pendiente de la sesión activa', async () => {
      totalAdeudado = 150.75;
      totalPagado = 50.25;

      const resultado = await service.obtenerTotalDeMesa(1);

      expect(resultado.totalAdeudado).toBe(150.75);
      expect(resultado.totalPagado).toBe(50.25);
      expect(resultado.saldoPendiente).toBe(100.5);
      expect(resultado.idSesion).toBe(10);
      expect(resultado.nombreMesa).toBe('Mesa 1');
    });

    it('sesión sin consumo ni pagos → todo en 0 (sin caso especial)', async () => {
      totalAdeudado = 0;
      totalPagado = 0;

      const resultado = await service.obtenerTotalDeMesa(1);

      expect(resultado.totalAdeudado).toBe(0);
      expect(resultado.totalPagado).toBe(0);
      expect(resultado.saldoPendiente).toBe(0);
    });

    it('el saldo se calcula en centavos (sin error de float)', async () => {
      totalAdeudado = 0.3;
      totalPagado = 0.1;

      const resultado = await service.obtenerTotalDeMesa(1);

      // 0.3 - 0.1 en float daría 0.19999999999999998.
      expect(resultado.saldoPendiente).toBe(0.2);
    });
  });

  describe('registrarPago — semántica de commit antes de liberar', () => {
    it('pago exacto: persiste el cobro, commitea y libera la mesa (mesaLiberada true)', async () => {
      totalAdeudado = 100;
      totalPagado = 0;
      cerrarSesionActivaMock.mockResolvedValue({
        idMesa: 1,
        nombreMesa: 'Mesa 1',
        estado: EstadoMesa.LIBRE,
        sesionActiva: null,
      });

      const resultado = await service.registrarPago({
        idMesa: 1,
        pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
      });

      expect(managerSaveMock).toHaveBeenCalled();
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(rollbackMock).not.toHaveBeenCalled();
      expect(resultado.mesaLiberada).toBe(true);
      expect(resultado.mesa.estado).toBe(EstadoMesa.LIBRE);
      expect(resultado.pagos).toHaveLength(1);
      expect(resultado.totalPagado).toBe(100);
    });

    it('el pago YA commiteado NO se revierte si falla la liberación → mesaLiberada false', async () => {
      totalAdeudado = 100;
      totalPagado = 0;
      // Escenario central de esta fase: cerrarSesionActiva ahora puede
      // rechazar con 409 (saldo) además de fallar por otros motivos.
      cerrarSesionActivaMock.mockRejectedValue(
        new ConflictException('No se puede liberar la mesa: ...'),
      );

      const resultado = await service.registrarPago({
        idMesa: 1,
        pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
      });

      // El cobro se commiteó ANTES de intentar liberar: no se pierde.
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(rollbackMock).not.toHaveBeenCalled();
      expect(resultado.mesaLiberada).toBe(false);
      expect(resultado.pagos).toHaveLength(1);
      expect(mesasFindOneMock).toHaveBeenCalledWith(1);
    });

    it('pago que no cubre el total exacto → 409 y rollback (no persiste nada)', async () => {
      totalAdeudado = 100;
      totalPagado = 0;

      await expect(
        service.registrarPago({
          idMesa: 1,
          pagos: [{ idMetodoPago: 1, montoPagado: 40 }],
        }),
      ).rejects.toThrow(ConflictException);

      expect(rollbackMock).toHaveBeenCalledTimes(1);
      expect(commitMock).not.toHaveBeenCalled();
      expect(cerrarSesionActivaMock).not.toHaveBeenCalled();
    });

    it('sesión sin consumo → 409 "no hay nada que cobrar" (regla preexistente)', async () => {
      totalAdeudado = 0;

      await expect(
        service.registrarPago({
          idMesa: 1,
          pagos: [{ idMetodoPago: 1, montoPagado: 10 }],
        }),
      ).rejects.toThrow(ConflictException);
      expect(commitMock).not.toHaveBeenCalled();
    });

    it('sin caja abierta → 409 (regla preexistente)', async () => {
      hayCajaAbierta = false;

      await expect(
        service.registrarPago({
          idMesa: 1,
          pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
        }),
      ).rejects.toThrow(ConflictException);
      expect(rollbackMock).toHaveBeenCalledTimes(1);
    });

    it('un cobro parcial previo ya registrado se cuenta como pagado (no cobra dos veces)', async () => {
      totalAdeudado = 100;
      totalPagado = 60; // ya registrado antes en esta sesión
      cerrarSesionActivaMock.mockResolvedValue({
        idMesa: 1,
        nombreMesa: 'Mesa 1',
        estado: EstadoMesa.LIBRE,
        sesionActiva: null,
      });

      const resultado = await service.registrarPago({
        idMesa: 1,
        pagos: [{ idMetodoPago: 1, montoPagado: 40 }],
      });

      expect(resultado.totalPagado).toBe(100);
      expect(commitMock).toHaveBeenCalledTimes(1);
    });
  });

  // ---------------------------------------------------------------------
  // anularPago
  // ---------------------------------------------------------------------
  // Estos tests NO reutilizan los mocks de arriba a propósito. anularPago
  // depende de leer, dentro de su propia transacción, lo que esa misma
  // transacción acaba de escribir: la regla central es que el saldo reaparece
  // SOLO por el filtro `anuladoEl IS NULL`, sin aritmética propia. Con mocks
  // que devuelven totales fijos eso no se puede verificar, solo suponer.
  //
  // Por eso el manager de acá se comporta como una base de datos mínima: los
  // `update` MUTAN el estado, las lecturas ven esas mutaciones, y
  // `rollbackTransaction` restaura el snapshot tomado al abrir la transacción.
  // Así las aserciones de "todo o nada" son reales (el pago efectivamente NO
  // queda anulado) y no un `expect(update).not.toHaveBeenCalled()` indirecto.
  describe('anularPago', () => {
    interface EstadoDb {
      pago: {
        idPago: number;
        idSesion: number;
        idMetodoPago: number;
        montoPagado: number;
        nroRecibo: string | null;
        anuladoEl: Date | null;
        creadoEl: Date;
      } | null;
      sesion: {
        idSesion: number;
        idMesa: number;
        cerradaEl: Date | null;
      } | null;
      mesa: { idMesa: number; nombreMesa: string; estado: EstadoMesa } | null;
      otraSesionActiva: { idSesion: number; idMesa: number } | null;
      // Turno cuya ventana contiene a pago.creadoEl: el abierto (cerradoEl
      // null), uno ya cerrado, o null si el pago no cae en ninguno (huérfano).
      ventanaCaja: { idCierre: number; cerradoEl: Date | null } | null;
      cajaAbierta: boolean;
      totalAdeudado: number;
      // Pagos vigentes de la sesión DISTINTOS del que se está anulando.
      otrosPagosVigentes: number;
    }

    const clonar = (estado: EstadoDb): EstadoDb => ({
      ...estado,
      pago: estado.pago ? { ...estado.pago } : null,
      sesion: estado.sesion ? { ...estado.sesion } : null,
      mesa: estado.mesa ? { ...estado.mesa } : null,
      otraSesionActiva: estado.otraSesionActiva
        ? { ...estado.otraSesionActiva }
        : null,
      ventanaCaja: estado.ventanaCaja ? { ...estado.ventanaCaja } : null,
    });

    const CERRADA_EL = new Date('2026-01-01T20:00:00Z');

    const montarEscenario = async (parcial: Partial<EstadoDb> = {}) => {
      const db: EstadoDb = {
        pago: {
          idPago: 100,
          idSesion: 10,
          idMetodoPago: 1,
          montoPagado: 100,
          nroRecibo: null,
          anuladoEl: null,
          creadoEl: new Date('2026-01-01T13:00:00Z'),
        },
        sesion: { idSesion: 10, idMesa: 1, cerradaEl: null },
        mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.OCUPADA },
        otraSesionActiva: null,
        // Por defecto el pago cae en el turno todavía abierto -> anulable.
        ventanaCaja: { idCierre: 9, cerradoEl: null },
        cajaAbierta: true,
        totalAdeudado: 100,
        otrosPagosVigentes: 0,
        ...parcial,
      };

      // Exactamente el filtro `anuladoEl IS NULL` de calcularTotalPagado.
      const totalPagadoVigente = () =>
        db.otrosPagosVigentes +
        (db.pago && db.pago.anuladoEl === null ? db.pago.montoPagado : 0);

      const saldoCentavos = () =>
        aCentavos(db.totalAdeudado) - aCentavos(totalPagadoVigente());

      let falloUpdateSesion: Error | null = null;

      const findOneMock = jest.fn(
        (entidad: unknown, opciones?: { where?: Record<string, unknown> }) => {
          const where = opciones?.where ?? {};

          if (entidad === Pago) {
            return Promise.resolve(
              db.pago && db.pago.idPago === where.idPago
                ? { ...db.pago }
                : null,
            );
          }
          if (entidad === CierreCaja) {
            return Promise.resolve(db.cajaAbierta ? { idCierre: 9 } : null);
          }
          if (entidad === Mesa) {
            return Promise.resolve(db.mesa ? { ...db.mesa } : null);
          }
          if (entidad === SesionMesa) {
            // "¿la mesa ya tiene OTRA sesión activa?" — único where que trae
            // idSesion (como Not(...)) y cerradaEl (IsNull()) a la vez.
            if (where.idSesion !== undefined && where.cerradaEl !== undefined) {
              return Promise.resolve(
                db.otraSesionActiva ? { ...db.otraSesionActiva } : null,
              );
            }
            // Sesión del pago, por id (la que se lockea).
            if (where.idSesion !== undefined) {
              return Promise.resolve(db.sesion ? { ...db.sesion } : null);
            }
            // Sesión activa de la mesa (flujo de cobro).
            const activa =
              db.sesion && db.sesion.cerradaEl === null ? db.sesion : null;
            return Promise.resolve(
              activa ? { ...activa, mesa: db.mesa } : null,
            );
          }
          return Promise.resolve(null);
        },
      );

      const updateMock = jest.fn(
        (
          entidad: unknown,
          _criterio: unknown,
          valores: Record<string, unknown>,
        ) => {
          if (entidad === Pago && db.pago) {
            Object.assign(db.pago, valores);
          } else if (entidad === SesionMesa) {
            if (falloUpdateSesion) return Promise.reject(falloUpdateSesion);
            if (db.sesion) Object.assign(db.sesion, valores);
          } else if (entidad === Mesa && db.mesa) {
            Object.assign(db.mesa, valores);
          }
          return Promise.resolve({ affected: 1 });
        },
      );

      const findMock = jest.fn((entidad: unknown) => {
        if (entidad === MetodoPago) return Promise.resolve([metodoEfectivo]);
        return Promise.resolve(
          db.pago ? [{ ...db.pago, metodoPago: metodoEfectivo }] : [],
        );
      });

      const createQueryBuilderMock = jest.fn((entidad: unknown) => {
        const qb: Record<string, jest.Mock> = {};
        for (const metodo of [
          'innerJoin',
          'select',
          'addSelect',
          'where',
          'andWhere',
          'groupBy',
          'setLock',
        ]) {
          qb[metodo] = jest.fn(() => qb);
        }
        // Regla A: el turno cuya ventana contiene a pago.creadoEl (abierto o
        // cerrado). Lo pide con FOR UPDATE — la exclusión real la modela el
        // spec de concurrencia, acá solo interesa qué fila devuelve.
        qb.getOne = jest.fn(() =>
          Promise.resolve(db.ventanaCaja ? { ...db.ventanaCaja } : null),
        );
        qb.getRawOne = jest.fn(() =>
          Promise.resolve({
            total:
              entidad === DetallePedido
                ? db.totalAdeudado
                : totalPagadoVigente(),
          }),
        );
        return qb;
      });

      const manager = {
        findOne: findOneMock,
        find: findMock,
        update: updateMock,
        save: jest.fn((filas: unknown) => Promise.resolve(filas)),
        create: jest.fn((_entidad: unknown, datos: unknown) => datos),
        createQueryBuilder: createQueryBuilderMock,
      };

      const commit = jest.fn();
      let snapshot: EstadoDb | null = null;
      const startTransaction = jest.fn(() => {
        snapshot = clonar(db);
        return Promise.resolve();
      });
      // Rollback de verdad: restaura el snapshot, igual que haría Postgres.
      const rollback = jest.fn(() => {
        if (snapshot) Object.assign(db, clonar(snapshot));
        return Promise.resolve();
      });

      const cerrarSesionActiva = jest.fn();

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PagosService,
          {
            provide: getRepositoryToken(Pago),
            useValue: {
              manager,
              // Lectura preliminar de anularPago (sin lock, fuera de la
              // transacción): solo localiza la ventana de turno del pago.
              findOne: jest.fn(() =>
                Promise.resolve(db.pago ? { ...db.pago } : null),
              ),
              find: jest.fn(),
              update: jest.fn(),
            },
          },
          {
            provide: getRepositoryToken(SesionMesa),
            useValue: { findOne: jest.fn() },
          },
          {
            provide: MesasService,
            useValue: { cerrarSesionActiva, findOne: jest.fn() },
          },
          {
            provide: DataSource,
            useValue: {
              createQueryRunner: jest.fn(() => ({
                connect: jest.fn(),
                startTransaction,
                commitTransaction: commit,
                rollbackTransaction: rollback,
                release: jest.fn(),
                manager,
              })),
            },
          },
        ],
      }).compile();

      return {
        pagos: module.get<PagosService>(PagosService),
        db,
        commit,
        rollback,
        findOneMock,
        updateMock,
        cerrarSesionActiva,
        saldoCentavos,
        fallarUpdateSesion: (error: Error) => {
          falloUpdateSesion = error;
        },
      };
    };

    // --- Regla A: turno de caja ya cerrado ---

    it('pago perteneciente a un CierreCaja cerrado → 409 y nada se modifica', async () => {
      const { pagos, db, commit, rollback, updateMock } = await montarEscenario(
        {
          ventanaCaja: { idCierre: 7, cerradoEl: CERRADA_EL },
          sesion: { idSesion: 10, idMesa: 1, cerradaEl: CERRADA_EL },
          mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.LIBRE },
        },
      );

      await expect(pagos.anularPago(100)).rejects.toThrow(
        /turno de caja ya cerrado/,
      );

      expect(db.pago?.anuladoEl).toBeNull();
      expect(db.sesion?.cerradaEl).toEqual(CERRADA_EL);
      expect(db.mesa?.estado).toBe(EstadoMesa.LIBRE);
      // Se rechaza ANTES de escribir: ni siquiera se intentó un update.
      expect(updateMock).not.toHaveBeenCalled();
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
    });

    it('un pago del turno EN CURSO (cierre sin cerrar) sí se puede anular', async () => {
      const { pagos, db, commit } = await montarEscenario({
        ventanaCaja: { idCierre: 9, cerradoEl: null },
      });

      await pagos.anularPago(100);

      expect(db.pago?.anuladoEl).not.toBeNull();
      expect(commit).toHaveBeenCalledTimes(1);
    });

    it('pago huérfano (no cae en ninguna ventana de turno) conserva el comportamiento previo: se anula', async () => {
      // Sólo alcanzable con datos anteriores a la Etapa 3B, cuando creado_el
      // tomaba el inicio de la transacción y podía quedar antes de abiertoEl.
      // No puede volverse histórico (abiertoEl nunca retrocede), así que no se
      // le inventa una regla nueva ni se lo bloquea.
      const { pagos, db, commit } = await montarEscenario({
        ventanaCaja: null,
      });

      await pagos.anularPago(100);

      expect(db.pago?.anuladoEl).not.toBeNull();
      expect(commit).toHaveBeenCalledTimes(1);
    });

    // --- Regla B, caso 1: la sesión sigue activa ---

    it('pago de sesión activa: se anula, el saldo vuelve a subir y la sesión no se toca', async () => {
      const { pagos, db, commit, updateMock, saldoCentavos } =
        await montarEscenario({
          sesion: { idSesion: 10, idMesa: 1, cerradaEl: null },
        });

      expect(saldoCentavos()).toBe(0);

      const resultado = await pagos.anularPago(100);

      expect(resultado.anuladoEl).not.toBeNull();
      expect(db.pago?.anuladoEl).not.toBeNull();
      // La deuda reaparece sola al excluir el pago anulado.
      expect(saldoCentavos()).toBe(10_000);
      // Sesión y mesa quedan exactamente como estaban.
      expect(db.sesion?.cerradaEl).toBeNull();
      expect(db.mesa?.estado).toBe(EstadoMesa.OCUPADA);
      const entidadesEscritas = updateMock.mock.calls.map(
        (llamada) => llamada[0],
      );
      expect(entidadesEscritas).toEqual([Pago]);
      expect(commit).toHaveBeenCalledTimes(1);
    });

    // --- Regla B, caso 2: reapertura de la sesión cerrada ---

    it('pago que había saldado y cerrado la sesión: reabre ESA misma sesión y deja la mesa en cuenta_solicitada', async () => {
      const { pagos, db, commit, updateMock, saldoCentavos } =
        await montarEscenario({
          sesion: { idSesion: 10, idMesa: 1, cerradaEl: CERRADA_EL },
          mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.LIBRE },
        });

      expect(saldoCentavos()).toBe(0);

      await pagos.anularPago(100);

      expect(db.pago?.anuladoEl).not.toBeNull();
      // MISMA sesión reabierta, no una nueva.
      expect(db.sesion?.idSesion).toBe(10);
      expect(db.sesion?.cerradaEl).toBeNull();
      expect(db.mesa?.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);
      expect(saldoCentavos()).toBe(10_000);
      expect(commit).toHaveBeenCalledTimes(1);

      // Los pedidos y sus detalles no se tocan: siguen colgando del idSesion.
      const entidadesEscritas = updateMock.mock.calls.map(
        (llamada) => llamada[0],
      );
      expect(entidadesEscritas).not.toContain(Pedido);
      expect(entidadesEscritas).not.toContain(DetallePedido);
    });

    it('tras la reapertura, el flujo normal de cobro vuelve a encontrar esa sesión y la cobra', async () => {
      const { pagos, db, cerrarSesionActiva } = await montarEscenario({
        sesion: { idSesion: 10, idMesa: 1, cerradaEl: CERRADA_EL },
        mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.LIBRE },
      });

      await pagos.anularPago(100);
      expect(db.sesion?.cerradaEl).toBeNull();

      cerrarSesionActiva.mockResolvedValue({
        idMesa: 1,
        nombreMesa: 'Mesa 1',
        estado: EstadoMesa.LIBRE,
        sesionActiva: null,
      });

      // Sin ningún endpoint especial: el mismo POST /pagos de siempre.
      const cobro = await pagos.registrarPago({
        idMesa: 1,
        pagos: [{ idMetodoPago: 1, montoPagado: 100 }],
      });

      expect(cobro.idSesion).toBe(10);
      expect(cobro.totalAdeudado).toBe(100);
      expect(cobro.totalPagado).toBe(100);
      expect(cobro.mesaLiberada).toBe(true);
    });

    // --- Regla B, caso crítico: la mesa ya tiene otra sesión activa ---

    it('la mesa ya tiene otra sesión activa → 409 y rollback total (el pago NO queda anulado)', async () => {
      const { pagos, db, commit, rollback } = await montarEscenario({
        sesion: { idSesion: 10, idMesa: 1, cerradaEl: CERRADA_EL },
        mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.OCUPADA },
        otraSesionActiva: { idSesion: 11, idMesa: 1 },
      });

      await expect(pagos.anularPago(100)).rejects.toThrow(
        /ya tiene una nueva sesión activa/,
      );

      expect(db.pago?.anuladoEl).toBeNull();
      expect(db.sesion?.cerradaEl).toEqual(CERRADA_EL);
      expect(db.otraSesionActiva?.idSesion).toBe(11);
      expect(db.mesa?.estado).toBe(EstadoMesa.OCUPADA);
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
    });

    // --- Regla B, caso 3: la anulación no genera deuda ---

    it('anulación de un pago duplicado (saldo sigue en 0): no reabre la sesión', async () => {
      // Sesión de 100 cobrada dos veces: se anula el cobro repetido.
      const { pagos, db, commit, updateMock, saldoCentavos } =
        await montarEscenario({
          totalAdeudado: 100,
          otrosPagosVigentes: 100,
          sesion: { idSesion: 10, idMesa: 1, cerradaEl: CERRADA_EL },
          mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.LIBRE },
        });

      await pagos.anularPago(100);

      expect(db.pago?.anuladoEl).not.toBeNull();
      expect(saldoCentavos()).toBe(0);
      // Sin deuda no hay nada que cobrar: la sesión sigue cerrada.
      expect(db.sesion?.cerradaEl).toEqual(CERRADA_EL);
      expect(db.mesa?.estado).toBe(EstadoMesa.LIBRE);
      const entidadesEscritas = updateMock.mock.calls.map(
        (llamada) => llamada[0],
      );
      expect(entidadesEscritas).toEqual([Pago]);
      expect(commit).toHaveBeenCalledTimes(1);
    });

    // --- Atomicidad ---

    it('si falla la escritura de la reapertura, no queda nada escrito', async () => {
      const { pagos, db, commit, rollback, fallarUpdateSesion } =
        await montarEscenario({
          sesion: { idSesion: 10, idMesa: 1, cerradaEl: CERRADA_EL },
          mesa: { idMesa: 1, nombreMesa: 'Mesa 1', estado: EstadoMesa.LIBRE },
        });

      fallarUpdateSesion(new Error('fallo al reabrir la sesión'));

      await expect(pagos.anularPago(100)).rejects.toThrow(
        'fallo al reabrir la sesión',
      );

      // El pago ya se había marcado antes del fallo: el rollback lo deshace.
      expect(db.pago?.anuladoEl).toBeNull();
      expect(db.sesion?.cerradaEl).toEqual(CERRADA_EL);
      expect(db.mesa?.estado).toBe(EstadoMesa.LIBRE);
      expect(rollback).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
    });

    it('lockea el pago y la sesión con pessimistic_write, y una segunda anulación da 409', async () => {
      const { pagos, db, findOneMock } = await montarEscenario();

      await pagos.anularPago(100);

      expect(findOneMock).toHaveBeenCalledWith(
        Pago,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(findOneMock).toHaveBeenCalledWith(
        SesionMesa,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );

      // La segunda pasada relee la fila ya anulada bajo el lock (lo mismo que
      // hace Postgres al reevaluar la fila tras esperar el lock).
      await expect(pagos.anularPago(100)).rejects.toThrow(ConflictException);
      expect(db.pago?.anuladoEl).not.toBeNull();
    });

    // --- Comportamiento preexistente conservado ---

    it('pago inexistente → 404, ya en la lectura preliminar (sin abrir transacción)', async () => {
      const { pagos, commit, rollback } = await montarEscenario({ pago: null });

      await expect(pagos.anularPago(100)).rejects.toThrow(NotFoundException);
      // El 404 se decide antes del BEGIN: no hay transacción que revertir.
      expect(rollback).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    });

    it('pago ya anulado → 409', async () => {
      const { pagos, commit } = await montarEscenario({
        pago: {
          idPago: 100,
          idSesion: 10,
          idMetodoPago: 1,
          montoPagado: 100,
          nroRecibo: null,
          anuladoEl: new Date('2026-01-01T14:00:00Z'),
          creadoEl: new Date('2026-01-01T13:00:00Z'),
        },
      });

      await expect(pagos.anularPago(100)).rejects.toThrow(/ya estaba anulado/);
      expect(commit).not.toHaveBeenCalled();
    });
  });
});
