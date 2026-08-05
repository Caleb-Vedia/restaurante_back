import { Test, TestingModule } from '@nestjs/testing';
import { AreasProductoService } from './areas-producto.service';

describe('AreasProductoService', () => {
  let service: AreasProductoService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AreasProductoService],
    }).compile();

    service = module.get<AreasProductoService>(AreasProductoService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
