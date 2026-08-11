// Lakehouse mínimo sobre S3 Tables, para el experimento gold vs detalle.
//
// Dos tablas Iceberg en el mismo namespace:
//   ventas_gold     — agregada por tenant, mes y categoría. Sin datos
//                     personales: es la capa que un agente debería consumir.
//   ventas_detalle  — el grano crudo, con PII inventada y con TODOS los
//                     tenants mezclados. Existe para mostrar en vivo qué
//                     pasa cuando el agente lee la capa equivocada.
//
// El agente consulta por Athena; el workgroup y su bucket de resultados
// también viven acá.
import * as cdk from "aws-cdk-lib";
import * as s3tables from "aws-cdk-lib/aws-s3tables";
import * as athena from "aws-cdk-lib/aws-athena";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface LakehouseStackProps extends cdk.StackProps {
  prefijo: string;
}

export class LakehouseStack extends cdk.Stack {
  /** Catálogo federado de Glue que expone el table bucket. */
  public readonly catalogo: string;
  public readonly baseDatos = "craftech_store";
  public readonly tablaGold = "ventas_gold";
  public readonly tablaDetalle = "ventas_detalle";
  public readonly workgroupNombre: string;
  public readonly bucketResultados: s3.Bucket;
  public readonly tableBucketArn: string;

  constructor(scope: Construct, id: string, props: LakehouseStackProps) {
    super(scope, id, props);

    const nombreBucket = `${props.prefijo}-lakehouse`;

    const tableBucket = new s3tables.CfnTableBucket(this, "TableBucket", {
      tableBucketName: nombreBucket,
    });
    this.tableBucketArn = tableBucket.attrTableBucketArn;

    const namespace = new s3tables.CfnNamespace(this, "Namespace", {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: this.baseDatos,
    });

    // La capa gold: solo agregados, solo columnas que un agente puede ver.
    const gold = new s3tables.CfnTable(this, "VentasGold", {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: this.baseDatos,
      tableName: this.tablaGold,
      openTableFormat: "ICEBERG",
      icebergMetadata: {
        icebergSchema: {
          schemaFieldList: [
            { name: "tenant_id", type: "string", required: true },
            { name: "mes", type: "string", required: true }, // YYYY-MM
            { name: "categoria", type: "string", required: true },
            { name: "pedidos", type: "int" },
            { name: "unidades", type: "int" },
            { name: "monto_total", type: "double" },
            { name: "ticket_promedio", type: "double" },
          ],
        },
      },
    });
    gold.addDependency(namespace);

    // La capa de detalle: el grano crudo con datos personales (inventados)
    // y todos los tenants juntos. En una plataforma real esto es bronze o
    // silver sin enmascarar: justo lo que un agente NO debería leer.
    const detalle = new s3tables.CfnTable(this, "VentasDetalle", {
      tableBucketArn: tableBucket.attrTableBucketArn,
      namespace: this.baseDatos,
      tableName: this.tablaDetalle,
      openTableFormat: "ICEBERG",
      icebergMetadata: {
        icebergSchema: {
          schemaFieldList: [
            { name: "pedido_id", type: "string", required: true },
            { name: "tenant_id", type: "string", required: true },
            { name: "fecha", type: "string", required: true }, // YYYY-MM-DD
            { name: "cliente_nombre", type: "string" },
            { name: "cliente_email", type: "string" },
            { name: "cliente_telefono", type: "string" },
            { name: "cliente_documento", type: "string" },
            { name: "direccion_entrega", type: "string" },
            { name: "producto", type: "string" },
            { name: "categoria", type: "string" },
            { name: "cantidad", type: "int" },
            { name: "precio_unitario", type: "double" },
            { name: "monto", type: "double" },
            { name: "tarjeta_ultimos4", type: "string" },
            { name: "estado", type: "string" },
          ],
        },
      },
    });
    detalle.addDependency(namespace);

    // ── Athena ─────────────────────────────────────────────────────────
    this.bucketResultados = new s3.Bucket(this, "ResultadosAthena", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });

    this.workgroupNombre = `${props.prefijo}-lakehouse`;
    new athena.CfnWorkGroup(this, "Workgroup", {
      name: this.workgroupNombre,
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        publishCloudWatchMetricsEnabled: false,
        resultConfiguration: {
          outputLocation: `s3://${this.bucketResultados.bucketName}/athena/`,
        },
      },
    });

    // El catálogo federado que crea la integración S3 Tables ↔ Glue.
    this.catalogo = `s3tablescatalog/${nombreBucket}`;

    new cdk.CfnOutput(this, "TableBucketArn", { value: tableBucket.attrTableBucketArn });
    new cdk.CfnOutput(this, "Catalogo", { value: this.catalogo });
    new cdk.CfnOutput(this, "BaseDatos", { value: this.baseDatos });
    new cdk.CfnOutput(this, "Tablas", { value: `${this.tablaGold}, ${this.tablaDetalle}` });
    new cdk.CfnOutput(this, "WorkgroupSalida", { value: this.workgroupNombre });
    new cdk.CfnOutput(this, "ResultadosAthenaBucket", { value: this.bucketResultados.bucketName });
  }
}
