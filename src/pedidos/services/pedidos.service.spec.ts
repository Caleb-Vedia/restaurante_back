import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { PedidosService } from './pedidos.service';
import { Pedido } from '../entities/pedido.entity';
import { Producto } from '../../productos/entities/producto.entity';
import { AreaProducto } from '../../productos/entities/area-producto.entity';
import { SesionesMesaService } from '../../mesas/services/sesiones-mesa.service';
import { MesasService } from '../../mesas/services/mesas.service';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { EstadoPedido } from '../../common/enums/estado-pedido.enum';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';

describe('PedidosService', () => {
  let service: PedidosService;
  // Mocks tipados como jest.Mock (no como métodos de Repository/Service) para
  // que @typescript-eslint/unbound-method no los marque como falso positivo
  // al pasarlos sueltos a expect(...).
  let managerFindOneMock: jest.Mock;
  let managerFindMock: jest.Mock;
  let obtenerSesionActivaPorTokenMock: jest.Mock;
  let mesasFindOneMock: jest.Mock;

  const sesion = (overrides: Partial<SesionMesa> = {}): SesionMesa =>
    ({
      idSesion: 10,
      idMesa: 1,
      token: 'token-valido',
      abiertaEl: new Date('2026-08-22T12:00:00Z'),
      cerradaEl: null,
      ...overrides,
    }) as SesionMesa;

  const pedido = (overrides: Partial<Pedido> = {}): Pedido =>
    ({
      idPedido: 5,
      idSesion: 10,
      nombreComensal: 'Mesa 3 - Juan',
      estado: EstadoPedido.PENDIENTE,
      nroOrden: 1,
      creadoEl: new Date('2026-08-22T12:05:00Z'),
      detallesPedido: [],
      ...overrides,
    }) as Pedido;

  const mesaConSesion = (
    overrides: Partial<{
      idMesa: number;
      nombreMesa: string;
      estado: EstadoMesa;
      idSesion: number;
      abiertaEl: Date;
    }> = {},
  ) => ({
    idMesa: overrides.idMesa ?? 1,
    nombreMesa: overrides.nombreMesa ?? 'Mesa 1',
    estado: overrides.estado ?? EstadoMesa.OCUPADA,
    sesionActiva: {
      idSesion: overrides.idSesion ?? 10,
      abiertaEl: overrides.abiertaEl ?? new Date('2026-08-22T09:50:00Z'),
    },
  });

  beforeEach(async () => {
    managerFindOneMock = jest.fn();
    managerFindMock = jest.fn();
    obtenerSesionActivaPorTokenMock = jest.fn();
    mesasFindOneMock = jest.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PedidosService,
        {
          provide: getRepositoryToken(Pedido),
          useValue: {
            manager: { findOne: managerFindOneMock, find: managerFindMock },
          },
        },
        {
          provide: getRepositoryToken(Producto),
          useValue: {},
        },
        {
          provide: getRepositoryToken(AreaProducto),
          useValue: {},
        },
        {
          provide: SesionesMesaService,
          useValue: {
            obtenerSesionActivaPorToken: obtenerSesionActivaPorTokenMock,
          },
        },
        {
          provide: MesasService,
          useValue: { findOne: mesasFindOneMock },
        },
        {
          provide: DataSource,
          useValue: {},
        },
      ],
    }).compile();

    service = module.get<PedidosService>(PedidosService);
  });

  describe('listarPedidosDeSesion', () => {
    it('sesión válida con varios pedidos → devuelve todos', async () => {
      obtenerSesionActivaPorTokenMock.mockResolvedValue(sesion());
      managerFindMock.mockResolvedValue([
        pedido({ idPedido: 5, nroOrden: 1 }),
        pedido({ idPedido: 6, nroOrden: 2 }),
      ]);

      const resultado = await service.listarPedidosDeSesion('token-valido');

      expect(resultado).toHaveLength(2);
      expect(resultado.map((p) => p.idPedido)).toEqual([5, 6]);
    });

    it('consulta únicamente por idSesion de la sesión resuelta (nunca por idMesa)', async () => {
      obtenerSesionActivaPorTokenMock.mockResolvedValue(
        sesion({ idSesion: 42 }),
      );
      managerFindMock.mockResolvedValue([]);

      await service.listarPedidosDeSesion('token-valido');

      expect(managerFindMock).toHaveBeenCalledWith(
        Pedido,
        expect.objectContaining({ where: { idSesion: 42 } }),
      );
    });

    it('sesión válida sin pedidos → array vacío', async () => {
      obtenerSesionActivaPorTokenMock.mockResolvedValue(sesion());
      managerFindMock.mockResolvedValue([]);

      const resultado = await service.listarPedidosDeSesion('token-valido');

      expect(resultado).toEqual([]);
    });

    it('lanza 401 si falta el token', async () => {
      await expect(service.listarPedidosDeSesion(undefined)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(obtenerSesionActivaPorTokenMock).not.toHaveBeenCalled();
      expect(managerFindMock).not.toHaveBeenCalled();
    });

    it('lanza 401 si el token no resuelve a ninguna sesión activa (inválido o sesión cerrada)', async () => {
      obtenerSesionActivaPorTokenMock.mockRejectedValue(
        new UnauthorizedException('Sesión no encontrada o inválida'),
      );

      await expect(
        service.listarPedidosDeSesion('token-cerrado-o-invalido'),
      ).rejects.toThrow(UnauthorizedException);
      expect(managerFindMock).not.toHaveBeenCalled();
    });

    it('funciona con la mesa en "cuenta_solicitada" (la resolución del token no depende del estado de la mesa)', async () => {
      obtenerSesionActivaPorTokenMock.mockResolvedValue(
        sesion({ idSesion: 10 }),
      );
      managerFindMock.mockResolvedValue([pedido()]);

      const resultado = await service.listarPedidosDeSesion('token-valido');

      // El propio mock de obtenerSesionActivaPorToken es lo único que
      // decidiría rechazar por estado de mesa, y acá no lo hace — confirma
      // que listarPedidosDeSesion no agrega ninguna restricción de estado
      // por su cuenta (a diferencia de crearPedido).
      expect(resultado).toHaveLength(1);
    });

    it('conserva detalles, cantidades y observación de cada pedido', async () => {
      obtenerSesionActivaPorTokenMock.mockResolvedValue(sesion());
      managerFindMock.mockResolvedValue([
        pedido({
          detallesPedido: [
            {
              idDetalle: 100,
              idProducto: 7,
              producto: { nombreProducto: 'Silpancho' },
              cantidad: 2,
              precioActual: 35,
              observacion: 'sin cebolla',
            },
            {
              idDetalle: 101,
              idProducto: 8,
              producto: { nombreProducto: 'Coca Cola' },
              cantidad: 1,
              precioActual: 10,
              observacion: null,
            },
          ],
        } as never),
      ]);

      const [resultado] = await service.listarPedidosDeSesion('token-valido');

      expect(resultado.detalles).toEqual([
        {
          idDetalle: 100,
          idProducto: 7,
          nombreProducto: 'Silpancho',
          cantidad: 2,
          precioActual: 35,
          observacion: 'sin cebolla',
        },
        {
          idDetalle: 101,
          idProducto: 8,
          nombreProducto: 'Coca Cola',
          cantidad: 1,
          precioActual: 10,
          observacion: null,
        },
      ]);
    });
  });

  describe('obtenerPedidoDeCliente', () => {
    it('devuelve el PedidoResponse cuando el pedido pertenece a la sesión del token', async () => {
      obtenerSesionActivaPorTokenMock.mockResolvedValue(sesion());
      managerFindOneMock.mockResolvedValue(pedido());

      const resultado = await service.obtenerPedidoDeCliente('token-valido', 5);

      expect(resultado).toEqual({
        idPedido: 5,
        nroOrden: 1,
        nombreComensal: 'Mesa 3 - Juan',
        estado: EstadoPedido.PENDIENTE,
        creadoEl: pedido().creadoEl,
        detalles: [],
      });
      // No debe filtrar idSesion/idMesa/token en la respuesta.
      expect(resultado).not.toHaveProperty('idSesion');
      expect(resultado).not.toHaveProperty('idMesa');
      expect(resultado).not.toHaveProperty('token');
    });

    it('lanza 404 si el pedido no existe', async () => {
      obtenerSesionActivaPorTokenMock.mockResolvedValue(sesion());
      managerFindOneMock.mockResolvedValue(null);

      await expect(
        service.obtenerPedidoDeCliente('token-valido', 999),
      ).rejects.toThrow(NotFoundException);
    });

    it('lanza 404 (no 403) si el pedido pertenece a otra sesión', async () => {
      obtenerSesionActivaPorTokenMock.mockResolvedValue(
        sesion({ idSesion: 10 }),
      );
      managerFindOneMock.mockResolvedValue(pedido({ idSesion: 999 }));

      await expect(
        service.obtenerPedidoDeCliente('token-valido', 5),
      ).rejects.toThrow(NotFoundException);
    });

    it('lanza 401 si el token no resuelve a ninguna sesión activa (inválido o sesión cerrada)', async () => {
      obtenerSesionActivaPorTokenMock.mockRejectedValue(
        new UnauthorizedException('Sesión no encontrada o inválida'),
      );

      await expect(
        service.obtenerPedidoDeCliente('token-cerrado-o-invalido', 5),
      ).rejects.toThrow(UnauthorizedException);
      expect(managerFindOneMock).not.toHaveBeenCalled();
    });

    it('lanza 401 si falta el token', async () => {
      await expect(
        service.obtenerPedidoDeCliente(undefined, 5),
      ).rejects.toThrow(UnauthorizedException);
      expect(obtenerSesionActivaPorTokenMock).not.toHaveBeenCalled();
      expect(managerFindOneMock).not.toHaveBeenCalled();
    });
  });

  describe('obtenerConsumoActualDeMesa', () => {
    it('mesa con sesión activa y 2 pedidos → los devuelve en orden, con idMesa/nombreMesa/idSesion/abiertaEl', async () => {
      mesasFindOneMock.mockResolvedValue(
        mesaConSesion({ idMesa: 1, nombreMesa: 'Mesa 1', idSesion: 10 }),
      );
      managerFindMock.mockResolvedValue([
        pedido({ idPedido: 5, nroOrden: 1 }),
        pedido({ idPedido: 6, nroOrden: 2 }),
      ]);

      const resultado = await service.obtenerConsumoActualDeMesa(1);

      expect(resultado.idMesa).toBe(1);
      expect(resultado.nombreMesa).toBe('Mesa 1');
      expect(resultado.idSesion).toBe(10);
      expect(resultado.abiertaEl).toEqual(new Date('2026-08-22T09:50:00Z'));
      expect(resultado.pedidos.map((p) => p.idPedido)).toEqual([5, 6]);
    });

    it('consulta los pedidos por idSesion de la sesión activa resuelta (nunca por idMesa)', async () => {
      mesasFindOneMock.mockResolvedValue(mesaConSesion({ idSesion: 42 }));
      managerFindMock.mockResolvedValue([]);

      await service.obtenerConsumoActualDeMesa(1);

      expect(managerFindMock).toHaveBeenCalledWith(
        Pedido,
        expect.objectContaining({ where: { idSesion: 42 } }),
      );
    });

    it('cada pedido conserva detalles con cantidad, precio congelado, observación y estado', async () => {
      mesasFindOneMock.mockResolvedValue(mesaConSesion());
      managerFindMock.mockResolvedValue([
        pedido({
          estado: EstadoPedido.PREPARACION,
          detallesPedido: [
            {
              idDetalle: 100,
              idProducto: 7,
              producto: { nombreProducto: 'Sopa de Maní' },
              cantidad: 1,
              precioActual: 25,
              observacion: 'Sin: perejil',
            },
            {
              idDetalle: 101,
              idProducto: 9,
              producto: { nombreProducto: 'Lapping' },
              cantidad: 1,
              precioActual: 40,
              observacion: 'Sin: perejil\nNota: salsa aparte',
            },
          ],
        } as never),
      ]);

      const resultado = await service.obtenerConsumoActualDeMesa(1);

      expect(resultado.pedidos[0].estado).toBe(EstadoPedido.PREPARACION);
      expect(resultado.pedidos[0].detalles).toEqual([
        {
          idDetalle: 100,
          idProducto: 7,
          nombreProducto: 'Sopa de Maní',
          cantidad: 1,
          precioActual: 25,
          observacion: 'Sin: perejil',
        },
        {
          idDetalle: 101,
          idProducto: 9,
          nombreProducto: 'Lapping',
          cantidad: 1,
          precioActual: 40,
          observacion: 'Sin: perejil\nNota: salsa aparte',
        },
      ]);
    });

    it('la personalización (Sin:/Nota:) se devuelve intacta, sin parsear', async () => {
      mesasFindOneMock.mockResolvedValue(mesaConSesion());
      managerFindMock.mockResolvedValue([
        pedido({
          detallesPedido: [
            {
              idDetalle: 100,
              idProducto: 7,
              producto: { nombreProducto: 'Silpancho' },
              cantidad: 1,
              precioActual: 35,
              observacion: 'Sin: perejil\nNota: salsa aparte',
            },
          ],
        } as never),
      ]);

      const resultado = await service.obtenerConsumoActualDeMesa(1);

      expect(resultado.pedidos[0].detalles[0].observacion).toBe(
        'Sin: perejil\nNota: salsa aparte',
      );
    });

    it('producto cuyo precio actual cambió: Caja recibe el precio CONGELADO del detalle, no el vigente', async () => {
      mesasFindOneMock.mockResolvedValue(mesaConSesion());
      managerFindMock.mockResolvedValue([
        pedido({
          detallesPedido: [
            {
              idDetalle: 100,
              idProducto: 7,
              // El producto "actual" tiene otro precio (ej. subió de 25 a
              // 30): el detalle guarda el precio de cuando se pidió.
              producto: { nombreProducto: 'Sopa de Maní', precio: 30 },
              cantidad: 1,
              precioActual: 25,
              observacion: null,
            },
          ],
        } as never),
      ]);

      const resultado = await service.obtenerConsumoActualDeMesa(1);

      expect(resultado.pedidos[0].detalles[0].precioActual).toBe(25);
    });

    it('sesión activa iniciada antes del turno actual: devuelve el consumo completo (no filtra por Caja)', async () => {
      // La sesión abrió a las 09:50; no se le pasa nada relativo a Caja al
      // service — obtenerConsumoActualDeMesa no conoce CierreCaja en
      // absoluto, así que no hay forma de que filtre por turno.
      mesasFindOneMock.mockResolvedValue(
        mesaConSesion({ abiertaEl: new Date('2026-08-22T09:50:00Z') }),
      );
      managerFindMock.mockResolvedValue([
        pedido({ idPedido: 1, creadoEl: new Date('2026-08-22T09:55:00Z') }),
        pedido({ idPedido: 2, creadoEl: new Date('2026-08-22T10:10:00Z') }),
      ]);

      const resultado = await service.obtenerConsumoActualDeMesa(1);

      expect(resultado.pedidos.map((p) => p.idPedido)).toEqual([1, 2]);
    });

    it('sin sesión activa/cobrable → 404, sin consultar pedidos', async () => {
      mesasFindOneMock.mockResolvedValue({
        idMesa: 3,
        nombreMesa: 'Mesa 3',
        estado: EstadoMesa.LIBRE,
        sesionActiva: null,
      });

      await expect(service.obtenerConsumoActualDeMesa(3)).rejects.toThrow(
        NotFoundException,
      );
      expect(managerFindMock).not.toHaveBeenCalled();
    });

    it('mesa inexistente → propaga el 404 de MesasService.findOne', async () => {
      mesasFindOneMock.mockRejectedValue(
        new NotFoundException('Mesa 999 no encontrada'),
      );

      await expect(service.obtenerConsumoActualDeMesa(999)).rejects.toThrow(
        NotFoundException,
      );
      expect(managerFindMock).not.toHaveBeenCalled();
    });

    it('dos sesiones históricas de la misma mesa: no mezcla pedidos de visitas anteriores con la actual', async () => {
      // mesasFindOneMock ya resuelve la sesión ACTUAL (idSesion 10); el mock
      // de pedidos solo devuelve lo que manager.find fue llamado a buscar —
      // simula que la query real filtró por ese idSesion y dejó afuera los
      // pedidos de sesiones anteriores (7, 8) de la misma mesa.
      mesasFindOneMock.mockResolvedValue(mesaConSesion({ idSesion: 10 }));
      managerFindMock.mockImplementation(
        (_entidad: unknown, opts: { where: { idSesion: number } }) =>
          Promise.resolve(
            opts.where.idSesion === 10 ? [pedido({ idPedido: 50 })] : [],
          ),
      );

      const resultado = await service.obtenerConsumoActualDeMesa(1);

      expect(resultado.pedidos.map((p) => p.idPedido)).toEqual([50]);
    });

    it('mesa en CUENTA_SOLICITADA: sigue devolviendo el consumo de su sesión activa', async () => {
      mesasFindOneMock.mockResolvedValue(
        mesaConSesion({ estado: EstadoMesa.CUENTA_SOLICITADA }),
      );
      managerFindMock.mockResolvedValue([pedido()]);

      const resultado = await service.obtenerConsumoActualDeMesa(1);

      expect(resultado.pedidos).toHaveLength(1);
    });

    it('no ejecuta ninguna escritura: es una lectura pura', async () => {
      // El mock de pedidoRepo.manager (ver beforeEach) solo define findOne y
      // find — ni save ni update existen en él. Si el método intentara
      // escribir algo, la llamada explotaría acá mismo (`.save is not a
      // function`) en vez de resolver limpio.
      mesasFindOneMock.mockResolvedValue(mesaConSesion());
      managerFindMock.mockResolvedValue([pedido()]);

      await expect(
        service.obtenerConsumoActualDeMesa(1),
      ).resolves.toBeDefined();
    });
  });
});
