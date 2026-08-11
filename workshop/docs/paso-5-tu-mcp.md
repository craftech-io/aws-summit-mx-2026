# Paso 5 — Tu propia herramienta MCP  ·  15 min

> Al final de este paso tu agente va a saber rastrear envíos: una capacidad nueva, escrita por vos, sin haber tocado el prompt del sistema, ni el loop del agente, ni la infraestructura.

## Qué vamos a hacer y por qué

Hasta acá el agente sabe hacer tres cosas: consultar pedidos, buscar en la base de conocimiento y abrir reclamos. Cada una de esas capacidades es un **servidor MCP**: un archivo en `lambda/agent/mcp/` que exporta un objeto con un nombre, una versión, una descripción y una lista de herramientas. Nada más. En este paso vas a escribir el cuarto — `envios` — con una herramienta que rastrea paquetes.

> Un ejemplo ya desplegado de este mismo patrón: `lambda/agent/mcp/ventas.ts`,
> el servidor que consulta el lakehouse por Athena. Además de lo que vas a hacer
> acá, muestra un truco extra: sus herramientas declaran `fuentes: ["gold"]` o
> `["detalle"]` y el registro las expone o esconde según el switch de la
> interfaz. Si tu herramienta necesita existir solo en un modo, ese es el campo.


El punto del ejercicio no es el mock de la paquetería: es **dónde no vas a tener que meter mano**. No vas a tocar `lambda/agent/bedrock.ts`, que es el loop que conversa con Bedrock. No vas a tocar `PROMPT_SISTEMA`. No vas a tocar `lib/agent-stack.ts` ni ningún archivo de CDK. Vas a crear un archivo y agregar dos líneas en `lambda/agent/mcp/registro.ts`. Eso es todo, porque el despacho del orquestador no tiene ninguna herramienta cableada por nombre: en cada request arma el catálogo con `toolConfigBedrock()`, que recorre el índice plano que el registro construye a partir del array `servidores` y traduce cada herramienta al formato de la Converse API; cuando el modelo pide una, `ejecutarHerramienta()` la busca en ese mismo índice. Si está en el array, el modelo la ve; si no, no existe.

Por eso decimos que **el contrato es el esquema de la herramienta**. Lo que el modelo necesita saber para usar bien tu herramienta — cuándo llamarla, qué parámetros lleva, qué formato tiene cada uno, qué hacer si no encuentra nada — viaja en los campos `descripcion` y `esquemaEntrada`, que van en el `toolConfig` de cada llamada a Bedrock. El prompt del sistema es política general de la conversación ("sé breve", "no inventes", "no ofrezcas descuentos"); la política **de tu herramienta** vive en tu herramienta. `PROMPT_SISTEMA` sí nombra cuatro de las herramientas que ya existen, en su sección `## Herramientas`, pero eso es orientación de uso, no el contrato: tu herramienta nueva va a estar disponible sin agregarla ahí. Esto no es cosmética: significa que dos equipos distintos pueden sumar capacidades al mismo agente sin editar el mismo archivo, sin pisarse el prompt y sin coordinar un release. Es la misma razón por la que MCP existe como protocolo.

## Antes de empezar

Necesitás el paso 4 terminado: los cinco stacks desplegados, el seed corrido y una sesión abierta en el sitio de CloudFront (dejá esa pestaña abierta, la vamos a usar). Parate en la carpeta del workshop:

```bash
cd aws-summit-mx-2026/workshop
```

Y confirmá que el stack del agente está sano:

```bash
aws cloudformation describe-stacks --stack-name summit-agente --query "Stacks[0].StackStatus" --output text
```

```
CREATE_COMPLETE
```

Si te dice `UPDATE_COMPLETE` también está bien (es lo que vas a ver si ya desplegaste más de una vez). Si te dice `Stack with id summit-agente does not exist`, volvé al paso 3.

## Los pasos

### 1. Creá el servidor MCP

Creá el archivo `lambda/agent/mcp/envios.ts` con este contenido. Es el archivo completo: copialo tal cual.

```typescript
// Servidor MCP de envíos: rastreo del paquete con el transportista.
//
// EJERCICIO DEL WORKSHOP (paso 5). En producción, `ejecutar` haría el fetch
// contra la API del transportista. Acá los datos son simulados: lo que importa
// no es de dónde salen, sino que sumar una capacidad al agente es sumar un
// servidor — sin tocar el orquestador, el prompt ni la infraestructura.
import type { ServidorMCP } from "./tipos";

interface EventoEnvio {
  fecha: string;
  lugar: string;
  detalle: string;
}

interface Envio {
  estado: "en_transito" | "en_reparto" | "entregado" | "demorado";
  transportista: string;
  ultimaPosicion: string;
  entregaEstimada: string;
  eventos: EventoEnvio[];
}

// Los números coinciden con los pedidos que carga scripts/seed.ts:
//   MX884213907 → PED-1042 (entregado)
//   MX884219944 → PED-1078 (demorado)
const ENVIOS: Record<string, Envio> = {
  MX884213907: {
    estado: "entregado",
    transportista: "Paquetería del Valle",
    ultimaPosicion: "Av. Insurgentes Sur 1602, Ciudad de México",
    entregaEstimada: "2026-07-30",
    eventos: [
      {
        fecha: "2026-07-28T09:12:00Z",
        lugar: "Centro de distribución Iztapalapa, CDMX",
        detalle: "Paquete recibido en el centro de distribución.",
      },
      {
        fecha: "2026-07-29T14:40:00Z",
        lugar: "Sucursal Benito Juárez, CDMX",
        detalle: "Salió a reparto.",
      },
      {
        fecha: "2026-07-30T11:05:00Z",
        lugar: "Av. Insurgentes Sur 1602, CDMX",
        detalle: "Entregado. Firmó: J. Ramírez.",
      },
    ],
  },
  MX884219944: {
    estado: "demorado",
    transportista: "Paquetería del Valle",
    ultimaPosicion: "Centro de distribución Iztapalapa, CDMX",
    entregaEstimada: "2026-08-08",
    eventos: [
      {
        fecha: "2026-08-01T18:20:00Z",
        lugar: "Centro de distribución Querétaro",
        detalle: "Paquete en tránsito.",
      },
      {
        fecha: "2026-08-03T07:55:00Z",
        lugar: "Centro de distribución Iztapalapa, CDMX",
        detalle: "Demora por reprogramación de ruta.",
      },
    ],
  },
};

const FORMATO_SEGUIMIENTO = /^MX\d{9}$/;

export const servidorEnvios: ServidorMCP = {
  nombre: "envios",
  version: "1.0.0",
  descripcion: "Seguimiento de envíos con el transportista.",
  herramientas: [
    {
      nombre: "rastrear",
      descripcion:
        "Devuelve la última posición conocida de un envío y su historial de eventos a partir del " +
        "número de seguimiento. Usala cuando el cliente pregunta dónde está su paquete o cuándo le " +
        'llega. Si no tenés el número de seguimiento, buscalo antes con "pedidos__detalle": está en ' +
        "el campo seguimiento del pedido.",
      esquemaEntrada: {
        type: "object",
        properties: {
          seguimiento: {
            type: "string",
            description: "Número de seguimiento del transportista, por ejemplo MX884213907.",
          },
        },
        required: ["seguimiento"],
      },
      async ejecutar(argumentos) {
        const seguimiento = String(argumentos.seguimiento ?? "").trim().toUpperCase();

        // La validación vive en la herramienta, no en el prompt: el modelo no
        // adivina el formato — se lo decimos en el resultado y vuelve a preguntar.
        if (!FORMATO_SEGUIMIENTO.test(seguimiento)) {
          return {
            encontrado: false,
            mensaje:
              `"${seguimiento}" no tiene formato de número de seguimiento (MX + 9 dígitos). ` +
              "Pedíselo de nuevo al cliente.",
          };
        }

        const envio = ENVIOS[seguimiento];
        if (!envio) {
          return {
            encontrado: false,
            mensaje:
              `El transportista no tiene registros para ${seguimiento}. Puede ser que el pedido ` +
              "todavía no se haya despachado. No inventes una posición.",
          };
        }

        return {
          encontrado: true,
          seguimiento,
          ...envio,
          consultadoEn: new Date().toISOString(),
        };
      },
    },
  ],
};
```

Tres cosas para mirar antes de seguir:

- **La `descripcion` es el prompt de tu herramienta.** No describe qué hace la función: describe *cuándo* usarla y qué hacer si falta un dato. Compará con la de `reclamos__crear` en `lambda/agent/mcp/reclamos.ts`, que dice explícitamente "si falta alguno de los dos, preguntáselo antes en vez de inventarlo".
- **El `esquemaEntrada` es JSON Schema y viaja con la herramienta.** Es lo que el modelo lee para saber qué mandarte: con `required: ["seguimiento"]` sabe que ese campo no es opcional. Pero nadie lo valida en runtime — `ejecutarHerramienta` te pasa los argumentos tal cual llegaron —, así que la validación de verdad la hacés vos adentro de `ejecutar`, como acá con el regex.
- **El caso "no encontré nada" es un resultado, no una excepción.** Devolvemos `encontrado: false` con un mensaje dirigido al modelo. El modelo lo lee, se lo explica al cliente y sigue la conversación. Si tirás una excepción, el registro la atrapa igual (mirá el `try/catch` de `ejecutarHerramienta` en `registro.ts`) y le devuelve `{ error: true, mensaje }` al modelo — pero el mensaje te lo escribe el runtime, no vos.

### 2. Registralo

Abrí `lambda/agent/mcp/registro.ts` y agregá el import y el elemento del array. Son las dos únicas líneas que se tocan de código existente en todo el ejercicio — el resto del bloque ya está en el archivo, va acá solo para que veas dónde caen:

```typescript
import type { Tool, ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import { servidorPedidos } from "./pedidos";
import { servidorConocimiento } from "./conocimiento";
import { servidorReclamos } from "./reclamos";
import { servidorEnvios } from "./envios";
import { nombreCalificado } from "./tipos";
import type { ContextoEjecucion, HerramientaMCP, ServidorMCP } from "./tipos";

export const servidores: ServidorMCP[] = [
  servidorPedidos,
  servidorConocimiento,
  servidorReclamos,
  servidorEnvios,
];
```

El registro construye un índice plano con `nombreCalificado(servidor.nombre, herramienta.nombre)`, así que el nombre con el que el modelo va a ver tu herramienta es **`envios__rastrear`**: dos guiones bajos entre el servidor y la herramienta.

### 3. Chequeá los tipos antes de desplegar

Esto importa: la Lambda se empaqueta con esbuild, y **esbuild no verifica tipos** — borra las anotaciones y sigue. Un error de tipado no rompe el deploy, rompe en runtime a las tres de la mañana. Corré el chequeo a mano:

```bash
npm run typecheck
```

```
> craftech-aws-summit-workshop@1.0.0 typecheck
> tsc --noEmit
```

Sin más salida que esas dos líneas: eso es que compiló. Si aparece cualquier `error TS...`, arreglalo antes de seguir.

### 4. Desplegá solo el stack del agente

```bash
npx cdk deploy summit-agente
```

```
✨  Synthesis time: 7.82s

summit-datos
summit-datos: deploying... [1/3]

 ✅  summit-datos (no changes)

summit-auth
summit-auth: deploying... [2/3]

 ✅  summit-auth (no changes)

summit-agente
summit-agente: deploying... [3/3]
summit-agente: creating CloudFormation changeset...

 ✅  summit-agente

✨  Deployment time: 58.31s

Outputs:
summit-agente.ApiUrl = https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com
summit-agente.GuardrailId = abcd1234efgh
summit-agente.ModeloId = us.anthropic.claude-opus-5
```

Los tiempos y los identificadores cambian en tu cuenta. Dos aclaraciones:

- `summit-datos` y `summit-auth` aparecen porque son dependencias del stack del agente y CDK las revisa aunque no cambien. Tardan unos segundos y dicen `(no changes)`. Si querés saltearlas, agregá `-e`: `npx cdk deploy summit-agente -e`.
- Lo único que cambia acá es el bundle de la Lambda. **No se recrea el guardrail, ni la API, ni el autorizador de Cognito.** Tu sesión del navegador sigue viva: no hace falta volver a loguearse ni recargar la página.

### 5. Probalo desde el chat

Volvé a la pestaña del sitio (la URL de `summit-web.UrlSitio`) y escribí:

```
¿dónde está mi paquete MX884213907?
```

La respuesta debería ser algo así — el texto exacto lo redacta el modelo, así que no va a ser palabra por palabra igual:

```
Ese paquete ya fue entregado el 30 de julio en Av. Insurgentes Sur 1602, firmó J. Ramírez.
¿Necesitás algo más de ese envío?
```

Lo importante está abajo, en el panel de traza. En la fila **Herramientas** tenés que leer:

```
envios__rastrear
```

Ahora probá el caso interesante, el que encadena dos servidores:

```
¿dónde está el pedido PED-1078?
```

En la fila **Herramientas** deberías ver las dos, separadas por punto medio:

```
pedidos__detalle · envios__rastrear
```

El agente no tenía el número de seguimiento, lo sacó del pedido y recién ahí llamó a tu herramienta. Nadie le programó esa secuencia: la dedujo de la frase de tu `descripcion` que le dice dónde está el número. Si en tu intento no encadena y te pregunta el número de seguimiento, no está mal — es el momento exacto para ver que la descripción de la herramienta es lo que guía la decisión, y que ajustarla es un cambio de una línea.

Un tercero para ver el borde: preguntá por `PED-1103`. Ese pedido tiene `seguimiento: null` en el seed, así que el agente debería decirte que todavía está en preparación y que no hay envío que rastrear, en vez de inventar una posición.

### 6. Mirá la traza en CloudWatch

Cada llamada a herramienta queda logueada por el loop del agente (`console.log("Herramienta", nombre, ...)` en `lambda/agent/bedrock.ts`):

```bash
aws logs tail /aws/lambda/summit-agente --since 10m --format short
```

```
2026-08-06T20:14:31 START RequestId: 4f2c8f1a-1d3e-4b77-9f0a-6c1b2d3e4f50 Version: $LATEST
2026-08-06T20:14:33 Herramienta envios__rastrear {"seguimiento":"MX884213907"}
2026-08-06T20:14:36 END RequestId: 4f2c8f1a-1d3e-4b77-9f0a-6c1b2d3e4f50
2026-08-06T20:14:36 REPORT RequestId: 4f2c8f1a-1d3e-4b77-9f0a-6c1b2d3e4f50 Duration: 5012.44 ms ...
```

Esa línea es tu auditoría: qué herramienta se llamó y con qué argumentos exactos. En producción es lo que te permite responder "¿por qué el agente dijo eso?" sin adivinar.

### 7. Probalo por el endpoint MCP, con curl

Las mismas herramientas están expuestas por JSON-RPC 2.0 en `POST /mcp` (mirá `manejarMCP` en `lambda/agent/index.ts`). Es el mismo registro, el mismo código de tu herramienta: cero duplicación. Sirve para conectar un cliente MCP externo, o simplemente para probar una herramienta sin pasar por el modelo.

El endpoint está detrás del mismo autorizador de Cognito que el chat, así que necesitás tu `id_token`.

**Sacar el `id_token` de las DevTools.** El front lo guarda en `sessionStorage` después del login (`sessionStorage.setItem("idToken", ...)` en `web/app.js`). `sessionStorage` es **por pestaña**: tiene que ser la misma pestaña donde te logueaste.

1. Andá a la pestaña del sitio, ya logueado, y abrí las DevTools con `F12` (en Mac: `⌥ + ⌘ + I`).
2. En Chrome o Edge, entrá a la solapa **Application**. En Firefox se llama **Almacenamiento** / **Storage**.
3. En el panel de la izquierda, desplegá **Storage → Session storage** y hacé clic en tu origen: `https://d1234abcd.cloudfront.net`.
4. En la tabla de la derecha buscá la fila con clave `idToken`. El valor es un JWT: arranca con `eyJ` y tiene tres bloques separados por puntos. Doble clic sobre el valor para seleccionarlo entero y copiarlo.

Más rápido, si preferís: solapa **Console** y pegá esto, que te lo deja en el portapapeles.

```javascript
copy(sessionStorage.getItem("idToken"))
```

`copy()` es una función que existe solo dentro de las DevTools; devuelve `undefined` y eso está bien, el token ya está copiado.

> Ese token es tu identidad por 8 horas (`idTokenValidity` está en `lib/auth-stack.ts`). No lo pegues en un chat ni lo subas a ningún lado.

Ahora, en la terminal, guardá el token y la URL de la API:

```bash
TOKEN="$(pbpaste)"
```

En Linux usá `TOKEN="$(xclip -o -selection clipboard)"`, o pegalo a mano entre comillas: `TOKEN="eyJraWQiOi..."`.

```bash
API="$(aws cloudformation describe-stacks --stack-name summit-agente --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)"
```

Verificá que quedaron bien las dos variables:

```bash
echo "$API" && echo "${#TOKEN} caracteres de token"
```

```
https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com
1043 caracteres de token
```

El largo exacto varía; lo que importa es que no diga `0 caracteres`. Ahora el handshake de MCP, que te devuelve los servidores registrados:

```bash
curl -s -X POST "$API/mcp" -H "authorization: $TOKEN" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":0,"method":"initialize"}' | jq -c '.result.serverInfo.servidores'
```

```
[{"nombre":"pedidos","version":"1.0.0"},{"nombre":"conocimiento","version":"1.0.0"},{"nombre":"reclamos","version":"1.0.0"},{"nombre":"envios","version":"1.0.0"}]
```

Ahí está tu servidor, cuarto. El catálogo de herramientas:

```bash
curl -s -X POST "$API/mcp" -H "authorization: $TOKEN" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '.result.tools[].name'
```

```
pedidos__listar
pedidos__detalle
conocimiento__buscar
reclamos__crear
reclamos__consultar
envios__rastrear
```

Y la ejecución directa de tu herramienta, sin modelo en el medio:

```bash
curl -s -X POST "$API/mcp" -H "authorization: $TOKEN" -H "content-type: application/json" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"envios__rastrear","arguments":{"seguimiento":"MX884213907"}}}' | jq -r '.result.content[0].text'
```

```json
{
  "encontrado": true,
  "seguimiento": "MX884213907",
  "estado": "entregado",
  "transportista": "Paquetería del Valle",
  "ultimaPosicion": "Av. Insurgentes Sur 1602, Ciudad de México",
  "entregaEstimada": "2026-07-30",
  "eventos": [
    {
      "fecha": "2026-07-28T09:12:00Z",
      "lugar": "Centro de distribución Iztapalapa, CDMX",
      "detalle": "Paquete recibido en el centro de distribución."
    },
    {
      "fecha": "2026-07-29T14:40:00Z",
      "lugar": "Sucursal Benito Juárez, CDMX",
      "detalle": "Salió a reparto."
    },
    {
      "fecha": "2026-07-30T11:05:00Z",
      "lugar": "Av. Insurgentes Sur 1602, CDMX",
      "detalle": "Entregado. Firmó: J. Ramírez."
    }
  ],
  "consultadoEn": "2026-08-06T20:21:07.412Z"
}
```

El `consultadoEn` cambia en cada llamada, es la hora de tu request. Probá también con un número que no existe (`MX999999999`) y con uno mal formado (`hola`): vas a ver los dos mensajes de "no encontrado" que escribiste vos, que son exactamente lo que lee el modelo cuando pasa lo mismo en el chat.

> Si no tenés `jq`, sacá el `| jq ...` del final y agregá `| python3 -m json.tool` para ver el JSON formateado.

## Checkpoint

Con estas dos verificaciones sabés que el paso salió. Primero, que el código está bien tipado:

```bash
npm run typecheck
```

```
> craftech-aws-summit-workshop@1.0.0 typecheck
> tsc --noEmit
```

Y después, que la herramienta está viva en la Lambda desplegada. Chateá una vez preguntando por `MX884213907` y corré:

```bash
aws logs tail /aws/lambda/summit-agente --since 10m --format short | grep envios__rastrear
```

```
2026-08-06T20:14:33 Herramienta envios__rastrear {"seguimiento":"MX884213907"}
```

Si el `grep` no devuelve nada, la herramienta no se ejecutó: revisá la tabla de abajo antes de pasar al paso 6.

## Si algo falla

| Síntoma | Por qué pasa | Cómo se arregla |
|---|---|---|
| `error TS2307: Cannot find module './envios' or its corresponding type declarations.` | El archivo no está donde el import lo busca, o el nombre no coincide (`envios.ts`, no `envíos.ts` ni `Envios.ts`). | `ls lambda/agent/mcp/envios.ts` desde la raíz del workshop. Tiene que estar al lado de `registro.ts`. |
| `error TS2741: Property 'esquemaEntrada' is missing in type '{ nombre: string; descripcion: string; ejecutar(...): ...; }' but required in type 'HerramientaMCP'.` | Le falta un campo del contrato a tu herramienta. Los cuatro obligatorios están en `lambda/agent/mcp/tipos.ts`: `nombre`, `descripcion`, `esquemaEntrada` y `ejecutar`. | Agregá el campo que falta. TypeScript te dice cuál: el contrato del servidor MCP se valida en compilación, no en producción. |
| El deploy corta con `Error: Failed to bundle asset summit-agente/Agente/Code/Stage` y abajo `Build failed with 1 error: lambda/agent/mcp/envios.ts:97:10: ERROR: Expected ")" but found ...` | Error de sintaxis. esbuild no compila y CDK no puede empaquetar la Lambda. | Andá a esa línea y columna exactas del mensaje. Ojo con las comas de más al copiar y con las comillas dentro de la `descripcion`. |
| El deploy termina con ` ✅  summit-agente (no changes)` y la herramienta no aparece en `tools/list`. | Creaste `envios.ts` pero no lo agregaste al array `servidores` de `registro.ts`. Si nadie importa el módulo, esbuild no lo mete en el bundle, el bundle queda idéntico y CloudFormation no ve cambios. | Agregá el import **y** el elemento del array. Las dos cosas: el import solo tampoco alcanza, porque un import sin uso se elimina en el bundle. |
| `{"message":"Unauthorized"}` al hacer curl contra `$API/mcp`. | Falta el header `authorization`, el token está vacío o venció (dura 8 horas). | `echo "${#TOKEN}"` — si da `0`, no copiaste nada. Si da un número grande y sigue fallando, volvé a loguearte en el sitio y copiá el `idToken` de nuevo. |
| El agente responde de memoria y en la traza dice `ninguna (respondió de contexto)`. | La `descripcion` no le dice al modelo cuándo usar la herramienta, o el número que probaste no está en la tabla `ENVIOS` del mock. | Usá `MX884213907` o `MX884219944`, que son los dos del seed. Si igual no la llama, hacé la `descripcion` más explícita sobre el caso de uso y volvé a desplegar. |

## Lo que te llevás

No tocaste el prompt, no tocaste el loop, no tocaste CDK. Una capacidad nueva del agente fue **un archivo y dos líneas**. Ese es el argumento entero de MCP como contrato de integración: el agente no sabe si detrás de la herramienta hay DynamoDB, un índice vectorial, una API de terceros o un `Record` hardcodeado — y no tiene por qué saberlo.

### Ideas para la próxima herramienta

Todas estas se escriben igual: un archivo en `lambda/agent/mcp/`, un import y una línea en el array.

- **`garantia__verificar`** — recibe un `pedidoId`, calcula si está dentro de los 30 días de devolución y devuelve `elegible: true/false` con la fecha límite. Es la más barata y la más útil: las reglas con fechas y plazos son justo lo que un modelo no tiene que estar razonando. Van en código, se testean y no alucinan.
- **`envios__reprogramar`** — cambiar la fecha de entrega. Es una acción con efecto, así que se escribe con el mismo criterio que `reclamos__crear`: la `descripcion` exige confirmación explícita del cliente antes de llamarla. Y el criterio de fondo de todo el diseño: lo que el agente *no puede* hacer no lo decide el prompt, lo decide qué herramientas existen y qué permisos tiene el rol de la Lambda.
- **`catalogo__buscar`** — buscar productos en stock. Acá sí cambia infraestructura, y conviene verlo: tabla nueva en `lib/data-stack.ts`, pasarla por `AgentStackProps` en `lib/agent-stack.ts`, un `props.tablaCatalogo.grantReadData(agente)` y la variable de entorno `TABLA_CATALOGO`. **Toda herramienta que toque un servicio de AWS necesita ese permiso explícito**: el radio de daño de tu agente es el rol de su Lambda, no su prompt.
- **`facturas__descargar`** — devuelve una URL prefirmada de S3, igual que hace `manejarAdjunto` en `lambda/agent/index.ts`. Pensalo dos veces: esa URL entra al contexto del modelo y de ahí puede salir en un mensaje. Los links firmados que genera una herramienta van cortos de expiración y acotados al cliente autenticado.
- **`crm__historial`** — pegarle a una API real (HubSpot, Salesforce, Zendesk) con un token de Secrets Manager. Cambia el cuerpo de `ejecutar` y una línea de `grantRead` en el stack: el agente no se entera.

Y si ya tenés APIs o Lambdas andando y no querés escribir este archivo para cada una, **Bedrock AgentCore Gateway** las expone como herramientas MCP sin reescribirlas. Es la versión gestionada de lo que acabás de hacer a mano — y ahora sabés exactamente qué es lo que te está resolviendo.
