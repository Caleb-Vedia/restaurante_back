import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SesionesMesaService } from './sesiones-mesa.service';
import { Mesa } from '../entities/mesa.entity';
import { SesionMesa } from '../entities/sesion-mesa.entity';
import { Pedido } from '../../pedidos/entities/pedido.entity';
import { CierreCaja } from '../../caja/entities/cierre-caja.entity';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';

describe('SesionesMesaService', () => {
  let service: SesionesMesaService;
  // Mocks tipados como jest.Mock (no como métodos de Repository<T>) para
  // que @typescript-eslint/unbound-method no los marque como falso
  // positivo al pasarlos sueltos a expect(...). Mismo criterio que
  // mesas.service.spec.ts.
  let sesionFindOneMock: jest.Mock;

  // pedirCuenta pasó a correr en una transacción con locks (sincronización
  // con el cierre de caja): sus lecturas y su escritura ya no van por los
  // repositorios sino por el manager del queryRunner, así que los mocks que
  // importan son estos.
  let managerFindOneMock: jest.Mock;
  let managerCountMock: jest.Mock;
  let managerUpdateMock: jest.Mock;
  let queryRunner: {
    connect: jest.Mock;
    startTransaction: jest.Mock;
    commitTransaction: jest.Mock;
    rollbackTransaction: jest.Mock;
    release: jest.Mock;
    manager: {
      findOne: jest.Mock;
      count: jest.Mock;
      update: jest.Mock;
    };
  };

  const mesa = (overrides: Partial<Mesa> = {}): Mesa => ({
    idMesa: 1,
    nombreMesa: 'Mesa 1',
    estado: EstadoMesa.OCUPADA,
    borradoEl: null,
    sesiones: [],
    ...overrides,
  });

  const sesionActiva = (overrides: Partial<SesionMesa> = {}): SesionMesa =>
    ({
      idSesion: 10,
      idMesa: 1,
      token: 'token-valido',
      abiertaEl: new Date('2026-01-01T12:00:00Z'),
      cerradaEl: null,
      mesa: mesa(),
      ...overrides,
    }) as SesionMesa;

  /**
   * Configura el manager de la transacción: qué devuelve cada findOne según
   * la entidad. `cajaAbierta` modela si hay un turno abierto para lockear.
   */
  const configurarTransaccion = (opciones: {
    sesionBajoLock?: SesionMesa | null;
    mesaBajoLock?: Mesa | null;
    cajaAbierta?: boolean;
  }) => {
    managerFindOneMock.mockImplementation((entidad: unknown) => {
      if (entidad === CierreCaja) {
        return Promise.resolve(
          opciones.cajaAbierta === false
            ? null
            : { idCierre: 1, cerradoEl: null },
        );
      }
      if (entidad === SesionMesa) {
        return Promise.resolve(opciones.sesionBajoLock ?? null);
      }
      if (entidad === Mesa) {
        return Promise.resolve(opciones.mesaBajoLock ?? null);
      }
      return Promise.resolve(null);
    });
  };

  beforeEach(async () => {
    sesionFindOneMock = jest.fn();
    managerFindOneMock = jest.fn();
    managerCountMock = jest.fn();
    managerUpdateMock = jest.fn().mockResolvedValue({ affected: 1 });

    queryRunner = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        findOne: managerFindOneMock,
        count: managerCountMock,
        update: managerUpdateMock,
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SesionesMesaService,
        {
          provide: getRepositoryToken(Mesa),
          useValue: { findOne: jest.fn(), save: jest.fn() },
        },
        {
          provide: getRepositoryToken(SesionMesa),
          useValue: {
            findOne: sesionFindOneMock,
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(Pedido),
          useValue: { count: jest.fn() },
        },
        {
          provide: DataSource,
          useValue: { createQueryRunner: jest.fn(() => queryRunner) },
        },
      ],
    }).compile();

    service = module.get<SesionesMesaService>(SesionesMesaService);
  });

  describe('pedirCuenta', () => {
    it('rechaza (409) una sesión activa sin ningún pedido, sin cambiar la mesa', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva(),
        mesaBajoLock: mesa(),
      });
      managerCountMock.mockResolvedValue(0);

      await expect(service.pedirCuenta('token-valido')).rejects.toThrow(
        ConflictException,
      );
      expect(managerUpdateMock).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(queryRunner.commitTransaction).not.toHaveBeenCalled();
    });

    it('el mensaje del 409 por falta de consumo es el específico pedido', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva(),
        mesaBajoLock: mesa(),
      });
      managerCountMock.mockResolvedValue(0);

      await expect(service.pedirCuenta('token-valido')).rejects.toThrow(
        'No hay consumos registrados en esta mesa. Realizá un pedido antes de solicitar la cuenta.',
      );
    });

    it('la mesa permanece "ocupada" tras el 409 por falta de consumo', async () => {
      const mesaBajoLock = mesa();
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva(),
        mesaBajoLock,
      });
      managerCountMock.mockResolvedValue(0);

      await expect(service.pedirCuenta('token-valido')).rejects.toThrow(
        ConflictException,
      );

      expect(mesaBajoLock.estado).toBe(EstadoMesa.OCUPADA);
      expect(managerUpdateMock).not.toHaveBeenCalled();
    });

    it('con al menos un pedido registrado, pasa la mesa a "cuenta_solicitada"', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva(),
        mesaBajoLock: mesa(),
      });
      managerCountMock.mockResolvedValue(1);

      const resultado = await service.pedirCuenta('token-valido');

      expect(resultado).toEqual({
        idMesa: 1,
        estado: EstadoMesa.CUENTA_SOLICITADA,
      });
      expect(managerUpdateMock).toHaveBeenCalledWith(
        Mesa,
        { idMesa: 1 },
        { estado: EstadoMesa.CUENTA_SOLICITADA },
      );
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('consulta pedidos por idSesion de la sesión activa', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva({ idSesion: 42 }));
      configurarTransaccion({
        sesionBajoLock: sesionActiva({ idSesion: 42 }),
        mesaBajoLock: mesa(),
      });
      managerCountMock.mockResolvedValue(1);

      await service.pedirCuenta('token-valido');

      expect(managerCountMock).toHaveBeenCalledWith(Pedido, {
        where: { idSesion: 42 },
      });
    });

    it('valida token faltante (401), regla preexistente intacta', async () => {
      await expect(service.pedirCuenta(undefined)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(managerCountMock).not.toHaveBeenCalled();
      // Ni siquiera abre transacción.
      expect(queryRunner.startTransaction).not.toHaveBeenCalled();
    });

    it('valida token inválido/sesión no encontrada (401), regla preexistente intacta', async () => {
      sesionFindOneMock.mockResolvedValue(null);

      await expect(service.pedirCuenta('token-inexistente')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(managerCountMock).not.toHaveBeenCalled();
      expect(queryRunner.startTransaction).not.toHaveBeenCalled();
    });

    it('valida estado de mesa distinto de "ocupada" (409), regla preexistente intacta — sin ni siquiera consultar pedidos', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva(),
        mesaBajoLock: mesa({ estado: EstadoMesa.CUENTA_SOLICITADA }),
      });

      await expect(service.pedirCuenta('token-valido')).rejects.toThrow(
        ConflictException,
      );
      expect(managerCountMock).not.toHaveBeenCalled();
      expect(managerUpdateMock).not.toHaveBeenCalled();
    });

    // --- Sincronización con el cierre de caja (Etapa 7) ---

    it('toma el lock del cierre abierto ANTES que el de la sesión y el de la mesa', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva(),
        mesaBajoLock: mesa(),
      });
      managerCountMock.mockResolvedValue(1);

      await service.pedirCuenta('token-valido');

      const llamadas = managerFindOneMock.mock.calls as Array<
        [unknown, { lock?: unknown } | undefined]
      >;
      const posicion = (entidad: unknown) =>
        llamadas.findIndex(
          ([entidadLlamada, opciones]) =>
            entidadLlamada === entidad && opciones?.lock,
        );

      // Orden global de locks: CierreCaja -> SesionMesa -> Mesa.
      expect(posicion(CierreCaja)).toBe(0);
      expect(posicion(SesionMesa)).toBeGreaterThan(posicion(CierreCaja));
      expect(posicion(Mesa)).toBeGreaterThan(posicion(SesionMesa));

      // Los tres con el mismo modo.
      for (const entidad of [CierreCaja, SesionMesa, Mesa]) {
        expect(managerFindOneMock).toHaveBeenCalledWith(
          entidad,
          expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
        );
      }
    });

    it('SIN caja abierta la cuenta se pide igual: no es una regla nueva del Cliente', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva(),
        mesaBajoLock: mesa(),
        cajaAbierta: false,
      });
      managerCountMock.mockResolvedValue(1);

      const resultado = await service.pedirCuenta('token-valido');

      expect(resultado.estado).toBe(EstadoMesa.CUENTA_SOLICITADA);
      expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it('si la sesión se cerró entre la validación del token y el lock → 401 y rollback', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva({ cerradaEl: new Date() }),
        mesaBajoLock: mesa(),
      });

      await expect(service.pedirCuenta('token-valido')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(managerUpdateMock).not.toHaveBeenCalled();
      expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it('libera el queryRunner tanto en éxito como en error', async () => {
      sesionFindOneMock.mockResolvedValue(sesionActiva());
      configurarTransaccion({
        sesionBajoLock: sesionActiva(),
        mesaBajoLock: mesa(),
      });
      managerCountMock.mockResolvedValue(1);
      await service.pedirCuenta('token-valido');
      expect(queryRunner.release).toHaveBeenCalledTimes(1);

      managerCountMock.mockResolvedValue(0);
      await expect(service.pedirCuenta('token-valido')).rejects.toThrow(
        ConflictException,
      );
      expect(queryRunner.release).toHaveBeenCalledTimes(2);
    });
  });
});
