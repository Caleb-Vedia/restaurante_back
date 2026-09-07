// Primitivas COMPARTIDAS para los tests de concurrencia contra Caja.
//
// ⚠️ ALCANCE — leer antes de confiar en cualquier test que las use.
// Estas funciones MODELAN el comportamiento del motor; no lo ejecutan. Jest
// corre contra mocks, no contra Postgres: ningún test que las use emite un
// `SELECT ... FOR UPDATE` real. Lo que modelan es la premisa de la que depende
// el diseño —que FOR UPDATE es excluyente y que, al salir de la espera, READ
// COMMITTED reevalúa el WHERE contra la fila nueva (EvalPlanQual)— para poder
// verificar que NUESTRO código se comporta bien DADO ese motor. La exclusión
// mutua real la garantiza Postgres, no este archivo, y ningún test escrito
// sobre esto puede presentarse como prueba de las garantías del motor.
//
// Viven acá (y no dentro de un .spec) para que los tests de Pagos<->Caja y los
// de Pedidos<->Caja compartan UNA sola simulación de lock en vez de tener cada
// módulo la suya, que podrían divergir sin que nadie lo note.
//
// No se compila al build (tsconfig.build.json excluye src/common/testing).

/** Compuerta para pausar un flujo en un punto exacto y reanudarlo a mano. */
export const crearCompuerta = () => {
  let abrir!: () => void;
  const promesa = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { esperar: () => promesa, abrir: () => abrir() };
};

/** Deja correr los microtasks pendientes (para observar quién quedó bloqueado). */
export const cederElControl = () =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Modelo de un lock de fila excluyente: quien lo pide mientras está tomado
 * espera hasta que el titular commitea o hace rollback.
 */
export const crearLockDeFila = () => {
  let titular: string | null = null;
  const cola: Array<{ quien: string; entregar: () => void }> = [];

  return {
    get titular() {
      return titular;
    },
    adquirir(quien: string): Promise<void> {
      if (titular === null) {
        titular = quien;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        cola.push({ quien, entregar: resolve });
      });
    },
    liberar(quien: string) {
      if (titular !== quien) return;
      const siguiente = cola.shift();
      titular = siguiente ? siguiente.quien : null;
      siguiente?.entregar();
    },
  };
};
