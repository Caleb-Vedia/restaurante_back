import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

export class UpdateProductoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nombreProducto?: string;

  @IsOptional()
  @IsString()
  descripcion?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  precio?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  idAreaProducto?: number;

  @IsOptional()
  @IsInt()
  @IsPositive()
  idCategoriaProducto?: number;

  @IsOptional()
  @IsString()
  urlImagen?: string;
}
