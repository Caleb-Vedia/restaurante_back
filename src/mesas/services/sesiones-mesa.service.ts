import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { DataSource, IsNull, QueryFailedError, Repository } from 'typeorm';
import { Mesa } from '../entities/mesa.entity';
import { SesionMesa } from '../entities/sesion-mesa.entity';
import { Pedido } from '../../pedidos/entities/pedido.entity';
import {
  AbrirSesionResponse,
  PedirCuentaResponse,
} from '../dto/mesa-response.dto';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { lockearCajaAbierta } from '../../common/utils/caja-abierta.util';

// Código de error de Postgres para violación de constraint único.
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class SesionesMesaService {
  constructor(
    @InjectRepository(Mesa)
    private readonly mesaRepo: Repository<Mesa>,
    @InjectRepository(SesionMesa)
    private readonly sesionRepo: Repository<SesionMesa>,
    @InjectRepository(Pedido)
    private readonly pedidoRepo: Repository<Pedido>,
    private readonly dataSource: DataSource,
  ) {}

  // Cliente (vía QR): abre la sesión de la mesa, o devuelve la ya activa.
  async abrirSesion(idMesa: number): Promise<AbrirSesionResponse> {
    const mesa = await this.mesaRepo.findOne({ where: { idMesa } });
    if (!mesa) {
      throw new NotFoundException(`Mesa ${idMesa} no encontrada`);
    }

    // Mesa ocupada / cuenta_solicitada: ya hay sesión, se reusa (no se crea otra).
    if (mesa.estado !== EstadoMesa.LIBRE) {
      return this.devolverSesionActiva(idMesa);
    }

    const sesion = this.sesionRepo.create({
      idMesa,
      token: randomUUID(),
      abiertaEl: new Date(),
    });

    try {
      await this.sesionRepo.save(sesion);
    } catch (error) {
      // Condición de carrera: entre nuestro chequeo `estado === libre` y este
      // insert, otra request abrió la sesión. El índice parcial único
      // (id_mesa WHERE cerrada_el IS NULL) rechaza el segundo insert con
      // 23505. En vez de propagar el error crudo de Postgres, devolvemos la
      // sesión ganadora que la otra request ya dejó activa.
      if (this.esViolacionUnicidad(error)) {
        return this.devolverSesionActiva(idMesa);
      }
      throw error;
    }

    mesa.estado = EstadoMesa.OCUPADA;
    await this.mesaRepo.save(mesa);

    return {
      token: sesion.token,
      idMesa: mesa.idMesa,
      nombreMesa: mesa.nombreMesa,
      estado: mesa.estado,
    };
  }

  // Resuelve el header X-Table-Token (decisión #15) contra una sesión abierta,
  // con su mesa ya cargada. Público y reusable a propósito: PedidosService lo
  // consume para saber en qué sesión crear el pedido del cliente, en vez de
  // duplicar esta validación.
  //
  // Mensaje genérico a propósito: no distingue token inexistente de token ya
  // cerrado, para no filtrar qué tokens existieron.
  async obtenerSesionActivaPorToken(token: string): Promise<SesionMesa> {
    const sesion = await this.sesionRepo.findOne({
      where: { token, cerradaEl: IsNull() },
      relations: { mesa: true },
    });
    // `mesa` faltante solo puede darse si la mesa fue borrada con la sesión
    // abierta (estado inconsistente): se trata igual que token inválido.
    if (!sesion || !sesion.mesa) {
      throw new UnauthorizedException('Sesión no encontrada o inválida');
    }
    return sesion;
  }

  // Cliente: pide la cuenta usando el token de sesión (header X-Table-Token).
  //
  // SINCRONIZACIÓN CON EL CIERRE DE CAJA
  // ------------------------------------
  // El paso a `cuenta_solicitada` es justamente lo que dispara la regla C del
  // cierre ("mesa con la cuenta pedida y saldo pendiente bloquea el cierre",
  // ver ConciliacionCajaService). Mientras esta transición corría suelta,
  // quedaba una carrera real contra CierresCajaService.cerrarCaja: el cierre
  // revalidaba las sesiones, no veía ninguna bloqueante, y esta transición
  // commiteaba un instante después — el turno se cerraba con un cliente
  // esperando pagar, que es exactamente lo que la regla C existe para impedir.
  //
  // Por eso todo el flujo pasó a una transacción que toma el MISMO lock que el
  // cierre: la fila del `CierreCaja` abierto, con `pessimistic_write`, sostenido
  // hasta el commit. Con eso solo quedan dos desenlaces:
  //   - gana pedirCuenta: cerrarCaja espera acá; cuando avanza, su
  //     revalidación (statement nuevo en READ COMMITTED) ya ve la mesa en
  //     `cuenta_solicitada` y, si esa sesión debe algo, corta con 409. La caja
  //     queda abierta.
  //   - gana cerrarCaja: este SELECT ... FOR UPDATE espera y, al reevaluar la
  //     fila ya actualizada (EvalPlanQual), deja de cumplir `cerrado_el IS
  //     NULL` -> `lockearCajaAbierta` devuelve null y la cuenta se pide igual,
  //     ya en el turno siguiente. El snapshot histórico no se toca.
  //
  // SIN CAJA ABIERTA NO SE BLOQUEA NADA. `lockearCajaAbierta` devolviendo null
  // NO es un error acá: esta etapa sincroniza, no le agrega al Cliente una
  // regla nueva de "no podés pedir la cuenta sin caja". El cliente puede pedir
  // la cuenta entre turnos; simplemente no hay ningún cierre con el cual
  // sincronizarse.
  //
  // Orden de locks: CierreCaja -> SesionMesa -> Mesa, el mismo orden global ya
  // vigente (CierreCaja -> Pago -> SesionMesa -> Mesa). Como cerrarCaja solo
  // toma el primero, y este flujo lo toma también primero, no hay ciclo posible
  // entre ambos.
  async pedirCuenta(token?: string): Promise<PedirCuentaResponse> {
    if (!token) {
      throw new UnauthorizedException('Sesión no encontrada o inválida');
    }

    // Resolución del token fuera de la transacción (mismo patrón que
    // PedidosService.crearPedido): solo sirve para ubicar la sesión. Todo lo
    // que decide se revalida abajo, bajo los locks.
    const sesion = await this.obtenerSesionActivaPorToken(token);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const manager = queryRunner.manager;

      // 1) Caja abierta, si la hay. El valor no se usa: lo que importa es
      //    RETENER el lock hasta el commit (ver comentario largo arriba).
      await lockearCajaAbierta(manager);

      // 2) Sesión. Recheck bajo el lock: pudo cerrarse entre la validación del
      //    token y este punto (un cobro, o la liberación de la mesa).
      const sesionBloqueada = await manager.findOne(SesionMesa, {
        where: { idSesion: sesion.idSesion },
        lock: { mode: 'pessimistic_write' },
      });
      if (!sesionBloqueada || sesionBloqueada.cerradaEl !== null) {
        throw new UnauthorizedException('Sesión no encontrada o inválida');
      }

      // 3) Mesa. Este es el chequeo de estado AUTORITATIVO — el que decide, ya
      //    con la fila bloqueada. Una mesa borrada con la sesión abierta se
      //    trata como token inválido, igual que en obtenerSesionActivaPorToken.
      const mesa = await manager.findOne(Mesa, {
        where: { idMesa: sesionBloqueada.idMesa },
        lock: { mode: 'pessimistic_write' },
      });
      if (!mesa) {
        throw new UnauthorizedException('Sesión no encontrada o inválida');
      }
      if (mesa.estado !== EstadoMesa.OCUPADA) {
        throw new ConflictException(
          `No se puede pedir la cuenta: la mesa está en estado "${mesa.estado}".`,
        );
      }

      // Sin esto, una mesa que abre sesión y pide la cuenta sin haber
      // pedido nada queda en `cuenta_solicitada` sin consumo real (bug
      // reportado): el cliente se bloquea aunque no haya nada que cobrar.
      // Basta comprobar EXISTENCIA de pedidos de la sesión (sin importar su
      // `estado`, mismo criterio que "total adeudado" en Pagos) — no hace
      // falta calcular ningún monto para esta regla.
      //
      // Ahora se cuenta bajo los mismos locks: crearPedido toma CierreCaja y
      // SesionMesa antes de insertar, así que mientras esta transacción los
      // retiene no puede aparecer un pedido nuevo entre el conteo y el cambio
      // de estado.
      const totalPedidos = await manager.count(Pedido, {
        where: { idSesion: sesionBloqueada.idSesion },
      });
      if (totalPedidos === 0) {
        throw new ConflictException(
          'No hay consumos registrados en esta mesa. Realizá un pedido antes de solicitar la cuenta.',
        );
      }

      await manager.update(
        Mesa,
        { idMesa: mesa.idMesa },
        { estado: EstadoMesa.CUENTA_SOLICITADA },
      );

      await queryRunner.commitTransaction();
      return { idMesa: mesa.idMesa, estado: EstadoMesa.CUENTA_SOLICITADA };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private async devolverSesionActiva(
    idMesa: number,
  ): Promise<AbrirSesionResponse> {
    const mesa = await this.mesaRepo.findOne({ where: { idMesa } });
    const sesion = await this.sesionRepo.findOne({
      where: { idMesa, cerradaEl: IsNull() },
    });
    if (!mesa || !sesion) {
      throw new ConflictException(
        `La mesa ${idMesa} no tiene una sesión activa consistente`,
      );
    }
    return {
      token: sesion.token,
      idMesa: mesa.idMesa,
      nombreMesa: mesa.nombreMesa,
      estado: mesa.estado,
    };
  }

  private esViolacionUnicidad(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as { code?: string } | undefined;
    return driverError?.code === PG_UNIQUE_VIOLATION;
  }
}
