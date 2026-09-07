import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Not, Repository } from 'typeorm';
import { Mesa } from '../entities/mesa.entity';
import { SesionMesa } from '../entities/sesion-mesa.entity';
import { CreateMesaDto } from '../dto/create-mesa.dto';
import { UpdateMesaDto } from '../dto/update-mesa.dto';
import { MesaResponse } from '../dto/mesa-response.dto';
import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { normalizarNombre } from '../../common/utils/normalizar-nombre.util';
import { calcularSaldoSesion } from '../../common/utils/saldo-sesion.util';

@Injectable()
export class MesasService {
  constructor(
    @InjectRepository(Mesa)
    private readonly mesaRepo: Repository<Mesa>,
    @InjectRepository(SesionMesa)
    private readonly sesionRepo: Repository<SesionMesa>,
    private readonly dataSource: DataSource,
  ) {}

  async create(dto: CreateMesaDto): Promise<MesaResponse> {
    await this.assertNombreDisponible(dto.nombreMesa);
    const mesa = this.mesaRepo.create({ nombreMesa: dto.nombreMesa });
    const saved = await this.mesaRepo.save(mesa);
    // Reload para reflejar el default de `estado` aplicado en la base (libre).
    return this.findOne(saved.idMesa);
  }

  // Lista mesas no soft-deleted; cada una con su sesión activa (cerradaEl IS
  // NULL) si existe. El leftJoin filtra la relación a 0..1 sesión abierta.
  async findAll(): Promise<MesaResponse[]> {
    const mesas = await this.mesaRepo
      .createQueryBuilder('mesa')
      .leftJoinAndSelect('mesa.sesiones', 'sesion', 'sesion.cerradaEl IS NULL')
      .orderBy('mesa.idMesa', 'ASC')
      .getMany();
    return mesas.map((mesa) => this.toMesaResponse(mesa));
  }

  async findOne(id: number): Promise<MesaResponse> {
    const mesa = await this.mesaRepo
      .createQueryBuilder('mesa')
      .leftJoinAndSelect('mesa.sesiones', 'sesion', 'sesion.cerradaEl IS NULL')
      .where('mesa.idMesa = :id', { id })
      .getOne();
    if (!mesa) {
      throw new NotFoundException(`Mesa ${id} no encontrada`);
    }
    return this.toMesaResponse(mesa);
  }

  // Solo edita el nombre. El `estado` nunca se cambia por acá — solo por las
  // transiciones de sesión (abrir / pedir cuenta / cerrar).
  async update(id: number, dto: UpdateMesaDto): Promise<MesaResponse> {
    const mesa = await this.getMesaOrFail(id);
    if (dto.nombreMesa !== undefined) {
      await this.assertNombreDisponible(dto.nombreMesa, mesa.idMesa);
      mesa.nombreMesa = dto.nombreMesa;
    }
    await this.mesaRepo.save(mesa);
    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    const mesa = await this.getMesaOrFail(id);
    if (mesa.estado !== EstadoMesa.LIBRE) {
      throw new ConflictException(
        `No se puede borrar la mesa ${id}: está en estado "${mesa.estado}" (sesión abierta). Cerrá la sesión primero.`,
      );
    }
    await this.mesaRepo.softDelete(id);
  }

  // Cierra la sesión activa de una mesa y la deja libre. Método público y
  // estable: el módulo de Pagos+Caja lo invoca directo (sin el endpoint HTTP)
  // al cobrar y cerrar la cuenta, y es además el único camino de
  // PATCH /mesas/:id/cerrar-sesion.
  //
  // PRECONDICIÓN ECONÓMICA: solo libera si el saldo pendiente de la sesión
  // es 0. La regla es económica, NO de estado: da igual que la mesa esté
  // `ocupada` o `cuenta_solicitada` — lo único que decide es la deuda.
  //   - sesión sin pedidos            -> saldo 0 -> libera
  //   - sesión totalmente pagada      -> saldo 0 -> libera
  //   - sesión con consumo sin cubrir -> saldo > 0 -> 409, no toca nada
  // Nunca crea pagos ni modifica pedidos/importes para llegar a 0.
  //
  // Todo ocurre en UNA transacción con lock pesimista sobre la fila de la
  // SesionMesa (mismo patrón que PedidosService.crearPedido y
  // PagosService.registrarCobroEnTransaccion): el lock serializa este cierre
  // contra un cobro o un pedido nuevo concurrentes sobre la misma sesión, y
  // la transacción evita el estado a medio escribir que existía antes
  // (sesión cerrada pero mesa todavía ocupada si el segundo save fallaba).
  async cerrarSesionActiva(idMesa: number): Promise<MesaResponse> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const manager = queryRunner.manager;

      const mesa = await manager.findOne(Mesa, { where: { idMesa } });
      if (!mesa) {
        throw new NotFoundException(`Mesa ${idMesa} no encontrada`);
      }

      const sesionActiva = await manager.findOne(SesionMesa, {
        where: { idMesa, cerradaEl: IsNull() },
      });
      if (!sesionActiva) {
        throw new NotFoundException(
          `La mesa ${idMesa} no tiene una sesión activa para cerrar`,
        );
      }

      // Lock pesimista + recheck bajo el lock: entre la búsqueda de arriba y
      // este punto, otra terminal pudo cerrar la sesión (doble click de la
      // cajera, recuperación desde dos pestañas). Si ya está cerrada se
      // responde igual que "no hay sesión activa", sin cerrarla dos veces.
      const sesionBloqueada = await manager.findOne(SesionMesa, {
        where: { idSesion: sesionActiva.idSesion },
        lock: { mode: 'pessimistic_write' },
      });
      if (!sesionBloqueada || sesionBloqueada.cerradaEl !== null) {
        throw new NotFoundException(
          `La mesa ${idMesa} no tiene una sesión activa para cerrar`,
        );
      }

      // Saldo calculado YA bajo el lock, con el manager de esta transacción:
      // fuente única compartida con PagosService (ver saldo-sesion.util).
      const saldo = await calcularSaldoSesion(
        manager,
        sesionBloqueada.idSesion,
      );

      // Comparación en centavos enteros, nunca sobre el float.
      //
      // Se bloquea con saldo > 0 (deuda) y no con `!== 0`: un saldo NEGATIVO
      // (pagado de más) es inalcanzable por la API — registrarPago exige
      // coincidencia exacta, agregar pedidos solo sube la deuda y anular un
      // pago también. Si apareciera por una edición manual de la base,
      // bloquear el cierre dejaría la mesa trabada sin salida operativa,
      // cuando el riesgo que esta regla protege es específicamente la deuda.
      if (saldo.saldoPendienteCentavos > 0) {
        throw new ConflictException(
          `No se puede liberar la mesa: tiene un saldo pendiente de Bs ${saldo.saldoPendiente.toFixed(2)}. Registrá el pago completo antes de cerrar la sesión.`,
        );
      }

      sesionBloqueada.cerradaEl = new Date();
      await manager.save(sesionBloqueada);

      mesa.estado = EstadoMesa.LIBRE;
      await manager.save(mesa);

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }

    // Fuera de la transacción ya commiteada: relee el estado real para
    // devolver el mismo contrato MesaResponse de siempre.
    return this.findOne(idMesa);
  }

  // Unicidad de nombre entre mesas NO soft-deleted, sin importar `estado`
  // (libre/ocupada/cuenta_solicitada) — comparando por nombre normalizado
  // (case-insensitive + trim, ver normalizarNombre), nunca por el nombre
  // crudo. Mismo criterio que CategoriasProductoService/ProductosService.
  //
  // `find()` ya excluye soft-deleted por la columna @DeleteDateColumn: una
  // mesa dada de baja NUNCA bloquea su nombre para una nueva. `estado` no
  // aparece en esta condición a propósito: una mesa ocupada o con cuenta
  // solicitada sigue reservando su nombre igual que una libre.
  //
  // `idExcluido` se pasa solo desde update(): al editar, la propia mesa no
  // cuenta como "otra" mesa con ese nombre — permite guardar sin cambios,
  // o solo cambiar el casing/formato del propio nombre, siempre que
  // ninguna OTRA mesa activa lo tenga ya.
  private async assertNombreDisponible(
    nombreMesa: string,
    idExcluido?: number,
  ): Promise<void> {
    const normalizado = normalizarNombre(nombreMesa);

    const activas = await this.mesaRepo.find(
      idExcluido === undefined ? {} : { where: { idMesa: Not(idExcluido) } },
    );

    const duplicada = activas.find(
      (mesa) => normalizarNombre(mesa.nombreMesa) === normalizado,
    );

    if (duplicada) {
      throw new ConflictException(
        `Ya existe una mesa llamada "${duplicada.nombreMesa}".`,
      );
    }
  }

  // Mesa cruda (sin sesiones), no soft-deleted, o 404.
  private async getMesaOrFail(id: number): Promise<Mesa> {
    const mesa = await this.mesaRepo.findOne({ where: { idMesa: id } });
    if (!mesa) {
      throw new NotFoundException(`Mesa ${id} no encontrada`);
    }
    return mesa;
  }

  private toMesaResponse(mesa: Mesa): MesaResponse {
    const sesionActiva = (mesa.sesiones ?? [])[0] ?? null;
    return {
      idMesa: mesa.idMesa,
      nombreMesa: mesa.nombreMesa,
      estado: mesa.estado,
      sesionActiva: sesionActiva
        ? {
            idSesion: sesionActiva.idSesion,
            abiertaEl: sesionActiva.abiertaEl,
          }
        : null,
    };
  }
}
