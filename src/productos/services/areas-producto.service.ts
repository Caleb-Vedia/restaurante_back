import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AreaProducto } from '../entities/area-producto.entity';
import { CreateAreaProductoDto } from '../dto/create-area-producto.dto';
import { UpdateAreaProductoDto } from '../dto/update-area-producto.dto';

@Injectable()
export class AreasProductoService {
  constructor(
    @InjectRepository(AreaProducto)
    private readonly areaRepo: Repository<AreaProducto>,
  ) {}

  // find() excluye soft-deleted automáticamente por la columna @DeleteDateColumn.
  findAll(): Promise<AreaProducto[]> {
    return this.areaRepo.find({ order: { idAreaProducto: 'ASC' } });
  }

  async findOne(id: number): Promise<AreaProducto> {
    const area = await this.areaRepo.findOne({ where: { idAreaProducto: id } });
    if (!area) {
      throw new NotFoundException(`Área de producto ${id} no encontrada`);
    }
    return area;
  }

  create(dto: CreateAreaProductoDto): Promise<AreaProducto> {
    const area = this.areaRepo.create({ nombreArea: dto.nombreArea });
    return this.areaRepo.save(area);
  }

  async update(id: number, dto: UpdateAreaProductoDto): Promise<AreaProducto> {
    const area = await this.findOne(id);
    if (dto.nombreArea !== undefined) {
      area.nombreArea = dto.nombreArea;
    }
    return this.areaRepo.save(area);
  }

  async remove(id: number): Promise<void> {
    await this.findOne(id);
    await this.areaRepo.softDelete(id);
  }
}
