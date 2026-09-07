# dinemetrix-backend — CLAUDE.md

Contexto y convenciones para trabajar en este backend. Léase antes de generar entidades, DTOs, controladores o servicios de negocio.

## 1. Qué es esto

Backend de un sistema de pedidos para **un solo restaurante** (sin multi-sucursal, sin multi-tenant, sin pasarela de pagos, sin inventariado). El cliente pide desde la mesa vía QR sin login; cocina/bebidas ven pedidos en un KDS; cajera cobra y cierra caja; administrador gestiona el menú y ve reportes.

- **Frontend:** React + Tailwind + Vite, repo aparte. No tocar desde aquí.
- **Backend:** NestJS + TypeScript + TypeORM + PostgreSQL. Postgres local nativo (sin Docker). Base de datos: `restaurante_db`.
- **Roles:** `cliente` (sin cuenta, solo QR de mesa), `cocina`, `bebidas`, `caja`, `admin`.

## 2. Estado actual del proyecto (inspección)

Generado con Nest CLI, con **scaffolding de módulos ya creado** (no es el boilerplate default de `nest new` sin tocar):

- **Nest** `^11.0.1` (common/core/platform-express), `@nestjs/config ^4.0.4`, `@nestjs/typeorm ^11.0.3`.
- **class-validator** `^0.15.1`, **class-transformer** `^0.5.1`, **pg** `^8.22.0`.
- **TypeScript** `^5.7.3`, target `ES2023`, `module`/`moduleResolution: nodenext`, `strictNullChecks` + `noImplicitAny` activados (no es `strict` completo).
- ESLint 9 (flat config, `eslint.config.mjs`) + `typescript-eslint` recommendedTypeChecked + Prettier integrado como regla de lint. Prettier: `singleQuote: true`, `trailingComma: "all"`.
- Jest configurado en `package.json` (`rootDir: src`, patrón `*.spec.ts`), más `test/jest-e2e.json` para e2e.
- Scripts de migración TypeORM ya definidos en `package.json` (`typeorm`, `migration:generate/create/run/revert/show`) apuntando a `src/config/data-source.ts` — **ese archivo todavía no existe** (ver pendientes).

**⚠️ Hallazgo importante — `package.json` fija `"typeorm": "^1.1.0"`.** TypeORM no tiene una release `1.1.0` conocida (la serie estable actual es `0.3.x`); el paquete instalado en `node_modules` también reporta `1.1.0`. Esto huele a error de versión o posible problema de paquete — **verificar el registry antes de instalar nada más o de confiar en este lockfile**. No se tocó `package.json` en esta tarea.

**⚠️ `src/app.module.ts` está vacío (0 bytes) y no exporta `AppModule`.** `tsc --noEmit` falla por esto en `src/main.ts` y `test/app.e2e-spec.ts` (ambos importan `AppModule` desde ahí). **No se modificó** — cae dentro de la config manual (`main.ts`/`data-source.ts`/bootstrap) que el usuario está armando por su cuenta; ver sección 8. Fuera de esos dos errores, el resto del proyecto (entities, enums, módulos de dominio) compila limpio.

**Estructura real de `src/` hoy** (entities ya creadas; controllers/services siguen siendo stubs vacíos, sin lógica):

```
src/
  app.module.ts        (vacío, ver arriba)
  main.ts               (ValidationPipe + CORS ya presentes — no tocar)
  common/
    enums/              # EstadoMesa, EstadoPedido, RolUsuario
    transformers/       # decimal.transformer.ts (decimal Postgres <-> number JS)
  caja/             entities/ CierreCaja, CierreCajaDetalle · dto/ + CierresCajaService/Controller (POST /caja/abrir, GET /caja/actual, PATCH /caja/cerrar)
  mesas/            entities/ Mesa, SesionMesa · dto/ + MesasService/Controller (admin/caja) + SesionesMesa (cliente público)
  pagos/            entities/ Pago, MetodoPago · dto/ + PagosService/Controller (cobro, anulación, total) + MetodosPago CRUD
  pedidos/          entities/ Pedido, DetallePedido · dto/ + PedidosService + PedidosController (KDS staff) + PedidosClienteController (POST /pedidos público)
  productos/        entities/ Producto, AreaProducto, CategoriaProducto, IngredienteProducto · dto/ + controllers/services CRUD admin + MenuController (GET /menu)
  usuarios/         entities/ Usuario · dto/ + UsuariosService/Controller (CRUD admin)
  auth/             dto/ + AuthService/Controller (POST /auth/login, GET /auth/me)
```

Todos los controllers/services existentes son stubs vacíos (`@Controller()`/`@Injectable()` sin métodos). `dto/` sigue vacío en todos los módulos.

**Convención de carpetas confirmada:** `src/<modulo>/entities/` — **sin** nivel `modules/` intermedio. Esto reemplaza cualquier mención anterior a `src/modules/<modulo>/`. Ver sección 7.

## 3. Alcance (cerrado)

Un solo restaurante. Sin multi-sucursal. Sin multi-tenant. Sin pasarela de pagos (el pago se registra, no se procesa online). Sin inventariado/stock.

## 4. Decisiones de arquitectura cerradas

**NO REABRIR sin pedido explícito del usuario.**

1. El **QR/token vive atado al ciclo de vida de la MESA** (`libre → ocupada → cuenta_solicitada → libre`), no al comensal. Se invalida cuando se cierra la mesa.
2. **Una sesión de mesa por mesa** (no por comensal). Cada comensal crea su propio pedido dentro de la misma sesión de mesa.
3. El **estado (pendiente/preparacion/listo) vive a nivel de PEDIDO completo**, no por ítem individual del pedido.
4. El **pago está atado a la SESIÓN de mesa**, no al pedido individual — una sesión puede agrupar varios pedidos de varios comensales y se paga junta.
5. Se construye primero el flujo **"pagar después vía caja"**. La arquitectura debe quedar abierta a agregar "pagar antes" más adelante, pero sin necesitar un rediseño de las tablas ya definidas.
6. **Riesgo aceptado:** un QR puede ser compartido con alguien remoto mientras la sesión de mesa sigue abierta. Se mitiga dando visibilidad del tiempo que una sesión lleva abierta en caja/admin — **no** con medidas técnicas adicionales (geofencing, expiración agresiva, etc.).
7. **Estados fijos** (estado de mesa, estado de pedido, rol de usuario) → **enum de TypeScript**, no tabla.
   **Catálogos editables** (áreas de producto, categorías de producto, métodos de pago) → **tabla con soft delete** (columna `borrado_el`).
8. **"Área de producto"** (cocina/bebidas — determina a qué KDS se enruta) **≠ "categoría de producto"** (agrupación visual del menú, ej. "entradas", "postres"). Son dos catálogos independientes.
9. **Nombres de tabla:** snake_case plural, sin prefijos húngaros (ej. `sesiones_mesa`, no `tbl_sesion_mesa`). **Entidades TypeORM:** PascalCase singular (ej. `SesionMesa`).
10. **PKs:** `int` serial autoincremental. Nada de UUID.
11. **Fechas:** siempre `timestamptz`.
12. `sesiones_mesa` debe tener un **índice único parcial en `id_mesa` WHERE `cerrada_el` IS NULL**, garantizado en la base de datos (constraint/índice), no solo validado en código de aplicación.
13. `synchronize` **siempre en `false`**. Todo cambio de esquema pasa por una migración de TypeORM.
14. **Contrato JSON de la API en camelCase (convención cerrada, aplica a TODOS los módulos).** El snake_case queda encapsulado **únicamente** en el nombre físico de la columna Postgres. Concretamente:
    - **DTOs de request y de response, y cualquier payload que cruce la API** → camelCase (ej. `nombreProducto`, `idAreaProducto`, `urlImagen`).
    - **Propiedades TypeScript de las entities** → camelCase idiomático (ya es así; no cambia).
    - **Nombres de columna en Postgres** → snake_case explícito en cada `@Column`/`@JoinColumn` (ya es así; no cambia).
    - Dentro de un `QueryBuilder`, las condiciones `WHERE`/`ON`/`select` referencian el **nombre real de columna o el property-path de la entity**, no la clave del DTO de salida — el mapeo a camelCase se hace solo al armar el objeto de respuesta final.
    - Motivo: convención estándar del stack JS/TS; evita traducir snake↔camel en cada capa. Reemplaza la decisión anterior (sesión de Productos) que había usado snake_case en los DTOs — ya corregida en `src/productos/`.
15. **Identificación de sesión de mesa del cliente vía header `X-Table-Token` (convención cerrada).** Los endpoints públicos del cliente (sin login, acceso por QR) que necesitan saber en qué sesión de mesa operan leen el token de la sesión activa desde el header HTTP **`X-Table-Token`** — nunca en la URL ni en el body. En Nest se lee con `@Headers('x-table-token')` (los headers son case-insensitive). Si falta → `BadRequestException`; si el token no matchea una sesión con `cerrada_el IS NULL` → mensaje genérico ("sesión no encontrada o inválida"), sin distinguir token inexistente de token ya cerrado.
    - **La resolución del token vive en un solo lugar:** `SesionesMesaService.obtenerSesionActivaPorToken(token)` (público, exportado vía `MesasModule`), que devuelve la `SesionMesa` con su `mesa` cargada o lanza `UnauthorizedException` genérica. Todo módulo que necesite resolver el token debe consumir ese método, no reimplementar la búsqueda.
    - Aplicado en `PATCH /mesas/pedir-cuenta` (Mesas) y en `POST /pedidos` (Pedidos, que resuelve así la `SesionMesa` destino — nunca recibe `idSesion` ni el token por URL/body).
    - Nota: unificado a 401 en ambos casos (header faltante e inválido) — mensaje genérico, sin distinguir motivo.
16. **Autenticación de personal (cocina/bebidas/caja/admin) vía JWT en cookie httpOnly — mecanismo separado de `X-Table-Token` (convención cerrada).** `X-Table-Token` (#15) es exclusivo de clientes anónimos identificando su sesión de mesa; la **cookie httpOnly `access_token`** es exclusiva de personal logueado identificando su cuenta de `Usuario` — no se mezclan ni se reusan entre sí.
    - **Transporte = cookie, no header.** El JWT viaja en la cookie **`access_token`** con flags `httpOnly: true`, `secure` solo en producción (en dev sobre http el navegador la descartaría), `sameSite: 'strict'`, `path: '/'`. Frontend y backend se despliegan bajo el **mismo dominio** (backend detrás de `/api`), así que no hay escenario cross-site que soportar. Reemplaza al `Authorization: Bearer <jwt>` que se usaba antes: el token ya no viaja en el body de login ni lo manipula el frontend (con `httpOnly` no puede leerlo desde JS, lo que mitiga robo por XSS) — lo adjunta el navegador solo en cada request.
    - **Emisión:** `POST /auth/login` (email + password) firma un JWT con payload mínimo `{ sub: idUsuario, rol }` y lo setea como cookie. Expira en `JWT_EXPIRES_IN` (env var, default `1d`); el `maxAge` de la cookie se deriva del claim `exp` del token recién firmado (no de re-parsear la env var), así cookie y JWT caducan siempre juntos. El body de respuesta trae **solo** `{ usuario: { idUsuario, nombre, email, rol } }`.
    - **Cierre de sesión:** `POST /auth/logout`, **sin guard** a propósito — cerrar sesión con un token ya vencido o inválido tiene que poder limpiar igual la cookie, no responder `401`. Limpia `access_token` con exactamente los mismos flags con que se seteó: el navegador identifica una cookie por (nombre, dominio, path), así que si difiriera alguno la cookie vieja sobreviviría. Los flags viven en un solo lugar (`src/auth/config/auth-cookie.config.ts`) que consumen login y logout.
    - **Infra necesaria en `main.ts`:** `cookie-parser` registrado (sin él `req.cookies` viene `undefined` y el guard no puede leer nada) y CORS con `credentials: true` + `origin` explícito desde `FRONTEND_URL` — **nunca `'*'`**: el navegador rechaza el wildcard cuando la respuesta usa credenciales.
    - **Verificación:** `JwtAuthGuard` (`src/common/guards/`) lee el token de la cookie, valida la firma y **además** busca al `Usuario` en la base por `sub` y exige `activo === true` en cada request — esta es la revocación real (desactivar a alguien corta su acceso de inmediato, sin esperar a que expire el token; no alcanza con que el JWT sea válido criptográficamente).
    - **Autorización por rol:** `RolesGuard` + `@Roles(...RolUsuario[])` (`src/common/decorators/roles.decorator.ts`), leídos con `Reflector`. Sin `@Roles(...)` en el endpoint, `RolesGuard` solo exige estar autenticado.
    - **Passwords:** hasheadas con `argon2id` (`src/common/security/password.util.ts`, única fuente de verdad — la usan `AuthService`, `UsuariosService` y el seed script).
    - **Rate limiting:** `ThrottlerModule` configurado dentro de `AuthModule` (no en `app.module.ts`) y aplicado explícitamente solo en `POST /auth/login` (`@UseGuards(ThrottlerGuard)` + `@Throttle(...)`) — nunca como guard global.
    - **Primer admin:** se crea **únicamente** vía script de siembra manual (`src/database/seeds/create-admin.seed.ts`, standalone, no pasa por Nest ni por la API). Nunca vía endpoint HTTP — un `POST /usuarios` protegido por rol admin no puede crear al primer admin que autorice ese mismo endpoint (dependencia circular de permisos).
    - **Arquitectura de módulos:** `AuthModule` importa `TypeOrmModule.forFeature([Usuario])` directo (no importa `UsuariosModule`); `UsuariosModule` importa `AuthModule` para usar sus guards. El flujo de dependencia es de un solo sentido — `UsuariosModule → AuthModule`, nunca al revés — para no generar un ciclo entre ambos módulos.
    - **⚠️ Todo módulo cuyos controllers usen `@UseGuards(JwtAuthGuard)` DEBE importar `AuthModule`.** Al pasar la *clase* del guard a `@UseGuards(...)`, Nest lo instancia en el contexto del módulo que declara el controller, no reusa la instancia exportada — así que ese módulo tiene que poder resolver **ambas** dependencias del guard (`JwtService` y `UsuarioRepository`). Por eso `AuthModule` exporta `JwtModule` **y** `TypeOrmModule` (con la feature `Usuario`), no solo la clase del guard. Es un error que `tsc` no detecta: se manifiesta recién al levantar la app, como `UnknownDependenciesException`.
17. **Reglas de negocio del módulo Pedidos (convención cerrada).**
    - **Área única por pedido:** un pedido solo puede contener ítems de UNA área de producto (cocina O bebidas, nunca mezclado). Si el `POST` mezcla áreas → `400` indicando qué áreas se mezclaron; el cliente debe enviar un pedido separado por área. Corolario: un pedido pertenece enteramente a un área, lo que hace que el ruteo al KDS sea directo.
    - **Mesa con cuenta solicitada no acepta pedidos:** si la mesa está en `cuenta_solicitada` (o en cualquier estado que no sea `ocupada`) → `409`. Solo se aceptan pedidos con la mesa en `ocupada`.
    - **`nroOrden` correlativo por SESIÓN de mesa** (no global, no por día): el primer pedido de la sesión es 1, el siguiente 2, etc. Se calcula dentro de una transacción con **lock pesimista** (`pessimistic_write`) sobre la fila de `SesionMesa`, para que dos comensales que envían pedidos casi simultáneos no obtengan el mismo número.
    - **Precio congelado:** `detalles_pedidos.precio_actual` guarda el precio del producto al momento del pedido; cambios posteriores en el catálogo no alteran lo ya pedido.
    - **Validación todo-o-nada de los ítems:** si algún `idProducto` no existe / está soft-deleted (`400`) o tiene `disponible = false` (`409`), se rechaza el pedido **completo**, nunca parcialmente.
    - **Transiciones de estado forward-only:** `pendiente → preparacion → listo`. Se permite el salto `pendiente → listo` (ítems sin etapa real de preparación). Cualquier transición hacia atrás, o repetir el estado actual → `409`. **El rol `admin` no pasa por esta validación** (override operativo) y tampoco por la validación de área.
    - **KDS = dos rutas explícitas, no un query param:** `GET /pedidos/cocina` (`cocina`|`admin`) y `GET /pedidos/bebidas` (`bebidas`|`admin`), para que el guard de rol sea distinto en cada una. Devuelven pedidos en `pendiente` o `preparacion` (nunca `listo`), ordenados por `creado_el` ASC (orden de llegada real, no por `nro_orden` que es por sesión). El personal de `cocina`/`bebidas` solo puede cambiar el estado de pedidos de su propia área (`403` si no).
    - **Resolución de área del KDS por `codigo`, no por nombre.** `areas_producto` tiene una columna `codigo` (`varchar` nullable, índice único parcial `idx_areas_producto_codigo` sobre `codigo` WHERE `codigo IS NOT NULL` — mismo patrón que `idx_sesiones_mesa_id_mesa_abierta`). Es un campo **interno**: no se expone en `CreateAreaProductoDto`/`UpdateAreaProductoDto` (no se puede setear ni editar vía API), solo se escribe por migración/seed. Las dos rutas del KDS (`GET /pedidos/cocina`, `GET /pedidos/bebidas`) resuelven su área buscando `codigo = 'cocina'` / `'bebidas'` en `PedidosService.resolverAreaPorCodigo`. Si esa fila no existe, ya no es un `404` esperable del lado del usuario sino un problema de integridad de datos → `InternalServerErrorException`. **`nombre_area` sigue siendo libremente editable por el admin** (ej. renombrar "Cocina" a "Parrilla") sin que eso afecte al KDS — el acoplamiento por nombre que existía antes quedó eliminado.

18. **Reglas de negocio de Pagos + Caja (convención cerrada).**
    - **Caja única y obligatoria.** Un solo `CierreCaja` abierto a la vez en TODO el restaurante (no por usuario), garantizado en la base por el índice único parcial `idx_cierres_caja_abierto_unico`. Va sobre la **expresión constante** `((true))` WHERE `cerrado_el IS NULL`, no sobre una columna: un índice sobre `id_cierre` NO serviría porque cada fila tiene un id distinto y dos cierres abiertos nunca colisionarían. TypeORM no puede declarar índices sobre expresiones, así que vive solo en la migración (ver comentario de advertencia en la entity `CierreCaja`). Al abrir caja, la violación `23505` se traduce a `409`. **Registrar un pago sin caja abierta → `409`** ("primero debe abrirse caja").
    - **Match exacto en centavos.** Los pagos de una sesión deben sumar **exacto** el total adeudado, ni más ni menos → si no, `409` con total adeudado vs. total recibido. La comparación es siempre en centavos enteros (`Math.round(monto * 100)`, `src/common/utils/dinero.util.ts`), nunca comparando floats. "Total recibido" incluye los pagos no anulados **ya existentes** de esa sesión, así un reintento tras un cierre de mesa fallido no cobra dos veces.
    - **Total adeudado** = suma de `cantidad * precio_actual` de TODOS los `detalles_pedidos` de TODOS los `pedidos` de la sesión, **sin importar el estado** del pedido (pendiente/preparacion/listo cuentan igual).
    - **Cierre de la sesión de mesa** tras el cobro exitoso: se dispara vía `MesasService.cerrarSesionActiva(idMesa)` (`PagosModule → MesasModule`, un solo sentido). Se llama **después** del commit del cobro, porque `MesasService` usa sus propios repositorios y no puede participar de esa transacción; si fallara, el cobro queda registrado y la respuesta trae `mesaLiberada: false` (se reintenta con `PATCH /mesas/:id/cerrar-sesion`) — preferible a perder el pago por un rollback.
    - **Anulación de pagos (`PATCH /pagos/:id/anular`):** disponible para `caja` y `admin` por igual. Operación **atómica**: toda ella (marcar el pago, recalcular el saldo, reabrir la sesión si corresponde) ocurre en UNA transacción con lock `pessimistic_write` sobre la fila del `Pago` y sobre la de su `SesionMesa` — la misma fila que lockean el cobro y `cerrarSesionActiva`. A diferencia del cobro, acá NO se usa el patrón "commitear y arreglar la mesa después": allá el peor caso es una mesa ocupada de más (recuperable), acá sería una deuda sin sesión donde cobrarla. Dos reglas:
        - **Pago de un turno de caja ya CERRADO → `409`, no se anula.** `CierreCaja`/`CierreCajaDetalle` son una **fotografía histórica inmutable** del arqueo de ese turno y nunca se recalculan; permitir la anulación por atrás dejaría el histórico mintiendo. La pertenencia al turno se resuelve por **rango temporal**, sin FK `pagos → cierres_caja`: alcanza porque `idx_cierres_caja_abierto_unico` garantiza un solo cierre abierto a la vez, así que los turnos no se solapan. La consulta busca la ventana que contiene al pago **incluyendo el turno todavía abierto** (`abiertoEl <= pago.creadoEl AND (cerradoEl IS NULL OR cerradoEl >= pago.creadoEl)`) y la toma con `pessimistic_write`: si viniera cerrada → `409`; si es la abierta, el lock se sostiene hasta el commit y sincroniza la anulación con `cerrarCaja`. Buscar solo cierres cerrados dejaba sin lock justo al turno en curso — ahí vivía la carrera "se comprueba que no es histórico, cerrarCaja cierra, y la anulación sigue igual". Si el pago no cae en **ninguna** ventana (pagos huérfanos previos a esta sincronización) se conserva el comportamiento anterior y se deja anular: como `abiertoEl` nunca retrocede, un pago así no puede volverse histórico. La corrección de un turno ya consolidado se documenta fuera del sistema; no existe (todavía) flujo de ajuste/reversión.
        - **Pago del turno abierto → se anula, y si reaparece deuda se REABRE la misma sesión.** El saldo se relee dentro de la transacción con la utilidad compartida (`calcularSaldoSesion`), ya con el pago marcado: la deuda reaparece sola por el filtro `anulado_el IS NULL`, sin aritmética paralela. Si queda `saldoPendienteCentavos > 0` **y** la sesión estaba cerrada, se pone `cerrada_el = NULL` en **esa misma** `SesionMesa` (nunca se crea otra; los `pedidos` y sus `detalles_pedidos` quedan intactos) y la mesa pasa a `cuenta_solicitada` — el estado que describe la realidad (consumo servido esperando cobro) y desde el que `POST /pagos` vuelve a cobrar sin que el cliente re-escanee el QR. Si la sesión sigue **activa**, o si tras anular el saldo queda en **0** (ej. anular un cobro duplicado), no se reabre ni se toca el estado de la mesa.
        - **Caso crítico — la mesa ya tiene otra sesión activa:** reabrir chocaría contra `idx_sesiones_mesa_id_mesa_abierta`. Se responde `409` y se descarta **todo**: el pago NO queda anulado, la sesión vieja NO se reabre, la sesión nueva y la mesa quedan intactas. Se valida antes de escribir y además se traduce el `23505` del índice por si otra transacción abre una sesión en el medio.
        - Anular dos veces → `409` (la segunda anulación relee la fila bajo el lock y ya la ve anulada).
    - **Esperado por método al cerrar caja:** para el método con `codigo = 'efectivo'`, `montoEsperado = montoInicialEfectivo + suma de pagos no anulados de ese método en la ventana [abiertoEl, cerradoEl]`. Para cualquier otro método, solo la suma (el fondo inicial es exclusivo de efectivo). `montoContado` es opcional: lo que no se declara queda `null` (≠ 0, que significaría "conté y no había nada") y su `diferencia` queda `null`.
    - **Arqueo exhaustivo (incluye métodos soft-deleted con movimiento).** `CierreCajaDetalle` genera una fila para **cada método activo** (aunque no haya tenido movimiento en el turno: esperado 0, o el fondo inicial si es efectivo) **más** cualquier método **soft-deleted** que haya recibido pagos no anulados dentro de la ventana `[abiertoEl, cerradoEl]`. Un método dado de baja a mitad de turno igual pudo cobrar plata real; omitirlo del arqueo escondería ese ingreso. Para esos métodos soft-deleted incluidos, `montoEsperado` se calcula igual que cualquier otro (suma de pagos en la ventana, sin fondo inicial salvo que sea el propio `'efectivo'`).
    - **`metodos_pago.codigo`:** misma convención que `areas_producto` (#17) — `varchar` nullable, índice único parcial `idx_metodos_pago_codigo` WHERE `codigo IS NOT NULL`, interno (no expuesto en `Create/UpdateMetodoPagoDto`), solo escrito por migración/seed. Hoy el único código usado es `'efectivo'`. **`nombre_metodo` es libremente editable** por el admin sin afectar el arqueo.
    - **Validación fuerte de `'efectivo'` ausente.** `CierresCajaService` exige que exista un `MetodoPago` no borrado con `codigo = 'efectivo'`, en DOS puntos: al **abrir** caja (`abrirCaja`, alerta temprana al inicio del turno) y de nuevo al **cerrar** (`cerrarCaja`, defensivo por si se borró durante el turno — se valida ANTES de escribir cualquier fila del cierre, para que un rollback no deje el cierre a medio completar). Si falta, `InternalServerErrorException` ("No existe un método de pago configurado con código 'efectivo'; contactar al administrador para restaurarlo") — ya no falla en silencio dejando el fondo inicial afuera del esperado.

19. **Reglas de negocio del módulo Reportes (convención cerrada). Solo lectura, exclusivo admin.**
    - **Ingresos = `pagos` no anulados, nunca `pedidos`.** Un pedido creado no es plata cobrada; todo cálculo de ingresos filtra `anulado_el IS NULL`.
    - **"Platos más vendidos" = `detalles_pedidos` vía `pedidos.creado_el`**, sin importar el `estado` del pedido ni si la sesión ya se pagó — no depende de `pagos`. Incluye productos **soft-deleted** que hayan tenido ventas en el rango (mismo criterio que el arqueo exhaustivo de Caja, #18); como el reporte usa SQL crudo (`manager.query`), esto sale gratis — esa vía no aplica el filtro `@DeleteDateColumn` de TypeORM (ese filtro solo lo agregan `find()`/`QueryBuilder`), así que no hace falta un `withDeleted` explícito.
    - **Zona horaria fija `America/La_Paz`** (`TIMEZONE_RESTAURANTE`, `src/common/constants/timezone.constant.ts`, única fuente de verdad). "Un día" para el reporte es un día calendario en esa zona, no en UTC. Límite inferior del rango: `($1::date AT TIME ZONE 'America/La_Paz')`; límite superior **exclusivo**: `(($2::date + INTERVAL '1 day') AT TIME ZONE 'America/La_Paz')` — comparación con `>=`/`<`, nunca `<=`, para no arrastrar el primer instante del día siguiente. Agrupación diaria: `date_trunc('day', creado_el AT TIME ZONE 'America/La_Paz')`. La constante se **interpola** directo en el texto de la query (no se bindea como parámetro) porque es un literal fijo del código, nunca input de usuario, y Postgres tampoco admite un parámetro bindeado como nombre de zona en `AT TIME ZONE`; `desde`/`hasta`/`limite`, que sí vienen del usuario, siempre van bindeados (`$1`/`$2`/`$3`).
    - **`ticketPromedio` = ingresos del rango / `COUNT(DISTINCT id_sesion)` sobre `pagos`**, no cantidad de filas de `Pago`. Una mesa que paga con 2 métodos son 2 filas de pago pero 1 solo ticket.
    - **Endpoint único y flexible por rango** (`desde`/`hasta`), no rutas separadas para diario/semanal/mensual — el frontend arma esos presets calculando el rango y llamando al mismo endpoint. `desde > hasta` → `400`.
    - **Módulo desacoplado:** `ReportesModule` registra `TypeOrmModule.forFeature([Pago, DetallePedido, Producto, MetodoPago])` directo (no importa `PagosModule`/`ProductosModule`/`PedidosModule`) — mismo patrón que #16-#18. Solo importa `AuthModule` para los guards.

## 5. Modelo de datos (13 entidades)

| Tabla | Columnas |
|---|---|
| **mesas** | `id_mesa` PK · `nombre_mesa` varchar · `estado` enum(`libre`\|`ocupada`\|`cuenta_solicitada`) default `libre` · `borrado_el` timestamptz null |
| **sesiones_mesa** | `id_sesion` PK · `id_mesa` FK → mesas · `token` varchar unique · `abierta_el` timestamptz · `cerrada_el` timestamptz null · *(índice único parcial en `id_mesa` WHERE `cerrada_el` IS NULL)* |
| **pedidos** | `id_pedido` PK · `id_sesion` FK → sesiones_mesa · `nombre_comensal` varchar null · `estado` enum(`pendiente`\|`preparacion`\|`listo`) default `pendiente` · `nro_orden` int · `creado_el` timestamptz default now |
| **detalles_pedidos** | `id_detalle` PK · `id_pedido` FK → pedidos · `id_producto` FK → productos · `cantidad` int · `precio_actual` decimal(10,2) · `observacion` varchar null |
| **productos** | `id_producto` PK · `id_area_producto` FK → areas_producto · `id_categoria_producto` FK → categorias_producto · `nombre_producto` varchar · `descripcion` text null · `precio` decimal(10,2) · `url_imagen` varchar null · `disponible` boolean default `true` · `borrado_el` timestamptz null |
| **areas_producto** | `id_area_producto` PK · `nombre_area` varchar · `borrado_el` timestamptz null |
| **categorias_producto** | `id_categoria_producto` PK · `nombre_categoria` varchar · `borrado_el` timestamptz null |
| **ingredientes_producto** | `id_ingrediente` PK · `id_producto` FK → productos · `nombre_ingrediente` varchar · `borrado_el` timestamptz null |
| **pagos** | `id_pago` PK · `id_sesion` FK → sesiones_mesa · `id_metodo_pago` FK → metodos_pago · `nro_recibo` varchar null · `monto_pagado` decimal(10,2) · `anulado_el` timestamptz null · `creado_el` timestamptz default now |
| **metodos_pago** | `id_metodo_pago` PK · `nombre_metodo` varchar · `borrado_el` timestamptz null |
| **usuarios** | `id_usuario` PK · `nombre` varchar · `email` varchar unique · `password_hash` varchar · `rol` enum(`cocina`\|`bebidas`\|`caja`\|`admin`) · `activo` boolean default `true` |
| **cierres_caja** | `id_cierre` PK · `id_usuario` FK → usuarios · `abierto_el` timestamptz · `cerrado_el` timestamptz null · `monto_inicial_efectivo` decimal(10,2) |
| **cierres_caja_detalle** | `id_cierre` FK → cierres_caja · `id_metodo_pago` FK → metodos_pago · `monto_esperado` decimal(10,2) · `monto_contado` decimal(10,2) null |

**Nota — `ingredientes_producto`:** es la tabla que sostiene la personalización de pedidos (el comensal puede quitar ingredientes por defecto de un producto, ej. "sin cebolla"). Cada producto tiene 0..N ingredientes activos; se listan anidados en la respuesta de producto (admin) y de menú (cliente). Soft delete vía `borrado_el`, mismo patrón que los demás catálogos.

**Nota — imágenes de producto (`url_imagen`):** las imágenes subidas se guardan en la carpeta física `uploads/productos/` (en la raíz del proyecto, fuera de `src/`) y se sirven como estáticas bajo el prefijo **`/uploads`** (configurado en `main.ts`, fuera de estas sesiones). La columna `url_imagen` guarda la ruta pública, ej. `/uploads/productos/producto-{idProducto}-{uuid}.{ext}` (nombre de archivo generado con `crypto.randomUUID()`). Config de Multer reutilizable en `src/productos/config/multer-productos.config.ts` (disk storage, `fileFilter` solo JPEG/PNG/WebP, límite 5MB). Endpoints admin: **`POST /productos/:id/imagen`** (campo multipart `imagen`; reemplaza y borra del disco la imagen interna anterior) y **`DELETE /productos/:id/imagen`** (borra el archivo interno y pone `url_imagen` en `null`). El borrado físico solo actúa sobre rutas que empiezan con `/uploads/` y no falla si el archivo ya no existiera.

## 6. Roles y KDS

- **cliente**: sin login. Accede vía QR de mesa (token de la sesión de mesa activa).
- **cocina** / **bebidas**: KDS (Kitchen Display System) filtrado por `areas_producto` — cada pedido se enruta según el área de los productos que contiene.
- **caja**: cobra, ve sesiones de mesa abiertas (con tiempo abierto visible, ver decisión #6), abre/cierra caja.
- **admin**: CRUD de `productos`, `areas_producto`, `categorias_producto`, `metodos_pago`, `usuarios`, y reportes.

## 7. Estructura de módulos (convención final)

Convención confirmada: `src/{mesas,pedidos,productos,pagos,usuarios,caja}/...` — **sin** nivel `modules/` intermedio.

```
src/<modulo>/
  dto/                    # clases con class-validator para request/response shapes
  entities/               # entidades TypeORM del módulo (PascalCase singular, archivo kebab-case + .entity.ts)
  controllers/            # uno o más *.controller.ts cuando el módulo agrupa varias entidades
  services/               # uno o más *.service.ts, en paralelo con controllers/
  <modulo>.module.ts

src/common/
  enums/                  # enums compartidos entre módulos (EstadoMesa, EstadoPedido, RolUsuario)
  transformers/           # transformers de columna compartidos (ej. decimal.transformer.ts)
  guards/                 # guards de rol / auth (ej. RolesGuard) — pendiente
  decorators/             # decorators custom (ej. @Roles(), @Public()) — pendiente
  filters/                # exception filters compartidos, si aplica — pendiente

src/config/
  data-source.ts          # ⚠️ pendiente — lo arma el usuario manualmente, no crear
```

**Justificación por elección:**

- **`dto/` y `entities/` separados por módulo, no globales**: mantiene el contrato HTTP (DTO) desacoplado del modelo de persistencia (entidad); es la convención estándar de Nest y evita que un cambio de columna filtre directo a la API.
- **`controllers/` y `services/` como subcarpetas (no un único archivo por módulo)**: varios módulos agrupan más de una entidad relacionada (ej. `mesas` incluye `mesas` y `sesiones_mesa`; `productos` incluye productos, áreas y categorías) porque comparten ciclo de vida y casos de uso; un controller/service por entidad dentro de esas subcarpetas evita fragmentar en módulos de una sola tabla sin mezclar todo en un archivo gigante.
- **`common/enums/` centralizado**: los enums de decisión #7 (estado de mesa, estado de pedido, rol) se referencian desde varios módulos a la vez (ej. `RolUsuario` lo usan guards, `usuarios` y casi todos los controllers); vivir en un solo lugar evita imports circulares entre módulos de dominio.
- **`common/transformers/` centralizado**: el transformer decimal (Postgres `numeric` → `string`, necesita convertirse a `number`) se repite en 4 módulos distintos (`pedidos`, `productos`, `pagos`, `caja`); una sola implementación evita duplicar la misma lógica de conversión seis veces.
- **`common/guards/` y `common/decorators/`**: la autorización por rol (cocina/bebidas/caja/admin) es transversal a casi todos los controllers protegidos; un guard/decorator compartido evita duplicar la lógica de "¿este usuario tiene el rol X?" en cada módulo. Todavía no existen — quedan para cuando se defina la estrategia de auth (ver sección 8).
- **`config/data-source.ts` fuera de `common/`**: es configuración de infraestructura (conexión a Postgres), no lógica de dominio ni utilidades compartidas — se mantiene como pendiente manual del usuario, no se crea desde estas sesiones.

## 8. Pendientes / decisiones abiertas para el usuario

1. **`app.module.ts` está vacío** y no exporta `AppModule` — bloquea `tsc`/`build`/`start` (ver sección 2). No se tocó porque roza la config manual de `main.ts`/`data-source.ts`.
2. **`"typeorm": "^1.1.0"` en `package.json`** — no corresponde a ninguna versión conocida de TypeORM (la serie estable es 0.3.x), aunque la API de decoradores instalada en `node_modules` se comporta como la estándar (verificado al construir las entities de la sección 5). Confirmar si es un typo intencional, una versión de un fork, o un error antes de generar migraciones.
3. **`src/config/data-source.ts` no existe todavía** — queda como placeholder a cargo del usuario, según lo pedido.
4. Guards de rol (`RolesGuard` + `@Roles()`) y estrategia de autenticación para `cocina`/`bebidas`/`caja`/`admin` todavía no están definidos — este documento asume que van a existir pero no fija mecanismo (JWT, sesión, etc.); a decidir en una próxima sesión.
5. **13 entities TypeORM ya creadas** (una por tabla de la sección 5, registradas con `TypeOrmModule.forFeature` en cada `.module.ts`). Todos los FK quedan modelados con columna cruda (`@Column({name: 'id_x'})`) + relación (`@ManyToOne` + `@JoinColumn({name: 'id_x'})`) apuntando al mismo nombre de columna — patrón soportado nativamente por TypeORM para tener ambos accesos sin duplicar la columna en la base. El módulo **`productos` ya tiene lógica** (CRUD admin de áreas/categorías/productos/ingredientes + `GET /menu` público); el resto de módulos siguen con controllers/services stub.
