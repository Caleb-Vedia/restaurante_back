import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class CreateProductoDto {
  @IsString()
  @IsNotEmpty()
  nombreProducto: string;

  @IsOptional()
  @IsString()
  descripcion?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  precio: number;

  @IsInt()
  @IsPositive()
  idAreaProducto: number;

  @IsInt()
  @IsPositive()
  idCategoriaProducto: number;

  @IsOptional()
  @IsString()
  urlImagen?: string;
}
