// La versión «full Bedrock» del agente: el mismo dominio del workshop, pero
// con el loop, el catálogo de herramientas y la memoria como SERVICIOS.
//
//   Harness   → el loop del agente, gestionado (lo que la Lambda del
//               workshop principal hace a mano en bedrock.ts)
//   Gateway   → el catálogo MCP de herramientas, gestionado (lo que hace
//               mcp/registro.ts), con las tools como targets Lambda
//   Memory    → la conversación por actor y sesión (igual que en el
//               workshop principal, que ya la usa)
//
// Este stack REUTILIZA los datos del workshop principal: mismas tablas
// DynamoDB, misma Knowledge Base (vía SSM), mismo lakehouse. Desplegalo
// después de aquel, en la misma cuenta y región.
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";
import { PROMPT_BASE } from "./prompt";
import { servidores } from "../../workshop/lambda/agent/mcp/registro";

export interface FullBedrockStackProps extends cdk.StackProps {
  prefijo: string;
}

/** El toolSchema del Gateway acepta un subconjunto de JSON Schema; acá se
 *  poda cualquier clave extra (enum, default…) plegándola a la descripción
 *  para no perder la señal que le llega al modelo. */
function podarSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;
  const limpio: any = { type: schema.type ?? "string" };
  let descripcion = schema.description ?? "";
  if (Array.isArray(schema.enum)) {
    descripcion = `${descripcion}${descripcion ? " " : ""}(valores: ${schema.enum.join(" | ")})`;
  }
  if (descripcion) limpio.description = descripcion;
  if (schema.properties) {
    limpio.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, podarSchema(v)]),
    );
  }
  if (Array.isArray(schema.required) && schema.required.length) limpio.required = schema.required;
  if (schema.items) limpio.items = podarSchema(schema.items);
  return limpio;
}

export class FullBedrockStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: FullBedrockStackProps) {
    super(scope, id, props);

    const prefijo = props.prefijo;
    const modeloId = this.node.tryGetContext("modeloId") ?? "us.anthropic.claude-opus-5";

    // ── La Lambda de herramientas ──────────────────────────────────────
    // Una sola función para los cuatro servidores: el Gateway le dice qué
    // herramienta ejecutar por el client context. El código de negocio es
    // EL MISMO del workshop principal (se importa, no se copia).
    const herramientas = new nodejs.NodejsFunction(this, "Herramientas", {
      functionName: `${prefijo}-full-herramientas`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambda", "tools", "index.ts"),
      timeout: cdk.Duration.minutes(2),
      memorySize: 512,
      bundling: { minify: false, sourceMap: true, format: nodejs.OutputFormat.ESM },
      environment: {
        // Los mismos nombres deterministas que crea el workshop principal.
        TABLA_PEDIDOS: `${prefijo}-pedidos`,
        TABLA_TICKETS: `${prefijo}-tickets`,
        TABLA_VECTORES: `${prefijo}-kb-vectores`,
        BUCKET_DOCS: `${prefijo}-kb-docs-${this.account}`,
        KB_MODE: "managed",
        KB_PARAMETRO: `/${prefijo}/kb/id`,
        MODELO_EMBEDDINGS: "amazon.titan-embed-text-v2:0",
        LAKEHOUSE_CATALOGO: `s3tablescatalog/${prefijo}-lakehouse`,
        LAKEHOUSE_DB: "craftech_store",
        TABLA_VENTAS_GOLD: "ventas_gold",
        TABLA_VENTAS_DETALLE: "ventas_detalle",
        ATHENA_WORKGROUP: `${prefijo}-lakehouse`,
      },
    });

    // Permisos: el espejo de los que el workshop principal le da a su agente,
    // acotados a lo que las herramientas realmente tocan.
    herramientas.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:Scan"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/${prefijo}-pedidos`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/${prefijo}-pedidos/index/*`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/${prefijo}-tickets`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/${prefijo}-kb-vectores`,
        ],
      }),
    );
    herramientas.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:ListBucket"],
        resources: [
          `arn:aws:s3:::${prefijo}-kb-docs-${this.account}`,
          `arn:aws:s3:::${prefijo}-kb-docs-${this.account}/*`,
        ],
      }),
    );
    herramientas.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:Retrieve", "bedrock:InvokeModel"],
        resources: [
          `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`,
          `arn:aws:bedrock:${this.region}::foundation-model/*`,
        ],
      }),
    );
    herramientas.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/${prefijo}/kb/id`],
      }),
    );
    herramientas.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "athena:StartQueryExecution",
          "athena:GetQueryExecution",
          "athena:GetQueryResults",
          "athena:StopQueryExecution",
          "athena:GetWorkGroup",
        ],
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/${prefijo}-lakehouse`],
      }),
    );
    herramientas.addToRolePolicy(
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
    herramientas.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["lakeformation:GetDataAccess"], resources: ["*"] }),
    );
    // El bucket de resultados de Athena lo nombra CloudFormation en el stack
    // del lakehouse; el prefijo es determinista aunque el sufijo no.
    herramientas.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:GetBucketLocation", "s3:ListBucket", "s3:AbortMultipartUpload"],
        resources: [
          `arn:aws:s3:::${prefijo}-lakehouse-resultadosathena*`,
          `arn:aws:s3:::${prefijo}-lakehouse-resultadosathena*/*`,
        ],
      }),
    );

    // ── Gateway: el catálogo MCP gestionado ────────────────────────────
    const rolGateway = new iam.Role(this, "RolGateway", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "Con qué permisos el Gateway invoca las herramientas Lambda.",
    });
    herramientas.grantInvoke(rolGateway);

    const gateway = new agentcore.CfnGateway(this, "Gateway", {
      name: `${prefijo}-full-tienda`,
      description: "Las herramientas del agente de la tienda, expuestas como servidor MCP.",
      authorizerType: "AWS_IAM",
      protocolType: "MCP",
      roleArn: rolGateway.roleArn,
    });

    // Un target por servidor MCP del workshop: el Gateway consolida los
    // cuatro en un único tools/list. El esquema se genera DESDE EL CÓDIGO
    // (mismo origen que el catálogo del workshop principal): si mañana
    // agregás una herramienta al registro, el próximo deploy la publica.
    for (const servidor of servidores) {
      const definiciones = servidor.herramientas
        .filter((h) => !h.fuentes || h.fuentes.includes("gold"))
        .map((h) => {
          const schema = podarSchema(h.esquemaEntrada ?? { type: "object" });
          schema.type = "object";
          schema.properties = {
            ...(schema.properties ?? {}),
            clienteId: {
              type: "string",
              description: "El clienteId de la sesión actual, tal como figura en el prompt del sistema.",
            },
          };
          schema.required = [...new Set([...(schema.required ?? []), "clienteId"])];
          return {
            name: h.nombre,
            description: h.descripcion,
            inputSchema: schema,
          };
        });

      new agentcore.CfnGatewayTarget(this, `Target${servidor.nombre}`, {
        gatewayIdentifier: gateway.attrGatewayIdentifier,
        name: servidor.nombre,
        description: servidor.descripcion,
        // Para targets Lambda, quien firma la invocación es el rol del Gateway.
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
        targetConfiguration: {
          mcp: {
            lambda: {
              lambdaArn: herramientas.functionArn,
              toolSchema: { inlinePayload: definiciones },
            },
          },
        },
      });
    }

    // ── Memory: la conversación, por actor y sesión ────────────────────
    const memoria = new agentcore.CfnMemory(this, "Memoria", {
      name: `${prefijo.replace(/[^a-zA-Z0-9_]/g, "_")}_full_conversaciones`,
      description: "Memoria de corto plazo del agente gestionado.",
      eventExpiryDuration: 7,
    });

    // ── Harness: el loop del agente como recurso ───────────────────────
    const rolHarness = new iam.Role(this, "RolHarness", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "Con qué permisos el Harness llama al modelo, al Gateway y a la memoria.",
    });
    rolHarness.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          `arn:aws:bedrock:${this.region}::foundation-model/*`,
          `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
          `arn:aws:bedrock:*::foundation-model/*`,
        ],
      }),
    );
    rolHarness.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeGateway", "bedrock-agentcore:GetGateway", "bedrock-agentcore:ListTools", "bedrock-agentcore:CallTool"],
        resources: [gateway.attrGatewayArn, `${gateway.attrGatewayArn}/*`],
      }),
    );
    rolHarness.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:CreateEvent",
          "bedrock-agentcore:ListEvents",
          "bedrock-agentcore:ListSessions",
          "bedrock-agentcore:GetEvent",
        ],
        resources: [memoria.attrMemoryArn, `${memoria.attrMemoryArn}/*`],
      }),
    );

    const harness = new agentcore.CfnHarness(this, "Harness", {
      harnessName: `${prefijo.replace(/[^a-zA-Z0-9_]/g, "_")}_full_agente`,
      executionRoleArn: rolHarness.roleArn,
      model: { bedrockModelConfig: { modelId: modeloId, maxTokens: 1500 } },
      systemPrompt: [{ text: PROMPT_BASE }],
      tools: [
        {
          type: "agentcore_gateway",
          name: "tienda",
          config: { agentCoreGateway: { gatewayArn: gateway.attrGatewayArn, outboundAuth: { awsIam: {} } } },
        },
      ],
      memory: { agentCoreMemoryConfiguration: { arn: memoria.attrMemoryArn } },
      maxIterations: 12,
      timeoutSeconds: 300,
    });

    // ── La cara web de la demo ─────────────────────────────────────────
    // Una sola Lambda con Function URL: sirve la página y hace de puente al
    // Harness. El login reutiliza el user pool del workshop principal, y el
    // clienteId sale del id_token verificado acá — no del navegador.
    const harnessArn = `arn:aws:bedrock-agentcore:${this.region}:${this.account}:harness/${harness.attrHarnessId}`;
    const web = new nodejs.NodejsFunction(this, "Web", {
      functionName: `${prefijo}-full-web`,
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, "..", "lambda", "web", "index.ts"),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      bundling: { minify: false, sourceMap: true, format: nodejs.OutputFormat.ESM },
      environment: { PREFIJO: prefijo, HARNESS_ARN: harnessArn },
    });
    web.addToRolePolicy(
      new iam.PolicyStatement({
        // El data plane autoriza la invocación del Harness con la acción
        // InvokeAgentRuntime (lo dice el propio AccessDenied del servicio).
        actions: ["bedrock-agentcore:InvokeAgentRuntime", "bedrock-agentcore:InvokeHarness"],
        resources: [harnessArn, `${harnessArn}/*`],
      }),
    );
    web.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:DescribeStacks"],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${prefijo}-auth/*`,
          `arn:aws:cloudformation:${this.region}:${this.account}:stack/${prefijo}-agente/*`,
        ],
      }),
    );
    web.addToRolePolicy(
      new iam.PolicyStatement({
        // El guardrail lo crea el workshop principal y su id se resuelve en
        // runtime: el comodín evita acoplar los deploys. En esta cuenta no
        // hay otros guardrails que proteger.
        actions: ["bedrock:ApplyGuardrail"],
        resources: [`arn:aws:bedrock:${this.region}:${this.account}:guardrail/*`],
      }),
    );
    const urlDemo = web.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: ["*"],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: ["content-type", "authorization"],
      },
    });

    // ── El sitio: la webapp React compartida, en modo harness ──────────
    // La MISMA app que sirve el workshop principal (webapp/), con otra
    // config: idénticas por construcción, no por parecido.
    const bucketSitio = new s3.Bucket(this, "SitioWeb", {
      bucketName: `${prefijo}-full-web-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribucion = new cloudfront.Distribution(this, "Distribucion", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucketSitio),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      comment: `${prefijo}-full — el mismo agente, gestionado`,
    });

    const dist = path.join(__dirname, "..", "..", "webapp", "dist");
    if (!fs.existsSync(path.join(dist, "index.html"))) {
      throw new Error(
        "Falta el build del front. Corré primero:  cd ../webapp && npm install && npm run build",
      );
    }
    const config = {
      modo: "harness",
      region: this.region,
      chatUrl: urlDemo.url,
      configUrl: `${urlDemo.url}config`,
    };
    new s3deploy.BucketDeployment(this, "DesplegarWeb", {
      sources: [
        s3deploy.Source.asset(dist),
        s3deploy.Source.data("config.js", `window.CONFIG = ${JSON.stringify(config, null, 2)};`),
      ],
      destinationBucket: bucketSitio,
      distribution: distribucion,
      distributionPaths: ["/*"],
      prune: true,
    });

    new cdk.CfnOutput(this, "UrlDemo", { value: `https://${distribucion.distributionDomainName}` });
    new cdk.CfnOutput(this, "UrlPuente", { value: urlDemo.url });
    new cdk.CfnOutput(this, "HarnessId", { value: harness.attrHarnessId });
    new cdk.CfnOutput(this, "GatewayUrl", { value: gateway.attrGatewayUrl });
    new cdk.CfnOutput(this, "MemoriaId", { value: memoria.attrMemoryId });
    // Lo usa scripts/permisos.sh para el grant de Lake Formation.
    new cdk.CfnOutput(this, "RolHerramientas", { value: herramientas.role!.roleArn });
  }
}
