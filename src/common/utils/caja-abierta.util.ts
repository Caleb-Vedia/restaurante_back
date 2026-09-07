import { EntityManager, IsNull } from 'typeorm';
import { CierreCaja } from '../../caja/entities/cierre-caja.entity';

// Fuente ÚNICA de verdad de "¿hay caja abierta?" cuando la respuesta tiene que
// SOSTENERSE hasta el commit de quien pregunta. Vive acá —neutral, sin
// decoradores Nest ni providers— por el mismo motivo que saldo-sesion.util:
// la consumen módulos distintos (Pagos al cobrar, Pedidos al crear un pedido)
// y ninguno de ellos puede importar CajaModule sin armar un ciclo
// (decisiones #16-#19).
//
// Recibe un EntityManager, nunca un Repository: el lock solo tiene sentido
// dentro de la transacción del llamador, así que siempre se le pasa el manager
// de SU queryRunner.
//
// POR QUÉ CON LOCK Y NO UN findOne SUELTO
// ---------------------------------------
// Un `findOne({ cerradoEl: IsNull() })` sin lock no bloquea a nadie: entre esa
// lectura y el INSERT del llamador, CierresCajaService.cerrarCaja puede
// commitear el cierre, y la escritura termina cayendo fuera de todo turno.
// El FOR UPDATE sobre ESA MISMA FILA es lo que sincroniza las dos
// transacciones — cerrarCaja toma el mismo lock y lo sostiene hasta su commit:
//
//   - gana el llamador: cerrarCaja espera hasta su commit/rollback, y lo que
//     escribió ya está visible cuando el cierre calcula su snapshot;
//   - gana el cierre: este SELECT ... FOR UPDATE espera, y al reevaluar la
//     fila ya actualizada (EvalPlanQual, READ COMMITTED) deja de cumplir
//     `cerrado_el IS NULL` -> devuelve null, y el llamador aborta sin escribir.
//
// Devuelve el cierre abierto o `null`. El mensaje del 409 lo pone cada
// llamador: "no se puede cobrar" y "no se puede pedir" son conflictos
// operativos distintos y se le explican distinto al usuario.
//
// Orden global de locks vigente: CierreCaja -> Pago -> SesionMesa -> Mesa.
// Quien use este helper debe llamarlo ANTES de tomar cualquier otro lock de su
// transacción, para no invertirlo.
export function lockearCajaAbierta(
  manager: EntityManager,
): Promise<CierreCaja | null> {
  return manager.findOne(CierreCaja, {
    where: { cerradoEl: IsNull() },
    lock: { mode: 'pessimistic_write' },
  });
}
