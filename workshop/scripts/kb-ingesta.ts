// Ingesta de la Knowledge Base: le pide a Bedrock que lea los manuales del
// bucket, los trocee, los embeba con Titan y los indexe en S3 Vectors.
//
//   npm run kb:ingesta
//
// Correrlo cada vez que cambien los documentos de data/kb/. Es idempotente:
// Bedrock detecta qué archivos cambiaron y reprocesa solo esos.
import {
  BedrockAgentClient,
  StartIngestionJobCommand,
  GetIngestionJobCommand,
} from "@aws-sdk/client-bedrock-agent";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

const PREFIJO = process.env.PREFIJO ?? "summit";
const bedrock = new BedrockAgentClient({});
const cfn = new CloudFormationClient({});

async function salidaStack(stack: string, clave: string): Promise<string> {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  const valor = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === clave)?.OutputValue;
  if (!valor) throw new Error(`No encontré la salida ${clave} en ${stack}`);
  return valor;
}

async function main() {
  const stack = `${PREFIJO}-datos`;
  const knowledgeBaseId = await salidaStack(stack, "KnowledgeBaseId");
  const dataSourceId = await salidaStack(stack, "DataSourceId");

  console.log(`Knowledge Base ${knowledgeBaseId} · data source ${dataSourceId}`);
  const inicio = await bedrock.send(
    new StartIngestionJobCommand({ knowledgeBaseId, dataSourceId }),
  );
  const jobId = inicio.ingestionJob!.ingestionJobId!;
  console.log(`Ingesta ${jobId} lanzada, esperando…`);

  for (;;) {
    await new Promise((r) => setTimeout(r, 4000));
    const estado = await bedrock.send(
      new GetIngestionJobCommand({ knowledgeBaseId, dataSourceId, ingestionJobId: jobId }),
    );
    const job = estado.ingestionJob!;
    const s = job.status;
    if (s === "COMPLETE") {
      const stats = job.statistics;
      console.log(
        `Listo. Documentos: ${stats?.numberOfDocumentsScanned ?? "?"} escaneados, ` +
          `${stats?.numberOfNewDocumentsIndexed ?? 0} nuevos, ` +
          `${stats?.numberOfModifiedDocumentsIndexed ?? 0} modificados, ` +
          `${stats?.numberOfDocumentsFailed ?? 0} fallidos.`,
      );
      return;
    }
    if (s === "FAILED") {
      console.error("La ingesta falló:", job.failureReasons?.join(" · "));
      process.exit(1);
    }
    console.log(`  estado: ${s}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
