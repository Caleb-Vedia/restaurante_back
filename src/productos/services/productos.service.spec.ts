import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProductosService } from './productos.service';
import { Producto } from '../entities/producto.entity';
import { AreaProducto } from '../entities/area-producto.entity';
import { CategoriaProducto } from '../entities/categoria-producto.entity';
import { IngredienteProducto } from '../entities/ingrediente-producto.entity';

describe('ProductosService', () => {
  let service: ProductosService;
  // Mocks tipados como jest.Mock (no como métodos de Repository<Producto>)
  // para que @typescript-eslint/unbound-method no los marque como falso
  // positivo al pasarlos sueltos a expect(...). Mismo criterio que
  // categorias-producto.service.spec.ts.
  let findMock: jest.Mock;
  let findOneMock: jest.Mock;
  let createMock: jest.Mock;
  let saveMock: jest.Mock;
  let areaCountMock: jest.Mock;
  let categoriaCountMock: jest.Mock;

  const producto = (overrides: Partial<Producto> = {}): Producto =>
    ({
      idProducto: 1,
      idAreaProducto: 1,
      idCategoriaProducto: 1,
      nombreProducto: 'Sopa de Mani',
      descripcion: null,
      precio: 25,
      urlImagen: null,
      disponible: true,
      borradoEl: null,
      ingredientes: [],
      ...overrides,
    }) as Producto;

  beforeEach(async () => {
    findMock = jest.fn();
    findOneMock = jest.fn();
    createMock = jest.fn((dto: Partial<Producto>) => dto);
    saveMock = jest.fn();
    areaCountMock = jest.fn().mockResolvedValue(1);
    categoriaCountMock = jest.fn().mockResolvedValue(1);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductosService,
        {
          provide: getRepositoryToken(Producto),
          useValue: {
            find: findMock,
            findOne: findOneMock,
            create: createMock,
            save: saveMock,
          },
        },
        {
          provide: getRepositoryToken(AreaProducto),
          useValue: { count: areaCountMock },
        },
        {
          provide: getRepositoryToken(CategoriaProducto),
          useValue: { count: categoriaCountMock },
        },
        {
          provide: getRepositoryToken(IngredienteProducto),
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<ProductosService>(ProductosService);
  });

  const createDto = (nombreProducto: string) => ({
    nombreProducto,
    precio: 25,
    idAreaProducto: 1,
    idCategoriaProducto: 1,
  });

  describe('create', () => {
    it('crea un producto con nombre nuevo (sin activos equivalentes)', async () => {
      findMock.mockResolvedValue([]); // sin productos activos
      findOneMock.mockResolvedValue(
        producto({ nombreProducto: 'Pique Macho' }),
      );
      saveMock.mockResolvedValue(producto({ nombreProducto: 'Pique Macho' }));

      const resultado = await service.create(createDto('Pique Macho'));

      expect(resultado.nombreProducto).toBe('Pique Macho');
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ nombreProducto: 'Pique Macho' }),
      );
    });

    it('rechaza un duplicado con distinto casing/espacios (409)', async () => {
      findMock.mockResolvedValue([
        producto({ nombreProducto: 'Sopa de Mani' }),
      ]);

      await expect(
        service.create(createDto('  sopa de mani  ')),
      ).rejects.toThrow(ConflictException);
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('rechaza un duplicado aunque esté en otra categoría (unicidad GLOBAL)', async () => {
      findMock.mockResolvedValue([
        producto({ nombreProducto: 'Sopa de Mani', idCategoriaProducto: 1 }),
      ]);

      await expect(
        service.create({
          ...createDto('Sopa de Mani'),
          idCategoriaProducto: 2,
        }),
      ).rejects.toThrow(ConflictException);
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('rechaza un duplicado aunque el producto existente esté desactivado (disponible=false)', async () => {
      findMock.mockResolvedValue([
        producto({ nombreProducto: 'Sopa de Mani', disponible: false }),
      ]);

      await expect(service.create(createDto('Sopa de Mani'))).rejects.toThrow(
        ConflictException,
      );
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('permite reutilizar el nombre de un producto soft-deleted (find() ya lo excluye)', async () => {
      // find() con @DeleteDateColumn excluye soft-deleted automáticamente:
      // un "Sopa de Mani" borrado no aparece acá, aunque haya existido antes.
      findMock.mockResolvedValue([]);
      findOneMock.mockResolvedValue(
        producto({ nombreProducto: 'Sopa de Mani' }),
      );
      saveMock.mockResolvedValue(producto({ nombreProducto: 'Sopa de Mani' }));

      const resultado = await service.create(createDto('Sopa de Mani'));

      expect(resultado.nombreProducto).toBe('Sopa de Mani');
      expect(saveMock).toHaveBeenCalled();
    });

    it('el mensaje de conflicto identifica el nombre del producto existente', async () => {
      findMock.mockResolvedValue([producto({ nombreProducto: 'Pique Macho' })]);

      await expect(service.create(createDto('PIQUE MACHO'))).rejects.toThrow(
        'Ya existe un producto llamado "Pique Macho".',
      );
    });
  });

  describe('update', () => {
    it('rechaza editar un producto al nombre de otro producto no eliminado (409)', async () => {
      findOneMock.mockResolvedValue(
        producto({ idProducto: 2, nombreProducto: 'Pique Macho' }),
      );
      findMock.mockResolvedValue([
        producto({ idProducto: 1, nombreProducto: 'Sopa de Mani' }),
      ]);

      await expect(
        service.update(2, { nombreProducto: 'sopa de mani' }),
      ).rejects.toThrow(ConflictException);
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('permite editar conservando su propio nombre (excluido del chequeo)', async () => {
      const existente = producto({
        idProducto: 1,
        nombreProducto: 'Sopa de Mani',
      });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ningún OTRO producto activo
      saveMock.mockResolvedValue(existente);

      const resultado = await service.update(1, {
        nombreProducto: 'Sopa de Mani',
      });

      expect(resultado.nombreProducto).toBe('Sopa de Mani');
      expect(saveMock).toHaveBeenCalled();
    });

    it('permite cambiar el casing/formato del propio nombre si ningún OTRO producto activo es equivalente', async () => {
      const existente = producto({
        idProducto: 1,
        nombreProducto: 'Sopa de Mani',
      });
      findOneMock.mockResolvedValue(existente);
      findMock.mockResolvedValue([]); // ningún OTRO producto activo equivalente
      saveMock.mockResolvedValue({
        ...existente,
        nombreProducto: 'SOPA DE MANI',
      });

      const resultado = await service.update(1, {
        nombreProducto: 'SOPA DE MANI',
      });

      expect(resultado.nombreProducto).toBe('SOPA DE MANI');
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ nombreProducto: 'SOPA DE MANI' }),
      );
    });
  });
});
