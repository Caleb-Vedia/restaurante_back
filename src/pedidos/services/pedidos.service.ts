import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { Pedido } from '../entities/pedido.entity';
import { DetallePedido } from '../entities/detalle-pedido.entity';
import { Producto } from '../../productos/entities/producto.entity';
import { AreaProducto } from '../../productos/entities/area-producto.entity';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { SesionesMesaService } from '../../mesas/services/sesiones-mesa.service';
import { MesasService } from '../../mesas/services/mesas.service';
import { lockearCajaAbierta } from '../../common/utils/caja-abierta.util';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { EstadoPedido } from '../../common/enums/estado-pedido.enum';
import { RolUsuario } from '../../common/enums/rol-usuario.enum';
import type { UsuarioAutenticado } from '../../common/guards/jwt-auth.guard';
import { CreatePedidoDto } from '../dto/create-pedido.dto';
import { CambiarEstadoPedidoDto } from '../dto/cambiar-estado-pedido.dto';
import {
  ConsumoSesionResponse,
  PedidoKdsResponse,
  PedidoResponse,
} from '../dto/pedido-response.dto';
import { toPedidoResponse } from '../dto/pedido-response.mapper';

// El KDS expone dos rutas fijas (/pedidos/cocina, /pedidos/bebidas). Se
// resuelven por `areas_producto.codigo` (columna interna, no editable vía API
// — ver AreaProducto), no por `nombre_area`: el admin puede renombrar
// libremente "Cocina" a cualquier cosa sin romper el KDS (decisión #17).
const CODIGO_AREA_COCINA = 'cocina';
const CODIGO_AREA_BEBIDAS = 'bebidas';

// Transiciones permitidas (decisión #17): solo hacia adelante. Se admite el
// salto pendiente → listo para ítems que no tienen etapa real de preparación
// (ej. una bebida embotellada), sin obligar al KDS a un doble toque inútil.
const TRANSICIONES_PERMITIDAS: Record<EstadoPedido, EstadoPedido[]> = {
  [EstadoPedido.PENDIENTE]: [EstadoPedido.PREPARACION, EstadoPedido.LISTO],
  [EstadoPedido.PREPARACION]: [EstadoPedido.LISTO],
  [EstadoPedido.LISTO]: [],
};

@Injectable()
export class PedidosService {
  constructor(
    @InjectRepository(Pedido)
    private readonly pedidoRepo: Repository<Pedido>,
    @InjectRepository(Producto)
    private readonly productoRepo: Repository<Producto>,
    @InjectRepository(AreaProducto)
    private readonly areaRepo: Repository<AreaProducto>,
    private readonly sesionesMesaService: SesionesMesaService,
    // Solo para resolver "¿cuál es la sesión activa de esta mesa?" en
    // obtenerConsumoActualDeMesa (staff). Ya estaba disponible sin wiring
    // nuevo: MesasModule exporta MesasService y PedidosModule ya lo importa
    // (para SesionesMesaService, resolución del X-Table-Token).
    private readonly mesasService: MesasService,
    private readonly dataSource: DataSource,
  ) {}

  // --- Cliente (público, identificado por X-Table-Token) ---

  async crearPedido(
    token: string | undefined,
    dto: CreatePedidoDto,
  ): Promise<PedidoResponse> {
    if (!token) {
      throw new UnauthorizedException('Sesión no encontrada o inválida');
    }

    // Reusa la validación de token del módulo Mesas (no se duplica acá).
    const sesion =
      await this.sesionesMesaService.obtenerSesionActivaPorToken(token);

    // Regla: con la cuenta ya pedida no entran pedidos nuevos.
    if (sesion.mesa.estado !== EstadoMesa.OCUPADA) {
      throw new ConflictException(
        sesion.mesa.estado === EstadoMesa.CUENTA_SOLICITADA
          ? 'Ya se solicitó la cuenta para esta mesa: no se aceptan pedidos nuevos.'
          : `No se pueden crear pedidos: la mesa está en estado "${sesion.mesa.estado}".`,
      );
    }

    const productosPorId = await this.validarProductosDelPedido(dto);
    // Valida de paso que el pedido no mezcle áreas (cocina/bebidas).
    this.derivarAreaUnica([...productosPorId.values()]);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      // Regla (Caja 2.0): sin caja abierta no entran pedidos nuevos. El turno
      // es la ventana operativa del restaurante; un pedido registrado fuera de
      // ella no tendría cierre que lo contabilice ni caja que lo cobre.
      //
      // Va DENTRO de esta transacción y con FOR UPDATE sobre la fila del cierre
      // abierto —el mismo lock que toma CierresCajaService.cerrarCaja y sostiene
      // hasta su commit— porque una comprobación suelta dejaba la carrera
      // "crearPedido ve caja abierta -> cerrarCaja cierra -> crearPedido
      // inserta el pedido". Con el lock solo quedan dos desenlaces:
      //   - gana el pedido: el cierre espera acá, y el pedido queda creado
      //     dentro del turno que seguía abierto;
      //   - gana el cierre: este SELECT espera y, al reevaluar la fila ya
      //     actualizada (EvalPlanQual, READ COMMITTED), deja de cumplir
      //     `cerrado_el IS NULL` -> 409 y no se escribe ni Pedido ni detalle.
      // Ver el detalle completo en lockearCajaAbierta (caja-abierta.util).
      //
      // Es el PRIMER lock de la transacción, antes del de SesionMesa: fija el
      // orden CierreCaja -> SesionMesa, el mismo que ya usa
      // PagosService.registrarCobroEnTransaccion, así que no aparece ningún
      // ciclo nuevo (el orden global es CierreCaja -> Pago -> SesionMesa ->
      // Mesa, y este flujo solo usa el primero y el tercero, en ese orden).
      //
      // Encontrar la caja cerrada NO toca la sesión: no la cierra, no libera la
      // mesa, no invalida el token. Solo aborta ESTE pedido — la sesión puede
      // atravesar el cambio de turno y volver a pedir cuando se abra el
      // siguiente.
      const cajaAbierta = await lockearCajaAbierta(queryRunner.manager);
      if (!cajaAbierta) {
        throw new ConflictException(
          'No se pueden registrar pedidos en este momento porque Caja está cerrada.',
        );
      }

      // Lock pesimista sobre la fila de la sesión: serializa el cálculo del
      // correlativo entre comensales que envían pedidos casi simultáneos, para
      // que no salgan dos pedidos con el mismo nroOrden en la misma sesión.
      const sesionBloqueada = await queryRunner.manager.findOne(SesionMesa, {
        where: { idSesion: sesion.idSesion },
        lock: { mode: 'pessimistic_write' },
      });
      // Recheck bajo el lock: la sesión pudo cerrarse entre la validación del
      // token y este punto.
      if (!sesionBloqueada || sesionBloqueada.cerradaEl !== null) {
        throw new UnauthorizedException('Sesión no encontrada o inválida');
      }

      const nroOrden = await this.siguienteNroOrden(
        queryRunner.manager,
        sesion.idSesion,
      );

      const pedido = await queryRunner.manager.save(
        queryRunner.manager.create(Pedido, {
          idSesion: sesion.idSesion,
          nombreComensal: dto.nombreComensal ?? null,
          nroOrden,
        }),
      );

      const detalles = dto.items.map((item) => {
        const producto = this.obtenerProductoValidado(
          productosPorId,
          item.idProducto,
        );
        return queryRunner.manager.create(DetallePedido, {
          idPedido: pedido.idPedido,
          idProducto: producto.idProducto,
          cantidad: item.cantidad,
          // Precio congelado al momento del pedido.
          precioActual: producto.precio,
          observacion: item.observacion ?? null,
        });
      });
      await queryRunner.manager.save(detalles);

      // Se arma la respuesta dentro de la transacción (ve sus propias
      // escrituras) para devolver estado y creadoEl tal como quedaron en la
      // base, en vez de reconstruirlos en memoria.
      const respuesta = await this.construirPedidoResponse(
        queryRunner.manager,
        pedido.idPedido,
      );

      await queryRunner.commitTransaction();
      return respuesta;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // Mis pedidos: TODOS los pedidos de la sesión activa del token, para que
  // el cliente pueda revisar todo lo que pidió durante la visita. Ownership
  // por idSesion (nunca por idMesa): la resolución del token ya garantiza
  // "mi sesión", así que filtrar por idSesion alcanza para nunca exponer
  // pedidos de otra sesión — no hace falta un chequeo posterior como en
  // obtenerPedidoDeCliente (ahí sí hace falta, porque ese método parte de
  // un idPedido ajeno a la sesión).
  //
  // Funciona en `cuenta_solicitada` igual que en `ocupada`: reusa
  // obtenerSesionActivaPorToken, que solo exige `cerradaEl IS NULL` — nunca
  // mira `mesa.estado` (esa regla es exclusiva de crearPedido, para bloquear
  // pedidos NUEVOS, no lecturas).
  //
  // Mismas relaciones/orden/withDeleted que buscarPedidoConDetalles (ver
  // comentario ahí) y el mismo toPedidoResponse — ninguna transformación
  // paralela.
  async listarPedidosDeSesion(
    token: string | undefined,
  ): Promise<PedidoResponse[]> {
    if (!token) {
      throw new UnauthorizedException('Sesión no encontrada o inválida');
    }

    const sesion =
      await this.sesionesMesaService.obtenerSesionActivaPorToken(token);

    const pedidos = await this.buscarPedidosDeSesion(
      this.pedidoRepo.manager,
      sesion.idSesion,
    );

    return pedidos.map((pedido) => toPedidoResponse(pedido));
  }

  // --- Staff (Caja/Admin, autenticado por JWT — nunca X-Table-Token) ---

  // Consumo actual de la mesa: todos los pedidos de su sesión ACTIVA, para
  // que Caja entienda de dónde sale el saldo antes de cobrar. "Sesión actual"
  // se define igual que en Pagos (ver PagosService.obtenerSesionActivaDeMesa
  // / GET /pagos/total/:idMesa): la única con `cerradaEl IS NULL` — la MISMA
  // sesión sobre la que Caja puede cobrar en este momento, nunca una visita
  // ya cerrada. MesasService.findOne ya resuelve exactamente eso (mesa +
  // sesión activa en una sola query, vía leftJoin) sin duplicar esa lógica
  // acá; reusarlo evita una tabla nueva y un segundo criterio de "sesión
  // actual" que pudiera divergir del que ya usa Pagos.
  //
  // Sin sesión activa (mesa libre, o la última sesión ya cerró) → 404, igual
  // que GET /pagos/total/:idMesa: no hay "consumo actual" que mostrar, y
  // devolver la última sesión HISTÓRICA sería mezclar la visita ya cobrada
  // con la que Caja gestiona ahora.
  //
  // Deliberadamente NO filtra por CierreCaja.abiertoEl: una sesión puede
  // haber empezado en el turno anterior y seguir activa — Caja necesita ver
  // la deuda completa de la visita, no solo lo pedido durante el turno en
  // curso (eso es "Actividad del turno", fuera de esta etapa).
  //
  // READ-ONLY real: ni un solo `save`/`update`/lock acá. No toca Pedido,
  // SesionMesa ni Mesa.
  async obtenerConsumoActualDeMesa(
    idMesa: number,
  ): Promise<ConsumoSesionResponse> {
    // findOne ya lanza 404 ("Mesa X no encontrada") si la mesa no existe.
    const mesa = await this.mesasService.findOne(idMesa);
    if (!mesa.sesionActiva) {
      throw new NotFoundException(
        `La mesa ${idMesa} no tiene una sesión abierta`,
      );
    }

    const pedidos = await this.buscarPedidosDeSesion(
      this.pedidoRepo.manager,
      mesa.sesionActiva.idSesion,
    );

    return {
      idMesa: mesa.idMesa,
      nombreMesa: mesa.nombreMesa,
      idSesion: mesa.sesionActiva.idSesion,
      abiertaEl: mesa.sesionActiva.abiertaEl,
      pedidos: pedidos.map((pedido) => toPedidoResponse(pedido)),
    };
  }

  // Tracking del pedido para el cliente: mismo token que usó para crearlo.
  // Ownership por idSesion, no por idMesa/token — un pedido de otra sesión
  // responde 404 (nunca 403), para no confirmar su existencia a quien no es
  // dueño. Sesión cerrada = token inválido, resuelto por
  // obtenerSesionActivaPorToken (no hace falta lógica extra acá).
  async obtenerPedidoDeCliente(
    token: string | undefined,
    idPedido: number,
  ): Promise<PedidoResponse> {
    if (!token) {
      throw new UnauthorizedException('Sesión no encontrada o inválida');
    }

    const sesion =
      await this.sesionesMesaService.obtenerSesionActivaPorToken(token);

    const pedido = await this.buscarPedidoConDetalles(
      this.pedidoRepo.manager,
      idPedido,
    );
    if (pedido.idSesion !== sesion.idSesion) {
      throw new NotFoundException(`Pedido ${idPedido} no encontrado`);
    }

    return toPedidoResponse(pedido);
  }

  // --- KDS (personal de cocina / bebidas) ---

  listarKdsCocina(): Promise<PedidoKdsResponse[]> {
    return this.listarKdsPorArea(CODIGO_AREA_COCINA);
  }

  listarKdsBebidas(): Promise<PedidoKdsResponse[]> {
    return this.listarKdsPorArea(CODIGO_AREA_BEBIDAS);
  }

  async cambiarEstado(
    idPedido: number,
    dto: CambiarEstadoPedidoDto,
    usuario: UsuarioAutenticado,
  ): Promise<PedidoResponse> {
    const pedido = await this.buscarPedidoConDetalles(
      this.pedidoRepo.manager,
      idPedido,
    );

    // El admin puede forzar cualquier estado (override operativo). El personal
    // de KDS solo toca pedidos de su propia área y solo hacia adelante.
    if (usuario.rol !== RolUsuario.ADMIN) {
      await this.assertPedidoEsDelAreaDelRol(pedido, usuario.rol);
      this.assertTransicionValida(pedido.estado, dto.estado);
    }

    await this.pedidoRepo.update(idPedido, { estado: dto.estado });
    pedido.estado = dto.estado;
    return toPedidoResponse(pedido);
  }

  // --- Validaciones de creación ---

  // Todo o nada: si un solo producto no existe o no está disponible, se
  // rechaza el pedido completo. Devuelve los productos indexados por id.
  private async validarProductosDelPedido(
    dto: CreatePedidoDto,
  ): Promise<Map<number, Producto>> {
    const idsPedidos = [...new Set(dto.items.map((item) => item.idProducto))];

    // find() excluye soft-deleted automáticamente (@DeleteDateColumn).
    const productos = await this.productoRepo.find({
      where: { idProducto: In(idsPedidos) },
      relations: { areaProducto: true },
    });
    const productosPorId = new Map(
      productos.map((producto) => [producto.idProducto, producto]),
    );

    const inexistentes = idsPedidos.filter((id) => !productosPorId.has(id));
    if (inexistentes.length > 0) {
      throw new BadRequestException(
        `Pedido rechazado: los productos ${inexistentes.join(', ')} no existen o fueron dados de baja.`,
      );
    }

    const noDisponibles = productos.filter((producto) => !producto.disponible);
    if (noDisponibles.length > 0) {
      const nombres = noDisponibles
        .map((producto) => producto.nombreProducto)
        .join(', ');
      throw new ConflictException(
        `Pedido rechazado: no hay disponibilidad de ${nombres}. Actualizá el menú y volvé a intentar.`,
      );
    }

    return productosPorId;
  }

  // Deriva el área única de un conjunto de productos y falla si se mezclaron
  // (regla de área única por pedido). Se reusa en la creación y al validar
  // rol vs. área en el cambio de estado.
  private derivarAreaUnica(productos: Producto[]): number {
    const areasPorId = new Map<number, string>();
    for (const producto of productos) {
      areasPorId.set(
        producto.idAreaProducto,
        producto.areaProducto?.nombreArea ?? `área ${producto.idAreaProducto}`,
      );
    }

    if (areasPorId.size === 0) {
      throw new ConflictException(
        'El pedido no tiene ítems: no se puede determinar su área.',
      );
    }
    if (areasPorId.size > 1) {
      throw new BadRequestException(
        `Un pedido no puede mezclar áreas (se mezclaron: ${[...areasPorId.values()].join(', ')}). Enviá un pedido separado por cada área.`,
      );
    }
    return [...areasPorId.keys()][0];
  }

  private obtenerProductoValidado(
    productosPorId: Map<number, Producto>,
    idProducto: number,
  ): Producto {
    const producto = productosPorId.get(idProducto);
    if (!producto) {
      // Inalcanzable: validarProductosDelPedido ya rechazó los faltantes.
      throw new BadRequestException(`Producto ${idProducto} no disponible`);
    }
    return producto;
  }

  // Correlativo por SESIÓN de mesa (no global ni por día). Se llama siempre
  // bajo el lock pesimista de la sesión.
  private async siguienteNroOrden(
    manager: EntityManager,
    idSesion: number,
  ): Promise<number> {
    const fila = await manager
      .createQueryBuilder(Pedido, 'pedido')
      .select('MAX(pedido.nroOrden)', 'max')
      .where('pedido.idSesion = :idSesion', { idSesion })
      .getRawOne<{ max: string | number | null }>();
    return Number(fila?.max ?? 0) + 1;
  }

  // --- Validaciones de cambio de estado ---

  private async assertPedidoEsDelAreaDelRol(
    pedido: Pedido,
    rol: RolUsuario,
  ): Promise<void> {
    let codigoAreaDelRol: string;
    if (rol === RolUsuario.COCINA) {
      codigoAreaDelRol = CODIGO_AREA_COCINA;
    } else if (rol === RolUsuario.BEBIDAS) {
      codigoAreaDelRol = CODIGO_AREA_BEBIDAS;
    } else {
      // RolesGuard ya restringe el endpoint a cocina/bebidas/admin; esto cubre
      // el caso de que esa lista cambie sin actualizar esta validación.
      throw new ForbiddenException(
        `El rol "${rol}" no puede cambiar el estado de un pedido`,
      );
    }

    const areaDelPedido = this.derivarAreaUnica(
      pedido.detallesPedido.map((detalle) => detalle.producto),
    );
    const areaDelRol = await this.resolverAreaPorCodigo(codigoAreaDelRol);

    if (areaDelPedido !== areaDelRol.idAreaProducto) {
      throw new ForbiddenException(
        `El pedido ${pedido.idPedido} no pertenece al área "${codigoAreaDelRol}".`,
      );
    }
  }

  private assertTransicionValida(
    actual: EstadoPedido,
    nuevo: EstadoPedido,
  ): void {
    if (!TRANSICIONES_PERMITIDAS[actual].includes(nuevo)) {
      throw new ConflictException(
        `Transición inválida: un pedido en "${actual}" no puede pasar a "${nuevo}". El flujo es pendiente → preparacion → listo (se permite pendiente → listo directo), nunca hacia atrás.`,
      );
    }
  }

  // --- Lectura / armado de respuestas ---

  private async listarKdsPorArea(
    codigoArea: string,
  ): Promise<PedidoKdsResponse[]> {
    const area = await this.resolverAreaPorCodigo(codigoArea);

    const pedidos = await this.pedidoRepo
      .createQueryBuilder('pedido')
      .innerJoinAndSelect('pedido.sesion', 'sesion')
      .innerJoinAndSelect('sesion.mesa', 'mesa')
      .innerJoinAndSelect('pedido.detallesPedido', 'detalle')
      .innerJoinAndSelect('detalle.producto', 'producto')
      // withDeleted: si un producto (o la mesa) se dio de baja DESPUÉS de que
      // el pedido entró, el pedido igual tiene que seguir viéndose en el KDS —
      // la cocina ya lo tiene que preparar.
      .withDeleted()
      .where('pedido.estado IN (:...estados)', {
        estados: [EstadoPedido.PENDIENTE, EstadoPedido.PREPARACION],
      })
      .andWhere('producto.idAreaProducto = :idArea', {
        idArea: area.idAreaProducto,
      })
      // Orden de llegada real, no por nroOrden (que es por sesión).
      .orderBy('pedido.creadoEl', 'ASC')
      .addOrderBy('detalle.idDetalle', 'ASC')
      .getMany();

    return pedidos.map((pedido) => ({
      idPedido: pedido.idPedido,
      nroOrden: pedido.nroOrden,
      nombreMesa: pedido.sesion.mesa.nombreMesa,
      nombreComensal: pedido.nombreComensal,
      estado: pedido.estado,
      creadoEl: pedido.creadoEl,
      detalles: pedido.detallesPedido.map((detalle) => ({
        idDetalle: detalle.idDetalle,
        nombreProducto: detalle.producto.nombreProducto,
        cantidad: detalle.cantidad,
        observacion: detalle.observacion,
      })),
    }));
  }

  // Busca por `codigo` (columna interna, no editable vía API) en vez de por
  // `nombre_area` (decisión #17): el admin puede renombrar el área en el
  // catálogo sin romper esta resolución. Si falta el código, ya no es un "no
  // encontrado" esperable del lado del usuario — es un problema de integridad
  // de datos (la migración AddCodigoAreaProducto debería garantizar que
  // exista), así que se reporta como error de servidor, no 404.
  private async resolverAreaPorCodigo(codigo: string): Promise<AreaProducto> {
    const area = await this.areaRepo.findOne({ where: { codigo } });
    if (!area) {
      throw new InternalServerErrorException(
        `Integridad de datos: no existe un área de producto con codigo="${codigo}" en areas_producto. El KDS no puede funcionar sin esa fila — revisar la migración AddCodigoAreaProducto.`,
      );
    }
    return area;
  }

  // Todos los pedidos de UNA sesión, con sus detalles y el producto de cada
  // detalle, en una sola query (relations + withDeleted) — sin N+1. Fuente
  // única compartida por listarPedidosDeSesion (cliente, ownership por
  // token) y obtenerConsumoActualDeMesa (staff, ownership por mesa/rol): el
  // criterio de "qué pedidos entran y en qué orden" no puede divergir entre
  // los dos consumidores.
  private async buscarPedidosDeSesion(
    manager: EntityManager,
    idSesion: number,
  ): Promise<Pedido[]> {
    return manager.find(Pedido, {
      where: { idSesion },
      relations: { detallesPedido: { producto: true } },
      order: {
        creadoEl: 'ASC',
        detallesPedido: { idDetalle: 'ASC' },
      },
      // Ver comentario de withDeleted en listarKdsPorArea: un producto dado
      // de baja después de pedirse no debe desaparecer del historial.
      withDeleted: true,
    });
  }

  private async buscarPedidoConDetalles(
    manager: EntityManager,
    idPedido: number,
  ): Promise<Pedido> {
    const pedido = await manager.findOne(Pedido, {
      where: { idPedido },
      relations: { detallesPedido: { producto: true } },
      order: { detallesPedido: { idDetalle: 'ASC' } },
      // Ver comentario de withDeleted en listarKdsPorArea.
      withDeleted: true,
    });
    if (!pedido) {
      throw new NotFoundException(`Pedido ${idPedido} no encontrado`);
    }
    return pedido;
  }

  private async construirPedidoResponse(
    manager: EntityManager,
    idPedido: number,
  ): Promise<PedidoResponse> {
    const pedido = await this.buscarPedidoConDetalles(manager, idPedido);
    return toPedidoResponse(pedido);
  }
}
