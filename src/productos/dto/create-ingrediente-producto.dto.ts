import { IsNotEmpty, IsString } from 'class-validator';

export class CreateIngredienteProductoDto {
  @IsString()
  @IsNotEmpty()
  nombreIngrediente: string;
}
