import { EstadoMesa } from '../../common/enums/estado-mesa.enum';
import { CierreCajaDetalleResponse } from './cierre-caja-response.dto';

// Contexto y preview del cierre de caja (Caja 2.0, Etapa 6). Contrato JSON en
// camelCase (#14).
//
// GET /caja/cierre/contexto y POST /caja/cierre/preview devuelven ESTE MISMO
// shape: son el mismo cálculo, con y sin montos verificados. Nada de lo que
// devuelven se persiste — ver CierresCajaService.previsualizarCierre.

// Clasificación de una sesión todavía abierta al momento de cerrar el turno.
// Se deriva del saldo y del estado de la mesa; no se persiste en ningún lado.
//
//   activa_sin_saldo            (regla A) sesión abierta sin deuda. No bloquea
//                               el cierre y NO se libera automáticamente: la
//                               mesa la libera un humano, no el arqueo.
//   ocupada_con_saldo           (regla B) hay consumo sin cobrar y el cliente
//                               NO pidió la cuenta. No bloquea: la visita
//                               simplemente continúa en el turno siguiente,
//                               pero se reporta como advertencia explícita.
//   cuenta_solicitada_con_saldo (regla C) el cliente pidió la cuenta y todavía
//                               debe. BLOQUEA el cierre: hay alguien esperando
//                               pagar en este turno.
export type ClasificacionSesionCierre =
  'activa_sin_saldo' | 'ocupada_con_saldo' | 'cuenta_solicitada_con_saldo';

export interface SesionPendienteCierreResponse {
  idSesion: number;
  idMesa: number;
  nombreMesa: string;
  // Estado REAL de la mesa, además de la clasificación derivada: la regla B
  // agrupa "consumo sin cuenta pedida", que en la práctica es `ocupada`, pero
  // si por una inconsistencia la mesa estuviera en otro estado con deuda, el
  // consumidor tiene que poder verlo tal cual está en la base.
  estadoMesa: EstadoMesa;
  abiertaEl: Date;
  saldoPendiente: number;
  clasificacion: ClasificacionSesionCierre;
  // Solo la regla C bloquea. Se expone por fila (y no solo como el
  // `puedeCerrar` global) para que la UI pueda señalar CUÁLES mesas hay que
  // resolver antes de cerrar.
  bloqueaCierre: boolean;
}

// Cuántas sesiones cayeron en cada regla. La regla A pide explícitamente
// "reportar cuántas existen"; las otras dos se cuentan por simetría.
export interface ResumenSesionesCierreResponse {
  activasSinSaldo: number;
  ocupadasConSaldo: number;
  cuentaSolicitadaConSaldo: number;
}

export interface CierrePreviewResponse {
  idCierre: number;
  idUsuario: number;
  abiertoEl: Date;
  // Instante en que se calculó este preview. El estado real puede cambiar
  // después (un cobro, una anulación, una cuenta pedida): el cierre definitivo
  // NO confía en este preview y vuelve a calcular todo bajo lock.
  generadoEl: Date;
  montoInicialEfectivo: number;

  totalEsperado: number;
  // null si no se declaró ningún conteo (mismo criterio que el resumen del
  // cierre definitivo): 0 significaría "conté y no había nada".
  totalContado: number | null;
  diferenciaTotal: number | null;

  // Esperado / contado / diferencia por método. Mismo shape y MISMO cálculo
  // que el snapshot que persiste PATCH /caja/cerrar (ver ConciliacionCajaService).
  detalle: CierreCajaDetalleResponse[];

  // Eco de `CerrarCajaDto.observacionDiferencia`, YA normalizada (trim, null
  // si queda vacía) — la misma normalización que aplicaría el cierre
  // definitivo si este mismo body se mandara a PATCH /caja/cerrar. El preview
  // NO la persiste en ningún lado (ver CierresCajaService.previsualizarCierre):
  // esto es solo para que el wizard pueda mostrar "así vas a guardar la nota"
  // antes de confirmar.
  observacionDiferencia: string | null;

  sesiones: SesionPendienteCierreResponse[];
  resumenSesiones: ResumenSesionesCierreResponse;

  // false si alguna sesión cae en la regla C. Es informativo: el cierre
  // definitivo revalida por su cuenta y responde 409 igual, aunque el preview
  // dijera que se podía (el preview pudo quedar stale).
  puedeCerrar: boolean;
}
