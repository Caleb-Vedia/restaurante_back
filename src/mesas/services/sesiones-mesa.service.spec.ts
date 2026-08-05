import { Test, TestingModule } from '@nestjs/testing';
import { SesionesMesaService } from './sesiones-mesa.service';

describe('SesionesMesaService', () => {
  let service: SesionesMesaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SesionesMesaService],
    }).compile();

    service = module.get<SesionesMesaService>(SesionesMesaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
