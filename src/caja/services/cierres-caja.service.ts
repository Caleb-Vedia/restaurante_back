import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, QueryFailedError, Repository } from 'typeorm';
import { CierreCaja } from '../entities/cierre-caja.entity';
import { CierreCajaDetalle } from '../entities/cierre-caja-detalle.entity';
import { ConciliacionCajaService } from './conciliacion-caja.service';
import { AbrirCajaDto } from '../dto/abrir-caja.dto';
import { CerrarCajaDto } from '../dto/cerrar-caja.dto';
import {
  CajaAbiertaResponse,
  CierreCajaResumenResponse,
} from '../dto/cierre-caja-response.dto';
import { CierrePreviewResponse } from '../dto/cierre-preview-response.dto';

// Código de error de Postgres para violación de constraint único (mismo
// criterio que SesionesMesaService con el índice parcial de sesiones_mesa).
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class CierresCajaService {
  constructor(
    @InjectRepository(CierreCaja)
    private readonly cierreRepo: Repository<CierreCaja>,
    // Fuente única del arqueo y de las reglas A/B/C. La usan por igual el
    // preview y el cierre definitivo — ver ConciliacionCajaService.
    private readonly conciliacion: ConciliacionCajaService,
    private readonly dataSource: DataSource,
  ) {}

  async abrirCaja(
    dto: AbrirCajaDto,
    idUsuario: number,
  ): Promise<CajaAbiertaResponse> {
    // Alerta temprana: si falta el método 'efectivo', mejor detectarlo al
    // abrir el turno que descubrirlo recién al cerrar caja.
    await this.conciliacion.assertMetodoEfectivoExiste(this.cierreRepo.manager);

    const cierre = this.cierreRepo.create({
      idUsuario,
      abiertoEl: new Date(),
      montoInicialEfectivo: dto.montoInicialEfectivo,
    });

    try {
      const guardado = await this.cierreRepo.save(cierre);
      return this.toCajaAbiertaResponse(guardado);
    } catch (error) {
      // El índice único parcial idx_cierres_caja_abierto_unico garantiza en la
      // base que haya un solo cierre con cerrado_el IS NULL. Se traduce el
      // 23505 crudo de Postgres a un 409 con mensaje claro.
      if (this.esViolacionUnicidad(error)) {
        throw new ConflictException(
          'Ya hay un cierre de caja abierto. Cerrá el turno actual (PATCH /caja/cerrar) antes de abrir uno nuevo.',
        );
      }
      throw error;
    }
  }

  // Devuelve null (no 404) cuando todavía no se abrió caja: es un estado
  // normal que el frontend consulta al arrancar, no un error.
  async obtenerCajaActual(): Promise<CajaAbiertaResponse | null> {
    const cierre = await this.cierreRepo.findOne({
      where: { cerradoEl: IsNull() },
    });
    return cierre ? this.toCajaAbiertaResponse(cierre) : null;
  }

  // --- Cierre en 4 pasos: contexto y preview (NO persisten nada) ---

  // Paso 2 del wizard: qué se espera en caja y en qué estado están las mesas,
  // todavía sin montos verificados. Es exactamente el preview con el conteo
  // vacío — un solo cálculo, dos puertas de entrada.
  obtenerContextoCierre(): Promise<CierrePreviewResponse> {
    return this.previsualizarCierre({});
  }

  // Paso 3 del wizard: mismo cálculo que el contexto, ahora con los montos que
  // la cajera verificó, para ver diferencias por método y total.
  //
  // NO persiste NADA: no crea CierreCajaDetalle, no toca `cerradoEl`, no
  // modifica sesiones ni mesas. Por eso corre sin transacción y sin lock —
  // repetirlo o corregirlo cuantas veces haga falta es gratis y no bloquea
  // cobros ni el cierre de otra terminal.
  //
  // Tampoco lanza por la regla C: un bloqueo se informa con
  // `puedeCerrar: false` y la fila marcada, no con un error. El 409 es
  // exclusivo del cierre definitivo.
  async previsualizarCierre(
    dto: CerrarCajaDto,
  ): Promise<CierrePreviewResponse> {
    const manager = this.cierreRepo.manager;

    const cierre = await manager.findOne(CierreCaja, {
      where: { cerradoEl: IsNull() },
    });
    if (!cierre) {
      // Mismo patrón que cerrarCaja y ActividadTurnoService: pedir el cierre
      // de un turno que no existe es un conflicto de estado operativo.
      throw new ConflictException(
        'No hay ningún cierre de caja abierto: abrí caja (POST /caja/abrir) antes de previsualizar el cierre.',
      );
    }

    // Igual que al cerrar: sin el método 'efectivo' el fondo inicial dejaría
    // de sumarse al esperado, y el preview mostraría un número que el cierre
    // definitivo no podría reproducir.
    await this.conciliacion.assertMetodoEfectivoExiste(manager);

    const generadoEl = new Date();
    const [detalle, sesiones] = await Promise.all([
      this.conciliacion.calcularDetalle(manager, cierre, generadoEl, dto),
      this.conciliacion.evaluarSesionesDelCierre(manager),
    ]);
    const totales = this.conciliacion.calcularTotales(detalle);

    return {
      idCierre: cierre.idCierre,
      idUsuario: cierre.idUsuario,
      abiertoEl: cierre.abiertoEl,
      generadoEl,
      montoInicialEfectivo: cierre.montoInicialEfectivo,
      ...totales,
      detalle,
      // Eco normalizado, NUNCA persistido acá — ver comentario del campo en
      // CierrePreviewResponse.
      observacionDiferencia: this.conciliacion.normalizarObservacionDiferencia(
        dto.observacionDiferencia,
      ),
      sesiones,
      resumenSesiones: this.conciliacion.resumirSesiones(sesiones),
      puedeCerrar: !sesiones.some((sesion) => sesion.bloqueaCierre),
    };
  }

  // --- Cierre definitivo: la ÚNICA operación irreversible ---

  // Paso 4 del wizard. NO confía en ningún preview previo: vuelve a calcular
  // el arqueo y a revalidar las sesiones desde cero, dentro de la transacción
  // y bajo el lock. Un preview puede haber quedado stale (entró un cobro, se
  // anuló un pago, una mesa pidió la cuenta) y este es el único punto donde
  // el estado que se persiste tiene que ser el real.
  async cerrarCaja(dto: CerrarCajaDto): Promise<CierreCajaResumenResponse> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const manager = queryRunner.manager;

      // Lock pesimista sobre la fila del cierre abierto, sostenido hasta el
      // commit: es la contraparte del que toma PagosService al cobrar sobre
      // ESTA MISMA fila. Mientras este cierre lo retiene, ningún cobro nuevo
      // puede pasar de su validación de caja abierta, así que el conjunto de
      // pagos que suma calcularDetalle no se puede mover por debajo (ver el
      // comentario largo en PagosService.registrarCobroEnTransaccion).
      const cierre = await manager.findOne(CierreCaja, {
        where: { cerradoEl: IsNull() },
        lock: { mode: 'pessimistic_write' },
      });
      if (!cierre) {
        throw new ConflictException(
          'No hay ningún cierre de caja abierto para cerrar.',
        );
      }

      // Las dos precondiciones se chequean ANTES de escribir nada, para que si
      // alguna falla el rollback deje el cierre intacto y no a medio completar.

      // Defensivo: el método pudo borrarse durante el turno (ya se validó al
      // abrir).
      await this.conciliacion.assertMetodoEfectivoExiste(manager);

      // Regla C, revalidada acá y no en el preview: el saldo de las sesiones
      // se recalcula con el manager de ESTA transacción, ya con el lock del
      // cierre tomado. Ese lock es lo que impide que un cobro, un pedido nuevo
      // o una anulación se cuelen entre esta comprobación y el commit —
      // los tres lockean primero esta misma fila de cierres_caja.
      //
      // Lo que el lock NO serializa es `PATCH /mesas/pedir-cuenta`, que no
      // toca cierres_caja: una mesa con deuda puede pedir la cuenta justo
      // después de esta comprobación y quedar del lado del turno siguiente.
      // Es una carrera benigna y aceptada — "pidió la cuenta un instante
      // después de cerrar" es indistinguible de "la pidió un instante después
      // del commit", y bloquear todas las mesas del salón para cerrar caja
      // sería un remedio peor que el problema.
      const sesiones =
        await this.conciliacion.evaluarSesionesDelCierre(manager);
      this.conciliacion.assertSesionesNoBloqueanCierre(sesiones);

      const cerradoEl = new Date();
      const detalle = await this.conciliacion.calcularDetalle(
        manager,
        cierre,
        cerradoEl,
        dto,
      );
      // Se normaliza (trim, '' -> null) ANTES de escribir: lo que se persiste
      // y lo que devuelve la respuesta tienen que ser el MISMO valor exacto.
      const observacionDiferencia =
        this.conciliacion.normalizarObservacionDiferencia(
          dto.observacionDiferencia,
        );

      await manager.save(
        detalle.map((fila) =>
          manager.create(CierreCajaDetalle, {
            idCierre: cierre.idCierre,
            idMetodoPago: fila.idMetodoPago,
            montoEsperado: fila.montoEsperado,
            montoContado: fila.montoContado,
          }),
        ),
      );

      // Se persiste UNA sola vez, en el mismo UPDATE que sella `cerradoEl`:
      // un cierre histórico es inmutable (decisión de esta etapa), así que no
      // hay ningún otro punto de escritura para esta columna.
      await manager.update(
        CierreCaja,
        { idCierre: cierre.idCierre },
        { cerradoEl, observacionDiferencia },
      );

      // Las sesiones NO se tocan (reglas A y B): una caja cerrada no libera
      // mesas ni cierra visitas. La sesión sigue abierta y continúa en el
      // turno siguiente; liberarla es una acción humana aparte
      // (PATCH /mesas/:id/cerrar-sesion).
      const { totalEsperado, totalContado } =
        this.conciliacion.calcularTotales(detalle);

      const resumen: CierreCajaResumenResponse = {
        idCierre: cierre.idCierre,
        idUsuario: cierre.idUsuario,
        abiertoEl: cierre.abiertoEl,
        cerradoEl,
        montoInicialEfectivo: cierre.montoInicialEfectivo,
        totalEsperado,
        totalContado,
        detalle,
        observacionDiferencia,
      };

      await queryRunner.commitTransaction();
      return resumen;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private toCajaAbiertaResponse(cierre: CierreCaja): CajaAbiertaResponse {
    return {
      idCierre: cierre.idCierre,
      idUsuario: cierre.idUsuario,
      abiertoEl: cierre.abiertoEl,
      montoInicialEfectivo: cierre.montoInicialEfectivo,
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
