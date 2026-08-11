// Capa de datos: todo serverless y bajo demanda, sin capacidad provisionada.
import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as s3vectors from "aws-cdk-lib/aws-s3vectors";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import * as path from "path";

export interface DataStackProps extends cdk.StackProps {
  prefijo: string;
}

export class DataStack extends cdk.Stack {
  public readonly tablaPedidos: dynamodb.Table;
  public readonly tablaConversaciones: dynamodb.Table;
  public readonly tablaTickets: dynamodb.Table;
  public readonly tablaVectores: dynamodb.Table;
  public readonly bucketAdjuntos: s3.Bucket;
  public readonly bucketDocumentos: s3.Bucket;
  /** Bedrock Knowledge Base sobre S3 Vectors: manuales y procedimientos. */
  public readonly knowledgeBaseId: string;
  public readonly knowledgeBaseArn: string;
  public readonly dataSourceId: string;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    const comun = {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // workshop: se borra todo al final
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    };

    // Pedidos del cliente. Se consulta desde el servidor MCP de pedidos.
    this.tablaPedidos = new dynamodb.Table(this, "Pedidos", {
      tableName: `${props.prefijo}-pedidos`,
      partitionKey: { name: "clienteId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "pedidoId", type: dynamodb.AttributeType.STRING },
      ...comun,
    });

    // Historial de conversación. TTL para no acumular datos del laboratorio.
    this.tablaConversaciones = new dynamodb.Table(this, "Conversaciones", {
      tableName: `${props.prefijo}-conversaciones`,
      partitionKey: { name: "sesionId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "turno", type: dynamodb.AttributeType.NUMBER },
      timeToLiveAttribute: "expiraEn",
      ...comun,
    });

    // Reclamos generados por el agente (mock de Jira).
    this.tablaTickets = new dynamodb.Table(this, "Tickets", {
      tableName: `${props.prefijo}-tickets`,
      partitionKey: { name: "ticketId", type: dynamodb.AttributeType.STRING },
      ...comun,
    });
    this.tablaTickets.addGlobalSecondaryIndex({
      indexName: "porCliente",
      partitionKey: { name: "clienteId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "creadoEn", type: dynamodb.AttributeType.STRING },
    });

    // Vectores de la base de conocimiento (modo local, sin costo fijo).
    // Ver README: en producción esto es una Bedrock Knowledge Base.
    this.tablaVectores = new dynamodb.Table(this, "Vectores", {
      tableName: `${props.prefijo}-kb-vectores`,
      partitionKey: { name: "documentoId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "fragmentoId", type: dynamodb.AttributeType.STRING },
      ...comun,
    });

    // Adjuntos: las fotos que manda el cliente en el chat.
    this.bucketAdjuntos = new s3.Bucket(this, "Adjuntos", {
      bucketName: `${props.prefijo}-adjuntos-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET],
          allowedOrigins: ["*"],
          allowedHeaders: ["*"],
          maxAge: 3000,
        },
      ],
    });

    // Documentos fuente de la base de conocimiento: los manuales y
    // procedimientos de la empresa, versionados con el repo.
    this.bucketDocumentos = new s3.Bucket(this, "Documentos", {
      bucketName: `${props.prefijo}-kb-docs-${this.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new s3deploy.BucketDeployment(this, "CargaDocumentos", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "..", "data", "kb"))],
      destinationBucket: this.bucketDocumentos,
    });

    // ── Bedrock Knowledge Base sobre S3 Vectors ────────────────────────
    // El vector store más barato que existe: paga por lo almacenado y lo
    // consultado, sin mínimo mensual. Con esto la base de conocimiento es
    // el servicio gestionado de verdad, no una imitación.
    const vectorBucket = new s3vectors.CfnVectorBucket(this, "VectoresKB", {
      vectorBucketName: `${props.prefijo}-kb-vectores-${this.account}`,
    });

    // Titan Embeddings V2 devuelve 1024 dimensiones; el índice tiene que
    // coincidir o la ingesta falla.
    const indice = new s3vectors.CfnIndex(this, "IndiceKB", {
      vectorBucketName: vectorBucket.vectorBucketName!,
      indexName: "manuales-v2",
      dataType: "float32",
      dimension: 1024,
      distanceMetric: "cosine",
      // Bedrock guarda el texto del fragmento y su metadata propia en el
      // vector. S3 Vectors limita la metadata FILTRABLE a 2 KB: estos dos
      // campos tienen que quedar fuera de ese límite o la ingesta falla.
      // S3 Vectors limita la metadata FILTRABLE a 2 KB por vector: el texto
      // del fragmento y la metadata propia de Bedrock tienen que quedar fuera
      // de ese límite o la ingesta falla con «Filterable metadata must have
      // at most 2048 bytes».
      metadataConfiguration: {
        nonFilterableMetadataKeys: ["AMAZON_BEDROCK_TEXT", "AMAZON_BEDROCK_METADATA"],
      },
    });
    indice.addDependency(vectorBucket);

    const modeloEmbeddings = `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`;

    const rolKB = new iam.Role(this, "RolKnowledgeBase", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    });
    this.bucketDocumentos.grantRead(rolKB);
    rolKB.addToPolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [modeloEmbeddings],
      }),
    );
    rolKB.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "s3vectors:GetIndex",
          "s3vectors:PutVectors",
          "s3vectors:GetVectors",
          "s3vectors:QueryVectors",
          "s3vectors:DeleteVectors",
          "s3vectors:ListVectors",
        ],
        resources: [indice.attrIndexArn],
      }),
    );

    const kb = new bedrock.CfnKnowledgeBase(this, "KnowledgeBase", {
      name: `${props.prefijo}-manuales-v2`,
      description: "Manuales y procedimientos de la tienda: devoluciones, envíos, garantías y pagos.",
      roleArn: rolKB.roleArn,
      knowledgeBaseConfiguration: {
        type: "VECTOR",
        vectorKnowledgeBaseConfiguration: { embeddingModelArn: modeloEmbeddings },
      },
      storageConfiguration: {
        type: "S3_VECTORS",
        s3VectorsConfiguration: {
          vectorBucketArn: vectorBucket.attrVectorBucketArn,
          indexArn: indice.attrIndexArn,
        },
      },
    });
    kb.addDependency(indice);
    kb.node.addDependency(rolKB);

    const origenDocs = new bedrock.CfnDataSource(this, "OrigenDocumentos", {
      knowledgeBaseId: kb.attrKnowledgeBaseId,
      name: "manuales-y-procedimientos",
      dataSourceConfiguration: {
        type: "S3",
        s3Configuration: { bucketArn: this.bucketDocumentos.bucketArn },
      },
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: "FIXED_SIZE",
          fixedSizeChunkingConfiguration: { maxTokens: 300, overlapPercentage: 20 },
        },
      },
    });

    this.knowledgeBaseId = kb.attrKnowledgeBaseId;
    this.knowledgeBaseArn = kb.attrKnowledgeBaseArn;
    this.dataSourceId = origenDocs.attrDataSourceId;

    // El agente lee el id de la KB desde este parámetro EN RUNTIME. Así los
    // stacks quedan desacoplados: reemplazar la KB no pelea con los exports
    // de CloudFormation (un export en uso no se puede modificar).
    new ssm.StringParameter(this, "ParametroKB", {
      parameterName: `/${props.prefijo}/kb/id`,
      stringValue: kb.attrKnowledgeBaseId,
    });

    // Exports pineados: el agente ya no los importa, pero mientras la versión
    // desplegada los use, tienen que seguir existiendo para poder actualizar.
    this.exportValue(kb.attrKnowledgeBaseArn);
    this.exportValue(kb.attrKnowledgeBaseId);

    new cdk.CfnOutput(this, "TablaPedidos", { value: this.tablaPedidos.tableName });
    new cdk.CfnOutput(this, "TablaTickets", { value: this.tablaTickets.tableName });
    new cdk.CfnOutput(this, "BucketDocumentos", { value: this.bucketDocumentos.bucketName });
    new cdk.CfnOutput(this, "KnowledgeBaseId", { value: this.knowledgeBaseId });
    new cdk.CfnOutput(this, "DataSourceId", { value: this.dataSourceId });
  }
}
