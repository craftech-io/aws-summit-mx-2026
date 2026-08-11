# Paso 1 — Setup · 10 min

> Al terminar este paso vas a tener el repo clonado y compilando, tu cuenta de AWS con acceso real a Claude Opus 5 y a Titan Text Embeddings V2 en `us-east-1`, y CDK bootstrapeado. Nada desplegado todavía: solo la plataforma de lanzamiento.

## Qué vamos a hacer y por qué

Este laboratorio despliega cinco stacks de CloudFormation en **tu** cuenta con AWS CDK. Antes de escribir `npm run deploy` hay tres cosas que tienen que estar en su lugar, y las tres fallan de maneras distintas y confusas si te las salteás: las herramientas locales (Node y AWS CLI), el permiso para invocar los modelos de Bedrock, y el bootstrap de CDK.

**El acceso a los modelos es lo que más gente traba.** En Bedrock, que un modelo exista en una región no significa que puedas invocarlo: cada cuenta tiene que habilitarlo explícitamente, una vez, por región, desde la consola. No hay comando de CLI para hacerlo. Si te lo salteás, el deploy sale perfecto y recién cuando le escribís al agente te aparece un `AccessDeniedException` desde adentro de una Lambda, que es el peor lugar para descubrirlo. Por eso lo hacemos ahora y lo verificamos invocando de verdad, no mirando una lista.

**El bootstrap de CDK** es el otro paso invisible. CDK no le manda a CloudFormation un template autocontenido: sube *assets* primero. En este repo son el bundle de las Lambdas que arma esbuild (`lambda/agent/`, `lambda/auth/`), los cuatro documentos de `data/kb/` y el sitio estático de `web/`. Todo eso necesita un lugar donde vivir y una identidad con permisos para desplegarlo. El bootstrap crea exactamente eso: un stack llamado `CDKToolkit` con un bucket S3 para assets, un repositorio ECR (que este lab no usa), cinco roles IAM y un parámetro en SSM con la versión del bootstrap. Es **una sola vez por cuenta + región**, no por proyecto: si ya usaste CDK en esta cuenta y en esta región, ya está hecho y el comando no hace nada.

**La región del laboratorio es `us-east-1`, y no es un capricho.** Tres razones concretas, todas en el código: `cdk.json` fija `modeloId: us.anthropic.claude-opus-5`, que es un *inference profile* de la geografía de EE.UU. y solo se invoca desde regiones de EE.UU.; `lib/agent-stack.ts` crea un `bedrock.CfnGuardrail`, y los guardrails de Bedrock no están disponibles en todas las regiones; y `bin/workshop.ts` resuelve la región con `process.env.CDK_DEFAULT_REGION ?? "us-east-1"`, mientras que `scripts/seed.ts` usa `process.env.AWS_REGION ?? "us-east-1"`. Traducido: si tu CLI apunta a otra región, los stacks se van a esa otra región pero el seed sigue cargando datos en `us-east-1`, y vas a tener un agente sin pedidos y sin base de conocimiento sin ningún error a la vista. Fijá la región ahora.

## Antes de empezar

Es el primer paso, así que no depende de nada del laboratorio. Lo que sí necesitás en la máquina y en la cuenta:

| Requisito | Por qué |
|---|---|
| **Node 20 o superior** | Las Lambdas corren en `NODEJS_22_X` y el CDK app se ejecuta con `ts-node` |
| **npm** | Viene con Node |
| **AWS CLI v2** | Para las verificaciones y para que CDK resuelva credenciales |
| **git** | Para clonar |
| **Una cuenta de AWS con permisos de administrador** | El bootstrap crea roles IAM; con permisos recortados falla |
| **Un número de celular** | Es el usuario con el que vas a entrar en el paso 4. El código se muestra en pantalla (`MODO_DEMO=true`), así que recibir el SMS es opcional. Ahora no hace falta |

Verificá las cuatro herramientas de una:

```bash
node -v && npm -v && aws --version && git --version
```

```
v22.14.0
11.6.2
aws-cli/2.26.1 Python/3.13.2 Darwin/25.5.0 exe/x86_64
git version 2.45.2
```

Los números exactos no importan mientras Node sea `v20.x` o mayor y la AWS CLI sea `aws-cli/2.x`. Si `node -v` te da `v18.x` o menos, actualizá antes de seguir.

## Los pasos

### 1. Confirmá con qué identidad de AWS estás trabajando

Antes que nada, saber en qué cuenta vas a desplegar. Este comando no crea nada: pregunta quién sos.

```bash
aws sts get-caller-identity
```

```json
{
    "UserId": "AROAXXXXXXXXXXXXXXXXX:vos@tuempresa.com",
    "Account": "123456789012",
    "Arn": "arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_AdministratorAccess_.../vos@tuempresa.com"
}
```

Lo que importa es que devuelva JSON y que el `Account` sea la cuenta donde querés desplegar. Anotá ese número: lo vas a ver de nuevo en el bootstrap y en los nombres de los buckets (`lib/data-stack.ts` los nombra `summit-adjuntos-<cuenta>`).

Si usás perfiles con nombre, exportá el perfil una vez y olvidate — todos los comandos que siguen lo van a tomar:

```bash
export AWS_PROFILE=mi-perfil
```

### 2. Fijá la región en `us-east-1`

CDK toma la región de la misma cadena de resolución que la CLI. Dejarla explícita evita el problema de los stacks en una región y el seed en otra.

```bash
aws configure set region us-east-1
```

Y confirmá de dónde la está sacando:

```bash
aws configure list
```

```
      Name                    Value             Type    Location
      ----                    -----             ----    --------
   profile                <not set>             None    None
access_key     ****************KAA5              sso    
secret_key     ****************c1TN              sso    
    region                us-east-1      config-file    ~/.aws/config
```

La fila `region` tiene que decir `us-east-1`. Si preferís no tocar tu configuración global de AWS, exportá las variables solo para esta sesión de terminal:

```bash
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
```

Ojo con esto: si abrís otra terminal para correr el seed del paso 4, tenés que volver a exportarlas ahí.

### 3. Habilitá los modelos en la consola de Bedrock

Esto es 100% consola: no hay API pública para habilitar acceso a modelos. Andá despacio, son ocho clics.

1. Abrí la consola de AWS y entrá a **Amazon Bedrock** (buscá "Bedrock" en la barra de búsqueda de arriba), o andá directo a `https://console.aws.amazon.com/bedrock/`.
2. **Mirá el selector de región, arriba a la derecha.** Tiene que decir **N. Virginia** (`us-east-1`). Si dice otra cosa, cambialo *antes* de seguir: el acceso a modelos se habilita por región y habilitarlo en la región equivocada no sirve de nada.
3. En el menú de la izquierda, bajá hasta abajo de todo. Debajo del grupo **Bedrock configurations** (en algunas cuentas el grupo se llama **Configure and learn**), hacé clic en **Model access**.
4. Arriba a la derecha de la tabla, botón **Modify model access**. Si nunca habilitaste nada en esta cuenta, el botón dice **Enable specific models**.
5. Te muestra la lista de modelos agrupada por proveedor. Tildá dos casillas:
   - **Anthropic → Claude Opus 5**
   - **Amazon → Titan Text Embeddings V2**
   > Los modelos de Amazon suelen venir ya habilitados en cuentas que usaron Bedrock antes. Si Titan ya dice **Access granted**, dejalo como está.
6. Botón **Next**, abajo a la derecha.
7. **Si es la primera vez que pedís un modelo de Anthropic en esta cuenta**, la consola te pide completar **Submit use case details**: nombre de la empresa, sitio web, industria, quiénes lo van a usar y para qué. No es un trámite: se aprueba en el momento. Poné algo real y corto, tipo *"Evaluación interna de un agente de atención al cliente"*.
8. Botón **Submit**. Volvés a la tabla de **Model access**. La columna **Access status** de esos dos modelos pasa a **Access granted** en segundos. Si te queda en **In progress**, refrescá la página.

### 4. Verificá desde la terminal que existen los modelos

Primero, que la región tenga los modelos de Anthropic:

```bash
aws bedrock list-foundation-models --region us-east-1 --query "modelSummaries[?providerName=='Anthropic'].modelId" --output table
```

```
-------------------------------------------------
|             ListFoundationModels              |
+-----------------------------------------------+
|  anthropic.claude-sonnet-4-20250514-v1:0      |
|  anthropic.claude-haiku-4-5-20251001-v1:0     |
|  anthropic.claude-fable-5                     |
|  anthropic.claude-sonnet-4-6                  |
|  anthropic.claude-opus-4-6-v1                 |
|  anthropic.claude-opus-5                      |
|  anthropic.claude-opus-4-8                    |
|  anthropic.claude-opus-4-7                    |
|  anthropic.claude-sonnet-4-5-20250929-v1:0    |
|  anthropic.claude-sonnet-5                    |
|  anthropic.claude-opus-4-1-20250805-v1:0      |
|  anthropic.claude-opus-4-5-20251101-v1:0      |
|  anthropic.claude-3-haiku-20240307-v1:0:48k   |
|  anthropic.claude-3-haiku-20240307-v1:0:200k  |
|  anthropic.claude-3-haiku-20240307-v1:0       |
+-----------------------------------------------+
```

**Este comando lista lo que existe en la región, no lo que tenés habilitado.** Aparece igual aunque no hayas hecho el paso 3. Sirve para descartar que estés en una región sin Claude, nada más.

Segundo: el `modeloId` que usa el lab no es un modelo base, es un *inference profile* de la geografía US (mirá el prefijo `us.` en `cdk.json`). Confirmá que existe:

```bash
aws bedrock list-inference-profiles --region us-east-1 --query "inferenceProfileSummaries[?contains(inferenceProfileId,'opus-5')].[inferenceProfileId,status]" --output table
```

```
----------------------------------------------
|            ListInferenceProfiles           |
+----------------------------------+---------+
|  us.anthropic.claude-opus-5      |  ACTIVE |
|  global.anthropic.claude-opus-5  |  ACTIVE |
+----------------------------------+---------+
```

El que usa el laboratorio es `us.anthropic.claude-opus-5`, en estado `ACTIVE`.

### 5. Probá que el acceso funciona de verdad

Acá es donde se descubre si el paso 3 salió bien. Invocamos los dos modelos con la CLI, exactamente igual que lo va a hacer la Lambda: Converse para Claude, InvokeModel para Titan.

```bash
aws bedrock-runtime converse --region us-east-1 --model-id us.anthropic.claude-opus-5 --messages '[{"role":"user","content":[{"text":"Respondé solo con la palabra: listo"}]}]' --inference-config '{"maxTokens":50}'
```

```json
{
    "output": {
        "message": {
            "role": "assistant",
            "content": [
                {
                    "text": "listo"
                }
            ]
        }
    },
    "stopReason": "end_turn",
    "usage": {
        "inputTokens": 20,
        "outputTokens": 4,
        "totalTokens": 24,
        "cacheReadInputTokens": 0
    },
    "metrics": {
        "latencyMs": 1262
    }
}
```

Esa es la misma API que usa `lambda/agent/bedrock.ts` (`ConverseCommand`). Si esto responde, el agente va a poder hablar. Costó menos de un centavo.

Ahora el modelo de embeddings, con los mismos parámetros que usa `scripts/seed.ts` (512 dimensiones, normalizado):

```bash
aws bedrock-runtime invoke-model --region us-east-1 --model-id amazon.titan-embed-text-v2:0 --content-type application/json --accept application/json --cli-binary-format raw-in-base64-out --body '{"inputText":"prueba","dimensions":512,"normalize":true}' embedding.json
```

```json
{
    "contentType": "application/json"
}
```

`invoke-model` escribe la respuesta en el archivo que le pasás como último argumento y solo imprime el `contentType` en pantalla. Mirá que el vector tenga 512 números:

```bash
python3 -c "import json;print(len(json.load(open('embedding.json'))['embedding']))"
```

```
512
```

Si te dio 512, borrá el archivo y seguí: `rm embedding.json`.

### 6. Cloná el repo e instalá las dependencias

```bash
git clone https://github.com/craftech-io/aws-summit-mx-2026.git
```

```
Cloning into 'aws-summit-mx-2026'...
remote: Enumerating objects: 312, done.
Receiving objects: 100% (312/312), 1.84 MiB | 6.21 MiB/s, done.
Resolving deltas: 100% (98/98), done.
```

(Los conteos de objetos y la velocidad cambian; lo que tiene que aparecer es `Resolving deltas` y ningún error.)

Todo el laboratorio vive en el subdirectorio `workshop/`. **Todos los comandos del resto de la guía se corren desde ahí.**

```bash
cd aws-summit-mx-2026/workshop
```

```bash
npm install
```

```
added 71 packages, and audited 92 packages in 9s

1 package is looking for funding
  run `npm fund` for details

2 vulnerabilities (1 moderate, 1 high)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
```

Son 71 paquetes: `aws-cdk-lib`, los clientes del SDK v3 que usan las Lambdas y el seed, `esbuild` (que arma los bundles de las Lambdas durante el deploy), `ts-node` y `typescript`. El CDK CLI viene como dependencia de desarrollo (`aws-cdk`), así que **no hace falta instalar nada global**: cada `npx cdk ...` usa el binario local del proyecto.

**No corras `npm audit fix`.** Los dos avisos son de dependencias de build (`brace-expansion` adentro de `aws-cdk-lib`, y el dev-server de `esbuild`, que este proyecto no levanta): nada de eso llega a la Lambda, y `--force` te cambia la versión de `esbuild` y te rompe el bundling en el deploy.

Confirmá que el proyecto compila antes de seguir:

```bash
npm run typecheck
```

```
> craftech-aws-summit-workshop@1.0.0 typecheck
> tsc --noEmit
```

Sin más salida que esas dos líneas: `tsc` no imprime nada cuando no hay errores.

### 7. Bootstrapeá CDK

```bash
npx cdk bootstrap
```

```
 ⏳  Bootstrapping environment aws://123456789012/us-east-1...
Trusted accounts for deployment: (none)
Trusted accounts for lookup: (none)
Using default execution policy of 'arn:aws:iam::aws:policy/AdministratorAccess'. Pass '--cloudformation-execution-policies' to customize.
CDKToolkit: creating CloudFormation changeset...
 ✅  Environment aws://123456789012/us-east-1 bootstrapped.
```

Tarda entre 1 y 2 minutos. **Leé la línea del `aws://`**: te dice la cuenta y la región donde quedó bootstrapeado. Si ahí dice una región que no es `us-east-1`, volvé al paso 2 — tu CLI está apuntando a otro lado y el deploy también se va a ir ahí.

Si la cuenta ya estaba bootstrapeada, el comando termina en segundos y dice `✅ Environment aws://…/us-east-1 bootstrapped` igual. Es idempotente: correrlo de más no rompe nada.

## Checkpoint

Dos comandos. Si los dos dan lo que se espera, estás listo para el paso 2.

**Uno: el bootstrap existe.**

```bash
aws cloudformation describe-stacks --stack-name CDKToolkit --region us-east-1 --query "Stacks[0].StackStatus" --output text
```

```
CREATE_COMPLETE
```

(Si ya estaba bootstrapeado de antes, puede decir `UPDATE_COMPLETE`. Cualquiera de los dos sirve.)

**Dos: el CDK app sintetiza y ve los cinco stacks.**

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

Esos son los cinco stacks de `bin/workshop.ts`, en orden de dependencia. Que este comando funcione significa que Node ejecutó el app, TypeScript compiló, CDK resolvió tus credenciales y tu región, y la definición de infraestructura es válida. Es la verificación más completa que podés hacer sin desplegar.

Si `cdk list` te lista los cuatro nombres y `describe-stacks` te dio `CREATE_COMPLETE`, el setup terminó. **Si alguno de los dos falla, no sigas al paso 2**: el deploy va a fallar más tarde y con un error menos claro.

## Si algo falla

| Síntoma | Por qué pasa | Cómo se arregla |
|---|---|---|
| `Unable to locate credentials. You can configure credentials by running "aws configure".` | La CLI no encuentra credenciales: nunca configuraste el perfil, o exportaste un `AWS_PROFILE` que no existe | `aws configure` (o `aws configure sso`). Si usás perfiles con nombre, revisá que el valor de `AWS_PROFILE` coincida con una sección de `~/.aws/config` |
| `An error occurred (ExpiredToken) when calling the GetCallerIdentity operation: The security token included in the request is invalid` | Las credenciales temporales vencieron. Pasa siempre con SSO después de unas horas | `aws sso login` (o `aws sso login --profile mi-perfil`). Volvé a correr `aws sts get-caller-identity` para confirmar |
| `An error occurred (AccessDeniedException) when calling the Converse operation: You don't have access to the model with the specified model ID.` | Falta el paso 3, o lo hiciste en otra región. El acceso a modelos es por cuenta **y** por región | Volvé a **Bedrock → Model access** con el selector de región en **N. Virginia (us-east-1)** y confirmá que Claude Opus 5 diga **Access granted** |
| `An error occurred (ValidationException) when calling the Converse operation: Invocation of model ID anthropic.claude-opus-5 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.` | Usaste el ID del modelo base en vez del inference profile. Opus 5 solo se invoca on-demand a través de un perfil de inferencia | Usá `us.anthropic.claude-opus-5`, con el prefijo `us.`. Es exactamente el valor de `modeloId` en `cdk.json`; no lo cambies |
| `An error occurred (ValidationError) when calling the DescribeStacks operation: Stack with id CDKToolkit does not exist` — y, si intentás desplegar, `❌ Deployment failed: Error: summit-datos: SSM parameter /cdk-bootstrap/hnb659fds/version not found. Has the environment been bootstrapped? Please run 'cdk bootstrap'` | Falta el bootstrap en esa cuenta + región, o lo corriste apuntando a otra región | `npx cdk bootstrap` desde `workshop/`, y verificá en la salida que la línea `aws://<cuenta>/<región>` diga `us-east-1` |
