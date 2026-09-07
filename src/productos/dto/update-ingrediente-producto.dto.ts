import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateIngredienteProductoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nombreIngrediente?: string;
}
