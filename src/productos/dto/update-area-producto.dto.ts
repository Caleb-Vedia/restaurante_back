import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateAreaProductoDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nombreArea?: string;
}
