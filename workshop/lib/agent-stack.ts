// El corazón del workshop: guardrail de Bedrock + Lambda orquestadora + API HTTP.
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigw from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwIntegrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as apigwAuthorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import * as path from "path";
import type { LakehouseStack } from "./lakehouse-stack";
import type { DataStack } from "./data-stack";

export interface AgentStackProps extends cdk.StackProps {
  prefijo: string;
  datos: DataStack;
  tablaPedidos: dynamodb.Table;
  tablaConversaciones: dynamodb.Table;
  tablaTickets: dynamodb.Table;
  tablaVectores: dynamodb.Table;
  bucketAdjuntos: s3.Bucket;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  lakehouse: LakehouseStack;
}

export class AgentStack extends cdk.Stack {
  public readonly apiUrl: string;
  public readonly chatUrl: string;

  constructor(scope: Construct, id: string, props: AgentStackProps) {
    super(scope, id, props);

    const modeloId = this.node.tryGetContext("modeloId") ?? "us.anthropic.claude-opus-5";
    const modeloEmbeddings =
      this.node.tryGetContext("modeloEmbeddings") ?? "amazon.titan-embed-text-v2:0";
    // La Knowledge Base ahora se crea por stack: el modo gestionado es el
    // default. El modo local queda para correr el lab sin la KB (-c kbMode=local).
    const kbMode = this.node.tryGetContext("kbMode") ?? "managed";

    // ── Guardrail ──────────────────────────────────────────────────────
    // Se define una vez y aplica a cualquier modelo: la seguridad de IA
    // es una capa aparte, no un párrafo del prompt.
    const guardrail = new bedrock.CfnGuardrail(this, "Guardrail", {
      name: `${props.prefijo}-atencion-cliente`,
      description: "Controles de contenido, temas y datos personales del agente de atención.",
      blockedInputMessaging:
        "No puedo ayudarte con eso. Puedo responder consultas sobre tus pedidos, envíos y reclamos.",
      blockedOutputsMessaging:
        "No puedo responder eso. ¿Te ayudo con tu pedido o con un reclamo?",
      contentPolicyConfig: {
        filtersConfig: [
          { type: "SEXUAL", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "VIOLENCE", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "HATE", inputStrength: "HIGH", outputStrength: "HIGH" },
          { type: "INSULTS", inputStrength: "MEDIUM", outputStrength: "MEDIUM" },
          // MISCONDUCT solo mira la entrada: en HIGH bloqueaba salidas
          // legítimas con confianza LOW — el trace mostró tablas de compras
          // marcadas como «conducta indebida». Lo que el usuario pide sigue
          // filtrado; lo que el agente responde ya pasó por las herramientas
          // y el prompt, y el filtro ahí solo metía falsos positivos.
          { type: "MISCONDUCT", inputStrength: "HIGH", outputStrength: "NONE" },
          // En HIGH este filtro confunde imperativos normales del español
          // («dame el detalle») con intentos de jailbreak y frena consultas
          // legítimas. En MEDIUM sigue atajando los ataques reales.
          { type: "PROMPT_ATTACK", inputStrength: "MEDIUM", outputStrength: "NONE" },
        ],
      },
      // Temas negados: el clásico bot de atención que termina escribiendo código.
      //
      // Solo se evalúan en la ENTRADA. En la salida, el clasificador de temas
      // confundía cada tanto una tabla de montos del lakehouse con «condiciones
      // comerciales» y bloqueaba respuestas legítimas: un recordatorio de que
      // los guardrails también tienen falsos positivos y hay que calibrarlos.
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
            inputEnabled: true,
            outputEnabled: false,
          },
          {
            name: "condiciones-comerciales-inventadas",
            definition:
              "El asistente ofrece, promete o negocia descuentos, reembolsos, bonificaciones o " +
              "condiciones comerciales que no estén en la base de conocimiento. Informar compras " +
              "ya registradas no cuenta.",
            examples: [
              "Dame un 50% de descuento",
              "Prometeme que me devuelven el doble",
            ],
            type: "DENY",
            inputEnabled: true,
            outputEnabled: false,
          },
        ],
      },
      // Datos personales: se enmascaran, no se bloquean, para no romper el flujo.
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          { type: "CREDIT_DEBIT_CARD_NUMBER", action: "BLOCK" },
          { type: "CREDIT_DEBIT_CARD_CVV", action: "BLOCK" },
          { type: "PASSWORD", action: "BLOCK" },
          { type: "EMAIL", action: "ANONYMIZE" },
          { type: "PHONE", action: "ANONYMIZE" },
        ],
      },
    });

    // Cambiar la descripción reemplaza el recurso y congela una versión nueva
    // con la configuración vigente; la Lambda recibe el número por env var.
    const versionGuardrail = new bedrock.CfnGuardrailVersion(this, "GuardrailVersion", {
      guardrailIdentifier: guardrail.attrGuardrailId,
      description: "v5 — misconduct solo en la entrada",
    });

    // ── Memoria de la conversación: AgentCore Memory ───────────────────
    // Capa de corto plazo sola (sin estrategias de extracción): eventos
    // crudos por actor y sesión. Es la opción más económica del servicio y
    // suma AgentCore al inventario de servicios del laboratorio. La
    // expiración corta mantiene el costo de almacenamiento en el piso.
    const memoria = new agentcore.CfnMemory(this, "Memoria", {
      name: `${props.prefijo.replace(/[^a-zA-Z0-9_]/g, "_")}_conversaciones`,
      description: "Memoria de corto plazo del agente de atención (por actor y sesión).",
      eventExpiryDuration: 7,
    });

    // ── Lambda del agente ──────────────────────────────────────────────
    const agente = new nodejs.NodejsFunction(this, "Agente", {
      functionName: `${props.prefijo}-agente`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambda", "agent", "index.ts"),
      // Un agente encadena varias herramientas: no es un request HTTP típico.
      timeout: cdk.Duration.minutes(5),
      memorySize: 1024,
      bundling: { minify: false, sourceMap: true, format: nodejs.OutputFormat.ESM },
      environment: {
        MODELO_ID: modeloId,
        MODELO_EMBEDDINGS: modeloEmbeddings,
        GUARDRAIL_ID: guardrail.attrGuardrailId,
        GUARDRAIL_VERSION: versionGuardrail.attrVersion,
        KB_MODE: kbMode,
        // El id real se lee de SSM en el arranque de la Lambda: reemplazar la
        // KB no obliga a redesplegar el agente.
        KB_PARAMETRO: `/${props.prefijo}/kb/id`,
        BUCKET_DOCS: props.datos.bucketDocumentos.bucketName,
        TABLA_PEDIDOS: props.tablaPedidos.tableName,
        TABLA_CONVERSACIONES: props.tablaConversaciones.tableName,
        TABLA_TICKETS: props.tablaTickets.tableName,
        TABLA_VECTORES: props.tablaVectores.tableName,
        BUCKET_ADJUNTOS: props.bucketAdjuntos.bucketName,
        // Lakehouse (experimento gold vs detalle).
        LAKEHOUSE_CATALOGO: props.lakehouse.catalogo,
        LAKEHOUSE_DB: props.lakehouse.baseDatos,
        TABLA_VENTAS_GOLD: props.lakehouse.tablaGold,
        TABLA_VENTAS_DETALLE: props.lakehouse.tablaDetalle,
        ATHENA_WORKGROUP: props.lakehouse.workgroupNombre,
        // Para verificar el JWT cuando el request entra por la Function URL.
        USER_POOL_ID: props.userPool.userPoolId,
        USER_POOL_CLIENT_ID: props.userPoolClient.userPoolClientId,
        // Con MEMORY_ID presente, el historial vive en AgentCore Memory;
        // sin él, cae al backend DynamoDB que explica el paso 2 del lab.
        MEMORY_ID: memoria.attrMemoryId,
      },
    });

    agente.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents"],
        resources: [memoria.attrMemoryArn, `${memoria.attrMemoryArn}/*`],
      }),
    );

    // El chat entra por una Function URL y no por API Gateway: un agente que
    // encadena herramientas y reintentos supera con facilidad el techo de
    // 30 segundos que API Gateway impone a cada integración. La identidad se
    // verifica igual — el handler valida el id_token de Cognito por su cuenta.
    const urlChat = agente.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ["content-type", "authorization"],
      },
    });
    this.chatUrl = urlChat.url;

    // Permisos mínimos: solo los modelos que usa y solo su guardrail.
    agente.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
          `arn:aws:bedrock:*::foundation-model/*`,
        ],
      }),
    );
    agente.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:ApplyGuardrail"],
        resources: [guardrail.attrGuardrailArn],
      }),
    );
    agente.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:Retrieve"],
        // Comodín a propósito: la KB puede reemplazarse (cambia el id) sin
        // tocar este stack. En esta cuenta no hay otras KBs que proteger.
        resources: [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`],
      }),
    );
    agente.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/${props.prefijo}/kb/id`,
        ],
      }),
    );
    // Para que conocimiento__temas pueda enumerar los manuales.
    props.datos.bucketDocumentos.grantRead(agente);

    props.tablaPedidos.grantReadData(agente);
    props.tablaConversaciones.grantReadWriteData(agente);
    props.tablaTickets.grantReadWriteData(agente);
    props.tablaVectores.grantReadWriteData(agente);
    props.bucketAdjuntos.grantReadWrite(agente);

    // ── Lakehouse: consultas por Athena sobre S3 Tables ────────────────
    agente.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "athena:StartQueryExecution",
          "athena:GetQueryExecution",
          "athena:GetQueryResults",
          "athena:StopQueryExecution",
          "athena:GetWorkGroup",
        ],
        resources: [
          `arn:aws:athena:${this.region}:${this.account}:workgroup/${props.lakehouse.workgroupNombre}`,
        ],
      }),
    );
    // Metadata del catálogo federado (solo lectura) y acceso a datos vía
    // Lake Formation, que es quien de verdad decide qué tabla puede leer.
    agente.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "glue:GetCatalog",
          "glue:GetDatabase",
          "glue:GetDatabases",
          "glue:GetTable",
          "glue:GetTables",
          "glue:GetPartition",
          "glue:GetPartitions",
        ],
        resources: ["*"],
      }),
    );
    agente.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lakeformation:GetDataAccess"],
        resources: ["*"],
      }),
    );
    props.lakehouse.bucketResultados.grantReadWrite(agente);

    // ── API HTTP con autorizador de Cognito ────────────────────────────
    const autorizador = new apigwAuthorizers.HttpJwtAuthorizer(
      "AutorizadorCognito",
      `https://cognito-idp.${this.region}.amazonaws.com/${props.userPool.userPoolId}`,
      { jwtAudience: [props.userPoolClient.userPoolClientId] },
    );

    const api = new apigw.HttpApi(this, "Api", {
      apiName: `${props.prefijo}-api`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.OPTIONS],
        allowHeaders: ["content-type", "authorization"],
      },
    });

    const integracion = new apigwIntegrations.HttpLambdaIntegration("AgenteIntegracion", agente);

    api.addRoutes({
      path: "/chat",
      methods: [apigw.HttpMethod.POST],
      integration: integracion,
      authorizer: autorizador,
    });
    api.addRoutes({
      path: "/adjuntos/url",
      methods: [apigw.HttpMethod.POST],
      integration: integracion,
      authorizer: autorizador,
    });
    // La conversación persistida, para repintarla después de un refresh.
    api.addRoutes({
      path: "/historial",
      methods: [apigw.HttpMethod.POST],
      integration: integracion,
      authorizer: autorizador,
    });
    // Endpoint MCP: expone las mismas herramientas por JSON-RPC para que
    // puedas conectar un cliente MCP externo. Ver README.
    api.addRoutes({
      path: "/mcp",
      methods: [apigw.HttpMethod.POST],
      integration: integracion,
      authorizer: autorizador,
    });

    this.apiUrl = api.apiEndpoint;

    new cdk.CfnOutput(this, "ApiUrl", { value: this.apiUrl });
    new cdk.CfnOutput(this, "UrlChat", { value: this.chatUrl });
    new cdk.CfnOutput(this, "GuardrailId", { value: guardrail.attrGuardrailId });
    // La versión congelada, para que otros consumidores (la variante full
    // Bedrock) apliquen el MISMO guardrail con ApplyGuardrail.
    new cdk.CfnOutput(this, "GuardrailVersionOut", { value: versionGuardrail.attrVersion });
    new cdk.CfnOutput(this, "ModeloId", { value: modeloId });
    // Lo usa scripts/lakehouse-permisos.sh para los grants de Lake Formation.
    new cdk.CfnOutput(this, "RolAgente", { value: agente.role!.roleArn });
  }
}
