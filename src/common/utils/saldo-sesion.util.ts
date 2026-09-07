import { EntityManager } from 'typeorm';
import { DetallePedido } from '../../pedidos/entities/detalle-pedido.entity';
import { Pago } from '../../pagos/entities/pago.entity';
import { aCentavos, desdeCentavos } from './dinero.util';

// Fuente ÚNICA de verdad del saldo de una sesión de mesa. Vive acá —
// neutral, sin decoradores Nest ni providers— a propósito: la consumen
// tanto PagosService (cobro / GET /pagos/total/:idMesa) como MesasService
// (precondición de PATCH /mesas/:id/cerrar-sesion). Si el cálculo viviera
// dentro de PagosService, MesasModule tendría que importar PagosModule
// para liberar una mesa, y PagosModule ya importa MesasModule
// (cerrarSesionActiva al cobrar) — eso sería un ciclo de módulos, que este
// proyecto evita en todos sus módulos (decisiones #16-#19).
//
// Todas las funciones reciben un EntityManager, nunca un Repository: así
// el MISMO cálculo sirve dentro de una transacción con lock (el manager
// del queryRunner) o fuera de ella (`repo.manager`), sin duplicar la
// lógica ni la consulta.

export interface SaldoSesion {
  totalAdeudado: number;
  totalPagado: number;
  saldoPendiente: number;
  // Mismo saldo en centavos enteros: es el valor con el que se DECIDE
  // (comparar `saldoPendiente > 0` como float reintroduciría exactamente
  // el error que dinero.util existe para evitar). `saldoPendiente` queda
  // solo para mostrar/serializar.
  saldoPendienteCentavos: number;
}

// Total adeudado = suma de cantidad * precioActual de TODOS los detalles de
// TODOS los pedidos de la sesión, sin importar el estado del pedido
// (pendiente/preparacion/listo cuentan igual — decisión #18).
export async function calcularTotalAdeudado(
  manager: EntityManager,
  idSesion: number,
): Promise<number> {
  const fila = await manager
    .createQueryBuilder(DetallePedido, 'detalle')
    .innerJoin('detalle.pedido', 'pedido')
    .select(
      'COALESCE(SUM(detalle.cantidad * detalle.precioActual), 0)',
      'total',
    )
    .where('pedido.idSesion = :idSesion', { idSesion })
    .getRawOne<{ total: string | number | null }>();
  return Number(fila?.total ?? 0);
}

// Versión POR LOTE de calcularTotalAdeudado: mismo consumo (misma suma
// `cantidad * precioActual` sobre TODOS los pedidos de la sesión, sin filtro
// de fecha ni de estado), pero para varias sesiones en UNA sola consulta
// agrupada. Existe para la actividad del turno de Caja, que necesita el total
// de N visitas a la vez: llamar a calcularTotalAdeudado en un bucle sería un
// N+1 con una query por sesión.
//
// Devuelve un Map idSesion -> total. Una sesión sin pedidos NO aparece en el
// Map (el GROUP BY no genera fila): el llamador debe interpretar la ausencia
// como 0, igual que el COALESCE de la versión unitaria.
export async function calcularTotalAdeudadoPorSesiones(
  manager: EntityManager,
  idsSesion: number[],
): Promise<Map<number, number>> {
  // `IN ()` vacío es SQL inválido: sin sesiones no hay nada que sumar.
  if (idsSesion.length === 0) {
    return new Map();
  }

  const filas = await manager
    .createQueryBuilder(DetallePedido, 'detalle')
    .innerJoin('detalle.pedido', 'pedido')
    .select('pedido.idSesion', 'idSesion')
    .addSelect(
      'COALESCE(SUM(detalle.cantidad * detalle.precioActual), 0)',
      'total',
    )
    .where('pedido.idSesion IN (:...idsSesion)', { idsSesion })
    .groupBy('pedido.idSesion')
    .getRawMany<{ idSesion: number; total: string | number | null }>();

  return new Map(
    filas.map((fila) => [Number(fila.idSesion), Number(fila.total ?? 0)]),
  );
}

// Solo pagos VIGENTES: un pago anulado (anuladoEl con fecha) no cuenta como
// pagado, así que vuelve a generar saldo pendiente (decisión #18).
export async function calcularTotalPagado(
  manager: EntityManager,
  idSesion: number,
): Promise<number> {
  const fila = await manager
    .createQueryBuilder(Pago, 'pago')
    .select('COALESCE(SUM(pago.montoPagado), 0)', 'total')
    .where('pago.idSesion = :idSesion', { idSesion })
    .andWhere('pago.anuladoEl IS NULL')
    .getRawOne<{ total: string | number | null }>();
  return Number(fila?.total ?? 0);
}

// Versión POR LOTE de calcularTotalPagado: mismo filtro de vigencia
// (`anuladoEl IS NULL`), agrupado por sesión en UNA sola consulta. Contraparte
// de calcularTotalAdeudadoPorSesiones; existe para el mismo motivo — el cierre
// de caja necesita el saldo de TODAS las sesiones activas a la vez, y un bucle
// de calcularTotalPagado sería un N+1.
//
// Igual que su hermana: una sesión sin pagos NO aparece en el Map.
export async function calcularTotalPagadoPorSesiones(
  manager: EntityManager,
  idsSesion: number[],
): Promise<Map<number, number>> {
  if (idsSesion.length === 0) {
    return new Map();
  }

  const filas = await manager
    .createQueryBuilder(Pago, 'pago')
    .select('pago.idSesion', 'idSesion')
    .addSelect('COALESCE(SUM(pago.montoPagado), 0)', 'total')
    .where('pago.idSesion IN (:...idsSesion)', { idsSesion })
    .andWhere('pago.anuladoEl IS NULL')
    .groupBy('pago.idSesion')
    .getRawMany<{ idSesion: number; total: string | number | null }>();

  return new Map(
    filas.map((fila) => [Number(fila.idSesion), Number(fila.total ?? 0)]),
  );
}

// Versión POR LOTE de calcularSaldoSesion: MISMA aritmética (en centavos
// enteros), pero para N sesiones con dos consultas agrupadas en total en vez
// de dos por sesión.
//
// A diferencia de los dos helpers agrupados que consume, este SÍ devuelve una
// entrada por cada id pedido: una sesión sin pedidos ni pagos aparece con
// saldo 0, exactamente como la devolvería calcularSaldoSesion (el COALESCE de
// la versión unitaria). Así el llamador nunca tiene que interpretar la
// ausencia de una clave, que es justo donde se colaría un bug de "sesión sin
// consumo" tratada como "sesión desconocida".
export async function calcularSaldoPorSesiones(
  manager: EntityManager,
  idsSesion: number[],
): Promise<Map<number, SaldoSesion>> {
  const [adeudadoPorSesion, pagadoPorSesion] = await Promise.all([
    calcularTotalAdeudadoPorSesiones(manager, idsSesion),
    calcularTotalPagadoPorSesiones(manager, idsSesion),
  ]);

  return new Map(
    idsSesion.map((idSesion) => {
      const totalAdeudado = adeudadoPorSesion.get(idSesion) ?? 0;
      const totalPagado = pagadoPorSesion.get(idSesion) ?? 0;
      const saldoPendienteCentavos =
        aCentavos(totalAdeudado) - aCentavos(totalPagado);

      return [
        idSesion,
        {
          totalAdeudado,
          totalPagado,
          saldoPendiente: desdeCentavos(saldoPendienteCentavos),
          saldoPendienteCentavos,
        },
      ];
    }),
  );
}

// Una sesión sin pedidos da totalAdeudado 0 por el COALESCE (no lanza ni
// necesita caso especial) y, sin pagos, saldo 0 — por eso una mesa cuyo
// cliente escaneó el QR y se fue sin consumir queda liberable sin
// inventar ningún pago de 0.
export async function calcularSaldoSesion(
  manager: EntityManager,
  idSesion: number,
): Promise<SaldoSesion> {
  const totalAdeudado = await calcularTotalAdeudado(manager, idSesion);
  const totalPagado = await calcularTotalPagado(manager, idSesion);
  const saldoPendienteCentavos =
    aCentavos(totalAdeudado) - aCentavos(totalPagado);

  return {
    totalAdeudado,
    totalPagado,
    saldoPendiente: desdeCentavos(saldoPendienteCentavos),
    saldoPendienteCentavos,
  };
}
