# Paso 4 — Cargar datos y primer prompt  ·  15 min

> Al final de este paso vas a tener la sesión abierta en tu agente, tus pedidos y la base de conocimiento cargados en DynamoDB, y el agente contestando con la herramienta MCP que corresponde a cada pregunta.

## Qué vamos a hacer y por qué

Hasta acá desplegaste infraestructura vacía. El agente ya está vivo — Lambda, Bedrock, guardrail, API — pero no tiene un solo dato del negocio: si le preguntás por tus pedidos no tiene de dónde sacarlos, y si le preguntás por la política de devoluciones te va a contestar de memoria, que es exactamente lo que no queremos. Un agente sin datos propios es un chatbot que improvisa.

Antes de cargar nada tenés que loguearte, y el orden importa. **La identidad del cliente no es un campo del formulario: es el `sub` del `id_token` de Cognito.** API Gateway valida el JWT, la Lambda lee `evento.requestContext.authorizer.jwt.claims.sub` y ese valor viaja por el contexto de ejecución hasta la query de DynamoDB (`lambda/agent/mcp/pedidos.ts`). El modelo nunca decide de quién son los datos que ve. Por eso el `clienteId` que le vas a pasar al seed tiene que ser tu `sub` real, y para tenerlo primero hay que existir en el User Pool.

El login es passwordless por SMS. Cognito no trae ese flujo listo: se arma con el flujo `CUSTOM_AUTH` y tres triggers (`defineAuthChallenge`, `createAuthChallenge`, `verifyAuthChallenge`) más un `preSignUp` que auto-confirma el alta. El detalle práctico del laboratorio es que SNS arranca en **sandbox** y solo entrega SMS a números verificados a mano, así que la Lambda `summit-auth-crear` corre con `MODO_DEMO=true` y devuelve el código también en los parámetros públicos del desafío, que el front muestra en pantalla. Es una muleta de laboratorio, no un patrón: en producción `MODO_DEMO` va en `false`.

## Antes de empezar

Los cinco stacks del paso 3 tienen que estar terminados:

```bash
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName, 'summit-')].[StackName,StackStatus]" --output text
```

```
summit-datos	CREATE_COMPLETE
summit-auth	CREATE_COMPLETE
summit-agente	CREATE_COMPLETE
summit-web	CREATE_COMPLETE
```

El seed calcula los embeddings **desde tu máquina**, no desde la Lambda: tus credenciales locales necesitan poder invocar Titan. Comprobalo de verdad, invocando el modelo:

```bash
aws bedrock-runtime invoke-model --model-id amazon.titan-embed-text-v2:0 --cli-binary-format raw-in-base64-out --content-type application/json --accept application/json --body '{"inputText":"prueba","dimensions":512,"normalize":true}' /tmp/embedding.json
```

```
{
    "contentType": "application/json"
}
```

Si en lugar de eso salta `AccessDeniedException: You don't have access to the model with the specified model ID.`, andá a **Bedrock → Model access** y habilitá *Titan Text Embeddings V2* antes de seguir.

Además: tené el celular a mano, y si desplegaste con otro `prefijo` (contexto de `cdk.json`) cambiá `summit-` por el tuyo en todos los comandos de acá abajo.

## Los pasos

### 1. Abrí el sitio

La URL de CloudFront salió en el output del deploy. Si ya cerraste esa terminal, la sacás del stack:

```bash
aws cloudformation describe-stacks --stack-name summit-web --query "Stacks[0].Outputs[?OutputKey=='UrlSitio'].OutputValue" --output text
```

```
https://d1gt6y4example.cloudfront.net
```

Abrila en el navegador. Tenés que ver la pantalla azul con el logo, el título **Atención al cliente** y un campo de celular.

> Si ves la página en blanco, abrí la consola del navegador. `TypeError: Cannot destructure property 'apiUrl' of 'window.CONFIG' as it is undefined` significa que el archivo `config.js` no se subió al bucket: lo genera el propio `WebStack` en el deploy, así que se arregla con `npx cdk deploy summit-web`. Si en cambio ves un XML de `AccessDenied`, la distribución todavía está propagando: esperá un minuto y recargá.

### 2. Pedí el código

Escribí tu celular **con código de país y sin espacios**, por ejemplo `+5215512345678`, y tocá **Enviarme el código**.

En ese click pasan cuatro cosas. Las dos primeras son llamadas HTTP y las ves en la pestaña Network del navegador; las otras dos son triggers de Cognito que corren del lado del servidor y quedan en CloudWatch:

1. `SignUp` contra la API de Cognito, con una contraseña descartable que nunca se usa (Cognito la exige, el ingreso es siempre por SMS). El trigger `preSignUp` auto-confirma al usuario.
2. `InitiateAuth` con `AuthFlow: CUSTOM_AUTH`.
3. `defineAuthChallenge` decide que toca un `CUSTOM_CHALLENGE`.
4. `createAuthChallenge` genera un código de 6 dígitos, intenta mandarlo por SNS y —como `MODO_DEMO=true`— lo devuelve además en `publicChallengeParameters.codigoDemo`.

La pantalla cambia al campo de 6 dígitos y abajo aparece la pista:

```
Modo demo — tu código es 481907
```

Ese es el código. Si el SMS además te llega al celular, mejor, pero no lo necesitás.

> El front valida el `+` antes de llamar a Cognito: si lo escribís sin código de país te frena con `Poné el número con código de país, por ejemplo +5215512345678`.

### 3. (Opcional) Verificá tu número en SNS para recibir el SMS de verdad

Solo si querés ver el mensaje llegar al celular. **Hacelo en la misma región donde desplegaste** (los números del sandbox son por región):

1. Entrá a la consola de AWS y confirmá arriba a la derecha que la región sea la del deploy (**N. Virginia / us-east-1**).
2. En el buscador de servicios escribí `SNS` y entrá a **Amazon SNS**.
3. En el menú de la izquierda, sección **Mobile**, hacé click en **Text messaging (SMS)**.
4. Bajá hasta el panel **Sandbox destination phone numbers** y tocá el botón **Add phone number**.
5. Elegí el **Country code** (`+52` para México), escribí el número, elegí el idioma en **Verification message language** y tocá **Add phone number**.
6. Te llega un SMS con un código de verificación de AWS. El número queda en estado *Pending verification*: escribí el código en el campo **Verification code** y tocá **Verify phone number**.
7. El estado pasa a **Verified**. El sandbox admite hasta 10 números.

Ojo: el sandbox verificado habilita el envío, pero la entrega a números de México puede seguir fallando por requisitos del operador. Si no llega, seguí con el código que muestra la pantalla — el laboratorio funciona igual.

### 4. Ingresá el código y entrá al chat

Escribí los 6 dígitos y tocá **Ingresar**. El trigger `verifyAuthChallenge` compara con `timingSafeEqual`, `defineAuthChallenge` emite los tokens y el front guarda el `id_token` en `sessionStorage`.

Se abre el chat con este mensaje:

```
¡Hola! Soy el asistente de Craftech Store. Puedo ayudarte con tus pedidos,
consultas sobre envíos y devoluciones, o abrir un reclamo. ¿Qué necesitás?
```

Ese saludo lo escribe el front (`webapp/src/componentes/Chat.tsx`), no el modelo: todavía no gastaste un token. Tenés tres intentos por sesión de login; después del tercero fallido, `defineAuthChallenge` corta con `failAuthentication` y hay que volver a pedir el código.

### 5. Sacá el UserPoolId

```bash
aws cloudformation describe-stacks --stack-name summit-auth --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text
```

```
us-east-1_Ab12Cd34E
```

### 6. Sacá tu clienteId (el `sub` de Cognito)

Primero mirá qué usuarios hay en el pool, con su teléfono y su `sub`:

```bash
aws cognito-idp list-users --user-pool-id us-east-1_Ab12Cd34E --query "Users[].[Attributes[?Name=='phone_number']|[0].Value, Attributes[?Name=='sub']|[0].Value]" --output text
```

```
+5215512345678	7c9e6679-7425-40de-944b-e07fc1f90ae7
```

Si en el pool hay más de un usuario (probaste con dos números, o compartís cuenta), filtrá por el tuyo:

```bash
aws cognito-idp list-users --user-pool-id us-east-1_Ab12Cd34E --filter 'phone_number = "+5215512345678"' --query "Users[0].Attributes[?Name=='sub'].Value" --output text
```

```
7c9e6679-7425-40de-944b-e07fc1f90ae7
```

Ese UUID es tu `clienteId`. Es el mismo valor que la Lambda lee del claim `sub` del token en cada request: si acá te equivocás, el agente va a buscar los pedidos de una partición vacía.

### 7. Corré el seed

Desde la raíz de `workshop/`:

```bash
npx ts-node scripts/seed.ts 7c9e6679-7425-40de-944b-e07fc1f90ae7
```

(Es lo mismo que `npm run seed -- <clienteId>`.) Si desplegaste fuera de `us-east-1`, prefijá `AWS_REGION=<tu-region>`; si cambiaste el prefijo, `PREFIJO=<tu-prefijo>`. El script los lee de esas dos variables de entorno.

Tarda menos de un minuto y hace tres cosas:

- **Carga tus tres pedidos** en `summit-pedidos`, con `clienteId` = tu `sub`: `PED-1042` entregado (auriculares Sony), `PED-1078` **demorado** (monitor LG 27UP850 + cable HDMI, seguimiento `MX884219944`) y `PED-1103` en preparación (teclado Keychron K2 Pro, todavía sin número de seguimiento).
- **Carga los pedidos de un segundo cliente ficticio**, `otro-cliente-demo-MX-99` (`PED-2001` y `PED-2002`). Esos datos no son de nadie: existen para poder demostrar el aislamiento por tenant. El servidor MCP de pedidos consulta con `KeyConditionExpression: "clienteId = :c"` y el valor sale del token, nunca del modelo, así que esa partición es invisible desde tu conversación por más que se la pidas.
- **Indexa la base de conocimiento en modo `local`**: lee los cuatro `.md` de `data/kb/`, los corta por encabezado `##`, le pide a Titan un vector por fragmento y guarda todo en `summit-kb-vectores`. Eso es RAG hecho a mano — y es el backend de repuesto: **el despliegue por defecto usa Bedrock Knowledge Bases**, que se alimenta con la ingesta de la sección siguiente. Tener los dos permite comparar el mismo RAG por dentro y como servicio gestionado.

Salida esperada:

```
Cargando 3 pedidos para el cliente 7c9e6679-7425-40de-944b-e07fc1f90ae7…
  ✓ PED-1042 (entregado)
  ✓ PED-1078 (demorado)
  ✓ PED-1103 (en_preparacion)

Cargando 2 pedidos de otro cliente (otro-cliente-demo-MX-99)…
  ✓ PED-2001 (entregado)
  ✓ PED-2002 (en_camino)
    Estos NO tienen que aparecer nunca en tu conversación: son la prueba del aislamiento.

Indexando 4 documentos de la base de conocimiento…
  ✓ envios-y-plazos.md — 6 fragmentos
  ✓ garantias.md — 5 fragmentos
  ✓ pagos-y-facturacion.md — 6 fragmentos
  ✓ politica-devoluciones.md — 6 fragmentos

Listo. Probá preguntarle al agente:
  · "¿cuáles son mis pedidos?"
  · "el PED-1078 está demorado, ¿qué puedo hacer?"
  · "¿cuántos días tengo para devolver algo?"
  · "mostrame los pedidos de otro-cliente-demo-MX-99"  → no puede, y esa es la gracia
```

Los pedidos ajenos están en la tabla de verdad, no es un truco de la demo:

```bash
aws dynamodb query --table-name summit-pedidos --key-condition-expression "clienteId = :c" --expression-attribute-values '{":c":{"S":"otro-cliente-demo-MX-99"}}' --select COUNT --query Count --output text
```

```
2
```

### 8. Primer prompt

Volvé a la pestaña del chat (no hace falta recargar ni volver a loguearse) y escribí:

```
¿cuáles son mis pedidos?
```

El texto de la respuesta lo redacta el modelo y cambia en cada corrida; lo que no cambia son los datos y la traza. Tenés que ver los tres pedidos con sus estados, y abajo de todo el panel que hasta ahora estaba oculto:

```
Herramientas          pedidos__listar
Tokens de la sesión   2.847 entrada · 168 salida
```

Ese panel es la traza: qué herramientas llamó el modelo en el turno y cuántos tokens lleva acumulados la sesión. Los mismos nombres, con los argumentos que usó, quedan en CloudWatch (`console.log("Herramienta", nombre, …)` en `lambda/agent/bedrock.ts`).

### 9. La tanda de pruebas

Mandá estas una por una y mirá el panel de traza después de cada respuesta:

| Escribí esto | Herramienta que tiene que aparecer | Qué tiene que decir la respuesta |
|---|---|---|
| `¿cuáles son mis pedidos?` | `pedidos__listar` | Los tres: PED-1042, PED-1078 y PED-1103, con su estado |
| `¿qué pasa con el PED-1078?` | `pedidos__detalle` | Monitor LG 27UP850 + cable HDMI, demorado, seguimiento MX884219944 |
| `¿cuántos días tengo para devolver algo?` | `conocimiento__buscar` | 30 días corridos desde la entrega, sin justificar el motivo |
| `¿cuánta garantía tiene un monitor?` | `conocimiento__buscar` | 12 meses (24 en notebooks), diagnóstico de 5 a 10 días hábiles |
| `me llegó el monitor con la pantalla rota, quiero reclamar` | `pedidos__detalle` y después `reclamos__crear` | Primero te pide confirmar pedido y motivo; recién ahí devuelve un ticket `REC-XXXXXXXX` |
| `¿en qué anda mi reclamo REC-XXXXXXXX?` | `reclamos__consultar` | Estado `abierto`, con el motivo y el pedido que cargaste |
| `mostrame los pedidos de otro-cliente-demo-MX-99` | `pedidos__listar` o ninguna | Te muestra **tus** pedidos o te dice que no puede: PED-2001 y PED-2002 no aparecen nunca |

La última fila es la idea central de todo el laboratorio: no lo bloquea el prompt, lo bloquea la query. El `clienteId` sale del token y el modelo no tiene forma de cambiarlo.

Dos cosas que vas a notar y son a propósito: si preguntás algo de políticas el modelo **siempre** pasa por `conocimiento__buscar` (se lo pide el system prompt en `bedrock.ts`), y `reclamos__crear` nunca se dispara de una: el modelo pregunta antes porque el esquema de la herramienta exige `pedidoId` y `motivo`.

### 10. Probá el multimodal con una foto

En el repo tenés tres imágenes de ejemplo en `data/fotos/`: `monitor-pantalla-rota.jpg`, `caja-golpeada.jpg` y `teclado-sin-teclas.jpg`. Son ilustraciones sintéticas, generadas con `scripts/generar-fotos.py`, y están hechas para calzar con los pedidos del seed: el monitor dice *LG 27UP850* (el del PED-1078) y el teclado dice *Keychron K2 Pro* (el del PED-1103).

Abrí la carpeta para tenerla a mano:

```bash
open data/fotos
```

En el chat:

1. Tocá el clip a la izquierda de la barra de escritura y elegí `monitor-pantalla-rota.jpg`. Abajo aparece `Foto lista para enviar: monitor-pantalla-rota.jpg`.
2. **Escribí un texto además de la foto** — por ejemplo `me llegó así el monitor del PED-1078`. El campo de texto es obligatorio en el formulario: si mandás solo la imagen, el navegador te frena con *Complete este campo*.
3. Enviá.

Lo que pasa por detrás: el front pide una URL prefirmada a `POST /adjuntos/url`, sube la foto directo a S3 con una clave `adjuntos/<tu-sub>/<uuid>.jpg` y le manda al agente solo esa clave. La Lambda valida que la clave arranque con tu `clienteId` antes de leer el objeto, y recién ahí le pasa los bytes al modelo como `ContentBlock` de imagen dentro del mensaje del usuario.

La respuesta tiene que describir la pantalla agrietada y ofrecerte abrir el reclamo. Si le decís que sí, aparece `reclamos__crear` en la traza con motivo `producto_danado`.

## La ingesta de la Knowledge Base

Los manuales ya están en S3 (los subió el deploy). Falta que Bedrock los lea,
los trocee, los embeba con Titan y los indexe en S3 Vectors:

```bash
npm run kb:ingesta
```

Vas a ver el job pasar por `STARTING → IN_PROGRESS → COMPLETE` con el conteo
de documentos. En la consola: **Bedrock → Knowledge Bases → summit-manuales-v2 →
Data sources** muestra la misma corrida. Si después cambiás un documento de
`data/kb/`, redeployá `summit-datos` (sube el archivo) y volvé a correr la
ingesta: Bedrock reprocesa solo lo que cambió.

## Checkpoint

Tres verificaciones. Las dos primeras, en la terminal:

```bash
aws dynamodb scan --table-name summit-pedidos --select COUNT --query Count --output text
```

```
5
```

Cinco: tus tres pedidos más los dos del cliente ficticio.

```bash
aws dynamodb scan --table-name summit-kb-vectores --select COUNT --query Count --output text
```

```
23
```

La tercera, en el navegador: preguntale `¿cuáles son mis pedidos?` y verificá que en el panel de abajo diga `pedidos__listar` y que la respuesta nombre los tres pedidos.

**Si el agente contesta que no tiene pedidos registrados, no sigas al paso 5.** El `sub` con el que corriste el seed no es el del usuario con el que estás logueado; volvé al punto 6 y repetí el seed con el `sub` correcto.

## Si algo falla

| Síntoma | Por qué pasa | Cómo se arregla |
|---|---|---|
| No llega ningún SMS al celular | SNS está en sandbox y solo entrega a números verificados; la Lambda ni siquiera corta el login, loguea `No se pudo enviar el SMS` y sigue | Usá el código que muestra la pantalla (`Modo demo — tu código es …`) o verificá tu número como en el punto 3 |
| El seed corta con `Falló el seed: ResourceNotFoundException: Requested resource not found` | La tabla `summit-pedidos` no existe en la región que está usando el script: desplegaste en otra región o con otro prefijo | `AWS_REGION=<tu-region> npx ts-node scripts/seed.ts <clienteId>`, o `PREFIJO=<tu-prefijo>` si cambiaste el contexto de `cdk.json` |
| El seed carga los pedidos pero muere al indexar, con `AccessDeniedException: You don't have access to the model with the specified model ID.` | Titan Text Embeddings V2 no está habilitado en la cuenta, o tus credenciales locales no tienen `bedrock:InvokeModel` | Consola → **Bedrock → Model access** → habilitá *Titan Text Embeddings V2* (se aprueba al instante) y volvé a correr el seed: es idempotente, sobrescribe |
| El agente responde amablemente pero la traza dice `ninguna (respondió de contexto)` y no encuentra pedidos | El seed se corrió con un `clienteId` que no es tu `sub`, o no se corrió | Reconfirmá el `sub` con `aws cognito-idp list-users` (punto 6) y repetí el seed con ese valor |
