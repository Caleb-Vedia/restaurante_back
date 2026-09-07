import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MesasService } from './mesas.service';
import { Mesa } from '../entities/mesa.entity';
import { SesionMesa } from '../entities/sesion-mesa.entity';
import { DetallePedido } from '../../pedidos/entities/detalle-pedido.entity';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';

describe('MesasService', () => {
  let service: MesasService;
  // Mocks tipados como jest.Mock (no como métodos de Repository<Mesa>) para
  // que @typescript-eslint/unbound-method no los marque como falso
  // positivo al pasarlos sueltos a expect(...). Mismo criterio que
  // productos.service.spec.ts / categorias-producto.service.spec.ts.
  let findMock: jest.Mock;
  let findOneMock: jest.Mock;
  let createMock: jest.Mock;
  let saveMock: jest.Mock;
  let sesionSaveMock: jest.Mock;

  // --- Mocks de la transacción de cerrarSesionActiva ---
  let managerFindOneMock: jest.Mock;
  let managerSaveMock: jest.Mock;
  let startTransactionMock: jest.Mock;
  let commitMock: jest.Mock;
  let rollbackMock: jest.Mock;
  let releaseMock: jest.Mock;
  // Totales que devuelve el saldo compartido (saldo-sesion.util) dentro de
  // la transacción; cada test los ajusta para simular deuda / pago total.
  let totalAdeudado: number;
  let totalPagado: number;

  const mesa = (overrides: Partial<Mesa> = {}): Mesa => ({
    idMesa: 1,
    nombreMesa: 'Mesa 1',
    estado: EstadoMesa.LIBRE,
    borradoEl: null,
    sesiones: [],
    ...overrides,
  });

  const sesion = (overrides: Partial<SesionMesa> = {}): SesionMesa =>
    ({
      idSesion: 10,
      idMesa: 1,
      token: 'token-abc',
      abiertaEl: new Date('2026-01-01T12:00:00Z'),
      cerradaEl: null,
      ...overrides,
    }) as SesionMesa;

  // QueryBuilder encadenable: saldo-sesion.util hace
  // createQueryBuilder(...).innerJoin?.select().where().andWhere?().getRawOne()
  const queryBuilderMock = (total: number) => {
    const qb: Record<string, jest.Mock> = {};
    qb.innerJoin = jest.fn(() => qb);
    qb.select = jest.fn(() => qb);
    qb.where = jest.fn(() => qb);
    qb.andWhere = jest.fn(() => qb);
    qb.getRawOne = jest.fn(() => Promise.resolve({ total }));
    return qb;
  };

  beforeEach(async () => {
    findMock = jest.fn();
    findOneMock = jest.fn();
    createMock = jest.fn((dto: Partial<Mesa>) => dto);
    saveMock = jest.fn();
    sesionSaveMock = jest.fn();

    managerFindOneMock = jest.fn();
    managerSaveMock = jest.fn();
    startTransactionMock = jest.fn();
    commitMock = jest.fn();
    rollbackMock = jest.fn();
    releaseMock = jest.fn();
    totalAdeudado = 0;
    totalPagado = 0;

    const manager = {
      findOne: managerFindOneMock,
      save: managerSaveMock,
      // DetallePedido -> total adeudado; Pago -> total pagado.
      createQueryBuilder: jest.fn((entidad: unknown) =>
        entidad === DetallePedido
          ? queryBuilderMock(totalAdeudado)
          : queryBuilderMock(totalPagado),
      ),
    };

    const dataSourceMock = {
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn(),
        startTransaction: startTransactionMock,
        commitTransaction: commitMock,
        rollbackTransaction: rollbackMock,
        release: releaseMock,
        manager,
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MesasService,
        {
          provide: getRepositoryToken(Mesa),
          useValue: {
            find: findMock,
            findOne: findOneMock,
            create: createMock,
            save: saveMock,
          },
        },
        {
          provide: getRepositoryToken(SesionMesa),
          useValue: { findOne: jest.fn(), save: sesionSaveMock },
        },
        { provide: DataSource, useValue: dataSourceMock },
      ],
    }).compile();

    service = module.get<MesasService>(MesasService);

    // findOne() de MesasService usa createQueryBuilder (para el
    // leftJoinAndSelect de sesión activa), no Repository.findOne — se
    // parchea acá para que create()/update()/cerrarSesionActiva() (que
    // hacen `return this.findOne(id)` al final) puedan resolver sin
    // duplicar ese mock en cada test.
    jest.spyOn(service, 'findOne').mockImplementation((id: number) =>
      Promise.resolve({
        idMesa: id,
        nombreMesa: 'placeholder',
        estado: EstadoMesa.LIBRE,
        sesionActiva: null,
      }),
    );
  });

  /** Deja la transacción resolviendo una mesa + sesión activa concretas. */
  const configurarTransaccion = (
    mesaEnTx: Mesa | null,
    sesionEnTx: SesionMesa | null,
  ) => {
    managerFindOneMock.mockImplementation((entidad: unknown) =>
      Promise.resolve(entidad === Mesa ? mesaEnTx : sesionEnTx),
    );
  };

  describe('create', () => {
    it('crea una mesa con nombre nuevo (sin activas equivalentes)', async () => {
      findMock.mockResolvedValue([]); // sin mesas activas
      saveMock.mockResolvedValue(mesa({ idMesa: 2, nombreMesa: 'Mesa 2' }));

      await service.create({ nombreMesa: 'Mesa 2' });

      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ nombreMesa: 'Mesa 2' }),
      );
    });

    it('rechaza un duplicado con distinto casing/espacios (409)', async () => {
      findMock.mockResolvedValue([mesa({ nombreMesa: 'Mesa 1' })]);

      await expect(
        service.create({ nombreMesa: '  mesa 1  ' }),
      ).rejects.toThrow(ConflictException);
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('una mesa ocupada o con cuenta solicitada sigue reservando el nombre', async () => {
      findMock.mockResolvedValue([
        mesa({ nombreMesa: 'Mesa 1', estado: EstadoMesa.OCUPADA }),
      ]);

      await expect(service.create({ nombreMesa: 'MESA 1' })).rejects.toThrow(
        ConflictException,
      );
      expect(saveMock).not.toHaveBeenCalled();

      findMock.mockResolvedValue([
        mesa({ nombreMesa: 'Mesa 1', estado: EstadoMesa.CUENTA_SOLICITADA }),
      ]);
      await expect(service.create({ nombreMesa: 'MESA 1' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('permite reutilizar el nombre de una mesa soft-deleted (find() ya la excluye)', async () => {
      // find() con @DeleteDateColumn excluye soft-deleted automáticamente:
      // una "Mesa 1" borrada no aparece acá, aunque haya existido antes.
      findMock.mockResolvedValue([]);
      saveMock.mockResolvedValue(mesa({ nombreMesa: 'Mesa 1' }));

      await service.create({ nombreMesa: 'Mesa 1' });

      expect(saveMock).toHaveBeenCalled();
    });

    it('el mensaje de conflicto identifica el nombre de la mesa existente', async () => {
      findMock.mockResolvedValue([mesa({ nombreMesa: 'Mesa 1' })]);

      await expect(service.create({ nombreMesa: 'MESA 1' })).rejects.toThrow(
        'Ya existe una mesa llamada "Mesa 1".',
      );
    });
  });

  describe('update', () => {
    it('rechaza editar una mesa al nombre de otra mesa no eliminada (409)', async () => {
      findOneMock.mockResolvedValue(mesa({ idMesa: 2, nombreMesa: 'Mesa 2' }));
      findMock.mockResolvedValue([mesa({ idMesa: 1, nombreMesa: 'Mesa 1' })]);

      await expect(service.update(2, { nombreMesa: 'mesa 1' })).rejects.toThrow(
        ConflictException,
      );
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('permite editar conservando su propio nombre (excluida del chequeo)', async () => {
      const existente = mesa({ idMesa: 1, nombreMesa: 'Mesa 1' });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ninguna OTRA mesa activa
      saveMock.mockResolvedValue(existente);

      await service.update(1, { nombreMesa: 'Mesa 1' });

      expect(saveMock).toHaveBeenCalled();
    });

    it('permite cambiar el casing/formato del propio nombre si ninguna OTRA mesa activa es equivalente', async () => {
      const existente = mesa({ idMesa: 1, nombreMesa: 'Mesa 1' });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ninguna OTRA mesa activa equivalente
      saveMock.mockResolvedValue({ ...existente, nombreMesa: 'MESA 1' });

      await service.update(1, { nombreMesa: 'MESA 1' });

      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ nombreMesa: 'MESA 1' }),
      );
    });
  });

  describe('remove — regla existente de sesión, sin alterar', () => {
    it('rechaza borrar una mesa ocupada (409), regla preexistente intacta', async () => {
      findOneMock.mockResolvedValue(mesa({ estado: EstadoMesa.OCUPADA }));

      await expect(service.remove(1)).rejects.toThrow(ConflictException);
    });

    it('permite borrar una mesa libre (soft delete), regla preexistente intacta', async () => {
      findOneMock.mockResolvedValue(mesa({ estado: EstadoMesa.LIBRE }));
      const softDeleteMock = jest.fn();
      // Acceso directo al mock del repo (bracket notation) para este único caso.
      service['mesaRepo'].softDelete = softDeleteMock;

      await service.remove(1);

      expect(softDeleteMock).toHaveBeenCalledWith(1);
    });

    it('404 al operar sobre una mesa inexistente, regla preexistente intacta', async () => {
      findOneMock.mockResolvedValue(null);

      await expect(service.remove(99)).rejects.toThrow(NotFoundException);
    });
  });

  describe('cerrarSesionActiva — precondición de saldo', () => {
    it('sesión SIN pedidos (saldo 0) → cierra la sesión y libera la mesa', async () => {
      const mesaEnTx = mesa({ estado: EstadoMesa.OCUPADA });
      const sesionEnTx = sesion();
      configurarTransaccion(mesaEnTx, sesionEnTx);
      totalAdeudado = 0;
      totalPagado = 0;

      await service.cerrarSesionActiva(1);

      expect(sesionEnTx.cerradaEl).toBeInstanceOf(Date);
      expect(mesaEnTx.estado).toBe(EstadoMesa.LIBRE);
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(rollbackMock).not.toHaveBeenCalled();
    });

    it('sesión con pedidos SIN pagar → 409 y no modifica nada', async () => {
      const mesaEnTx = mesa({ estado: EstadoMesa.OCUPADA });
      const sesionEnTx = sesion();
      configurarTransaccion(mesaEnTx, sesionEnTx);
      totalAdeudado = 120.5;
      totalPagado = 0;

      await expect(service.cerrarSesionActiva(1)).rejects.toThrow(
        ConflictException,
      );

      expect(sesionEnTx.cerradaEl).toBeNull();
      expect(mesaEnTx.estado).toBe(EstadoMesa.OCUPADA);
      expect(managerSaveMock).not.toHaveBeenCalled();
      expect(commitMock).not.toHaveBeenCalled();
      expect(rollbackMock).toHaveBeenCalledTimes(1);
    });

    it('el mensaje del 409 informa el saldo pendiente con el formato del proyecto', async () => {
      configurarTransaccion(mesa({ estado: EstadoMesa.OCUPADA }), sesion());
      totalAdeudado = 120.5;
      totalPagado = 20;

      await expect(service.cerrarSesionActiva(1)).rejects.toThrow(
        'No se puede liberar la mesa: tiene un saldo pendiente de Bs 100.50. Registrá el pago completo antes de cerrar la sesión.',
      );
    });

    it('pago PARCIAL → 409 (el saldo remanente sigue bloqueando)', async () => {
      const mesaEnTx = mesa({ estado: EstadoMesa.CUENTA_SOLICITADA });
      const sesionEnTx = sesion();
      configurarTransaccion(mesaEnTx, sesionEnTx);
      totalAdeudado = 100;
      totalPagado = 40;

      await expect(service.cerrarSesionActiva(1)).rejects.toThrow(
        ConflictException,
      );
      expect(sesionEnTx.cerradaEl).toBeNull();
      expect(mesaEnTx.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);
    });

    it('sesión TOTALMENTE pagada → libera (saldo 0 exacto en centavos)', async () => {
      const mesaEnTx = mesa({ estado: EstadoMesa.CUENTA_SOLICITADA });
      const sesionEnTx = sesion();
      configurarTransaccion(mesaEnTx, sesionEnTx);
      // 0.1 + 0.2 en decimales: el cálculo va en centavos, así que cierra.
      totalAdeudado = 0.3;
      totalPagado = 0.3;

      await service.cerrarSesionActiva(1);

      expect(sesionEnTx.cerradaEl).toBeInstanceOf(Date);
      expect(mesaEnTx.estado).toBe(EstadoMesa.LIBRE);
      expect(commitMock).toHaveBeenCalledTimes(1);
    });

    it('pago ANULADO que vuelve a dejar deuda → 409', async () => {
      const mesaEnTx = mesa({ estado: EstadoMesa.CUENTA_SOLICITADA });
      const sesionEnTx = sesion();
      configurarTransaccion(mesaEnTx, sesionEnTx);
      // calcularTotalPagado excluye los anulados: tras anular, el pagado
      // vuelve a 0 aunque exista la fila de Pago.
      totalAdeudado = 100;
      totalPagado = 0;

      await expect(service.cerrarSesionActiva(1)).rejects.toThrow(
        ConflictException,
      );
      expect(sesionEnTx.cerradaEl).toBeNull();
      expect(mesaEnTx.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);
    });

    it('libera desde "ocupada" con saldo 0 (la regla es económica, no de estado)', async () => {
      const mesaEnTx = mesa({ estado: EstadoMesa.OCUPADA });
      configurarTransaccion(mesaEnTx, sesion());
      totalAdeudado = 50;
      totalPagado = 50;

      await service.cerrarSesionActiva(1);

      expect(mesaEnTx.estado).toBe(EstadoMesa.LIBRE);
    });

    it('libera desde "cuenta_solicitada" con saldo 0', async () => {
      const mesaEnTx = mesa({ estado: EstadoMesa.CUENTA_SOLICITADA });
      configurarTransaccion(mesaEnTx, sesion());
      totalAdeudado = 50;
      totalPagado = 50;

      await service.cerrarSesionActiva(1);

      expect(mesaEnTx.estado).toBe(EstadoMesa.LIBRE);
    });

    it('sin sesión activa → 404, conservando el comportamiento actual', async () => {
      configurarTransaccion(mesa({ estado: EstadoMesa.LIBRE }), null);

      await expect(service.cerrarSesionActiva(1)).rejects.toThrow(
        NotFoundException,
      );
      expect(managerSaveMock).not.toHaveBeenCalled();
      expect(rollbackMock).toHaveBeenCalledTimes(1);
    });

    it('mesa inexistente → 404, conservando el comportamiento actual', async () => {
      configurarTransaccion(null, null);

      await expect(service.cerrarSesionActiva(99)).rejects.toThrow(
        NotFoundException,
      );
      expect(managerSaveMock).not.toHaveBeenCalled();
    });

    it('si la sesión ya fue cerrada por otra terminal (recheck bajo el lock) → 404', async () => {
      configurarTransaccion(
        mesa({ estado: EstadoMesa.OCUPADA }),
        sesion({ cerradaEl: new Date('2026-01-01T13:00:00Z') }),
      );

      await expect(service.cerrarSesionActiva(1)).rejects.toThrow(
        NotFoundException,
      );
      expect(managerSaveMock).not.toHaveBeenCalled();
    });

    it('toma lock pessimistic_write sobre la SesionMesa ANTES de calcular el saldo', async () => {
      configurarTransaccion(mesa({ estado: EstadoMesa.OCUPADA }), sesion());
      totalAdeudado = 0;
      totalPagado = 0;

      await service.cerrarSesionActiva(1);

      expect(managerFindOneMock).toHaveBeenCalledWith(
        SesionMesa,
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
    });

    it('cierre de sesión + cambio de estado de la mesa ocurren en la MISMA transacción', async () => {
      const mesaEnTx = mesa({ estado: EstadoMesa.OCUPADA });
      const sesionEnTx = sesion();
      configurarTransaccion(mesaEnTx, sesionEnTx);
      totalAdeudado = 30;
      totalPagado = 30;

      await service.cerrarSesionActiva(1);

      // Ambas escrituras pasan por el manager de la transacción...
      expect(startTransactionMock).toHaveBeenCalledTimes(1);
      expect(managerSaveMock).toHaveBeenCalledTimes(2);
      expect(managerSaveMock).toHaveBeenCalledWith(sesionEnTx);
      expect(managerSaveMock).toHaveBeenCalledWith(mesaEnTx);
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(releaseMock).toHaveBeenCalledTimes(1);
      // ...y NINGUNA por los repositorios sueltos (que quedarían fuera de la
      // transacción, que es exactamente el estado a medio escribir que este
      // cambio elimina).
      expect(saveMock).not.toHaveBeenCalled();
      expect(sesionSaveMock).not.toHaveBeenCalled();
    });

    it('libera el queryRunner incluso cuando falla con 409', async () => {
      configurarTransaccion(mesa({ estado: EstadoMesa.OCUPADA }), sesion());
      totalAdeudado = 10;
      totalPagado = 0;

      await expect(service.cerrarSesionActiva(1)).rejects.toThrow(
        ConflictException,
      );
      expect(releaseMock).toHaveBeenCalledTimes(1);
    });
  });
});
