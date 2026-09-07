import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, IsNull, Repository } from 'typeorm';
import { CierreCaja } from '../entities/cierre-caja.entity';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { Pedido } from '../../pedidos/entities/pedido.entity';
import { Pago } from '../../pagos/entities/pago.entity';
import { toPedidoResponse } from '../../pedidos/dto/pedido-response.mapper';
import { toPagoResponse } from '../../pagos/dto/pago-response.mapper';
import { calcularTotalAdeudadoPorSesiones } from '../../common/utils/saldo-sesion.util';
import { aCentavos, desdeCentavos } from '../../common/utils/dinero.util';
import {
  ActividadTurnoResponse,
  SesionActividadTurnoResponse,
} from '../dto/actividad-turno-response.dto';

/**
 * Actividad del turno de caja EN CURSO (Caja 2.0, Etapa 5B).
 *
 * Lectura pura y transversal (sesiones + pedidos + pagos) pensada para
 * reusarse después en Operación y en el Paso 1 del cierre. Vive en el módulo
 * Caja porque la VENTANA la define Caja (`CierreCaja.abiertoEl` -> ahora) y
 * porque su unidad de salida es el turno, no el pedido ni el pago: Pedidos y
 * Pagos son insumos que se leen, igual que ReportesModule lee Pago y
 * DetallePedido sin importar esos módulos (decisiones #16-#19).
 *
 * READ-ONLY estricto: ni un save/update/delete, ni transacción, ni lock. En
 * particular NO usa lockearCajaAbierta — ese helper toma FOR UPDATE sobre la
 * fila del cierre para sincronizarse con cerrarCaja, y un reporte no tiene
 * por qué bloquear el cierre del turno mientras lo lee.
 */
@Injectable()
export class ActividadTurnoService {
  constructor(
    @InjectRepository(CierreCaja)
    private readonly cierreRepo: Repository<CierreCaja>,
    @InjectRepository(SesionMesa)
    private readonly sesionRepo: Repository<SesionMesa>,
    @InjectRepository(Pedido)
    private readonly pedidoRepo: Repository<Pedido>,
    @InjectRepository(Pago)
    private readonly pagoRepo: Repository<Pago>,
  ) {}

  async obtenerActividadDelTurno(): Promise<ActividadTurnoResponse> {
    const cierre = await this.cierreRepo.findOne({
      where: { cerradoEl: IsNull() },
    });
    if (!cierre) {
      // Mismo patrón (409 + mensaje que indica la salida) que ya usan
      // cerrarCaja y PagosService.registrarPago cuando no hay turno abierto.
      // No se reusa el `null` de GET /caja/actual: ahí "todavía no se abrió
      // caja" es el estado normal de arranque del frontend; acá se está
      // pidiendo la actividad de un turno que no existe.
      throw new ConflictException(
        'No hay ningún cierre de caja abierto: abrí caja (POST /caja/abrir) para ver la actividad del turno.',
      );
    }

    const desde = cierre.abiertoEl;
    const hasta = new Date();

    const sesiones = await this.buscarSesionesDelTurno(desde);
    const idsSesion = sesiones.map((sesion) => sesion.idSesion);

    // Tres consultas agrupadas más (no una por sesión): pedidos de la ventana,
    // pagos de la ventana y totales de consumo por visita. Con esto el costo
    // es constante en cantidad de queries, no proporcional a las sesiones.
    const [pedidosPorSesion, pagosPorSesion, totalesPorSesion] =
      await Promise.all([
        this.buscarPedidosDelTurnoPorSesion(idsSesion, desde, hasta),
        this.buscarPagosDelTurnoPorSesion(idsSesion, desde, hasta),
        calcularTotalAdeudadoPorSesiones(this.pedidoRepo.manager, idsSesion),
      ]);

    const filas: SesionActividadTurnoResponse[] = sesiones.map((sesion) => ({
      idSesion: sesion.idSesion,
      idMesa: sesion.idMesa,
      nombreMesa: sesion.mesa.nombreMesa,
      abiertaEl: sesion.abiertaEl,
      cerradaEl: sesion.cerradaEl,
      comenzoEnTurnoAnterior: sesion.abiertaEl < desde,
      // Ausente en el Map = sesión sin pedidos (ver
      // calcularTotalAdeudadoPorSesiones: el GROUP BY no genera esa fila).
      totalSesion: totalesPorSesion.get(sesion.idSesion) ?? 0,
      pedidos: (pedidosPorSesion.get(sesion.idSesion) ?? []).map((pedido) =>
        toPedidoResponse(pedido),
      ),
      pagos: (pagosPorSesion.get(sesion.idSesion) ?? []).map((pago) =>
        toPagoResponse(pago),
      ),
    }));

    return {
      idCierre: cierre.idCierre,
      abiertoEl: cierre.abiertoEl,
      generadoEl: hasta,
      totalIngresosTurno: this.sumarIngresosVigentes(filas),
      sesiones: filas,
    };
  }

  // --- Consultas ---

  // Sesiones que INTERSECTARON el turno: su intervalo [abiertaEl, cerradaEl o
  // infinito) se solapa con [desde, ahora]. Como una sesión nunca puede
  // abrirse en el futuro, `abiertaEl <= ahora` es siempre cierto y la
  // condición se reduce a "sigue abierta, o cerró después de que abrió esta
  // caja". Eso cubre los tres casos pedidos:
  //   - abierta y cerrada dentro del turno  -> cerradaEl >= desde
  //   - abierta antes, cerrada durante      -> cerradaEl >= desde
  //   - abierta antes, todavía activa       -> cerradaEl IS NULL
  // y excluye exactamente las visitas terminadas ANTES de abrir esta caja
  // (cerradaEl < desde), que pertenecen a turnos anteriores.
  //
  // Una sesión que intersectó pero no tuvo movimiento en la ventana igual
  // aparece (con pedidos/pagos vacíos): una mesa abierta arrastrada del turno
  // anterior es información operativa, no ruido.
  //
  // withDeleted: la mesa pudo darse de baja después de la visita; el reporte
  // igual tiene que poder nombrarla (mismo criterio que el KDS y el arqueo).
  private buscarSesionesDelTurno(desde: Date): Promise<SesionMesa[]> {
    return this.sesionRepo
      .createQueryBuilder('sesion')
      .innerJoinAndSelect('sesion.mesa', 'mesa')
      .withDeleted()
      .where('(sesion.cerradaEl IS NULL OR sesion.cerradaEl >= :desde)', {
        desde,
      })
      .orderBy('sesion.abiertaEl', 'ASC')
      .addOrderBy('sesion.idSesion', 'ASC')
      .getMany();
  }

  // Pedidos CREADOS dentro de la ventana, con sus detalles y el producto de
  // cada detalle: una sola query para todas las sesiones, indexada después en
  // memoria. `Between` es inclusivo en los dos extremos, igual que el
  // `creadoEl >= desde AND creadoEl <= hasta` del arqueo de cerrarCaja.
  private async buscarPedidosDelTurnoPorSesion(
    idsSesion: number[],
    desde: Date,
    hasta: Date,
  ): Promise<Map<number, Pedido[]>> {
    if (idsSesion.length === 0) {
      return new Map();
    }

    const pedidos = await this.pedidoRepo.find({
      where: { idSesion: In(idsSesion), creadoEl: Between(desde, hasta) },
      relations: { detallesPedido: { producto: true } },
      order: { creadoEl: 'ASC', detallesPedido: { idDetalle: 'ASC' } },
      // Ver comentario de withDeleted en buscarSesionesDelTurno: sin esto, un
      // producto dado de baja después de pedirse haría desaparecer el pedido
      // entero del reporte (el join a productos dejaría de matchear).
      withDeleted: true,
    });

    return this.agruparPorSesion(pedidos, (pedido) => pedido.idSesion);
  }

  // Pagos CREADOS dentro de la ventana, VIGENTES Y ANULADOS (no se filtra por
  // anuladoEl): la anulación forma parte de la actividad del turno y esconderla
  // dejaría el movimiento sin explicación. El filtro de vigencia se aplica
  // únicamente al sumar ingresos.
  private async buscarPagosDelTurnoPorSesion(
    idsSesion: number[],
    desde: Date,
    hasta: Date,
  ): Promise<Map<number, Pago[]>> {
    if (idsSesion.length === 0) {
      return new Map();
    }

    const pagos = await this.pagoRepo.find({
      where: { idSesion: In(idsSesion), creadoEl: Between(desde, hasta) },
      relations: { metodoPago: true },
      order: { creadoEl: 'ASC', idPago: 'ASC' },
      // Un método de pago dado de baja después del cobro igual tiene que
      // mostrar su nombre (mismo criterio que historialPorMesa).
      withDeleted: true,
    });

    return this.agruparPorSesion(pagos, (pago) => pago.idSesion);
  }

  // --- Cálculo ---

  // Ingresos del turno: SOLO pagos de la ventana no anulados. Nunca se apoya
  // en totalSesion, que es consumo (puede no estar cobrado) y además abarca
  // toda la visita, incluidos turnos anteriores — sumarlo contaría plata que
  // este turno no recibió. Aritmética en centavos enteros (dinero.util), igual
  // que el resto del dominio monetario.
  private sumarIngresosVigentes(filas: SesionActividadTurnoResponse[]): number {
    const centavos = filas.reduce(
      (acumuladoSesiones, fila) =>
        acumuladoSesiones +
        fila.pagos.reduce(
          (acumuladoPagos, pago) =>
            pago.anuladoEl === null
              ? acumuladoPagos + aCentavos(pago.montoPagado)
              : acumuladoPagos,
          0,
        ),
      0,
    );
    return desdeCentavos(centavos);
  }

  private agruparPorSesion<T>(
    filas: T[],
    obtenerIdSesion: (fila: T) => number,
  ): Map<number, T[]> {
    const porSesion = new Map<number, T[]>();
    for (const fila of filas) {
      const idSesion = obtenerIdSesion(fila);
      const acumuladas = porSesion.get(idSesion);
      if (acumuladas) {
        acumuladas.push(fila);
      } else {
        porSesion.set(idSesion, [fila]);
      }
    }
    return porSesion;
  }
}
