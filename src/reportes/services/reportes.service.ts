import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Pago } from '../../pagos/entities/pago.entity';
import { DetallePedido } from '../../pedidos/entities/detalle-pedido.entity';
import { TIMEZONE_RESTAURANTE } from '../../common/constants/timezone.constant';
import { aCentavos, desdeCentavos } from '../../common/utils/dinero.util';
import {
  IngresoPorMetodoPagoResponse,
  ReporteVentasResponse,
  VentaDiariaResponse,
} from '../dto/reporte-ventas-response.dto';
import {
  PlatoMasVendidoResponse,
  ReportePlatosMasVendidosResponse,
} from '../dto/reporte-platos-response.dto';

const LIMITE_PLATOS_DEFAULT = 10;

// TIMEZONE_RESTAURANTE se interpola directo en el texto de las queries de este
// archivo (no se bindea como parámetro $n): es una constante fija del código,
// nunca viene de input del usuario, así que no hay riesgo de inyección SQL —
// y Postgres tampoco admite un parámetro bindeado como nombre de zona horaria
// en `AT TIME ZONE` (tiene que ser un literal en el texto de la query).
// `desde`/`hasta`/`limite`, que sí vienen del usuario, siempre van bindeados
// ($1/$2/$3), nunca interpolados.

interface ResumenVentasRow {
  ingresos_totales: string;
  cantidad_tickets: string;
}

interface IngresoPorMetodoRow {
  id_metodo_pago: number;
  nombre_metodo: string;
  ingresos: string;
  cantidad_pagos: string;
}

interface VentaDiariaRow {
  fecha: string;
  ingresos: string;
  cantidad_tickets: string;
}

interface PlatoMasVendidoRow {
  id_producto: number;
  nombre_producto: string;
  cantidad_vendida: string;
  ingreso_generado: string;
}

@Injectable()
export class ReportesService {
  constructor(
    @InjectRepository(Pago)
    private readonly pagoRepo: Repository<Pago>,
    @InjectRepository(DetallePedido)
    private readonly detalleRepo: Repository<DetallePedido>,
  ) {}

  // Ingresos = pagos no anulados (decisión #1), nunca pedidos: un pedido
  // creado no es plata cobrada.
  async obtenerReporteVentas(
    desde: string,
    hasta: string,
  ): Promise<ReporteVentasResponse> {
    this.assertRangoValido(desde, hasta);

    const [resumenRows, metodoRows, diariaRows] = await Promise.all([
      this.pagoRepo.manager.query<ResumenVentasRow[]>(
        `
        SELECT
          COALESCE(SUM(monto_pagado), 0) AS ingresos_totales,
          COUNT(DISTINCT id_sesion) AS cantidad_tickets
        FROM pagos
        WHERE anulado_el IS NULL
          AND creado_el >= ($1::date AT TIME ZONE '${TIMEZONE_RESTAURANTE}')
          AND creado_el < (($2::date + INTERVAL '1 day') AT TIME ZONE '${TIMEZONE_RESTAURANTE}')
        `,
        [desde, hasta],
      ),
      // Incluye métodos de pago soft-deleted que hayan tenido ingresos en el
      // rango (misma lógica que el arqueo exhaustivo de Caja, decisión #18):
      // esta query cruda no aplica el filtro @DeleteDateColumn de TypeORM.
      this.pagoRepo.manager.query<IngresoPorMetodoRow[]>(
        `
        SELECT
          mp.id_metodo_pago AS id_metodo_pago,
          mp.nombre_metodo AS nombre_metodo,
          COALESCE(SUM(p.monto_pagado), 0) AS ingresos,
          COUNT(*) AS cantidad_pagos
        FROM pagos p
        JOIN metodos_pago mp ON mp.id_metodo_pago = p.id_metodo_pago
        WHERE p.anulado_el IS NULL
          AND p.creado_el >= ($1::date AT TIME ZONE '${TIMEZONE_RESTAURANTE}')
          AND p.creado_el < (($2::date + INTERVAL '1 day') AT TIME ZONE '${TIMEZONE_RESTAURANTE}')
        GROUP BY mp.id_metodo_pago, mp.nombre_metodo
        ORDER BY ingresos DESC
        `,
        [desde, hasta],
      ),
      this.pagoRepo.manager.query<VentaDiariaRow[]>(
        `
        SELECT
          to_char(date_trunc('day', creado_el AT TIME ZONE '${TIMEZONE_RESTAURANTE}'), 'YYYY-MM-DD') AS fecha,
          COALESCE(SUM(monto_pagado), 0) AS ingresos,
          COUNT(DISTINCT id_sesion) AS cantidad_tickets
        FROM pagos
        WHERE anulado_el IS NULL
          AND creado_el >= ($1::date AT TIME ZONE '${TIMEZONE_RESTAURANTE}')
          AND creado_el < (($2::date + INTERVAL '1 day') AT TIME ZONE '${TIMEZONE_RESTAURANTE}')
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        [desde, hasta],
      ),
    ]);

    const ingresosTotales = Number(resumenRows[0]?.ingresos_totales ?? 0);
    const cantidadTickets = Number(resumenRows[0]?.cantidad_tickets ?? 0);
    // Ticket promedio sobre sesiones distintas pagadas (decisión #4), no
    // filas de pago: 2 métodos en una misma mesa son 1 ticket, no 2.
    const ticketPromedio =
      cantidadTickets > 0
        ? desdeCentavos(aCentavos(ingresosTotales / cantidadTickets))
        : 0;

    const porMetodoPago: IngresoPorMetodoPagoResponse[] = metodoRows.map(
      (fila) => ({
        idMetodoPago: fila.id_metodo_pago,
        nombreMetodo: fila.nombre_metodo,
        ingresos: Number(fila.ingresos),
        cantidadPagos: Number(fila.cantidad_pagos),
      }),
    );

    const serieDiaria: VentaDiariaResponse[] = diariaRows.map((fila) => ({
      fecha: fila.fecha,
      ingresos: Number(fila.ingresos),
      cantidadTickets: Number(fila.cantidad_tickets),
    }));

    return {
      desde,
      hasta,
      resumen: { ingresosTotales, cantidadTickets, ticketPromedio },
      porMetodoPago,
      serieDiaria,
    };
  }

  // "Más vendidos" = detalles_pedidos vía pedidos.creado_el (decisión #2), sin
  // importar estado del pedido ni si la sesión ya se pagó — no depende de pagos.
  async obtenerPlatosMasVendidos(
    desde: string,
    hasta: string,
    limite = LIMITE_PLATOS_DEFAULT,
  ): Promise<ReportePlatosMasVendidosResponse> {
    this.assertRangoValido(desde, hasta);

    // INNER JOIN alcanza para incluir productos soft-deleted (decisión #6):
    // el soft delete solo pone borrado_el, la fila sigue existiendo en
    // "productos", y esta query cruda no aplica el filtro @DeleteDateColumn
    // de TypeORM (ese filtro solo lo agregan find()/QueryBuilder ORM-level) —
    // no hace falta un equivalente explícito de `withDeleted`.
    const filas = await this.detalleRepo.manager.query<PlatoMasVendidoRow[]>(
      `
      SELECT
        dp.id_producto AS id_producto,
        prod.nombre_producto AS nombre_producto,
        SUM(dp.cantidad) AS cantidad_vendida,
        SUM(dp.cantidad * dp.precio_actual) AS ingreso_generado
      FROM detalles_pedidos dp
      JOIN pedidos ped ON ped.id_pedido = dp.id_pedido
      JOIN productos prod ON prod.id_producto = dp.id_producto
      WHERE ped.creado_el >= ($1::date AT TIME ZONE '${TIMEZONE_RESTAURANTE}')
        AND ped.creado_el < (($2::date + INTERVAL '1 day') AT TIME ZONE '${TIMEZONE_RESTAURANTE}')
      GROUP BY dp.id_producto, prod.nombre_producto
      ORDER BY cantidad_vendida DESC
      LIMIT $3
      `,
      [desde, hasta, limite],
    );

    const platos: PlatoMasVendidoResponse[] = filas.map((fila) => ({
      idProducto: fila.id_producto,
      nombreProducto: fila.nombre_producto,
      cantidadVendida: Number(fila.cantidad_vendida),
      ingresoGenerado: Number(fila.ingreso_generado),
    }));

    return { desde, hasta, platos };
  }

  private assertRangoValido(desde: string, hasta: string): void {
    if (desde > hasta) {
      throw new BadRequestException(
        `Rango de fechas inválido: "desde" (${desde}) es posterior a "hasta" (${hasta}).`,
      );
    }
  }
}
