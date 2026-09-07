import { IsNotEmpty, IsString } from 'class-validator';

export class CreateAreaProductoDto {
  @IsString()
  @IsNotEmpty()
  nombreArea: string;
}
