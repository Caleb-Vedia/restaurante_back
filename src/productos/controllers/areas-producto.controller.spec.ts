import { Test, TestingModule } from '@nestjs/testing';
import { AreasProductoController } from './areas-producto.controller';

describe('AreasProductoController', () => {
  let controller: AreasProductoController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AreasProductoController],
    }).compile();

    controller = module.get<AreasProductoController>(AreasProductoController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
