# Paso 3 — Desplegar  ·  15 min

> Al final de este paso vas a tener los cinco stacks creados en tu cuenta, una URL de CloudFront que abre el chat y las cuatro salidas anotadas que vas a necesitar en los pasos que siguen. Todavía sin datos: eso es el paso 4.

## Qué vamos a hacer y por qué

Un solo comando, `npm run deploy`, y CDK hace tres cosas seguidas. Primero **sintetiza**: ejecuta `bin/workshop.ts` con TypeScript y convierte los constructs en cuatro plantillas de CloudFormation que quedan en `cdk.out/`. En el camino empaqueta las cinco Lambdas con esbuild (las cuatro de Cognito y la del agente) y arma los assets del sitio y de los documentos de la base de conocimiento. Después **publica** esos assets en el bucket de bootstrap. Y recién ahí **despliega**: crea o actualiza un stack de CloudFormation por vez.

El orden no lo elegís vos, lo deduce CDK de las referencias que hay en el código. En `bin/workshop.ts` el stack del agente recibe las tablas de `datos` y el User Pool de `auth`, y el stack web recibe la URL de la API de `agente` y los ids de `auth`. Cada una de esas referencias se traduce en un `Export` de CloudFormation en el stack que la produce y un `ImportValue` en el que la consume. Por eso el grafo queda así, y por eso `--all` los despliega en este orden:

```
summit-datos ──┐
               ├──▶ summit-agente ──┐
summit-auth ───┤                    ├──▶ summit-web
               └────────────────────┘
```

Va a tardar entre 8 y 12 minutos, y casi todo ese tiempo es **CloudFront**. Crear una `AWS::CloudFront::Distribution` no es crear un registro en una base: AWS propaga la configuración a toda la red de puntos de presencia y CloudFormation se queda esperando a que el estado de la distribución pase a `Deployed`. Recién cuando termina corre el `Custom::CDKBucketDeployment` que sube `web/` al bucket e invalida la caché. Nada de eso se puede apurar: la única ventaja es que ya sabés que ese es el rato largo y podés usarlo para mirar los eventos en la consola.

Un detalle que conviene tener presente: **todo el stack de datos está declarado con `RemovalPolicy.DESTROY`**. Las cuatro tablas DynamoDB y los dos buckets se borran cuando borrás el stack, y los buckets además llevan `autoDeleteObjects: true` (esos `Custom::S3AutoDeleteObjects` que vas a ver pasar son eso: una Lambda que vacía el bucket antes de borrarlo). Es una decisión de laboratorio, está escrita con todas las letras en `lib/data-stack.ts` línea 25 — `removalPolicy: cdk.RemovalPolicy.DESTROY, // workshop: se borra todo al final`. En producción ahí va `RETAIN`, y si te equivocás en eso no hay `undo`.

## Antes de empezar

Del paso 1 tenés que traer las dependencias instaladas y el entorno bootstrapeado. Verificá las tres cosas:

```bash
node -v
```

```
v22.14.0
```

```bash
aws sts get-caller-identity
```

```json
{
    "UserId": "AIDA...",
    "Account": "123456789012",
    "Arn": "arn:aws:iam::123456789012:user/tu-usuario"
}
```

```bash
npx cdk list
```

```
summit-datos
summit-auth
summit-agente
summit-web
```

Ese último comando es el que más te dice: si imprime los cinco nombres, el TypeScript compila, `npm install` corrió bien y la app sintetiza. Si tira `Cannot find module 'aws-cdk-lib'`, volvé al paso 1 y corré `npm install`.

El acceso a los modelos de Bedrock (Claude Opus 5 y Titan Text Embeddings V2, los que habilitaste en el paso 1) **no** hace falta para el deploy: ningún stack invoca al modelo mientras se crea. Lo va a necesitar el agente recién en el paso 4. Igual, si ya sabés que te falta habilitar alguno, aprovechá los 10 minutos de espera que tenés por delante para resolverlo.

## Los pasos

### 1. Confirmá a qué región va a ir todo

Esto es lo que más rompe workshops. En `bin/workshop.ts` la región sale de acá:

```
region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
```

`CDK_DEFAULT_REGION` la setea la CLI de CDK a partir de tu configuración de AWS. O sea: si tu perfil apunta a `us-east-2`, los cinco stacks se crean en `us-east-2`, no en `us-east-1`.

```bash
aws configure get region
```

```
us-east-1
```

Si te devuelve otra región, o no devuelve nada, forzala para esta terminal:

```bash
export AWS_REGION=us-east-1
```

Usá `us-east-1`. Es donde los guardrails de Bedrock y los perfiles de inferencia `us.anthropic.*` están disponibles sin sorpresas, y es la región que asume el resto de la guía.

### 2. Lanzá el deploy

```bash
npm run deploy
```

Ese script es, textual, `cdk deploy --all --require-approval never` (está en `package.json`). Los dos flags importan:

- `--all` despliega los cinco stacks. Sin él, CDK te frena con `Since this app includes more than a single stack, specify which stacks to use (wildcards are supported) or specify --all`.
- `--require-approval never` evita que se quede esperando un `y/n`. El stack del agente crea políticas de IAM, y sin este flag CDK pide confirmación antes de tocar permisos — perfecto para un pipeline serio, malo para un laboratorio donde te vas a dar vuelta a mirar la pantalla de adelante.

La salida arranca así:

```
✨  Synthesis time: 11.4s

summit-datos: start: Building 133217628b23ec88c02cf8b5bdc6f286b3bfa140a37fad321652f3f2ca511912:current_account-current_region
summit-datos: success: Built 133217628b23ec88c02cf8b5bdc6f286b3bfa140a37fad321652f3f2ca511912:current_account-current_region
summit-datos: start: Publishing 133217628b23ec88c02cf8b5bdc6f286b3bfa140a37fad321652f3f2ca511912:current_account-current_region
summit-datos: success: Published 133217628b23ec88c02cf8b5bdc6f286b3bfa140a37fad321652f3f2ca511912:current_account-current_region
summit-datos: deploying... [1/4]
summit-datos: creating CloudFormation changeset...
summit-datos |  0/18 | 10:41:02 AM | CREATE_IN_PROGRESS   | AWS::CloudFormation::Stack | summit-datos User Initiated
summit-datos |  1/18 | 10:41:09 AM | CREATE_IN_PROGRESS   | AWS::DynamoDB::Table       | Pedidos (Pedidos75CD35AA)
summit-datos |  2/18 | 10:41:11 AM | CREATE_IN_PROGRESS   | AWS::DynamoDB::Table       | Vectores (Vectores6E5F56EF)
…
 ✅  summit-datos

✨  Deployment time: 78.4s

Outputs:
summit-datos.BucketDocumentos = summit-kb-docs-123456789012
summit-datos.TablaPedidos = summit-pedidos
summit-datos.TablaTickets = summit-tickets
summit-datos.ExportsOutputRefPedidos75CD35AA9D52092A = summit-pedidos
…
Stack ARN:
arn:aws:cloudformation:us-east-1:123456789012:stack/summit-datos/8f0e5a10-…
```

El `[1/4]`, `[2/4]`… es el contador de stacks. El `1/18` es el contador de recursos dentro del stack que se está desplegando (18 en datos, 17 en auth, 16 en agente, 13 en web). Las salidas con nombre `ExportsOutput…` son las referencias entre stacks que mencionamos arriba: las genera CDK sola, no las mires.

Si es la primera vez que corrés la CLI, va a imprimir también un bloque `NOTICES` con avisos de la comunidad de CDK. Es ruido, seguí de largo.

**Si querés las salidas en un archivo** en vez de tener que buscarlas en el scroll de la terminal, hay que decidirlo antes de arrancar. Este comando hace lo mismo que el anterior pero además escribe un JSON con todas las salidas de los cinco stacks (el archivo ya está en `.gitignore`):

```bash
npm run deploy -- --outputs-file salida-deploy.json
```

### 3. Mientras espera: mirá el progreso en la consola de CloudFormation

La terminal te muestra los eventos, pero la consola te muestra *por qué* un recurso tarda o falla. Vale la pena entrar aunque no haya problemas.

1. Entrá a la consola de AWS y buscá **CloudFormation** en la barra de búsqueda de arriba.
2. **Mirá el selector de región, arriba a la derecha.** Tiene que decir la misma región del paso 1 (`Este de EE. UU. (Norte de Virginia) us-east-1`). Si no coincide, no vas a ver ningún stack y vas a pensar que el deploy no arrancó.
3. En el menú de la izquierda, hacé clic en **Stacks**. Vas a ver la lista con `summit-datos`, `summit-auth`, `summit-agente` y `summit-web` apareciendo de a uno, en ese orden, con estado `CREATE_IN_PROGRESS` y después `CREATE_COMPLETE`.
4. Hacé clic en el nombre del stack que se esté desplegando ahora (no en el checkbox: en el nombre, que es un link).
5. Se abre la vista del stack con una fila de pestañas: **Stack info · Events · Resources · Outputs · Parameters · Template · Change sets**. Entrá a **Events**.
6. La tabla de eventos está ordenada del más nuevo al más viejo, con las columnas **Timestamp**, **Logical ID**, **Status** y **Status reason**. El botón de refrescar es el círculo con la flecha, arriba a la derecha de la tabla: la vista no se actualiza sola, hay que apretarlo.
7. **La columna que importa es `Status reason`.** Cuando algo falla, ahí está el mensaje real de AWS, completo. Lo que ves en la terminal es un resumen; acá está la frase entera.
8. Cuando estés en `summit-web`, vas a ver un `CREATE_IN_PROGRESS` en el recurso de tipo `AWS::CloudFront::Distribution` que se queda quieto varios minutos. Eso es lo esperado y es el 60 % del tiempo total del laboratorio. Justo después arranca el `Custom::CDKBucketDeployment`, que sube `web/` al bucket e invalida la caché.
9. Cuando el stack termina, pasá a la pestaña **Outputs**: es la misma información que imprimió la terminal, pero en tabla y sin scroll.

### 4. Anotá las cuatro salidas

Cuando terminen los cinco stacks, la terminal cierra con `✅ summit-web` y su bloque de `Outputs`. Estas son las que vas a usar:

| Salida | Sale del stack | Para qué la vas a necesitar |
|---|---|---|
| `UrlSitio` | `summit-web` | Es la URL del chat. La abrís en el paso 4. |
| `ApiUrl` | `summit-agente` | El endpoint de la API. La usás para el `curl` a `/mcp` del paso 5. |
| `UserPoolId` | `summit-auth` | Para sacar tu `clienteId` (el `sub` de Cognito) antes del seed del paso 4. |
| `UserPoolClientId` | `summit-auth` | La usa el front; te sirve para depurar el login si algo no anda. |

Los stacks publican algunas más que aparecen en los pasos siguientes: `TablaPedidos`, `TablaTickets` y `BucketDocumentos` en `summit-datos`, y `GuardrailId` y `ModeloId` en `summit-agente`.

Si ya perdiste el scroll de la terminal, las sacás de CloudFormation en cualquier momento:

```bash
aws cloudformation describe-stacks --stack-name summit-web --query "Stacks[0].Outputs[?OutputKey=='UrlSitio'].OutputValue" --output text
```

```
https://d1a2b3c4d5e6f7.cloudfront.net
```

```bash
aws cloudformation describe-stacks --stack-name summit-agente --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text
```

```
https://k3j9x2mq10.execute-api.us-east-1.amazonaws.com
```

```bash
aws cloudformation describe-stacks --stack-name summit-auth --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'||OutputKey=='UserPoolClientId'].[OutputKey,OutputValue]" --output table
```

```
------------------------------------------------------------
|                      DescribeStacks                       |
+--------------------+--------------------------------------+
|  UserPoolClientId  |  7h9k2m4n6p8q0r2s4t6u8v0w1x           |
|  UserPoolId        |  us-east-1_Ab12Cd34E                  |
+--------------------+--------------------------------------+
```

> **Dónde quedó la configuración del front.** No hay que copiar la `ApiUrl` a mano en ningún lado. El stack web genera un `config.js` con la API, el User Pool, el client y la región, y lo sube al bucket junto al sitio (`s3deploy.Source.data("config.js", …)` en `lib/web-stack.ts`). El HTML lo lee de `window.CONFIG`. Por eso el front no tiene build step: la infraestructura le inyecta su propia configuración. Ese archivo vive en S3, no en tu disco.

## Después del deploy: dos comandos más

El deploy deja la infraestructura; faltan dos inicializaciones que son parte
del contenido del lab:

```bash
# 1. La integración S3 Tables ↔ Glue/Lake Formation (una sola vez por cuenta)
#    y los permisos de lectura del agente sobre el lakehouse:
npm run lakehouse:permisos

# 2. La ingesta de la Knowledge Base: Bedrock lee los manuales del bucket,
#    los trocea, los embebe con Titan y los indexa en S3 Vectors:
npm run kb:ingesta
```

> **El atajo para la próxima vez.** Todo este camino — deploy, permisos,
> ingesta y los seeds del paso 4 — existe encadenado en un solo comando:
> `npm run todo -- <clienteId>` (sin clienteId corre hasta la ingesta y te
> dice cómo completar). La primera vez conviene el paso a paso, que es donde
> se entiende qué hace cada pieza; el atajo es para cuando quieras levantar
> el lab de nuevo en tu cuenta, después del Summit.

De las salidas del deploy, además de la URL del sitio vas a usar: **`UrlChat`**
(la Function URL por la que entra el chat, sin el techo de 30 segundos de API
Gateway), **`KnowledgeBaseId`** (para mirar la KB en la consola de Bedrock) y
las del stack `summit-lakehouse` (catálogo, base y tablas que consulta Athena).
El seed del lakehouse llega en el paso 4, cuando ya tengas tu usuario creado.

## Checkpoint

Los tres controles, en orden. Si alguno no da, no sigas al paso 4.

**1. Los cinco stacks completos:**

```bash
aws cloudformation describe-stacks --query "Stacks[?starts_with(StackName,'summit-')].[StackName,StackStatus]" --output table
```

```
-------------------------------------------
|             DescribeStacks              |
+-----------------+-----------------------+
|  summit-datos   |  CREATE_COMPLETE      |
|  summit-auth    |  CREATE_COMPLETE      |
|  summit-agente  |  CREATE_COMPLETE      |
|  summit-web     |  CREATE_COMPLETE      |
+-----------------+-----------------------+
```

Los cuatro tienen que decir `CREATE_COMPLETE` (o `UPDATE_COMPLETE` si es tu segundo deploy). Cualquier `ROLLBACK` es un deploy fallido: andá a la tabla de abajo.

**2. El sitio responde:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$(aws cloudformation describe-stacks --stack-name summit-web --query "Stacks[0].Outputs[?OutputKey=='UrlSitio'].OutputValue" --output text)"
```

```
200
```

**3. La API está protegida.** Este es el control lindo: pegarle a `/chat` sin token tiene que dar `401`, porque el autorizador JWT de Cognito está delante de la ruta.

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$(aws cloudformation describe-stacks --stack-name summit-agente --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)/chat"
```

```
401
```

Si te da `200` o `500`, algo quedó mal en el autorizador. Si te da `401`, el agente está desplegado y protegido: podés abrir la `UrlSitio` en el navegador. Va a cargar la pantalla de login. **Todavía no te loguees, eso es el paso 4.**

## Si algo falla

| Síntoma | Por qué pasa | Cómo se arregla |
|---|---|---|
| `You must either specify a list of Stacks or the --all argument` al correr `npm run deploy --profile X` | npm se queda con el `--profile` y le pasa el nombre del perfil a CDK como si fuera un stack. | Usá `AWS_PROFILE=mi-perfil npm run deploy`, o pasá los flags después del separador: `npm run deploy -- --profile mi-perfil`. |
| `SSM parameter /cdk-bootstrap/.../version not found. Has the environment been bootstrapped?` | La cuenta (o la región) a la que apunta tu perfil no tiene el bootstrap de CDK del [paso 1](paso-1-setup.md), o lo corriste con otro perfil. | `AWS_PROFILE=mi-perfil npx cdk bootstrap` y repetí el deploy con el mismo perfil. |
| `SSM parameter /cdk-bootstrap/hnb659fds/version not found. Has the environment been bootstrapped? Please run 'cdk bootstrap'` | La cuenta y región no tienen el stack `CDKToolkit`, o lo bootstrapeaste en otra región distinta a la que estás desplegando ahora. | `npx cdk bootstrap` con la misma región del paso 1, y volvé a correr `npm run deploy`. |
| `Falta el build del front. Corré primero: cd ../webapp && npm install && npm run build` | La interfaz es una app React compartida (carpeta `webapp/` en la raíz del repo) y CDK publica su build compilado, que todavía no existe. | Exactamente lo que dice el error: `cd ../webapp && npm install && npm run build`, y de vuelta `npm run deploy`. |
| `ExpiredToken: The security token included in the request is expired` o `The security token included in the request is invalid` | Se vencieron las credenciales a mitad del deploy (típico con SSO y sesiones cortas). | Renová la sesión (`aws sso login`, o exportá de nuevo las claves) y corré `npm run deploy` otra vez. Retoma stack por stack: los que ya están `CREATE_COMPLETE` los saltea con `(no changes)`. |
| `Resource handler returned message: "Resource of type 'AWS::S3::Bucket' with identifier 'summit-adjuntos-123456789012' already exists."` | Los buckets tienen nombre fijo (`${prefijo}-adjuntos-${account}`) y los nombres de S3 son globales. Ya desplegaste en otra región, o quedó un bucket de un intento anterior. | Destruí el despliegue viejo (`npx cdk destroy --all` apuntando a esa región) o desplegá con otro prefijo: `npm run deploy -- -c prefijo=summit2`. Ojo que eso también cambia los nombres de los stacks. |
| `Resource handler returned message: … Guardrail` al crear `summit-agente` | La región no tiene guardrails de Bedrock disponibles. El guardrail se crea como recurso de CloudFormation en `lib/agent-stack.ts`, así que si no existe en la región, el stack no puede terminar. | Desplegá en `us-east-1`: `export AWS_REGION=us-east-1` y `npm run deploy`. |
| `Stack summit-agente is in ROLLBACK_COMPLETE state and can not be updated.` | Un stack que falló en su **primera** creación queda inservible: CloudFormation no puede actualizarlo, hay que borrarlo y crearlo de nuevo. | La CLI de CDK normalmente lo detecta, avisa que lo va a borrar y lo recrea sola. Si no lo hace: `npx cdk destroy summit-agente` y después `npm run deploy`. |

Dos cosas más sobre reintentar, que valen para cualquiera de estos casos:

- **`npm run deploy` es idempotente y se puede correr todas las veces que quieras.** Si el deploy se cortó en el tercer stack, volver a correrlo no recrea los dos primeros: CloudFormation compara el changeset y los stacks sin cambios se saltean con `(no changes)`. No pierdas tiempo destruyendo todo para empezar de cero.
- **Podés desplegar un stack solo**, que es lo que vas a hacer en el paso 5: `npx cdk deploy summit-agente`. CDK incluye por default las dependencias del stack que le pediste (`summit-datos` y `summit-auth`), así que no hay riesgo de dejar una referencia colgada.

Y cuando termines todo el laboratorio, el reverso de este paso es un solo comando, que funciona justamente porque todo está declarado con `RemovalPolicy.DESTROY`:

```bash
npm run destroy
```
