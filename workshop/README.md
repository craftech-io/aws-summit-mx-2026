# Workshop — Agente de atención al cliente en AWS

Un agente de atención al cliente **100% serverless**, desplegado con **AWS CDK** en tu propia cuenta. Es el laboratorio de la sesión *De la POC a producción* del AWS Summit México, y está pensado para que te lo lleves: todo lo que ves acá corre en tu cuenta y es tuyo para modificar.

En 75 minutos vas a tener funcionando: login por SMS, un agente con Claude Opus 5 que entiende imágenes, cuatro servidores MCP (pedidos, conocimiento, reclamos y ventas sobre el lakehouse), memoria por sesión, generación de reclamos y guardrails activos.

---

## La guía, paso a paso

Cada paso es un documento con sus comandos, qué hacer en la consola de AWS, un checkpoint para saber si salió bien y una tabla de qué hacer si falla.

| | Paso | Qué hacés | Min |
|---|---|---|---|
| 1 | [Setup](docs/paso-1-setup.md) | Herramientas, acceso a los modelos de Bedrock y bootstrap de CDK | 10 |
| 2 | [Recorrer la arquitectura](docs/paso-2-arquitectura.md) | Leer el código antes de crear nada: los cinco stacks y el loop del agente | 15 |
| 3 | [Desplegar](docs/paso-3-deploy.md) | `cdk deploy` de los cinco stacks, la ingesta de la KB y qué salidas anotar | 15 |
| 4 | [Cargar datos y probar](docs/paso-4-datos.md) | Login por SMS, seed de pedidos y documentos, primer prompt | 15 |
| 5 | [Tu propia herramienta MCP](docs/paso-5-tu-mcp.md) | **El ejercicio que te llevás**: sumar una capacidad al agente | 15 |
| 6 | [Romperlo a propósito](docs/paso-6-romperlo.md) | Guardrails, aislamiento entre clientes, trazas y limpieza | 5 |
| ★ | [Gold vs detalle](docs/lakehouse-gold-vs-detalle.md) | El experimento de datos: el mismo agente contra la capa gold y contra la tabla cruda de un lakehouse en S3 Tables | 20 |

> Si venís a seguir el laboratorio en vivo, arrancá por el [paso 1](docs/paso-1-setup.md). El resto de este README es contexto.
>
> ¿Ya lo hiciste y querés levantarlo de nuevo? `npm run todo -- <clienteId>` encadena deploy, permisos, ingesta y seeds en un solo comando (los detalles, al final del [paso 3](docs/paso-3-deploy.md)).

---

## Qué construimos

```
Navegador
   │  id_token (Cognito · login por SMS, custom auth)
   ▼
CloudFront ──▶ S3 (sitio estático)
   │
   ├─▶ Function URL de la Lambda   (el chat: sin techo de 30 s)
   └─▶ API Gateway HTTP            (adjuntos, historial y MCP, con autorizador JWT)
   ▼
Lambda «agente»  ──▶  Bedrock: Claude Opus 5 (Converse API) + Guardrail (v. calibrada)
   │
   ├── Memoria       ──▶ AgentCore Memory  (corto plazo, por actor y sesión)
   ├── MCP «pedidos»       ──▶ DynamoDB
   ├── MCP «conocimiento»  ──▶ Bedrock Knowledge Bases (vectores en S3 Vectors)
   ├── MCP «reclamos»      ──▶ DynamoDB  (mock de Jira, ID con UUID)
   ├── MCP «ventas»        ──▶ Athena ──▶ S3 Tables (Iceberg) + Lake Formation
   │                            gold (agregada, sin PII) vs detalle (cruda) — el switch de la UI
   └── Adjuntos            ──▶ S3
```

Nada de esto corre si no se usa: sin servidores, sin capacidad provisionada, sin costo fijo
(la única excepción son los centavos de S3 Tables y de la memoria, que expiran solos).

| Stack | Qué crea |
|---|---|
| `summit-datos` | Tablas DynamoDB y buckets S3 |
| `summit-auth` | Cognito User Pool + 4 Lambdas de autenticación (SMS passwordless) |
| `summit-lakehouse` | S3 Tables (Iceberg): `ventas_gold` y `ventas_detalle` + workgroup de Athena — el experimento [gold vs detalle](docs/lakehouse-gold-vs-detalle.md) |
| `summit-agente` | Guardrail de Bedrock, **AgentCore Memory**, Lambda del agente, API HTTP y Function URL del chat |
| `summit-web` | Sitio estático en S3 detrás de CloudFront |

**Servicios que el lab recorre de punta a punta:** Amazon Bedrock (Converse API,
Guardrails con trace, inference profiles), Bedrock AgentCore Memory, Titan
Embeddings, Amazon S3 Tables (Iceberg), Athena, Glue Data Catalog federado,
Lake Formation, DynamoDB, S3, Lambda, API Gateway, Function URLs, Cognito,
SNS, CloudFront y CDK. Las dos sesiones del Summit se encuentran acá: la de
AI construye y despliega este agente; la de Data explica el lakehouse y la
base de conocimiento de los que se alimenta.

## Requisitos

| | Cómo verificarlo |
|---|---|
| **Node 20 o superior** | `node -v` |
| **AWS CLI configurado** | `aws sts get-caller-identity` |
| **Acceso a Bedrock** | Claude Opus 5 y Titan Embeddings habilitados — ver [paso 1](docs/paso-1-setup.md) |
| **Un celular** | Es el usuario del login. Recibir el SMS es opcional |

## La interfaz de demo

La interfaz es una app **React (Vite)** que vive en [`../webapp`](../webapp/) y es **compartida** con la versión [full Bedrock](../workshop-full-bedrock/): la misma app, con `window.CONFIG.modo` decidiendo qué backend usa. Antes del primer deploy hay que compilarla (`cd ../webapp && npm install && npm run build`). Trae todo lo necesario para explorar el agente sin tener que inventar preguntas:

- **Switch Gold/Detalle** en la cabecera: decide qué capa del lakehouse ve el
  agente. Es una decisión de plataforma que viaja en cada request.
- **Píldoras de preguntas** con scroll horizontal sobre la barra de envío: cada
  una carga la pregunta completa y ajusta la fuente sola. Las coral van a la
  tabla cruda.
- **Consumo por respuesta**, debajo de cada mensaje del agente: tiempo total,
  tokens de entrada y salida, modo, y a qué backends fue el dato
  (`fue a: Knowledge Base (S3 Vectors) · DynamoDB`).
- **Memoria por teléfono** con botón **Reiniciar memoria**: mismo número, misma
  conversación, aunque el navegador se recargue.

## Los datos del laboratorio

- [`data/kb/`](data/kb/) — cinco documentos de la empresa (devoluciones, envíos, garantías, pagos, y los procedimientos de atención paso a paso) que se indexan como base de conocimiento.
- [`scripts/seed.ts`](scripts/seed.ts) — tres pedidos tuyos, más dos de **otro cliente** que existen solo para poder comprobar el aislamiento entre tenants en el paso 6.
- [`data/fotos/`](data/fotos/) — tres imágenes para probar el agente multimodal: un monitor con la pantalla rota, una caja golpeada y un teclado al que le faltan teclas. Se regeneran con `python3 scripts/generar-fotos.py`.

---

## Decisiones de diseño

### La base de conocimiento tiene dos modos

| Modo | Qué usa | Cuándo |
|---|---|---|
| `managed` *(por defecto)* | **Bedrock Knowledge Bases** con vectores en **S3 Vectors** (`bedrock:Retrieve`) | El despliegue del lab: el servicio real, de punta a punta |
| `local` | Titan Embeddings + similitud coseno sobre DynamoDB | Para ver RAG por dentro, o correr sin la KB (`-c kbMode=local`) |

**Por qué ahora el default es `managed`.** Históricamente la KB gestionada
necesitaba OpenSearch Serverless, con un mínimo mensual alto. Con **S3 Vectors**
como vector store el costo baja a centavos sin mínimo, así que el lab crea la
Knowledge Base entera por CDK: vector bucket + índice + KB + data source
apuntando a los manuales del bucket `summit-kb-docs`. Después del deploy, la
ingesta se dispara con:

```bash
npm run kb:ingesta
```

El id de la KB viaja al agente por **SSM en runtime** (`/summit/kb/id`): el
stack de datos puede reemplazar la KB sin redesplegar el agente, y sin pelearse
con los exports de CloudFormation.

El código del servidor MCP no cambia entre modos: solo el backend detrás de la
herramienta. Está en [`lambda/agent/mcp/conocimiento.ts`](lambda/agent/mcp/conocimiento.ts) —
el modo `local` sigue ahí para leer cómo funciona RAG por dentro.

### La memoria también tiene dos modos

| Modo | Qué usa | Cuándo |
|---|---|---|
| `agentcore` *(si hay `MEMORY_ID`)* | **Bedrock AgentCore Memory**, capa de corto plazo: eventos crudos por actor y sesión, sin estrategias de extracción — la opción más económica del servicio | El despliegue por defecto |
| `dynamo` | DynamoDB con ventana deslizante y TTL | El backend que el [paso 2](docs/paso-2-arquitectura.md) explica por dentro |

En los dos casos la memoria queda atada a la identidad (actor = `sub` de
Cognito) y a la sesión: **mismo teléfono, misma conversación**, aunque el
navegador se recargue. La interfaz guarda la sesión por número, la repinta al
volver (`POST /historial`) y el botón **Reiniciar memoria** arranca una sesión
nueva; los eventos viejos expiran solos a los 7 días. El switch entre modos es
solo la presencia de `MEMORY_ID` en el ambiente de la Lambda: el resto del
código no se entera, igual que con la base de conocimiento.

### El reclamo es un mock

`reclamos__crear` guarda en DynamoDB y devuelve un ID con UUID, con la misma forma que devolvería Jira al crear un issue. Cambiar el mock por la API real es reemplazar el cuerpo de `ejecutar()` en [`lambda/agent/mcp/reclamos.ts`](lambda/agent/mcp/reclamos.ts): nada más se entera.

### El agente nunca decide quién es el usuario

El `clienteId` sale del `sub` del token que valida API Gateway y viaja por el contexto de ejecución. Aunque alguien escriba *«mostrame los pedidos del cliente 42»*, la consulta a DynamoDB queda acotada a su propia partición. **La defensa no es el prompt: son los permisos.** El paso 6 lo comprueba.

---

## Costo

Con el uso de un workshop (unas 50 conversaciones), el costo total es de **centavos de dólar**. Lo único con costo fijo sería un vector store gestionado — por eso el modo por defecto no usa uno.

Al terminar, el [paso 6](docs/paso-6-romperlo.md) cierra con `npm run destroy`, que borra todo.

## Cómo seguir

- Cambiá el modelo a uno más chico en `cdk.json` y compará calidad, latencia y tokens sobre las mismas preguntas.
- Agregá `cachePoint` al system prompt en `bedrock.ts` y medí el ahorro.
- Sumá un servidor MCP contra una API real tuya.
- Conectá el endpoint `/mcp` a un cliente MCP externo.

---

Hecho por [Craftech](https://craftech.io) para el AWS Summit México.
