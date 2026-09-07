import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  Not,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { Pago } from '../entities/pago.entity';
import { MetodoPago } from '../entities/metodo-pago.entity';
import { CierreCaja } from '../../caja/entities/cierre-caja.entity';
import { Mesa } from '../../mesas/entities/mesa.entity';
import { SesionMesa } from '../../mesas/entities/sesion-mesa.entity';
import { MesasService } from '../../mesas/services/mesas.service';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { aCentavos, desdeCentavos } from '../../common/utils/dinero.util';
import {
  calcularSaldoSesion,
  calcularTotalAdeudado,
  calcularTotalPagado,
} from '../../common/utils/saldo-sesion.util';
import { lockearCajaAbierta } from '../../common/utils/caja-abierta.util';
import { RegistrarPagoDto } from '../dto/registrar-pago.dto';
import {
  PagoResponse,
  RegistrarPagoResponse,
  TotalAdeudadoResponse,
} from '../dto/pago-response.dto';
import { toPagoResponse } from '../dto/pago-response.mapper';

// Código de error de Postgres para violación de constraint único. Mismo
// criterio (y mismo valor) que SesionesMesaService y CierresCajaService: acá
// hace falta para el índice único parcial idx_sesiones_mesa_id_mesa_abierta,
// que es el backstop real de "una sola sesión abierta por mesa" al reabrir.
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class PagosService {
  constructor(
    @InjectRepository(Pago)
    private readonly pagoRepo: Repository<Pago>,
    @InjectRepository(SesionMesa)
    private readonly sesionRepo: Repository<SesionMesa>,
    private readonly mesasService: MesasService,
    private readonly dataSource: DataSource,
  ) {}

  // Total adeudado de la sesión activa de una mesa, más lo ya pagado.
  async obtenerTotalDeMesa(idMesa: number): Promise<TotalAdeudadoResponse> {
    const sesion = await this.obtenerSesionActivaDeMesa(
      this.pagoRepo.manager,
      idMesa,
    );

    // Mismo cálculo (mismas dos consultas, misma aritmética en centavos) que
    // antes vivía en los métodos privados de este service: ahora es la
    // utilidad compartida con MesasService — ver saldo-sesion.util.
    const { totalAdeudado, totalPagado, saldoPendiente } =
      await calcularSaldoSesion(this.pagoRepo.manager, sesion.idSesion);

    return {
      idMesa: sesion.mesa.idMesa,
      nombreMesa: sesion.mesa.nombreMesa,
      idSesion: sesion.idSesion,
      abiertaEl: sesion.abiertaEl,
      totalAdeudado,
      totalPagado,
      saldoPendiente,
    };
  }

  async registrarPago(dto: RegistrarPagoDto): Promise<RegistrarPagoResponse> {
    const { cobro, idMesa } = await this.registrarCobroEnTransaccion(dto);

    // Cierre de la sesión DESPUÉS del commit: MesasService usa sus propios
    // repositorios (conexión distinta del queryRunner de arriba), así que no
    // puede participar de esa transacción. Si fallara, el cobro ya quedó
    // registrado y la mesa se libera reintentando PATCH /mesas/:id/cerrar-sesion
    // — preferible a perder el pago por un rollback.
    try {
      const mesa = await this.mesasService.cerrarSesionActiva(idMesa);
      return {
        ...cobro,
        mesa: {
          idMesa: mesa.idMesa,
          nombreMesa: mesa.nombreMesa,
          estado: mesa.estado,
        },
        mesaLiberada: true,
      };
    } catch {
      const mesa = await this.mesasService.findOne(idMesa);
      return {
        ...cobro,
        mesa: {
          idMesa: mesa.idMesa,
          nombreMesa: mesa.nombreMesa,
          estado: mesa.estado,
        },
        mesaLiberada: false,
      };
    }
  }

  private async registrarCobroEnTransaccion(dto: RegistrarPagoDto): Promise<{
    cobro: Omit<RegistrarPagoResponse, 'mesa' | 'mesaLiberada'>;
    idMesa: number;
  }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const manager = queryRunner.manager;

      // Regla: no se cobra sin caja abierta (el pago tiene que caer dentro de
      // un turno para que el cierre lo pueda contabilizar).
      //
      // El lock pesimista sobre la fila del cierre abierto es lo que sincroniza
      // este cobro con CierresCajaService.cerrarCaja, que toma FOR UPDATE sobre
      // ESA MISMA fila y lo sostiene hasta su commit. Sin el lock, este SELECT
      // no bloqueaba a nadie y quedaban dos carreras abiertas:
      //   - el cierre commiteaba entre esta validación y el INSERT, dejando un
      //     pago con creado_el posterior a cerrado_el (de ningún turno);
      //   - el pago commiteaba después de que el cierre ya había sumado los
      //     totales, quedando dentro de [abiertoEl, cerradoEl] pero fuera del
      //     snapshot de CierreCajaDetalle.
      //
      // Con el lock solo quedan dos desenlaces posibles:
      //   - gana el cobro: el cierre espera acá y su suma, que corre DESPUÉS de
      //     obtener el lock (statement nuevo en READ COMMITTED), ve el pago ya
      //     commiteado -> queda en el arqueo;
      //   - gana el cierre: este SELECT ... FOR UPDATE espera, y al reevaluar la
      //     fila ya actualizada (EvalPlanQual) deja de cumplir `cerrado_el IS
      //     NULL`, así que devuelve null -> 409 y no se inserta nada.
      //
      // Este es además el PRIMER lock de la transacción, antes del de SesionMesa:
      // fija el orden global CierreCaja -> SesionMesa y evita el ciclo con
      // cerrarCaja (ver anularPago, que toma Pago -> SesionMesa y nunca lockea
      // CierreCaja).
      //
      // La consulta en sí vive en lockearCajaAbierta (caja-abierta.util): es la
      // MISMA que necesita PedidosService.crearPedido para su propia regla de
      // "sin caja abierta no se registra", y una sola definición evita que las
      // dos se separen. El mensaje del 409 sí es propio de cada flujo.
      const cajaAbierta = await lockearCajaAbierta(manager);
      if (!cajaAbierta) {
        throw new ConflictException(
          'No hay un cierre de caja abierto: primero debe abrirse caja (POST /caja/abrir) para poder registrar pagos.',
        );
      }

      const sesion = await this.obtenerSesionActivaDeMesa(manager, dto.idMesa);

      // Lock pesimista sobre la sesión: serializa dos cobros simultáneos de la
      // misma mesa, para que no se dupliquen pagos ni se cierre dos veces.
      await manager.findOne(SesionMesa, {
        where: { idSesion: sesion.idSesion },
        lock: { mode: 'pessimistic_write' },
      });

      await this.validarMetodosDePago(manager, dto);

      const totalAdeudado = await calcularTotalAdeudado(
        manager,
        sesion.idSesion,
      );
      if (aCentavos(totalAdeudado) === 0) {
        throw new ConflictException(
          `La sesión de la mesa ${sesion.mesa.idMesa} no tiene consumos registrados: no hay nada que cobrar.`,
        );
      }

      // "Los pagos de una mesa deben sumar exacto el total adeudado": se
      // cuentan también los pagos no anulados ya existentes de esta sesión, así
      // un reintento tras un cierre fallido no cobra dos veces.
      const yaPagado = await calcularTotalPagado(manager, sesion.idSesion);
      const nuevoPagado = dto.pagos.reduce(
        (acumulado, pago) => acumulado + aCentavos(pago.montoPagado),
        0,
      );
      const totalRecibido = aCentavos(yaPagado) + nuevoPagado;

      if (totalRecibido !== aCentavos(totalAdeudado)) {
        throw new ConflictException(
          `El pago no coincide con el total adeudado: total adeudado ${totalAdeudado.toFixed(2)}, total recibido ${desdeCentavos(totalRecibido).toFixed(2)}` +
            (aCentavos(yaPagado) > 0
              ? ` (incluye ${yaPagado.toFixed(2)} ya registrado previamente en esta sesión)`
              : '') +
            '. El cobro debe cubrir el total exacto, ni más ni menos.',
        );
      }

      // `creadoEl` explícito, tomado ACÁ: después de haber encontrado la caja
      // abierta y de tener su lock. Sin esto lo ponía Postgres con el
      // `DEFAULT now()` de la columna, y `now()` es `transaction_timestamp()`
      // — el instante en que ARRANCÓ esta transacción, no el del INSERT. Si la
      // transacción había empezado antes de que `abrirCaja` commiteara, el pago
      // quedaba con `creado_el < caja.abierto_el`: fuera de la ventana del
      // turno, invisible para el arqueo y para la detección de cierre
      // histórico, aunque operativamente perteneciera a ese turno.
      //
      // Se usa `new Date()` de Node por coherencia con el resto del modelo:
      // `CierreCaja.abiertoEl` y `cerradoEl` también salen de `new Date()` en
      // CierresCajaService, así que las tres puntas de la comparación
      // `abiertoEl <= creadoEl <= cerradoEl` vienen del MISMO reloj y no
      // dependen de que el de Postgres esté sincronizado con el del proceso.
      //
      // Un solo timestamp para todo el cobro (no uno por ítem): un cobro
      // dividido es UNA operación, y compartir el instante deja los pagos de
      // un mismo ticket inequívocamente en la misma ventana de turno.
      const creadoEl = new Date();

      const pagos = await manager.save(
        dto.pagos.map((item) =>
          manager.create(Pago, {
            idSesion: sesion.idSesion,
            idMetodoPago: item.idMetodoPago,
            montoPagado: item.montoPagado,
            creadoEl,
            nroRecibo: item.nroRecibo ?? null,
          }),
        ),
      );

      const respuestaPagos = await this.buscarPagosResponse(
        manager,
        pagos.map((pago) => pago.idPago),
      );

      const cobro = {
        idSesion: sesion.idSesion,
        totalAdeudado,
        totalPagado: desdeCentavos(totalRecibido),
        pagos: respuestaPagos,
      };

      await queryRunner.commitTransaction();
      return { cobro, idMesa: sesion.mesa.idMesa };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // Anulación de un pago (decisión #18). Operación ATÓMICA: o queda el pago
  // anulado CON la sesión/mesa en un estado coherente, o no queda escrito
  // absolutamente nada. Todo pasa por una sola transacción a propósito —
  // el patrón "anular, commitear, arreglar la sesión después" que usa
  // registrarPago para liberar la mesa acá no sirve: allá el peor caso es una
  // mesa que queda ocupada de más (recuperable), acá sería una deuda que
  // reaparece sin sesión donde cobrarla.
  //
  // Dos reglas conviven:
  //  A) Un pago que ya cayó dentro de un turno de caja CERRADO no se puede
  //     anular (409). CierreCaja/CierreCajaDetalle son la fotografía contable
  //     inmutable del arqueo de ese turno: anular por atrás dejaría el
  //     histórico mintiendo sin recalcularlo. La corrección de un turno ya
  //     consolidado se documenta fuera del sistema.
  //  B) Un pago del turno todavía abierto sí se anula. Si al excluirlo vuelve
  //     a aparecer deuda sobre una sesión que ya se había cerrado, se REABRE
  //     esa misma sesión (nunca se crea otra) para que el flujo normal de
  //     cobro (POST /pagos, que busca la sesión activa de la mesa) pueda
  //     volver a cobrarla.
  async anularPago(idPago: number): Promise<PagoResponse> {
    // Lectura preliminar SIN lock y fuera de la transacción: sirve únicamente
    // para saber en qué ventana de turno cae el pago y poder tomar ESE lock
    // primero, respetando el orden global CierreCaja -> Pago -> SesionMesa ->
    // Mesa. `creado_el` es inmutable en el modelo (nada lo reescribe), así que
    // es seguro usarlo para localizar la ventana; todo lo demás —incluido que
    // el pago siga existiendo y vigente— se revalida abajo bajo lock.
    const preliminar = await this.pagoRepo.findOne({ where: { idPago } });
    if (!preliminar) {
      throw new NotFoundException(`Pago ${idPago} no encontrado`);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const manager = queryRunner.manager;

      // Regla A, ahora sincronizada: se lockea la fila del turno al que
      // pertenece el pago ANTES de tocar nada. Si es el turno abierto, el lock
      // se sostiene hasta el commit y cerrarCaja no puede cerrarlo por debajo;
      // si ya está cerrado, esto lanza 409 sin escribir nada.
      await this.lockearTurnoYAssertNoCerrado(manager, preliminar);

      // Lock pesimista sobre la fila del pago: serializa dos anulaciones
      // simultáneas del MISMO pago. La segunda espera en el lock y, al
      // re-evaluar la fila una vez que la primera commitea, ya la ve con
      // anuladoEl seteado -> 409, en vez de anular dos veces.
      const pago = await manager.findOne(Pago, {
        where: { idPago },
        lock: { mode: 'pessimistic_write' },
      });
      if (!pago) {
        throw new NotFoundException(`Pago ${idPago} no encontrado`);
      }
      if (pago.anuladoEl !== null) {
        throw new ConflictException(`El pago ${idPago} ya estaba anulado`);
      }
      // Las premisas con las que se eligió el turno a lockear siguen valiendo.
      // Hoy es inalcanzable (ambas columnas son inmutables vía API): es una
      // aserción defensiva contra una edición manual de la base entre la
      // lectura preliminar y el lock, no un caso de uso esperable.
      if (
        pago.creadoEl.getTime() !== preliminar.creadoEl.getTime() ||
        pago.idSesion !== preliminar.idSesion
      ) {
        throw new ConflictException(
          `El pago ${idPago} cambió mientras se procesaba la anulación. Reintentá la operación.`,
        );
      }

      // Sesión del pago, bloqueada: es la MISMA fila que lockean
      // registrarCobroEnTransaccion y MesasService.cerrarSesionActiva, así que
      // esta anulación queda serializada contra un cobro o un cierre de sesión
      // concurrentes sobre esa sesión.
      const sesion = await manager.findOne(SesionMesa, {
        where: { idSesion: pago.idSesion },
        lock: { mode: 'pessimistic_write' },
      });
      if (!sesion) {
        throw new NotFoundException(
          `El pago ${idPago} apunta a la sesión ${pago.idSesion}, que no existe`,
        );
      }

      await manager.update(Pago, { idPago }, { anuladoEl: new Date() });

      // El saldo se relee de la base DENTRO de esta transacción, ya con el
      // pago marcado: la deuda reaparece sola por el filtro `anuladoEl IS
      // NULL` de calcularTotalPagado. No se hace aritmética paralela ni un
      // segundo cálculo propio de este método — es la misma utilidad
      // compartida que usan el cobro y la liberación de mesa.
      const saldo = await calcularSaldoSesion(manager, sesion.idSesion);

      // Caso "sesión activa" (cerradaEl null): no hay nada que reabrir ni
      // estado de mesa que tocar — el saldo ya volvió a subir solo.
      // Caso "saldo 0": tampoco se reabre nada (no hay deuda que cobrar).
      if (saldo.saldoPendienteCentavos > 0 && sesion.cerradaEl !== null) {
        await this.reabrirSesionConDeuda(manager, sesion);
      }

      const [respuesta] = await this.buscarPagosResponse(manager, [idPago]);

      await queryRunner.commitTransaction();
      return respuesta;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // Historial de la sesión activa de la mesa o, si no hay ninguna abierta, de
  // la última sesión cerrada — para poder revisar/anular después del cobro.
  async historialPorMesa(idMesa: number): Promise<PagoResponse[]> {
    // La sesión de mayor id es siempre la más reciente (y si hay una abierta,
    // es necesariamente esa, por el índice único parcial de sesiones_mesa).
    const sesion = await this.sesionRepo.findOne({
      where: { idMesa },
      order: { idSesion: 'DESC' },
    });
    if (!sesion) {
      throw new NotFoundException(
        `La mesa ${idMesa} no tiene ninguna sesión registrada`,
      );
    }

    const pagos = await this.pagoRepo.find({
      where: { idSesion: sesion.idSesion },
      relations: { metodoPago: true },
      order: { idPago: 'ASC' },
      // El método de pago pudo darse de baja después del cobro; el histórico
      // igual tiene que poder mostrar su nombre.
      withDeleted: true,
    });
    return pagos.map((pago) => toPagoResponse(pago));
  }

  // --- Helpers ---

  private async obtenerSesionActivaDeMesa(
    manager: EntityManager,
    idMesa: number,
  ): Promise<SesionMesa> {
    const sesion = await manager.findOne(SesionMesa, {
      where: { idMesa, cerradaEl: IsNull() },
      relations: { mesa: true },
    });
    if (!sesion || !sesion.mesa) {
      throw new NotFoundException(
        `La mesa ${idMesa} no tiene una sesión abierta`,
      );
    }
    return sesion;
  }

  private async validarMetodosDePago(
    manager: EntityManager,
    dto: RegistrarPagoDto,
  ): Promise<void> {
    const ids = [...new Set(dto.pagos.map((pago) => pago.idMetodoPago))];
    // find() excluye soft-deleted: no se puede cobrar con un método dado de baja.
    const metodos = await manager.find(MetodoPago, {
      where: { idMetodoPago: In(ids) },
    });
    const encontrados = new Set(metodos.map((metodo) => metodo.idMetodoPago));
    const faltantes = ids.filter((id) => !encontrados.has(id));
    if (faltantes.length > 0) {
      throw new NotFoundException(
        `Métodos de pago inexistentes o dados de baja: ${faltantes.join(', ')}.`,
      );
    }
  }

  // Regla A. La pertenencia de un pago a un turno se resuelve por RANGO
  // TEMPORAL: no existe FK pagos -> cierres_caja (y esta etapa no la agrega).
  // El rango identifica a lo sumo un turno porque el índice único parcial
  // idx_cierres_caja_abierto_unico garantiza un solo cierre abierto a la vez:
  // los turnos no se solapan, van uno detrás de otro.
  //
  // La condición incluye el turno TODAVÍA ABIERTO (`cerrado_el IS NULL`), no
  // solo los cerrados. Buscar únicamente cerrados dejaba sin lock justamente
  // al turno en curso, que es el que cerrarCaja puede estar cerrando ahora
  // mismo: ahí vivía la carrera — se comprobaba "todavía no es histórico",
  // cerrarCaja cerraba, y la anulación seguía adelante sobre un pago que
  // acababa de volverse histórico.
  //
  // El FOR UPDATE lo resuelve en los dos sentidos, apoyándose en EvalPlanQual
  // (READ COMMITTED):
  //   - si esta anulación gana el lock, cerrarCaja espera acá y su snapshot,
  //     que se calcula después, ya ve el pago anulado y lo excluye;
  //   - si gana cerrarCaja, este SELECT espera y al reevaluar la fila ya
  //     actualizada la sigue matcheando —`cerrado_el >= creadoEl` es
  //     verdadero— pero ahora con `cerradoEl` no nulo, así que cae en el 409.
  private async lockearTurnoYAssertNoCerrado(
    manager: EntityManager,
    pago: Pago,
  ): Promise<void> {
    const cierre = await manager
      .createQueryBuilder(CierreCaja, 'cierre')
      .setLock('pessimistic_write')
      .where('cierre.abiertoEl <= :creadoEl', { creadoEl: pago.creadoEl })
      .andWhere('(cierre.cerradoEl IS NULL OR cierre.cerradoEl >= :creadoEl)', {
        creadoEl: pago.creadoEl,
      })
      .getOne();

    if (cierre?.cerradoEl) {
      throw new ConflictException(
        `El pago ${pago.idPago} pertenece a un turno de caja ya cerrado (cierre ${cierre.idCierre}) y no puede anularse.`,
      );
    }

    // `cierre === null` = el pago no cae en NINGUNA ventana de turno. Se
    // conserva el comportamiento previo (se deja anular) en vez de inventar
    // una regla nueva: son pagos huérfanos anteriores a esta sincronización,
    // creados en la ventana que la Etapa 3B cerró (creado_el tomaba el inicio
    // de la transacción y podía caer antes de `abierto_el`). No debilita nada:
    // un pago así tiene `creado_el` ANTERIOR al `abierto_el` de todo turno
    // existente, y como `abierto_el` nunca cambia, cerrar el turno en curso
    // solo puede extender su ventana hacia adelante — nunca hacia atrás para
    // capturarlo. O sea: no puede volverse histórico, y por eso no necesita
    // lock. Los pagos nuevos ya no pueden caer en este caso.
  }

  // Reabre la MISMA SesionMesa (nunca crea otra): los pedidos y sus detalles
  // siguen colgando de este id_sesion, así que la deuda vuelve a quedar
  // cobrable por el flujo normal sin tocar un solo pedido. La mesa pasa a
  // CUENTA_SOLICITADA porque es el estado que describe la realidad —
  // consumo ya servido esperando cobro — y deja a Caja cobrando de nuevo sin
  // que el cliente tenga que volver a escanear el QR.
  private async reabrirSesionConDeuda(
    manager: EntityManager,
    sesion: SesionMesa,
  ): Promise<void> {
    // Una mesa no puede tener dos sesiones abiertas (índice único parcial
    // idx_sesiones_mesa_id_mesa_abierta). Si otros comensales ya abrieron una
    // sesión nueva sobre esta mesa, reabrir la vieja chocaría contra ese
    // índice: se aborta TODO — incluida la anulación del pago — con 409.
    const otraSesionActiva = await manager.findOne(SesionMesa, {
      where: {
        idMesa: sesion.idMesa,
        cerradaEl: IsNull(),
        idSesion: Not(sesion.idSesion),
      },
    });
    if (otraSesionActiva) {
      throw new ConflictException(
        `No se puede anular el pago porque la mesa ${sesion.idMesa} ya tiene una nueva sesión activa (sesión ${otraSesionActiva.idSesion}). No se anuló el pago ni se modificó ninguna sesión.`,
      );
    }

    // findOne excluye soft-deleted: una mesa dada de baja después de cerrarse
    // la sesión no puede volver a ocuparse.
    const mesa = await manager.findOne(Mesa, {
      where: { idMesa: sesion.idMesa },
    });
    if (!mesa) {
      throw new ConflictException(
        `No se puede anular el pago: la mesa ${sesion.idMesa} de la sesión ${sesion.idSesion} ya no está disponible.`,
      );
    }

    try {
      await manager.update(
        SesionMesa,
        { idSesion: sesion.idSesion },
        { cerradaEl: null },
      );
    } catch (error) {
      // Backstop del índice único parcial: entre el chequeo de arriba y este
      // update, otra transacción pudo abrir una sesión en la misma mesa (la
      // mesa está `libre`, así que un QR escaneado en ese instante la abre).
      // Se traduce al MISMO 409 en vez de dejar escapar el 23505 crudo.
      if (this.esViolacionUnicidad(error)) {
        throw new ConflictException(
          `No se puede anular el pago porque la mesa ${sesion.idMesa} ya tiene una nueva sesión activa. No se anuló el pago ni se modificó ninguna sesión.`,
        );
      }
      throw error;
    }

    await manager.update(
      Mesa,
      { idMesa: mesa.idMesa },
      { estado: EstadoMesa.CUENTA_SOLICITADA },
    );
  }

  private esViolacionUnicidad(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
      return false;
    }
    const driverError = error.driverError as { code?: string } | undefined;
    return driverError?.code === PG_UNIQUE_VIOLATION;
  }

  private async buscarPagosResponse(
    manager: EntityManager,
    idsPago: number[],
  ): Promise<PagoResponse[]> {
    const pagos = await manager.find(Pago, {
      where: { idPago: In(idsPago) },
      relations: { metodoPago: true },
      order: { idPago: 'ASC' },
      withDeleted: true,
    });
    return pagos.map((pago) => toPagoResponse(pago));
  }
}
