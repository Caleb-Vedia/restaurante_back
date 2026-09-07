import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { MetodoPago } from '../entities/metodo-pago.entity';
import { CreateMetodoPagoDto } from '../dto/create-metodo-pago.dto';
import { UpdateMetodoPagoDto } from '../dto/update-metodo-pago.dto';
import { normalizarNombre } from '../../common/utils/normalizar-nombre.util';

// Identifica al método protegido por `codigo`, nunca por `nombreMetodo` (que
// el admin puede renombrar libremente) — mismo criterio que
// CierresCajaService.CODIGO_METODO_EFECTIVO.
const CODIGO_METODO_EFECTIVO = 'efectivo';

@Injectable()
export class MetodosPagoService {
  constructor(
    @InjectRepository(MetodoPago)
    private readonly metodoRepo: Repository<MetodoPago>,
  ) {}

  // find() excluye soft-deleted automáticamente por la columna @DeleteDateColumn.
  findAll(): Promise<MetodoPago[]> {
    return this.metodoRepo.find({ order: { idMetodoPago: 'ASC' } });
  }

  async findOne(id: number): Promise<MetodoPago> {
    const metodo = await this.metodoRepo.findOne({
      where: { idMetodoPago: id },
    });
    if (!metodo) {
      throw new NotFoundException(`Método de pago ${id} no encontrado`);
    }
    return metodo;
  }

  async create(dto: CreateMetodoPagoDto): Promise<MetodoPago> {
    await this.assertNombreDisponible(dto.nombreMetodo);
    // `codigo` queda null a propósito: solo lo setea una migración/seed.
    const metodo = this.metodoRepo.create({ nombreMetodo: dto.nombreMetodo });
    return this.metodoRepo.save(metodo);
  }

  async update(id: number, dto: UpdateMetodoPagoDto): Promise<MetodoPago> {
    const metodo = await this.findOne(id);
    if (dto.nombreMetodo !== undefined) {
      await this.assertNombreDisponible(dto.nombreMetodo, metodo.idMetodoPago);
      metodo.nombreMetodo = dto.nombreMetodo;
    }
    return this.metodoRepo.save(metodo);
  }

  async remove(id: number): Promise<void> {
    const metodo = await this.findOne(id);
    // El cierre de caja busca este método por `codigo` para abrir y cerrar
    // turno (CierresCajaService.assertMetodoEfectivoExiste); eliminarlo deja
    // Caja inoperable sin vía de restore. Se bloquea acá, en el origen.
    if (metodo.codigo === CODIGO_METODO_EFECTIVO) {
      throw new ConflictException(
        'El método de pago "efectivo" no puede eliminarse: Caja depende de él para abrir y cerrar turno.',
      );
    }
    await this.metodoRepo.softDelete(id);
  }

  // Unicidad de nombre entre métodos NO soft-deleted, comparando por nombre
  // normalizado (case-insensitive + trim, ver normalizarNombre), nunca por
  // el nombre crudo. Mismo criterio que CategoriasProductoService /
  // ProductosService / MesasService. Deliberadamente NO usa `codigo` para
  // nada — la unicidad es exclusivamente sobre `nombreMetodo`, y `codigo`
  // sigue siendo un campo interno aparte (protección de 'efectivo' en
  // remove(), sin relación con esta regla).
  //
  // `find()` ya excluye soft-deleted por la columna @DeleteDateColumn: un
  // método dado de baja NUNCA bloquea su nombre para uno nuevo.
  //
  // `idExcluido` se pasa solo desde update(): al editar, el propio método
  // no cuenta como "otro" método con ese nombre — permite guardar sin
  // cambios, o solo cambiar el casing/formato del propio nombre, siempre
  // que ningún OTRO método activo lo tenga ya.
  private async assertNombreDisponible(
    nombreMetodo: string,
    idExcluido?: number,
  ): Promise<void> {
    const normalizado = normalizarNombre(nombreMetodo);

    const activos = await this.metodoRepo.find(
      idExcluido === undefined
        ? {}
        : { where: { idMetodoPago: Not(idExcluido) } },
    );

    const duplicado = activos.find(
      (metodo) => normalizarNombre(metodo.nombreMetodo) === normalizado,
    );

    if (duplicado) {
      throw new ConflictException(
        `Ya existe un método de pago llamado "${duplicado.nombreMetodo}".`,
      );
    }
  }
}
