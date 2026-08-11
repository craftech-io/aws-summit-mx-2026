// Servidor MCP de base de conocimiento, con dos backends conmutables.
//
//   KB_MODE=managed → Bedrock Knowledge Bases sobre S3 Vectors, el default:
//                     el servicio gestionado real, creado por CDK en el
//                     stack de datos (bedrock-agent-runtime:Retrieve).
//   KB_MODE=local   → recuperación propia: embeddings de Titan + coseno
//                     sobre DynamoDB. Se conserva para ver RAG por dentro
//                     y para correr el lab sin la KB (-c kbMode=local).
//
// Con S3 Vectors como vector store la KB gestionada cuesta centavos y sin
// mínimo mensual — la razón histórica para no usarla (OpenSearch Serverless
// y su costo fijo) ya no corre. El resto del agente no distingue modos: la
// herramienta es la misma, cambia el backend.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
import {
  BedrockAgentRuntimeClient,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { generarEmbedding } from "../embeddings";
import type { ServidorMCP } from "./tipos";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const agentRuntime = new BedrockAgentRuntimeClient({});
const s3 = new S3Client({});

const TABLA_VECTORES = process.env.TABLA_VECTORES!;
const KB_MODE = process.env.KB_MODE ?? "local";
const BUCKET_DOCS = process.env.BUCKET_DOCS ?? "";

// El id de la KB se lee de SSM una sola vez por contenedor: el stack de
// datos puede reemplazar la KB sin que haya que redesplegar el agente.
const KB_PARAMETRO = process.env.KB_PARAMETRO ?? "";
let kbIdCache: string | null = process.env.KNOWLEDGE_BASE_ID || null;
async function knowledgeBaseId(): Promise<string> {
  if (kbIdCache !== null) return kbIdCache;
  if (!KB_PARAMETRO) return (kbIdCache = "");
  const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
  const respuesta = await new SSMClient({}).send(
    new GetParameterCommand({ Name: KB_PARAMETRO }),
  );
  return (kbIdCache = respuesta.Parameter?.Value ?? "");
}

interface Fragmento {
  documentoId: string;
  fragmentoId: string;
  texto: string;
  titulo: string;
  vector: number[];
}

// Cache en memoria: la Lambda tibia no vuelve a leer la tabla.
let cacheFragmentos: Fragmento[] | null = null;

export const servidorConocimiento: ServidorMCP = {
  nombre: "conocimiento",
  version: "1.0.0",
  descripcion: "Base de conocimiento de la empresa: políticas, plazos y procedimientos.",
  herramientas: [
    {
      nombre: "temas",
      descripcion:
        "Lista los documentos que hay en la base de conocimiento, con sus temas. Usala cuando el " +
        "cliente pregunte sobre qué lo podés ayudar, qué información tenés, o qué documentos, " +
        "políticas o procedimientos conocés.",
      esquemaEntrada: { type: "object", properties: {} },
      async ejecutar() {
        // En modo gestionado la fuente de verdad son los manuales del bucket
        // que ingiere la Knowledge Base.
        if (KB_MODE === "managed" && BUCKET_DOCS) {
          const objetos = await s3.send(
            new ListObjectsV2Command({ Bucket: BUCKET_DOCS, MaxKeys: 50 }),
          );
          const documentos = (objetos.Contents ?? [])
            .map((o) => o.Key ?? "")
            .filter((k) => k.endsWith(".md") || k.endsWith(".pdf") || k.endsWith(".txt"))
            .map((archivo) => ({
              archivo,
              tema: archivo
                .replace(/\.(md|pdf|txt)$/, "")
                .replace(/-/g, " ")
                .replace(/^\w/, (c) => c.toUpperCase()),
            }));
          return { documentos, backend: "Bedrock Knowledge Bases" };
        }
        const fragmentos = await cargarFragmentos();
        // Un título por documento: el más corto suele ser el del encabezado.
        const documentos = new Map<string, string>();
        for (const f of fragmentos) {
          const titulo = f.titulo.split("—")[0].trim();
          if (!documentos.has(f.documentoId) || titulo.length < documentos.get(f.documentoId)!.length) {
            documentos.set(f.documentoId, titulo);
          }
        }
        return {
          documentos: [...documentos.entries()].map(([archivo, tema]) => ({ archivo, tema })),
          fragmentosIndexados: fragmentos.length,
        };
      },
    },
    {
      nombre: "buscar",
      descripcion:
        "Busca en la base de conocimiento de la empresa (políticas de devolución, plazos de envío, " +
        "garantías, formas de pago). Usala SIEMPRE que el cliente pregunte por una política o un " +
        "procedimiento: no respondas de memoria, la información oficial está acá.",
      esquemaEntrada: {
        type: "object",
        properties: {
          consulta: {
            type: "string",
            description: "La pregunta del cliente, reformulada para buscar.",
          },
          cantidad: {
            type: "integer",
            description: "Cantidad de fragmentos a recuperar (por defecto 3).",
            minimum: 1,
            maximum: 8,
          },
        },
        required: ["consulta"],
      },
      async ejecutar(argumentos) {
        const consulta = String(argumentos.consulta);
        const cantidad = Math.min(Number(argumentos.cantidad ?? 3), 8);

        const kbId = KB_MODE === "managed" ? await knowledgeBaseId() : "";
        const fragmentos = kbId
          ? await buscarGestionada(kbId, consulta, cantidad)
          : await buscarLocal(consulta, cantidad);

        if (fragmentos.length === 0) {
          return {
            resultados: [],
            mensaje:
              "No hay información sobre eso en la base de conocimiento. Decíselo al cliente en vez de inventar una respuesta.",
          };
        }
        return { resultados: fragmentos };
      },
    },
  ],
};

/** Backend gestionado: Bedrock Knowledge Bases. */
async function buscarGestionada(kbId: string, consulta: string, cantidad: number) {
  const respuesta = await agentRuntime.send(
    new RetrieveCommand({
      knowledgeBaseId: kbId,
      retrievalQuery: { text: consulta },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: cantidad },
      },
    }),
  );
  return (respuesta.retrievalResults ?? []).map((r) => ({
    titulo: r.location?.s3Location?.uri ?? "documento",
    texto: r.content?.text ?? "",
    puntaje: r.score ?? 0,
  }));
}

/** Backend local: embeddings de Titan + similitud coseno. */
async function buscarLocal(consulta: string, cantidad: number) {
  const fragmentos = await cargarFragmentos();
  if (fragmentos.length === 0) return [];

  const vectorConsulta = await generarEmbedding(consulta);

  return fragmentos
    .map((f) => ({
      titulo: f.titulo,
      texto: f.texto,
      puntaje: similitudCoseno(vectorConsulta, f.vector),
    }))
    .sort((a, b) => b.puntaje - a.puntaje)
    // Por debajo de este umbral, lo recuperado no tiene que ver con la pregunta.
    // El filtro va ANTES de recortar: al revés, un fragmento flojo entre los
    // primeros se llevaba un lugar y devolvíamos menos de los pedidos.
    .filter((f) => f.puntaje > 0.35)
    .slice(0, cantidad);
}

async function cargarFragmentos(): Promise<Fragmento[]> {
  if (cacheFragmentos) return cacheFragmentos;

  const items: Fragmento[] = [];
  let clave: Record<string, any> | undefined;
  do {
    const resultado = await dynamo.send(
      new ScanCommand({ TableName: TABLA_VECTORES, ExclusiveStartKey: clave }),
    );
    for (const item of resultado.Items ?? []) {
      items.push({
        documentoId: item.documentoId,
        fragmentoId: item.fragmentoId,
        texto: item.texto,
        titulo: item.titulo,
        // DynamoDB devuelve los números como string en algunos SDK paths.
        vector: (item.vector as unknown[]).map(Number),
      });
    }
    clave = resultado.LastEvaluatedKey;
  } while (clave);

  cacheFragmentos = items;
  return items;
}

function similitudCoseno(a: number[], b: number[]): number {
  let producto = 0;
  let normaA = 0;
  let normaB = 0;
  for (let i = 0; i < a.length; i++) {
    producto += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }
  const denominador = Math.sqrt(normaA) * Math.sqrt(normaB);
  return denominador === 0 ? 0 : producto / denominador;
}
