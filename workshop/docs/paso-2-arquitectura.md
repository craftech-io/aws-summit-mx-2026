# Paso 2 — Recorrer la arquitectura  ·  15 min

> Al final de este paso vas a poder decir, sin mirar, qué recurso de AWS crea cada uno de los cinco stacks, cómo hace el agente para usar herramientas, y por qué un login por SMS necesita cuatro Lambdas. Y vas a haber visto el CloudFormation completo sin crear absolutamente nada en tu cuenta.

## Qué vamos a hacer y por qué

En el paso 3 vas a correr `npm run deploy` y en diez minutos vas a tener un agente andando. Si llegás a ese comando sin haber leído nada, lo que vas a tener es una caja negra que funciona: sirve para la foto, no sirve para llevarse nada. Este paso es el que convierte el laboratorio en algo que podés reproducir el lunes en tu trabajo.

Hay una idea que atraviesa todo el repo y conviene tenerla en la cabeza mientras leés: **un agente en producción es 10% modelo y 90% plomería**. El modelo es un string en `cdk.json`. Todo lo demás —quién es el usuario, qué herramientas ve, cuánto contexto le mandás, qué pasa cuando una herramienta falla, qué temas tiene prohibidos— es código y es infraestructura. Por eso el repo está partido en cinco stacks y no en uno: cada uno tiene un ciclo de vida distinto. Los datos sobreviven a todo. La identidad cambia poco. El agente cambia todos los días. El frontend cambia varias veces por día. Si eso vive en un solo stack de CloudFormation, cada cambio de prompt te hace esperar a que CloudFront revalide, y cada rollback te pone en riesgo las tablas.

También vas a ver un patrón que se repite en las tres piezas de código que miramos en detalle: **la seguridad nunca está en el prompt**. El `clienteId` sale del token que valida API Gateway, no de lo que dice el modelo. El tope de vueltas del loop está en una constante, no en una instrucción de "no repitas herramientas". Los temas prohibidos están en un guardrail declarado como recurso de CloudFormation, no en un párrafo del system prompt. Cuando alguien te pregunte "¿y si el usuario le pide al bot los pedidos de otro?", la respuesta correcta no es "le dijimos que no lo haga".

## Antes de empezar

Necesitás el paso 1 terminado: el repo clonado y `npm install` corrido. **No necesitás credenciales de AWS para este paso** — todo lo que hacemos acá es leer código y sintetizar plantillas localmente.

Verificá que las dependencias están:

```bash
npm run typecheck
```

```
> craftech-aws-summit-workshop@1.0.0 typecheck
> tsc --noEmit
```

Sin salida después de esas dos líneas significa que compila. Si tira `Cannot find module`, volvé al paso 1 y corré `npm install`.

Todos los comandos de esta guía se corren parado en la carpeta `workshop/`.

## Los pasos

### 1. Mirá el punto de entrada: cinco stacks y un orden

`bin/workshop.ts` es el archivo que la CLI de CDK ejecuta (está declarado en `cdk.json` como `"app": "npx ts-node --prefer-ts-exts bin/workshop.ts"`). Son 53 líneas y describen todo el sistema.

```bash
npx cdk list
```

```
summit-datos
summit-auth
summit-lakehouse
summit-agente
summit-web
```

Ese `summit` no está hardcodeado: sale del contexto de `cdk.json`.

```json
"context": {
  "prefijo": "summit",
  "modeloId": "us.anthropic.claude-opus-5",
  "modeloEmbeddings": "amazon.titan-embed-text-v2:0"
}
```

(`kbMode` ya no está en el contexto: el modo gestionado es el default. Para
forzar el RAG local: `-c kbMode=local` en el deploy del agente.)

Y se lee así en `bin/workshop.ts`:

```typescript
const prefijo = app.node.tryGetContext("prefijo") ?? "summit";
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};
```

Lo importante: **el orden de despliegue no está escrito en ningún lado**. No hay un `addDependency()`. CDK lo deduce porque los stacks se pasan objetos entre sí:

```typescript
const datos = new DataStack(app, `${prefijo}-datos`, { env, prefijo });
const auth = new AuthStack(app, `${prefijo}-auth`, { env, prefijo });

const lakehouse = new LakehouseStack(app, `${prefijo}-lakehouse`, { env, prefijo });

const agente = new AgentStack(app, `${prefijo}-agente`, {
  env,
  prefijo,
  datos,
  tablaPedidos: datos.tablaPedidos,
  // …las demás tablas y buckets…
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  lakehouse,
});
```

`agente` recibe la tabla real, no su nombre. De ahí CDK infiere que `summit-datos` va primero, genera un `Output` exportado del lado de datos y un `Fn::ImportValue` del lado del agente. En la sección 10 de esta guía lo vas a ver en el YAML.

Al final del archivo, tres tags que se aplican a todo lo que se cree:

```typescript
const tags = {
  Proyecto: "aws-summit-mx",
  Owner: "craftech",
  Ambiente: "workshop",
};
// …
for (const [clave, valor] of Object.entries(tags)) {
  cdk.Tags.of(app).add(clave, valor);
}
```

Eso es lo que después te deja filtrar el costo en Cost Explorer por proyecto.

### 2. `summit-datos` — lo único que no querés perder

Archivo: `lib/data-stack.ts`. Crea cuatro tablas DynamoDB y dos buckets S3.

```bash
grep -n "tableName:\|bucketName:\|addGlobalSecondaryIndex\|BucketDeployment" lib/data-stack.ts
```

```
31:      tableName: `${props.prefijo}-pedidos`,
39:      tableName: `${props.prefijo}-conversaciones`,
48:      tableName: `${props.prefijo}-tickets`,
52:    this.tablaTickets.addGlobalSecondaryIndex({
61:      tableName: `${props.prefijo}-kb-vectores`,
69:      bucketName: `${props.prefijo}-adjuntos-${this.account}`,
88:      bucketName: `${props.prefijo}-kb-docs-${this.account}`,
96:    new s3deploy.BucketDeployment(this, "CargaDocumentos", {
```

| Recurso | Nombre real | Clave | Para qué |
|---|---|---|---|
| Tabla | `summit-pedidos` | PK `clienteId`, SK `pedidoId` | Los pedidos. La PK es el cliente: **el aislamiento entre clientes es la clave de partición** |
| Tabla | `summit-conversaciones` | PK `sesionId`, SK `turno` (número) | Historial del chat, con TTL en `expiraEn` |
| Tabla | `summit-tickets` | PK `ticketId` + GSI `porCliente` | Reclamos. El GSI permite listar los de un cliente |
| Tabla | `summit-kb-vectores` | PK `documentoId`, SK `fragmentoId` | Los embeddings del modo `local` de la base de conocimiento (el desplegado usa Bedrock Knowledge Bases — ver abajo) |
| Bucket | `summit-adjuntos-<cuenta>` | — | Las fotos que sube el cliente. Privado, expiran a los 7 días |
| Bucket | `summit-kb-docs-<cuenta>` | — | Los cuatro `.md` de `data/kb/`, subidos por CDK |

Todas las tablas comparten esta configuración:

```typescript
const comun = {
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  removalPolicy: cdk.RemovalPolicy.DESTROY, // workshop: se borra todo al final
  pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
};
```

`PAY_PER_REQUEST` es lo que hace que este laboratorio cueste centavos: no hay capacidad provisionada, no hay costo si no lo usás. `RemovalPolicy.DESTROY` es correcto para un workshop y **está mal para producción**: ahí va `RETAIN`.

La tabla de conversaciones tiene una línea que vale la pena:

```typescript
timeToLiveAttribute: "expiraEn",
```

DynamoDB borra solo los ítems cuyo atributo `expiraEn` (epoch en segundos) ya pasó. No hay cron, no hay Lambda de limpieza. En `lambda/agent/historial.ts` vas a ver quién lo escribe.

Y una que suele sorprender: los `.md` de la base de conocimiento se suben con la
infraestructura. Este stack también crea la **Bedrock Knowledge Base** que los
indexa: un vector bucket de **S3 Vectors**, el índice (1024 dimensiones, métrica
coseno), la KB con Titan Embeddings V2 y el data source apuntando al bucket de
documentos. El id viaja al agente por un parámetro de SSM que la Lambda lee en
runtime — así el stack de datos puede reemplazar la KB sin redesplegar el agente.
La ingesta se dispara con `npm run kb:ingesta` (paso 4).

```typescript
new s3deploy.BucketDeployment(this, "CargaDocumentos", {
  sources: [s3deploy.Source.asset(path.join(__dirname, "..", "data", "kb"))],
  destinationBucket: bucketDocumentos,
});
```

Eso, por dentro, es una Lambda que CDK crea sola. Por eso el stack tiene 18 recursos y no 6.

### 3. `summit-auth` — identidad, y cuatro Lambdas

Archivo: `lib/auth-stack.ts`. Crea un Cognito User Pool (`summit-usuarios`), un client (`summit-web`) y cuatro funciones.

```bash
grep -n "functionName:" lib/auth-stack.ts
```

```
38:      functionName: `${props.prefijo}-auth-definir`,
44:      functionName: `${props.prefijo}-auth-crear`,
62:      functionName: `${props.prefijo}-auth-verificar`,
70:      functionName: `${props.prefijo}-auth-pre-registro`,
```

Las cuatro se enganchan al User Pool acá:

```typescript
lambdaTriggers: {
  preSignUp: preRegistro,
  defineAuthChallenge: definirDesafio,
  createAuthChallenge: crearDesafio,
  verifyAuthChallengeResponse: verificarDesafio,
},
```

Y el client habilita un solo flujo de autenticación:

```typescript
authFlows: {
  custom: true, // CUSTOM_AUTH: el flujo de OTP por SMS
  userSrp: false,
  userPassword: false,
  adminUserPassword: false,
},
```

El **por qué** de cada una de las cuatro lo vemos en la sección 9 de esta guía, cuando abramos el código de los triggers. Por ahora quedate con esto: Cognito **no trae** "OTP por SMS" como flujo listo para usar. Trae un flujo genérico (`CUSTOM_AUTH`) y unos puntos de extensión. El OTP lo escribís vos.

Dato para el paso 4: la Lambda `summit-auth-crear` se despliega con `MODO_DEMO: "true"`, que hace que el código también viaje en la respuesta del desafío. Es para que el laboratorio no se trabe con el sandbox de SNS. **En producción va en `false`.**

### 4. `summit-agente` — el cerebro

Archivo: `lib/agent-stack.ts`, 206 líneas y el archivo más denso del repo.

```bash
grep -n "name: \`\|functionName:\|apiName:\|path: \"" lib/agent-stack.ts
```

```
43:      name: `${props.prefijo}-atencion-cliente`,
104:      functionName: `${props.prefijo}-agente`,
169:      apiName: `${props.prefijo}-api`,
180:      path: "/chat",
186:      path: "/adjuntos/url",
194:      path: "/mcp",
```

Crea tres cosas:

**a) El guardrail, como infraestructura.** No es una librería ni un `if` en el código: es un recurso de CloudFormation (`bedrock.CfnGuardrail`) con su versión inmutable al lado. Tiene filtros de contenido, dos temas negados y una política de datos personales:

```typescript
topicPolicyConfig: {
  topicsConfig: [
    {
      name: "asistencia-tecnica-general",
      definition:
        "Pedidos de ayuda con programación, código fuente, configuración de sistemas o cualquier tarea ajena a la atención al cliente de la tienda.",
      examples: [
        "Escribime una función en Python",
        "¿Cómo configuro un servidor nginx?",
        "Corregime este código",
      ],
      type: "DENY",
    },
```

Fijate que los datos personales no se bloquean todos igual: tarjeta y contraseña se bloquean, mail y teléfono se **enmascaran**, para no cortar la conversación.

```typescript
piiEntitiesConfig: [
  { type: "CREDIT_DEBIT_CARD_NUMBER", action: "BLOCK" },
  { type: "CREDIT_DEBIT_CARD_CVV", action: "BLOCK" },
  { type: "PASSWORD", action: "BLOCK" },
  { type: "EMAIL", action: "ANONYMIZE" },
  { type: "PHONE", action: "ANONYMIZE" },
],
```

**b) La Lambda `summit-agente`.** Node 22, ARM64, 1024 MB y un timeout raro:

```typescript
// Un agente encadena varias herramientas: no es un request HTTP típico.
timeout: cdk.Duration.minutes(5),
```

Cinco minutos porque una conversación puede encadenar varias llamadas al modelo, y cada una tarda segundos. Es el primer lugar donde un agente se comporta distinto a una API común.

Los permisos son explícitos y acotados:

```typescript
agente.addToRolePolicy(
  new iam.PolicyStatement({
    actions: ["bedrock:ApplyGuardrail"],
    resources: [guardrail.attrGuardrailArn],
  }),
);
// …
props.tablaPedidos.grantReadData(agente);
props.tablaConversaciones.grantReadWriteData(agente);
props.tablaTickets.grantReadWriteData(agente);
props.tablaVectores.grantReadWriteData(agente);
props.bucketAdjuntos.grantReadWrite(agente);
```

Leé la línea de pedidos otra vez: `grantReadData`, no `grantReadWriteData`. **El agente no puede modificar un pedido, aunque el modelo lo quiera.** Eso no está en el prompt, está en IAM.

**c) La API HTTP con autorizador JWT.** Tres rutas, todas autenticadas contra el User Pool del stack anterior:

```typescript
const autorizador = new apigwAuthorizers.HttpJwtAuthorizer(
  "AutorizadorCognito",
  `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
  { jwtAudience: [props.userPoolClient.userPoolClientId] },
);
```

| Ruta | Qué hace |
|---|---|
| `POST /chat` | Conversar con el agente |
| `POST /adjuntos/url` | Pedir una URL prefirmada para subir una foto |
| `POST /mcp` | Endpoint MCP por JSON-RPC, para clientes MCP externos |

Las tres van a la misma Lambda; el ruteo interno está en `lambda/agent/index.ts`. La validación del token la hace API Gateway, **antes** de invocar tu código: si el JWT no es válido, tu Lambda ni se entera.

### 5. `summit-web` — S3 privado + CloudFront

Archivo: `lib/web-stack.ts`. Es el stack más chico, porque la interfaz no vive acá: es la app React (Vite) de [`webapp/`](../../webapp/), en la raíz del repo, compartida con la [versión full Bedrock](../../workshop-full-bedrock/). Este stack publica su build ya compilado; por eso, antes del primer deploy, `cd ../webapp && npm install && npm run build` (el `npm run todo` lo hace solo).

El bucket está cerrado (`BLOCK_ALL`) y CloudFront lo lee con Origin Access Control:

```typescript
origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
```

Nadie llega al bucket directo por HTTP. Y la parte linda: la configuración del frontend se genera en el deploy, no se commitea.

```typescript
const config = {
  modo: "lambda",
  apiUrl: props.apiUrl,
  chatUrl: props.chatUrl,
  userPoolId: props.userPoolId,
  userPoolClientId: props.userPoolClientId,
  region: this.region,
};

new s3deploy.BucketDeployment(this, "DesplegarWeb", {
  sources: [
    s3deploy.Source.asset(dist), // webapp/dist
    s3deploy.Source.data("config.js", `window.CONFIG = ${JSON.stringify(config, null, 2)};`),
  ],
  destinationBucket: bucket,
  distribution: distribucion,
  distributionPaths: ["/*"],
  prune: true,
});
```

`Source.data` inventa un archivo `config.js` en el momento del deploy con los IDs reales, y `distributionPaths: ["/*"]` invalida la caché de CloudFront. `modo` es lo que hace que la misma app se comporte como la interfaz de este workshop (`"lambda"`) o como la de la versión full Bedrock (`"harness"`). En tu disco hay un `webapp/public/config.js` con los valores vacíos, para que `npm run dev` arranque; en el deploy, el de `Source.data` lo pisa, y el que tiene los IDs de tu cuenta solo existe en el bucket. Si lo completás a mano para desarrollar local, no lo commitees.

---

Hasta acá el mapa. Ahora bajamos a las cuatro piezas de código que explican cómo funciona esto por dentro.

### 6. El loop del agente: `lambda/agent/bedrock.ts`

Este es **el** archivo del workshop. 146 líneas, y adentro está todo lo que un agente hace.

Lo primero: se habla con Bedrock por la **Converse API**. Un solo contrato para cualquier modelo, con soporte de imágenes y de tool use incluido. Cambiar de modelo es cambiar el string de `MODELO_ID`, no reescribir el cliente.

Lo segundo, y lo que más gente se olvida en su primera POC:

```bash
grep -n "MAX_VUELTAS\|for (let vuelta\|stopReason" lambda/agent/bedrock.ts
```

```
24:const MAX_VUELTAS = 8;
62:  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
84:    if (respuesta.stopReason === "guardrail_intervened") {
94:    if (respuesta.stopReason !== "tool_use") {
```

```typescript
// Tope de vueltas del loop. Sin esto, un modelo que se obstina con una
// herramienta rota consume tokens hasta el timeout de la Lambda.
const MAX_VUELTAS = 8;
```

Un agente **es un `for`**. No hay más magia que esa: se llama al modelo, si pidió herramientas se ejecutan, se le devuelven los resultados, se lo vuelve a llamar. Se sale del loop cuando el modelo deja de pedir herramientas.

El cuerpo del loop, entero:

```typescript
for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
  const respuesta: ConverseCommandOutput = await cliente.send(
    new ConverseCommand({
      modelId: MODELO_ID,
      messages: mensajes,
      system: [{ text: PROMPT_SISTEMA }],
      toolConfig: toolConfigBedrock(),
      inferenceConfig: { maxTokens: 2048 },
      ...(GUARDRAIL_ID && GUARDRAIL_VERSION
        ? {
            guardrailConfig: {
              guardrailIdentifier: GUARDRAIL_ID,
              guardrailVersion: GUARDRAIL_VERSION,
            },
          }
        : {}),
    }),
  );
```

Cuatro cosas para mirar acá:

- `toolConfig: toolConfigBedrock()` — las herramientas no están escritas en este archivo. Vienen del registro MCP (sección 7).
- `guardrailConfig` — el guardrail se aplica en **cada vuelta** del loop, no solo al mensaje del usuario. Si el modelo genera algo prohibido en la vuelta 4, se corta ahí.
- `system` es un array aparte de `messages`. Eso es lo que después te permite ponerle un `cachePoint` y dejar de pagar el prompt de sistema en cada request.
- Se acumulan los tokens de **todas** las vueltas. Un turno de conversación no es una llamada al modelo: pueden ser tres o cuatro. Esa es la diferencia de costo entre una POC y producción.

La decisión de salir del loop:

```typescript
const salida = respuesta.output?.message;
if (!salida) break;

mensajes.push(salida);

// El modelo terminó de hablar.
if (respuesta.stopReason !== "tool_use") {
  return {
    texto: extraerTexto(salida.content ?? []),
    herramientasUsadas,
    uso: { tokensEntrada, tokensSalida },
    bloqueadoPorGuardrail,
  };
}
```

Y si pidió herramientas, se ejecutan **todas** y los resultados vuelven en un único mensaje:

```typescript
// Pidió herramientas: se ejecutan todas y los resultados vuelven en un
// único mensaje de usuario (partirlos degrada el uso de paralelismo).
const pedidos = (salida.content ?? []).filter((b) => b.toolUse);
const resultados: ContentBlock[] = [];

for (const bloque of pedidos) {
  const uso = bloque.toolUse!;
  const nombre = uso.name!;
  herramientasUsadas.push(nombre);
  console.log("Herramienta", nombre, JSON.stringify(uso.input));

  const resultado = await ejecutarHerramienta(
    nombre,
    (uso.input ?? {}) as Record<string, any>,
    contexto,
  );

  resultados.push({
    toolResult: {
      toolUseId: uso.toolUseId!,
      content: [{ json: resultado }],
    },
  });
}

mensajes.push({ role: "user", content: resultados });
```

Ese `console.log` es tu observabilidad: en CloudWatch vas a ver qué herramienta se llamó y con qué argumentos. En el paso 6 del workshop lo vas a leer en vivo.

Y qué pasa si el loop se agota, o sea, si el modelo pidió herramientas ocho veces seguidas sin llegar a una respuesta:

```typescript
return {
  texto:
    "Se me complicó resolver esto. ¿Querés que abra un reclamo para que lo vea una persona del equipo?",
  herramientasUsadas,
  uso: { tokensEntrada, tokensSalida },
  bloqueadoPorGuardrail,
};
```

No tira una excepción: **degrada a una salida humana**. El usuario nunca ve un 500.

Por último, el system prompt vive en este mismo archivo, en `PROMPT_SISTEMA`. Leelo entero: define el tono, obliga a usar la base de conocimiento en vez de responder de memoria, y pone límites. Los límites del prompt son la primera línea; el guardrail es la segunda; IAM es la tercera. Las tres, no una.

### 7. El registro de servidores MCP: `lambda/agent/mcp/registro.ts`

MCP acá es un **contrato de integración**: cada capacidad del agente es un "servidor" con sus herramientas. El agente no sabe si por debajo hay DynamoDB, un índice vectorial o la API de un transportista.

El contrato está en `lambda/agent/mcp/tipos.ts` y son 34 líneas:

```typescript
export interface HerramientaMCP {
  nombre: string;
  descripcion: string;
  /** JSON Schema de los parámetros de entrada. */
  esquemaEntrada: Record<string, any>;
  /** El resultado viaja como documento JSON hacia el modelo. */
  ejecutar(argumentos: Record<string, any>, contexto: ContextoEjecucion): Promise<any>;
}

export interface ServidorMCP {
  nombre: string;
  version: string;
  descripcion: string;
  herramientas: HerramientaMCP[];
}

/** Nombre calificado que ve el modelo: servidor__herramienta. */
export function nombreCalificado(servidor: string, herramienta: string): string {
  return `${servidor}__${herramienta}`;
}
```

Y el `ContextoEjecucion` es donde vive la seguridad:

```typescript
export interface ContextoEjecucion {
  /** Identidad del usuario autenticado (viene del id_token de Cognito). */
  clienteId: string;
  /** Sesión de chat actual. */
  sesionId: string;
}
```

El registro tiene un array y un índice. Nada más:

```typescript
export const servidores: ServidorMCP[] = [
  servidorPedidos,
  servidorConocimiento,
  servidorReclamos,
];

/** Índice plano nombre-calificado → herramienta. */
const indice = new Map<string, { servidor: ServidorMCP; herramienta: HerramientaMCP }>();
for (const servidor of servidores) {
  for (const herramienta of servidor.herramientas) {
    indice.set(nombreCalificado(servidor.nombre, herramienta.nombre), { servidor, herramienta });
  }
}
```

De ese índice salen las dos vistas del mismo catálogo: `toolConfigBedrock()` lo traduce al formato de la Converse API, y `listarHerramientasMCP()` al formato de `tools/list` de MCP, que es lo que responde `POST /mcp`. **Una sola definición, dos consumidores.**

Podés ver las herramientas que el modelo recibe, sin desplegar nada:

```bash
npx ts-node -e 'const m = require("./lambda/agent/mcp/registro"); console.log(m.listarHerramientasMCP().map((h: any) => h.name).join("\n"))'
```

```
pedidos__listar
pedidos__detalle
conocimiento__buscar
reclamos__crear
reclamos__consultar
```

Ocho herramientas, cuatro servidores — el cuarto, `ventas`, es especial: sus dos
herramientas declaran `fuentes`, y el registro las filtra según el switch
Gold/Detalle de la interfaz. En modo gold el modelo ni se entera de que existe
`ventas__detalle`; en detalle, al revés. El filtro corre dos veces: al armar el
catálogo que ve el modelo y al ejecutar — dictarle el nombre de la herramienta
prohibida no alcanza. En el paso 5 del workshop vas a agregar un quinto servidor
tocando exactamente dos archivos: uno nuevo, y el array de arriba.

El ejecutor tiene una decisión que importa:

```typescript
try {
  return await entrada.herramienta.ejecutar(argumentos ?? {}, contexto);
} catch (error) {
  console.error(`Error ejecutando ${nombre}`, error);
  // El error vuelve al modelo como resultado: puede reintentar o explicarle
  // al cliente qué pasó, en vez de cortar la conversación.
  return {
    error: true,
    mensaje: error instanceof Error ? error.message : "Error desconocido en la herramienta.",
  };
}
```

Si una herramienta explota, el error **vuelve al modelo como resultado de la herramienta**. El modelo puede reintentar con otros argumentos o explicarle al cliente qué pasó. Si en cambio dejás propagar la excepción, la conversación se corta y el usuario ve un error genérico. Acá se combina con el `MAX_VUELTAS` de la sección anterior: reintentar sí, para siempre no.

Y mirá cómo lo usa el servidor de pedidos, en `lambda/agent/mcp/pedidos.ts`:

```typescript
async ejecutar(argumentos, contexto) {
  const limite = Math.min(Number(argumentos.limite ?? 5), 20);
  const resultado = await cliente.send(
    new QueryCommand({
      TableName: TABLA,
      KeyConditionExpression: "clienteId = :c",
      ExpressionAttributeValues: { ":c": contexto.clienteId },
      ScanIndexForward: false,
      Limit: limite,
    }),
  );
```

El `clienteId` de la query sale de `contexto`, **no de `argumentos`**. El modelo no puede tocarlo aunque quiera: no es un parámetro del esquema. Aunque el usuario escriba "mostrame los pedidos del cliente 42", la Query sale acotada a su propia partición. En el paso 4 el seed carga pedidos de un cliente ajeno justamente para que pruebes esto.

### 8. La memoria de la conversación: `lambda/agent/historial.ts`

Mandarle al modelo todos los turnos de la conversación en cada request es el error más caro y más común de las POCs. La conversación crece, el prompt crece, y el costo crece de forma cuadrática sobre el largo del chat.

La memoria tiene **dos backends conmutables**, y el switch es una sola env var:

```bash
grep -n "MEMORY_ID\|VENTANA\|TTL_HORAS" lambda/agent/historial.ts | head
```

- **Con `MEMORY_ID`** (el despliegue por defecto) el historial vive en **Bedrock AgentCore Memory**, en su capa de corto plazo: cada intercambio es un evento con `actorId` (el `sub` de Cognito) y `sessionId`. Sin estrategias de extracción es la opción más económica del servicio, la expiración la maneja AgentCore, y la memoria queda atada a la identidad: mismo teléfono, misma conversación, aunque el navegador se recargue.
- **Sin `MEMORY_ID`** cae al backend DynamoDB de abajo, que es el que conviene leer para entender la mecánica por dentro: ventana deslizante + TTL, sin servicios gestionados en el medio.

En los dos casos al modelo viaja solo una **ventana de los últimos 12 turnos**; el resto queda guardado para auditar pero no se paga en cada request.

La estrategia del repo: **guardar todo en DynamoDB, mandar poco al modelo.**

```typescript
/** Cantidad de turnos que viajan al modelo en cada request. */
const VENTANA = 12;

/** Los registros del laboratorio se borran solos a las 24 horas. */
const TTL_HORAS = 24;

export async function cargarHistorial(sesionId: string): Promise<Message[]> {
  const resultado = await cliente.send(
    new QueryCommand({
      TableName: TABLA,
      KeyConditionExpression: "sesionId = :s",
      ExpressionAttributeValues: { ":s": sesionId },
      ScanIndexForward: false,
      Limit: VENTANA,
    }),
  );

  const items = (resultado.Items ?? []).sort((a, b) => a.turno - b.turno);
```

El truco de la Query: `ScanIndexForward: false` la ordena descendente por `turno`, y `Limit: 12` se lleva los **últimos** doce. Después se reordena en memoria para que el modelo los reciba cronológicamente. Es una sola lectura de DynamoDB, sin escanear la sesión entera.

Y hay un detalle que solo aparece cuando la ventana corta:

```typescript
// Un historial que arranca con un mensaje del asistente no es válido:
// la conversación siempre empieza del lado del usuario.
while (items.length > 0 && items[0].rol !== "user") {
  items.shift();
}
```

Si la ventana empieza justo en una respuesta del asistente, Bedrock rechaza el request con un `ValidationException`. Descartar hasta el primer mensaje de usuario cuesta dos líneas y te ahorra un bug que solo aparece en la conversación número trece.

El TTL que la tabla declaró en la sección 2, acá se escribe:

```typescript
expiraEn: Math.floor(Date.now() / 1000) + TTL_HORAS * 3600,
```

Y en `lambda/agent/index.ts` se ve qué se persiste: el mensaje del usuario y el texto final del asistente, **no** los mensajes intermedios de tool use.

```typescript
const paraHistorial: Message = {
  role: "user",
  content: contenido.map((bloque) =>
    bloque.image ? { text: `[el cliente adjuntó una foto: ${adjuntoClave}]` } : bloque,
  ),
};

const turno = await proximoTurno(sesionId);
await guardarTurno(sesionId, turno, paraHistorial);
await guardarTurno(sesionId, turno + 1, {
  role: "assistant",
  content: [{ text: resultado.texto }],
});
```

Los `toolUse` y `toolResult` viven solo dentro de la invocación. Guardarlos multiplicaría el tamaño del historial sin agregar nada a la próxima conversación.

**Y las fotos tampoco se guardan.** Del turno del usuario se reemplaza el bloque de imagen por su ruta en S3. Hay dos razones, y la primera es un límite duro:

| | |
|---|---|
| **Un ítem de DynamoDB no puede pasar de 400 KB** | Los bytes de la foto van al ítem como un array JSON: una imagen de 60 KB lo revienta y la escritura falla con `Item size has exceeded the maximum allowed size`. La conversación se responde bien y muere al guardarse. |
| **Reenviar la foto cada turno se paga cada turno** | Sin esto, una imagen de la conversación se manda a Bedrock en los doce turnos siguientes de la ventana. |

Es el mismo criterio que con los `toolResult`: **en el historial va la referencia, no la carga**. Si más adelante hace falta la imagen, está en S3 y la clave quedó guardada.

Otras estrategias válidas, para que sepas que hay más de una: resumir los turnos viejos con un modelo chico, o recuperar por embedding solo los turnos relevantes. La ventana fija es la más barata y, para atención al cliente, casi siempre alcanza.

### 8b. Los datos analíticos: `lambda/agent/mcp/ventas.ts` y `lambda/agent/athena.ts`

El quinto stack, `summit-lakehouse`, crea dos tablas Iceberg en **Amazon S3
Tables**: `ventas_gold` (agregada por tenant, mes y categoría, sin datos
personales) y `ventas_detalle` (el grano crudo, con PII inventada y todos los
tenants mezclados). El agente las consulta por **Athena** contra el catálogo
federado de Glue, con permisos de **Lake Formation**.

```bash
grep -n "fuentes:" lambda/agent/mcp/ventas.ts
grep -n "tenant_id = " lambda/agent/mcp/ventas.ts
```

La línea que importa es el `WHERE tenant_id = <sub del token>` de
`ventas__resumen`: el aislamiento entre clientes lo arma la plataforma, no el
prompt. `ventas__detalle` hace lo contrario a propósito — es el anti-patrón en
vivo para el experimento gold vs detalle. La guía completa está
en [lakehouse-gold-vs-detalle.md](lakehouse-gold-vs-detalle.md).

### 8c. Por qué el chat entra por una Function URL

En `summit-agente` convive una API HTTP de API Gateway (adjuntos, historial,
MCP) con una **Function URL** de la Lambda solo para el chat:

```bash
grep -n "addFunctionUrl" lib/agent-stack.ts
grep -n "verificadorJWT" lambda/agent/index.ts
```

API Gateway corta toda integración a los 30 segundos, y un agente que encadena
herramientas y reintentos los supera con facilidad. La Function URL no tiene ese
techo. Lo que no se negocia es la identidad: como la Function URL no tiene
autorizador delante, el handler valida el mismo `id_token` de Cognito con
`aws-jwt-verify`, contra el mismo user pool. La identidad sale siempre de un
token verificado, entre por donde entre.

### 9. Los cuatro triggers de Cognito: `lambda/auth/*.ts`

Ahora sí, el por qué de las cuatro Lambdas. Cognito **no tiene** un botón de "login por SMS sin contraseña". Tiene un flujo genérico, `CUSTOM_AUTH`, en el que vos escribís qué es un desafío, cómo se emite y cómo se valida. Cada Lambda es un punto de extensión de ese flujo.

La secuencia completa, con lo que hace el frontend (`webapp/src/api.ts`) de un lado y los triggers del otro:

| # | El navegador llama | Cognito invoca | Archivo | Qué hace |
|---|---|---|---|---|
| 1 | `SignUp` (siempre; si el número ya existe, el front se traga el `UsernameExists`) | `preSignUp` | `pre-signup.ts` | Auto-confirma el usuario |
| 2 | `InitiateAuth` con `AuthFlow: "CUSTOM_AUTH"` | `defineAuthChallenge` | `define-challenge.ts` | Decide: hay que emitir un desafío |
| 3 | *(sigue el mismo `InitiateAuth`)* | `createAuthChallenge` | `create-challenge.ts` | Genera el código de 6 dígitos y lo manda por SNS |
| 4 | `RespondToAuthChallenge` con el código | `verifyAuthChallengeResponse` | `verify-challenge.ts` | Compara el código |
| 5 | *(sigue el mismo `RespondToAuthChallenge`)* | `defineAuthChallenge` otra vez | `define-challenge.ts` | Decide: dar tokens, reintentar o fallar |

Fijate que `defineAuthChallenge` se invoca **dos veces o más**: es el árbitro del flujo, se lo llama antes y después de cada desafío.

**`pre-signup.ts` — 12 líneas.** En un login sin contraseña no hay nada que confirmar por separado: la prueba de identidad es el SMS que viene después.

```typescript
export const handler: PreSignUpTriggerHandler = async (event) => {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyPhone = true;
  return event;
};
```

En producción, este es el lugar donde decidís **quién tiene derecho a registrarse**: dominio de correo, lista blanca de teléfonos, invitación previa.

**`define-challenge.ts` — la máquina de estados.**

```typescript
const MAX_INTENTOS = 3;

export const handler: DefineAuthChallengeTriggerHandler = async (event) => {
  const sesiones = event.request.session ?? [];

  // Usuario inexistente: Cognito lo marca así. Cortamos sin filtrar
  // si el número existe o no (evita enumeración de usuarios).
  if (event.request.userNotFound) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  const ultima = sesiones[sesiones.length - 1];

  if (ultima?.challengeName === "CUSTOM_CHALLENGE" && ultima.challengeResult === true) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
    return event;
  }

  if (sesiones.length >= MAX_INTENTOS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  event.response.issueTokens = false;
  event.response.failAuthentication = false;
  event.response.challengeName = "CUSTOM_CHALLENGE";
  return event;
};
```

`event.request.session` es el historial de intentos de **este** login. Tres respuestas posibles: emitir tokens, fallar, o pedir otro desafío. El tope de tres intentos está acá y no en el frontend, que es donde tiene que estar.

**`create-challenge.ts` — emite el código.** El detalle importante es el reintento:

```typescript
if (event.request.session && event.request.session.length > 0) {
  // Reintento del mismo login: se reutiliza el código ya emitido.
  const previo = event.request.session[event.request.session.length - 1];
  codigo = previo.challengeMetadata?.replace("CODIGO-", "") ?? generarCodigo();
} else {
  codigo = generarCodigo();
  // … PublishCommand a SNS con el SMS
}
```

Si te equivocaste al tipear, **no** te llega un SMS nuevo: se reutiliza el código anterior, guardado en `challengeMetadata`. Sin esto, tres intentos son tres SMS y tres costos.

Y la separación que hay que entender:

```typescript
event.response.publicChallengeParameters = {
  telefono: enmascarar(event.request.userAttributes.phone_number ?? ""),
  ...(MODO_DEMO ? { codigoDemo: codigo } : {}),
};
event.response.privateChallengeParameters = { codigo };
event.response.challengeMetadata = `CODIGO-${codigo}`;
```

`publicChallengeParameters` viaja al navegador. `privateChallengeParameters` solo lo ve el trigger de verificación. Por eso `MODO_DEMO` es un agujero deliberado: mete el código en la parte pública para que el laboratorio funcione con SNS en sandbox. **En producción va en `false`** — está en `lib/auth-stack.ts`.

**`verify-challenge.ts` — 19 líneas y una decisión fina.**

```typescript
export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event) => {
  const esperado = event.request.privateChallengeParameters?.codigo ?? "";
  const recibido = event.request.challengeAnswer ?? "";

  event.response.answerCorrect = comparar(esperado, recibido);
  return event;
};

// Comparación de tiempo constante: no filtra cuántos dígitos acertaste.
function comparar(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
```

`timingSafeEqual` en vez de `===`. Un `===` sobre strings corta en el primer carácter distinto, y esa diferencia de microsegundos, medida muchas veces, dice cuántos dígitos acertaste. Con seis dígitos y tres intentos el riesgo real es bajo, pero es una línea y es la correcta.

Resumen de por qué son cuatro: **una decide, una emite, una verifica, una admite**. Cognito pone la máquina de estados, la sesión y los tokens; vos ponés la lógica de negocio de cada paso.

### 10. `cdk synth`: ver el CloudFormation sin tocar la cuenta

`cdk synth` toma el TypeScript, lo ejecuta, empaqueta las Lambdas con esbuild y escribe las plantillas de CloudFormation en `cdk.out/`. **No llama a la API de AWS y no crea nada.**

```bash
npx cdk synth summit-agente
```

Las primeras líneas de la salida:

```
Resources:
  Guardrail:
    Type: AWS::Bedrock::Guardrail
    Properties:
      BlockedInputMessaging: No puedo ayudarte con eso. Puedo responder consultas sobre tus pedidos, envíos y reclamos.
      BlockedOutputsMessaging: No puedo responder eso. ¿Te ayudo con tu pedido o con un reclamo?
      ContentPolicyConfig:
        FiltersConfig:
          - InputStrength: HIGH
            OutputStrength: HIGH
            Type: SEXUAL
```

Ahí está tu `bedrock.CfnGuardrail` convertido en YAML. Buscá ahora las variables de entorno de la Lambda del agente:

```bash
npx cdk synth summit-agente 2>/dev/null | grep -B 2 "MODELO_ID" -A 15
```

```
      Environment:
        Variables:
          MODELO_ID: us.anthropic.claude-opus-5
          MODELO_EMBEDDINGS: amazon.titan-embed-text-v2:0
          GUARDRAIL_ID:
            Fn::GetAtt:
              - Guardrail
              - GuardrailId
          GUARDRAIL_VERSION:
            Fn::GetAtt:
              - GuardrailVersion
              - Version
          KB_MODE: local
          KNOWLEDGE_BASE_ID: ""
          TABLA_PEDIDOS:
            Fn::ImportValue: summit-datos:ExportsOutputRefPedidos75CD35AA9D52092A
          TABLA_CONVERSACIONES:
            Fn::ImportValue: summit-datos:ExportsOutputRefConversaciones68B0D69B607CFCC4
```

Esto es lo que buscábamos ver:

- `MODELO_ID` y `KB_MODE` salieron del contexto de `cdk.json` y quedaron como texto literal.
- `GUARDRAIL_ID` es un `Fn::GetAtt`: no existe hasta que CloudFormation cree el guardrail, y se resuelve en el momento del deploy.
- `TABLA_PEDIDOS` es un `Fn::ImportValue` contra `summit-datos`. **Eso es lo que generó pasar la tabla como prop en `bin/workshop.ts`.** Por eso los stacks se despliegan en orden, y por eso no podés borrar `summit-datos` mientras exista `summit-agente`.

Podés sintetizar todo de una, sin que te imprima el YAML:

```bash
npx cdk synth --quiet
```

```
Successfully synthesized to /Users/tu-usuario/aws-summit-mx-2026/workshop/cdk.out
Supply a stack id (summit-datos, summit-auth, summit-agente, summit-web) to display its template.
```

Antes de eso vas a ver a esbuild empaquetando las cinco Lambdas (`Bundling asset summit-auth/DefinirDesafio/Code/Stage...` y compañía) y un `WARNING` sobre `crossStackReferencesDefaultStrong`. Ese warning es informativo, no rompe nada: te está avisando que las referencias entre stacks son "fuertes", que es exactamente lo que queremos acá.

## Checkpoint

Las cuatro plantillas tienen que estar generadas en `cdk.out/` y con la cantidad de recursos esperada:

```bash
node -e "for (const s of ['datos','auth','agente','web']) { const t = require('./cdk.out/summit-' + s + '.template.json'); console.log('summit-' + s, Object.keys(t.Resources).length, 'recursos'); }"
```

```
summit-datos 18 recursos
summit-auth 17 recursos
summit-agente 16 recursos
summit-web 13 recursos
```

Si te dan esos cuatro números, tu código compila, esbuild empaquetó las Lambdas y CDK resolvió las referencias entre stacks. **Estás listo para el paso 3.**

Si querés ver de qué está hecho cada stack, este comando desglosa por tipo de recurso (necesita `jq`):

```bash
jq -r '.Resources | to_entries | group_by(.value.Type)[] | "\(length)  \(.[0].value.Type)"' cdk.out/summit-agente.template.json | sort -rn
```

```
3  AWS::Lambda::Permission
3  AWS::ApiGatewayV2::Route
1  AWS::Lambda::Function
1  AWS::IAM::Role
1  AWS::IAM::Policy
1  AWS::CDK::Metadata
1  AWS::Bedrock::GuardrailVersion
1  AWS::Bedrock::Guardrail
1  AWS::ApiGatewayV2::Stage
1  AWS::ApiGatewayV2::Integration
1  AWS::ApiGatewayV2::Authorizer
1  AWS::ApiGatewayV2::Api
```

El bloque del guardrail (líneas 42 a 100 de `agent-stack.ts`) se convirtió en dos recursos; los tres `api.addRoutes(...)` en tres rutas más tres permisos de Lambda, que nunca escribiste. Esa es la diferencia entre escribir CDK y escribir CloudFormation a mano.

## Si algo falla

| Síntoma | Por qué pasa | Cómo se arregla |
|---|---|---|
| `Error: Cannot find module 'aws-cdk-lib'` | No corriste `npm install`, o lo corriste en la carpeta de arriba | Parate en `workshop/` y corré `npm install` |
| `--app is required either in command-line, in cdk.json or in ~/.cdk.json` | Estás corriendo `cdk` desde otra carpeta: no encuentra `cdk.json` | `cd` a la carpeta `workshop/` del repo |
| `Bundling asset summit-agente/Agente/Code/Stage... Error: spawnSync docker ENOENT` | CDK no encontró `esbuild` local y quiso caer a Docker, que no está | `npm install` de nuevo (esbuild es una devDependency del repo). Con esbuild presente, Docker no hace falta |
| `This CDK CLI is not compatible with the CDK library used by your application` | La CLI global de `cdk` es más vieja que `aws-cdk-lib` | Usá siempre `npx cdk ...`, que toma la versión del repo, no la global |
| `error TS2307: Cannot find module './mcp/registro'` al hacer `synth` | Escribiste mal un import o falta un archivo — típico si ya te adelantaste al paso 5 | Corré `npm run typecheck`, que te da el error con archivo y línea, y arreglá el import |
| `WARNING No cross-stack-reference strength configured...` | Es un aviso de CDK sobre feature flags, no un error | Ignoralo. El `synth` termina con `Successfully synthesized` igual |
