import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UsuariosService } from './usuarios.service';
import { Usuario } from '../entities/usuario.entity';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';

describe('UsuariosService', () => {
  let service: UsuariosService;
  // Mocks tipados como jest.Mock (no como métodos de Repository<Usuario>)
  // para que @typescript-eslint/unbound-method no los marque como falso
  // positivo al pasarlos sueltos a expect(...).
  let findOneMock: jest.Mock;
  let countMock: jest.Mock;
  let createMock: jest.Mock;
  let saveMock: jest.Mock;
  // assertEmailDisponible usa createQueryBuilder (LOWER(TRIM(email)), no
  // Repository.count con where exacto) — se mockea la cadena
  // where/andWhere/getOne encadenable; `getOneMock` resuelve la fila
  // "duplicada" (o null) en cada test.
  let getOneMock: jest.Mock;
  let whereMock: jest.Mock;
  let andWhereMock: jest.Mock;

  const admin = (overrides: Partial<Usuario> = {}): Usuario => ({
    idUsuario: 1,
    nombre: 'Admin Uno',
    email: 'admin@dinemetrix.test',
    passwordHash: 'hash',
    rol: RolUsuario.ADMIN,
    activo: true,
    telefono: null,
    ...overrides,
  });

  const caja = (overrides: Partial<Usuario> = {}): Usuario => ({
    idUsuario: 2,
    nombre: 'Cajera Uno',
    email: 'caja@dinemetrix.test',
    passwordHash: 'hash',
    rol: RolUsuario.CAJA,
    activo: true,
    telefono: null,
    ...overrides,
  });

  beforeEach(async () => {
    findOneMock = jest.fn();
    countMock = jest.fn();
    createMock = jest.fn((dto: Partial<Usuario>) => dto);
    saveMock = jest.fn();
    getOneMock = jest.fn().mockResolvedValue(null); // por defecto: sin duplicado
    whereMock = jest.fn().mockReturnThis();
    andWhereMock = jest.fn().mockReturnThis();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsuariosService,
        {
          provide: getRepositoryToken(Usuario),
          useValue: {
            findOne: findOneMock,
            count: countMock,
            create: createMock,
            save: saveMock,
            createQueryBuilder: jest.fn(() => ({
              where: whereMock,
              andWhere: andWhereMock,
              getOne: getOneMock,
            })),
          },
        },
      ],
    }).compile();

    service = module.get<UsuariosService>(UsuariosService);
  });

  const createDto = (
    overrides: Partial<{
      nombre: string;
      email: string;
      password: string;
      rol: RolUsuario;
      telefono?: string;
    }> = {},
  ) => ({
    nombre: 'Nuevo Usuario',
    email: 'nuevo@dinemetrix.test',
    password: 'password123',
    rol: RolUsuario.CAJA,
    ...overrides,
  });

  describe('create — email', () => {
    it('crea un usuario con email nuevo (sin duplicado)', async () => {
      saveMock.mockResolvedValue(
        admin({ idUsuario: 3, email: 'nuevo@dinemetrix.test' }),
      );

      const resultado = await service.create(createDto());

      expect(resultado.email).toBe('nuevo@dinemetrix.test');
      expect(saveMock).toHaveBeenCalled();
    });

    it('el email se guarda normalizado (trim + lowercase), sin importar cómo lo tipeó el admin', async () => {
      saveMock.mockImplementation((usuario: Partial<Usuario>) =>
        Promise.resolve(usuario),
      );

      const resultado = await service.create(
        createDto({ email: '  JUAN@Gmail.com  ' }),
      );

      expect(resultado.email).toBe('juan@gmail.com');
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'juan@gmail.com' }),
      );
    });

    it('rechaza crear "JUAN@gmail.com" si ya existe "juan@gmail.com" (409)', async () => {
      getOneMock.mockResolvedValue(admin({ email: 'juan@gmail.com' }));

      await expect(
        service.create(createDto({ email: 'JUAN@gmail.com' })),
      ).rejects.toThrow(ConflictException);
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('el mensaje de conflicto usa el email normalizado', async () => {
      getOneMock.mockResolvedValue(admin({ email: 'juan@gmail.com' }));

      await expect(
        service.create(createDto({ email: '  Juan@Gmail.com' })),
      ).rejects.toThrow('Ya existe un usuario con el email "juan@gmail.com".');
    });
  });

  describe('create — telefono', () => {
    it('crea un usuario sin teléfono (queda null)', async () => {
      saveMock.mockImplementation((usuario: Partial<Usuario>) =>
        Promise.resolve(usuario),
      );

      const resultado = await service.create(createDto());

      expect(resultado.telefono).toBeNull();
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ telefono: null }),
      );
    });

    it('crea un usuario con teléfono y lo persiste', async () => {
      saveMock.mockImplementation((usuario: Partial<Usuario>) =>
        Promise.resolve(usuario),
      );

      const resultado = await service.create(
        createDto({ telefono: '+591 700 12345' }),
      );

      expect(resultado.telefono).toBe('+591 700 12345');
      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({ telefono: '+591 700 12345' }),
      );
    });
  });

  describe('update — email', () => {
    it('permite editar conservando su propio email (sin chequear duplicados)', async () => {
      const usuario = admin({ email: 'admin@dinemetrix.test' });
      findOneMock.mockResolvedValue(usuario);
      saveMock.mockResolvedValue(usuario);

      const resultado = await service.update(1, {
        email: 'admin@dinemetrix.test',
      });

      expect(resultado.email).toBe('admin@dinemetrix.test');
      expect(getOneMock).not.toHaveBeenCalled();
      expect(saveMock).toHaveBeenCalled();
    });

    it('permite cambiar solo casing/espacios del propio email y queda normalizado', async () => {
      const usuario = admin({ email: 'admin@dinemetrix.test' });
      findOneMock.mockResolvedValue(usuario);
      saveMock.mockImplementation((u: Usuario) => Promise.resolve(u));

      const resultado = await service.update(1, {
        email: '  ADMIN@Dinemetrix.Test  ',
      });

      expect(resultado.email).toBe('admin@dinemetrix.test');
      expect(getOneMock).not.toHaveBeenCalled();
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'admin@dinemetrix.test' }),
      );
    });

    it('rechaza editar al email de otro usuario no eliminado (409)', async () => {
      const usuario = caja({ email: 'caja@dinemetrix.test' });
      findOneMock.mockResolvedValue(usuario);
      getOneMock.mockResolvedValue(admin({ email: 'admin@dinemetrix.test' }));

      await expect(
        service.update(2, { email: 'ADMIN@dinemetrix.test' }),
      ).rejects.toThrow(ConflictException);
      expect(saveMock).not.toHaveBeenCalled();
    });
  });

  describe('update — telefono', () => {
    it('actualiza el teléfono y lo persiste', async () => {
      const usuario = admin({ telefono: null });
      findOneMock.mockResolvedValue(usuario);
      saveMock.mockImplementation((u: Usuario) => Promise.resolve(u));

      const resultado = await service.update(1, { telefono: '76543210' });

      expect(resultado.telefono).toBe('76543210');
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ telefono: '76543210' }),
      );
    });

    it('no toca el teléfono si no viene en el DTO', async () => {
      const usuario = admin({ telefono: '76543210' });
      findOneMock.mockResolvedValue(usuario);
      saveMock.mockImplementation((u: Usuario) => Promise.resolve(u));

      const resultado = await service.update(1, { nombre: 'Admin Renombrado' });

      expect(resultado.telefono).toBe('76543210');
    });
  });

  describe('toggleActivo', () => {
    it('rechaza desactivar al último admin activo (409)', async () => {
      findOneMock.mockResolvedValue(admin());
      countMock.mockResolvedValue(0); // no hay otros admins activos

      await expect(service.toggleActivo(1, { activo: false })).rejects.toThrow(
        ConflictException,
      );
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('permite desactivar un admin cuando existe otro admin activo', async () => {
      const usuario = admin();
      findOneMock.mockResolvedValue(usuario);
      countMock.mockResolvedValue(1); // otro admin activo distinto
      saveMock.mockResolvedValue({ ...usuario, activo: false });

      const resultado = await service.toggleActivo(1, { activo: false });

      expect(resultado.activo).toBe(false);
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ activo: false }),
      );
    });

    it('permite desactivar un usuario no-admin sin consultar el invariante de admins', async () => {
      const usuario = caja();
      findOneMock.mockResolvedValue(usuario);
      saveMock.mockResolvedValue({ ...usuario, activo: false });

      const resultado = await service.toggleActivo(2, { activo: false });

      expect(resultado.activo).toBe(false);
      expect(countMock).not.toHaveBeenCalled();
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ activo: false }),
      );
    });
  });

  describe('update (cambio de rol)', () => {
    it('rechaza quitarle el rol admin al último admin activo (409)', async () => {
      findOneMock.mockResolvedValue(admin());
      countMock.mockResolvedValue(0);

      await expect(service.update(1, { rol: RolUsuario.CAJA })).rejects.toThrow(
        ConflictException,
      );
      expect(saveMock).not.toHaveBeenCalled();
    });

    it('permite cambiar el rol de un admin cuando existe otro admin activo', async () => {
      const usuario = admin();
      findOneMock.mockResolvedValue(usuario);
      countMock.mockResolvedValue(1);
      saveMock.mockResolvedValue({ ...usuario, rol: RolUsuario.CAJA });

      const resultado = await service.update(1, { rol: RolUsuario.CAJA });

      expect(resultado.rol).toBe(RolUsuario.CAJA);
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ rol: RolUsuario.CAJA }),
      );
    });

    it('permite cambiar el rol de un usuario no-admin sin consultar el invariante de admins', async () => {
      const usuario = caja();
      findOneMock.mockResolvedValue(usuario);
      saveMock.mockResolvedValue({ ...usuario, rol: RolUsuario.BEBIDAS });

      const resultado = await service.update(2, { rol: RolUsuario.BEBIDAS });

      expect(resultado.rol).toBe(RolUsuario.BEBIDAS);
      expect(countMock).not.toHaveBeenCalled();
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({ rol: RolUsuario.BEBIDAS }),
      );
    });
  });
});
