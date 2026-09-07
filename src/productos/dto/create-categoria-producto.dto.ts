import { IsNotEmpty, IsString } from 'class-validator';

export class CreateCategoriaProductoDto {
  @IsString()
  @IsNotEmpty()
  nombreCategoria: string;
}
