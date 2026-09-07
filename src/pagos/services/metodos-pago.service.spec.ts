import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { MetodosPagoService } from './metodos-pago.service';
import { MetodoPago } from '../entities/metodo-pago.entity';

describe('MetodosPagoService', () => {
  let service: MetodosPagoService;
  // Mocks tipados como jest.Mock (no como métodos de Repository<MetodoPago>)
  // para que @typescript-eslint/unbound-method no los marque como falso
  // positivo al pasarlos sueltos a expect(...).
  let findOneMock: jest.Mock;
  let findMock: jest.Mock;
  let createMock: jest.Mock;
  let saveMock: jest.Mock;
  let softDeleteMock: jest.Mock;

  const metodo = (overrides: Partial<MetodoPago> = {}): MetodoPago => ({
    idMetodoPago: 1,
    nombreMetodo: 'Efectivo',
    codigo: null,
    borradoEl: null,
    ...overrides,
  });

  beforeEach(async () => {
    findOneMock = jest.fn();
    findMock = jest.fn();
    createMock = jest.fn((dto: Partial<MetodoPago>) => dto);
    saveMock = jest.fn();
    softDeleteMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MetodosPagoService,
        {
          provide: getRepositoryToken(MetodoPago),
          useValue: {
            findOne: findOneMock,
            find: findMock,
            create: createMock,
            save: saveMock,
            softDelete: softDeleteMock,
          },
        },
      ],
    }).compile();

    service = module.get<MetodosPagoService>(MetodosPagoService);
  });

  describe('create — unicidad de nombreMetodo', () => {
    it('crea un método con nombre nuevo (sin activos equivalentes)', async () => {
      findMock.mockResolvedValue([]); // sin métodos activos
      saveMock.mockResolvedValue(
        metodo({ idMetodoPago: 2, nombreMetodo: 'QR' }),
      );

      await service.create({ nombreMetodo: 'QR' });

      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ nombreMetodo: 'QR' }),
      );
    });

    it('rechaza un duplicado con distinto casing/espacios (409)', async () => {
      findMock.mockResolvedValue([metodo({ nombreMetodo: 'QR' })]);

      await expect(service.create({ nombreMetodo: '  qr  ' })).rejects.toThrow(
        ConflictException,
      );
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('el mensaje de conflicto identifica el nombre del método existente', async () => {
      findMock.mockResolvedValue([metodo({ nombreMetodo: 'QR' })]);

      await expect(service.create({ nombreMetodo: 'qr' })).rejects.toThrow(
        'Ya existe un método de pago llamado "QR".',
      );
    });

    it('permite reutilizar el nombre de un método soft-deleted (find() ya lo excluye)', async () => {
      // find() con @DeleteDateColumn excluye soft-deleted automáticamente:
      // un "QR" borrado no aparece acá, aunque haya existido antes.
      findMock.mockResolvedValue([]);
      saveMock.mockResolvedValue(metodo({ nombreMetodo: 'QR' }));

      await service.create({ nombreMetodo: 'QR' });

      expect(saveMock).toHaveBeenCalled();
    });

    it('la unicidad no depende de `codigo`: un duplicado sin `codigo` se rechaza igual', async () => {
      findMock.mockResolvedValue([
        metodo({ nombreMetodo: 'Efectivo', codigo: 'efectivo' }),
      ]);

      await expect(
        service.create({ nombreMetodo: 'EFECTIVO' }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update — unicidad de nombreMetodo', () => {
    it('rechaza editar un método al nombre de otro método no eliminado (409)', async () => {
      findOneMock.mockResolvedValue(
        metodo({ idMetodoPago: 2, nombreMetodo: 'Tarjeta' }),
      );
      findMock.mockResolvedValue([
        metodo({ idMetodoPago: 1, nombreMetodo: 'QR' }),
      ]);

      await expect(service.update(2, { nombreMetodo: 'qr' })).rejects.toThrow(
        ConflictException,
      );
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('permite editar conservando su propio nombre (excluido del chequeo)', async () => {
      const existente = metodo({ idMetodoPago: 1, nombreMetodo: 'QR' });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ningún OTRO método activo
      saveMock.mockResolvedValue(existente);

      await service.update(1, { nombreMetodo: 'QR' });

      expect(saveMock).toHaveBeenCalled();
    });

    it('permite cambiar el casing/formato del propio nombre si ningún OTRO método activo es equivalente', async () => {
      const existente = metodo({ idMetodoPago: 1, nombreMetodo: 'QR' });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ningún OTRO método activo equivalente
      saveMock.mockResolvedValue({ ...existente, nombreMetodo: 'qr' });

      await service.update(1, { nombreMetodo: 'qr' });

      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ nombreMetodo: 'qr' }),
      );
    });

    it('la regla NO usa `codigo`: renombrar el método "efectivo" (sin colisión de nombre) sigue permitido', async () => {
      const existente = metodo({
        idMetodoPago: 1,
        nombreMetodo: 'Efectivo',
        codigo: 'efectivo',
      });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ningún OTRO método activo con ese nombre
      saveMock.mockResolvedValue({
        ...existente,
        nombreMetodo: 'Efectivo caja',
      });

      await service.update(1, { nombreMetodo: 'Efectivo caja' });

      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          nombreMetodo: 'Efectivo caja',
          codigo: 'efectivo', // `codigo` no se toca ni se usa para esta validación
        }),
      );
    });
  });

  describe('remove', () => {
    it('elimina (soft-delete) un método normal con código null', async () => {
      const metodo: MetodoPago = {
        idMetodoPago: 2,
        nombreMetodo: 'Tarjeta',
        codigo: null,
        borradoEl: null,
      };
      findOneMock.mockResolvedValue(metodo);

      await service.remove(2);

      expect(softDeleteMock).toHaveBeenCalledWith(2);
    });

    it('elimina (soft-delete) un método normal con otro código', async () => {
      const metodo: MetodoPago = {
        idMetodoPago: 3,
        nombreMetodo: 'QR / Transferencia',
        codigo: 'qr',
        borradoEl: null,
      };
      findOneMock.mockResolvedValue(metodo);

      await service.remove(3);

      expect(softDeleteMock).toHaveBeenCalledWith(3);
    });

    it('rechaza eliminar el método con codigo "efectivo" y no llama a softDelete', async () => {
      const metodo: MetodoPago = {
        idMetodoPago: 1,
        nombreMetodo: 'Efectivo',
        codigo: 'efectivo',
        borradoEl: null,
      };
      findOneMock.mockResolvedValue(metodo);

      await expect(service.remove(1)).rejects.toThrow(ConflictException);
      expect(softDeleteMock).not.toHaveBeenCalled();
    });

    it('la regla depende de `codigo`, no de `nombreMetodo`: un método renombrado a "Efectivo" sin ese código sigue siendo eliminable', async () => {
      const metodo: MetodoPago = {
        idMetodoPago: 4,
        nombreMetodo: 'Efectivo',
        codigo: null,
        borradoEl: null,
      };
      findOneMock.mockResolvedValue(metodo);

      await service.remove(4);

      expect(softDeleteMock).toHaveBeenCalledWith(4);
    });

    it('lanza 404 si el método no existe', async () => {
      findOneMock.mockResolvedValue(null);

      await expect(service.remove(999)).rejects.toThrow(NotFoundException);
      expect(softDeleteMock).not.toHaveBeenCalled();
    });
  });
});
