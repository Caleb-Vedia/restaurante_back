import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { CierreCaja } from '../entities/cierre-caja.entity';
import { MetodoPago } from '../../pagos/entities/metodo-pago.entity';
import { Pago } from '../../pagos/entities/pago.entity';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { aCentavos, desdeCentavos } from '../../common/utils/dinero.util';
import { calcularSaldoPorSesiones } from '../../common/utils/saldo-sesion.util';
import { CerrarCajaDto } from '../dto/cerrar-caja.dto';
import { CierreCajaDetalleResponse } from '../dto/cierre-caja-response.dto';
import {
  ResumenSesionesCierreResponse,
  SesionPendienteCierreResponse,
} from '../dto/cierre-preview-response.dto';

// Método de pago al que se le suma el fondo inicial de efectivo al cerrar.
// Se identifica por `codigo` (columna interna estable, decisión #17), no por
// nombre: el admin puede renombrar "Efectivo" sin romper el arqueo.
const CODIGO_METODO_EFECTIVO = 'efectivo';

export interface TotalesConciliacion {
  totalEsperado: number;
  totalContado: number | null;
  diferenciaTotal: number | null;
}

/**
 * FUENTE ÚNICA de cálculo del cierre de caja (Caja 2.0, Etapa 6).
 *
 * La consumen los dos caminos del cierre en 4 pasos:
 *   - el PREVIEW (GET /caja/cierre/contexto, POST /caja/cierre/preview), que
 *     solo lee y puede repetirse las veces que haga falta;
 *   - el CIERRE DEFINITIVO (PATCH /caja/cerrar), que vuelve a llamarla dentro
 *     de su transacción con lock y persiste lo que devuelva.
 *
 * Existe precisamente para que NO haya dos fórmulas de arqueo. Todo lo que
 * este service calcula sale de los mismos métodos, con los mismos parámetros:
 * si el preview y el cierre difieren, es porque cambió el ESTADO de la base
 * entre uno y otro, nunca porque cambió la fórmula.
 *
 * Todos los métodos reciben un `EntityManager` en vez de usar repositorios
 * propios (mismo criterio que saldo-sesion.util): así el cierre puede pasarles
 * el manager de su queryRunner —y quedar dentro de su transacción y su lock—
 * mientras el preview les pasa un manager suelto, sin duplicar nada.
 *
 * READ-ONLY: este service no escribe. Persistir es responsabilidad exclusiva
 * de CierresCajaService.cerrarCaja.
 */
@Injectable()
export class ConciliacionCajaService {
  // Una fila por cada método ACTIVO, más cualquier método soft-deleted que
  // haya recibido pagos no anulados dentro de la ventana del turno (dado de
  // baja a mitad de turno, pero igual cobró plata real — omitirlo escondería
  // ingresos). Métodos activos sin movimiento igual aparecen (esperado 0, o el
  // fondo inicial si es efectivo).
  //
  // `hasta` es el límite superior de la ventana: el `cerradoEl` real en el
  // cierre definitivo, y el "ahora" del reporte en el preview.
  async calcularDetalle(
    manager: EntityManager,
    cierre: CierreCaja,
    hasta: Date,
    dto: CerrarCajaDto,
  ): Promise<CierreCajaDetalleResponse[]> {
    const metodosActivos = await manager.find(MetodoPago, {
      order: { idMetodoPago: 'ASC' },
    });

    // Suma de pagos NO anulados por método, dentro de la ventana del turno.
    const filas = await manager
      .createQueryBuilder(Pago, 'pago')
      .select('pago.idMetodoPago', 'idMetodoPago')
      .addSelect('COALESCE(SUM(pago.montoPagado), 0)', 'total')
      .where('pago.anuladoEl IS NULL')
      .andWhere('pago.creadoEl >= :desde', { desde: cierre.abiertoEl })
      .andWhere('pago.creadoEl <= :hasta', { hasta })
      .groupBy('pago.idMetodoPago')
      .getRawMany<{ idMetodoPago: number; total: string | number }>();

    const cobradoPorMetodo = new Map<number, number>(
      filas.map((fila) => [Number(fila.idMetodoPago), Number(fila.total)]),
    );

    const idsActivos = new Set(
      metodosActivos.map((metodo) => metodo.idMetodoPago),
    );
    const idsSoftDeletedConPago = [...cobradoPorMetodo.keys()].filter(
      (id) => !idsActivos.has(id),
    );
    const metodosSoftDeletedConPago =
      idsSoftDeletedConPago.length > 0
        ? await manager.find(MetodoPago, {
            where: { idMetodoPago: In(idsSoftDeletedConPago) },
            withDeleted: true,
          })
        : [];

    const metodos = [...metodosActivos, ...metodosSoftDeletedConPago].sort(
      (a, b) => a.idMetodoPago - b.idMetodoPago,
    );

    const contadoPorMetodo = new Map<number, number | null>(
      (dto.detalle ?? []).map((item) => [
        item.idMetodoPago,
        item.montoContado ?? null,
      ]),
    );

    return metodos.map((metodo) => {
      const cobrado = cobradoPorMetodo.get(metodo.idMetodoPago) ?? 0;
      // El fondo inicial es exclusivo de efectivo: el resto de los métodos
      // arranca el turno en cero.
      const fondoInicial =
        metodo.codigo === CODIGO_METODO_EFECTIVO
          ? cierre.montoInicialEfectivo
          : 0;
      const montoEsperado = desdeCentavos(
        aCentavos(fondoInicial) + aCentavos(cobrado),
      );
      const montoContado = contadoPorMetodo.get(metodo.idMetodoPago) ?? null;

      return {
        idMetodoPago: metodo.idMetodoPago,
        nombreMetodo: metodo.nombreMetodo,
        montoEsperado,
        montoContado,
        diferencia:
          montoContado === null
            ? null
            : desdeCentavos(aCentavos(montoContado) - aCentavos(montoEsperado)),
      };
    });
  }

  // Totales del arqueo a partir del detalle por método. Aritmética en centavos
  // enteros (dinero.util), nunca sumando los floats.
  //
  // `totalContado` y `diferenciaTotal` son null cuando NO se declaró ningún
  // conteo: 0 significaría "conté y no había nada". Si se contó al menos un
  // método, los métodos no contados suman 0 al total — el arqueo parcial es
  // válido, y su diferencia por fila igual queda null.
  calcularTotales(detalle: CierreCajaDetalleResponse[]): TotalesConciliacion {
    const totalEsperadoCentavos = detalle.reduce(
      (acumulado, fila) => acumulado + aCentavos(fila.montoEsperado),
      0,
    );
    const filasContadas = detalle.filter((fila) => fila.montoContado !== null);
    const totalContadoCentavos = filasContadas.reduce(
      (acumulado, fila) => acumulado + aCentavos(fila.montoContado ?? 0),
      0,
    );

    if (filasContadas.length === 0) {
      return {
        totalEsperado: desdeCentavos(totalEsperadoCentavos),
        totalContado: null,
        diferenciaTotal: null,
      };
    }

    return {
      totalEsperado: desdeCentavos(totalEsperadoCentavos),
      totalContado: desdeCentavos(totalContadoCentavos),
      diferenciaTotal: desdeCentavos(
        totalContadoCentavos - totalEsperadoCentavos,
      ),
    };
  }

  // Normalización ÚNICA de la observación de diferencia (Etapa 8): trim, y si
  // queda vacía se guarda/devuelve `null` en vez de `''`. La usan por igual
  // el preview (solo para el eco en la respuesta, nunca persiste) y el cierre
  // definitivo (para lo que efectivamente escribe en `CierreCaja`) — mismo
  // criterio que el resto de este service: una sola fórmula, dos puertas de
  // entrada.
  normalizarObservacionDiferencia(valor: string | undefined): string | null {
    if (valor === undefined) {
      return null;
    }
    const trimmed = valor.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  // Reglas A/B/C sobre las sesiones que siguen abiertas al momento de cerrar.
  // Ver ClasificacionSesionCierre (cierre-preview-response.dto) para el
  // significado de cada una.
  //
  // El saldo de todas las sesiones se resuelve con calcularSaldoPorSesiones
  // (dos consultas agrupadas en total, no dos por sesión): es la MISMA
  // aritmética que usa el cobro y la liberación de mesa, por lo que "saldo 0"
  // significa acá exactamente lo mismo que en el resto del sistema.
  //
  // `withDeleted` en la mesa: una mesa dada de baja con la sesión todavía
  // abierta es un estado inconsistente, pero el cierre igual tiene que poder
  // nombrarla en el reporte en vez de romper con un join vacío.
  async evaluarSesionesDelCierre(
    manager: EntityManager,
  ): Promise<SesionPendienteCierreResponse[]> {
    const sesionesActivas = await manager
      .createQueryBuilder(SesionMesa, 'sesion')
      .innerJoinAndSelect('sesion.mesa', 'mesa')
      .withDeleted()
      .where('sesion.cerradaEl IS NULL')
      .orderBy('mesa.idMesa', 'ASC')
      .addOrderBy('sesion.idSesion', 'ASC')
      .getMany();

    const saldos = await calcularSaldoPorSesiones(
      manager,
      sesionesActivas.map((sesion) => sesion.idSesion),
    );

    return sesionesActivas.map((sesion) => {
      // calcularSaldoPorSesiones garantiza una entrada por id pedido, así que
      // este fallback es defensivo, no un caso esperable.
      const saldo = saldos.get(sesion.idSesion);
      const saldoPendienteCentavos = saldo?.saldoPendienteCentavos ?? 0;
      const saldoPendiente = saldo?.saldoPendiente ?? 0;

      // Comparación en centavos enteros, nunca sobre el float. Se usa `> 0`
      // (deuda) y no `!== 0` por el mismo motivo que MesasService al liberar:
      // un saldo negativo es inalcanzable por la API, y si apareciera por una
      // edición manual no debería trabar el cierre del turno.
      const tieneDeuda = saldoPendienteCentavos > 0;

      let clasificacion: SesionPendienteCierreResponse['clasificacion'];
      if (!tieneDeuda) {
        clasificacion = 'activa_sin_saldo';
      } else if (sesion.mesa.estado === EstadoMesa.CUENTA_SOLICITADA) {
        clasificacion = 'cuenta_solicitada_con_saldo';
      } else {
        clasificacion = 'ocupada_con_saldo';
      }

      return {
        idSesion: sesion.idSesion,
        idMesa: sesion.idMesa,
        nombreMesa: sesion.mesa.nombreMesa,
        estadoMesa: sesion.mesa.estado,
        abiertaEl: sesion.abiertaEl,
        saldoPendiente,
        clasificacion,
        bloqueaCierre: clasificacion === 'cuenta_solicitada_con_saldo',
      };
    });
  }

  resumirSesiones(
    sesiones: SesionPendienteCierreResponse[],
  ): ResumenSesionesCierreResponse {
    return {
      activasSinSaldo: sesiones.filter(
        (sesion) => sesion.clasificacion === 'activa_sin_saldo',
      ).length,
      ocupadasConSaldo: sesiones.filter(
        (sesion) => sesion.clasificacion === 'ocupada_con_saldo',
      ).length,
      cuentaSolicitadaConSaldo: sesiones.filter(
        (sesion) => sesion.clasificacion === 'cuenta_solicitada_con_saldo',
      ).length,
    };
  }

  // Regla C como barrera dura. La llama el cierre DEFINITIVO dentro de su
  // transacción, después de tomar el lock y ANTES de escribir nada: si lanza,
  // el rollback no deja ningún CierreCajaDetalle a medio guardar ni `cerradoEl`
  // seteado.
  //
  // El preview NO la llama: ahí el bloqueo se reporta como `puedeCerrar:false`
  // para que el wizard lo muestre, sin convertir una consulta en un error.
  assertSesionesNoBloqueanCierre(
    sesiones: SesionPendienteCierreResponse[],
  ): void {
    const bloqueantes = sesiones.filter((sesion) => sesion.bloqueaCierre);
    if (bloqueantes.length === 0) {
      return;
    }

    const detalle = bloqueantes
      .map(
        (sesion) =>
          `${sesion.nombreMesa} (saldo ${sesion.saldoPendiente.toFixed(2)})`,
      )
      .join(', ');

    throw new ConflictException(
      `No se puede cerrar caja: ${bloqueantes.length} mesa(s) pidieron la cuenta y todavía tienen saldo pendiente: ${detalle}. Cobralas o resolvé su cuenta antes de cerrar el turno.`,
    );
  }

  // Falta de 'efectivo' = problema de integridad de datos, no un caso
  // esperable del usuario (mismo criterio que PedidosService.resolverAreaPorCodigo
  // con el área faltante): sin esta fila, el fondo inicial dejaría de sumarse
  // al esperado en silencio — tanto en el preview como en el cierre.
  async assertMetodoEfectivoExiste(manager: EntityManager): Promise<void> {
    // findOne excluye soft-deleted automáticamente (@DeleteDateColumn).
    const metodoEfectivo = await manager.findOne(MetodoPago, {
      where: { codigo: CODIGO_METODO_EFECTIVO },
    });
    if (!metodoEfectivo) {
      throw new InternalServerErrorException(
        "No existe un método de pago configurado con código 'efectivo'; contactar al administrador para restaurarlo.",
      );
    }
  }
}
