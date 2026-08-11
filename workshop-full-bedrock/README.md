# El mismo agente, gestionado — versión full Bedrock

Este es el **mismo agente de atención al cliente** del [workshop principal](../workshop/), pero con el andamiaje reemplazado por la suite gestionada de **Bedrock AgentCore**. Las herramientas, los datos, la Knowledge Base y el lakehouse son los mismos: lo que cambia es quién corre el loop.

| Lo que el workshop hace a mano | Acá lo hace |
|---|---|
| El loop del agente (~100 líneas en `bedrock.ts`: prompt, tool calls, reintentos, cierre) | **AgentCore Harness** — modelo, prompt, tools y memoria declarados como recurso de CloudFormation |
| El catálogo de herramientas (`mcp/registro.ts`) | **AgentCore Gateway** — las mismas Lambdas registradas como targets, expuestas como un único servidor MCP |
| La memoria por actor y sesión | **AgentCore Memory** — idéntica: el workshop principal ya la usaba |
| El chat por Function URL con streaming | **`InvokeHarness`** — la API del servicio, también con streaming |

La gracia pedagógica de tener las dos versiones en el repo: primero escribís el loop para entender qué hace cada pieza; después lo ves como servicio y podés decidir con criterio cuándo conviene cada camino.

## Requisitos

1. **El workshop principal desplegado** en la misma cuenta y región (`us-east-1`): este stack reutiliza sus tablas DynamoDB, su Knowledge Base (vía SSM) y su lakehouse.
2. Haber corrido el seed del workshop (pasos 3 y 4 de aquella guía) y tener a mano tu **clienteId** (el `sub` de Cognito que muestra la app).

## Desplegar y probar

```bash
npm install
npm run deploy      # un solo stack: summit-full
npm run permisos    # grant de Lake Formation para la Lambda de herramientas
npm run chat -- <clienteId>
```

El chat corre en la terminal, con streaming y con la memoria del servicio: cortá el proceso, volvé a entrar con la misma sesión (`SESION=... npm run chat -- <clienteId>`) y el agente sigue recordando. Cada respuesta muestra tiempo, tokens y qué herramientas llamó.

### La demo web

El deploy deja una salida **`UrlDemo`**: la **misma app React** del workshop
principal (la carpeta compartida [`../webapp`](../webapp/)), servida por S3 +
CloudFront pero configurada en modo `harness` — idénticas por construcción, no
por parecido. El login por SMS es el mismo (user pool compartido; en modo demo
el código aparece en pantalla) y cada respuesta muestra tiempo, tokens y a qué
herramientas fue. Antes del primer deploy, compilá el front:
`cd ../webapp && npm install && npm run build`.

Detrás, una Lambda con Function URL (salida `UrlPuente`) hace de puente: expone
`GET /config` (los ids de Cognito) y `POST /chat`, verifica el id_token en el
servidor — el `clienteId` sale del token, no del navegador — aplica el
**guardrail** del workshop principal sobre entrada y salida, e invoca el
Harness. Refrescá la página y el agente sigue recordando: la sesión vive en
AgentCore Memory, no en el navegador.

```
vos › ¿dónde está mi pedido?

agente ›
  ⚙ pedidos___listar
Tu pedido PED-1078 está demorado…

  ⏱ 6.2s · tokens: 2431 entrada / 187 salida · 1 tool calls
```

## Qué crea el stack

```
summit-full
├── Lambda «herramientas»   el MISMO código de negocio del workshop
│                           (se importa de ../workshop, no se copia)
├── Gateway MCP             cuatro targets: pedidos, conocimiento,
│                           reclamos y ventas — un tools/list unificado
├── AgentCore Memory        corto plazo, expira sola a los 7 días
└── AgentCore Harness       el loop: Claude + prompt + Gateway + Memory
```

El catálogo del Gateway **se genera desde el código**: el stack importa el registro de herramientas del workshop y publica sus esquemas como `toolSchema` de cada target. Si agregás una herramienta al registro (el ejercicio del paso 5 del workshop), el próximo `npm run deploy` de esta carpeta también la publica acá.

## Lo que este ejemplo hace distinto (y por qué importa)

- **La identidad viaja por prompt.** El chat le dice al Harness el `clienteId` en el prompt del sistema, y las herramientas lo reciben como argumento. En el workshop principal esto está resuelto mejor: el `clienteId` sale del JWT y las tools **no le creen al modelo**. En AgentCore, el equivalente gestionado son los **interceptores del Gateway** y el **Policy Engine** (reglas Cedar por tool call) — quedan como ejercicio, y son una excelente discusión de seguridad de agentes.
- **El guardrail va por fuera del loop.** El Harness gestiona el loop pero no aplica tu guardrail de Bedrock por configuración (en el workshop principal envuelve cada llamada al modelo vía `guardrailConfig`). Acá lo resuelve el puente web: [`lambda/web/index.ts`](lambda/web/index.ts) aplica **el mismo guardrail calibrado del workshop principal** con `ApplyGuardrail`, una vez sobre la entrada (si interviene, el Harness ni se entera) y una vez sobre la salida completa — entrega por bloques, exactamente el argumento de la charla. El chat de terminal no lo aplica: quedó a propósito como ejercicio.
- **Siempre capa gold.** El experimento gold vs detalle, con su switch, vive en el workshop principal.
- **Invocación con SigV4.** El chat firma con tus credenciales de AWS. El Harness también acepta un authorizer JWT (el mismo user pool de Cognito serviría) — otro ejercicio interesante: conectarle la SPA del workshop.

## Costo

Lo mismo que el workshop: tokens del modelo y centavos. Harness, Gateway y Memory se cobran por uso; nada queda prendido cuando nadie conversa.

```bash
npm run destroy
```

---

Hecho por [Craftech](https://craftech.io) para el AWS Summit México.
