import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateCategoriaProductoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nombreCategoria?: string;
}
