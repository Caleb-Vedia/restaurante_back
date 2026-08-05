import { Test, TestingModule } from '@nestjs/testing';
import { CategoriasProductoController } from './categorias-producto.controller';

describe('CategoriasProductoController', () => {
  let controller: CategoriasProductoController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CategoriasProductoController],
    }).compile();

    controller = module.get<CategoriasProductoController>(CategoriasProductoController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
