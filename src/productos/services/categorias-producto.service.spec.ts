import { Test, TestingModule } from '@nestjs/testing';
import { CategoriasProductoService } from './categorias-producto.service';

describe('CategoriasProductoService', () => {
  let service: CategoriasProductoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CategoriasProductoService],
    }).compile();

    service = module.get<CategoriasProductoService>(CategoriasProductoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
