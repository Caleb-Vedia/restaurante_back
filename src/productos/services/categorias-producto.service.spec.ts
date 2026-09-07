import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CategoriasProductoService } from './categorias-producto.service';
import { CategoriaProducto } from '../entities/categoria-producto.entity';

describe('CategoriasProductoService', () => {
  let service: CategoriasProductoService;
  // Mocks tipados como jest.Mock (no como métodos de Repository<CategoriaProducto>)
  // para que @typescript-eslint/unbound-method no los marque como falso
  // positivo al pasarlos sueltos a expect(...).
  let findMock: jest.Mock;
  let findOneMock: jest.Mock;
  let createMock: jest.Mock;
  let saveMock: jest.Mock;

  const categoria = (
    overrides: Partial<CategoriaProducto> = {},
  ): CategoriaProducto => ({
    idCategoriaProducto: 1,
    nombreCategoria: 'Entradas',
    borradoEl: null,
    ...overrides,
  });

  beforeEach(async () => {
    findMock = jest.fn();
    findOneMock = jest.fn();
    createMock = jest.fn((dto: Partial<CategoriaProducto>) => dto);
    saveMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriasProductoService,
        {
          provide: getRepositoryToken(CategoriaProducto),
          useValue: {
            find: findMock,
            findOne: findOneMock,
            create: createMock,
            save: saveMock,
          },
        },
      ],
    }).compile();

    service = module.get<CategoriasProductoService>(CategoriasProductoService);
  });

  describe('create', () => {
    it('crea una categoría con nombre nuevo (sin activas equivalentes)', async () => {
      findMock.mockResolvedValue([]); // sin categorías activas
      saveMock.mockResolvedValue(categoria({ nombreCategoria: 'Postres' }));

      const resultado = await service.create({ nombreCategoria: 'Postres' });

      expect(resultado.nombreCategoria).toBe('Postres');
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ nombreCategoria: 'Postres' }),
      );
    });

    it('rechaza un duplicado con distinto casing/espacios (409)', async () => {
      findMock.mockResolvedValue([categoria({ nombreCategoria: 'Entradas' })]);

      await expect(
        service.create({ nombreCategoria: '  entradas  ' }),
      ).rejects.toThrow(ConflictException);
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('permite reutilizar el nombre de una categoría soft-deleted (find() ya la excluye)', async () => {
      // find() con @DeleteDateColumn excluye soft-deleted automáticamente:
      // una "Entradas" borrada no aparece acá, aunque haya existido antes.
      findMock.mockResolvedValue([]);
      saveMock.mockResolvedValue(categoria({ nombreCategoria: 'Entradas' }));

      const resultado = await service.create({ nombreCategoria: 'Entradas' });

      expect(resultado.nombreCategoria).toBe('Entradas');
      expect(saveMock).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rechaza editar una categoría al nombre de otra categoría activa (409)', async () => {
      findOneMock.mockResolvedValue(
        categoria({ idCategoriaProducto: 2, nombreCategoria: 'Postres' }),
      );
      findMock.mockResolvedValue([
        categoria({ idCategoriaProducto: 1, nombreCategoria: 'Entradas' }),
      ]);

      await expect(
        service.update(2, { nombreCategoria: 'entradas' }),
      ).rejects.toThrow(ConflictException);
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('permite editar conservando su propio nombre (excluida del chequeo)', async () => {
      const existente = categoria({
        idCategoriaProducto: 1,
        nombreCategoria: 'Entradas',
      });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ninguna OTRA categoría activa
      saveMock.mockResolvedValue(existente);

      const resultado = await service.update(1, {
        nombreCategoria: 'Entradas',
      });

      expect(resultado.nombreCategoria).toBe('Entradas');
      expect(saveMock).toHaveBeenCalled();
    });

    it('permite cambiar el casing/formato del propio nombre si ninguna OTRA categoría activa es equivalente', async () => {
      const existente = categoria({
        idCategoriaProducto: 1,
        nombreCategoria: 'Entradas',
      });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ninguna OTRA categoría activa equivalente
      saveMock.mockResolvedValue({ ...existente, nombreCategoria: 'ENTRADAS' });

      const resultado = await service.update(1, {
        nombreCategoria: 'ENTRADAS',
      });

      expect(resultado.nombreCategoria).toBe('ENTRADAS');
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ nombreCategoria: 'ENTRADAS' }),
      );
    });
  });
});
