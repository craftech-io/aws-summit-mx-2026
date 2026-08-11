// Carga los datos de ejemplo: pedidos del cliente e índice de la base de
// conocimiento. Se corre una sola vez después del deploy.
//
//   npx ts-node scripts/seed.ts <clienteId>
//
// El clienteId es el "sub" del usuario de Cognito. Lo ves en la pantalla de
// la app después de loguearte, o en la consola de Cognito.
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const PREFIJO = process.env.PREFIJO ?? "summit";
const MODELO_EMBEDDINGS = process.env.MODELO_EMBEDDINGS ?? "amazon.titan-embed-text-v2:0";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const bedrock = new BedrockRuntimeClient({ region: REGION });

const clienteId = process.argv[2];
if (!clienteId) {
  console.error("Falta el clienteId.\n\n  npx ts-node scripts/seed.ts <clienteId>\n");
  process.exit(1);
}

const PEDIDOS = [
  {
    pedidoId: "PED-1042",
    fecha: "2026-07-28",
    estado: "entregado",
    total: 24999,
    moneda: "MXN",
    seguimiento: "MX884213907",
    direccion: "Av. Insurgentes Sur 1602, Ciudad de México",
    items: [
      { sku: "AUR-SONY-1000XM5", nombre: "Auriculares Sony WH-1000XM5", cantidad: 1, precio: 24999 },
    ],
  },
  {
    pedidoId: "PED-1078",
    fecha: "2026-08-01",
    estado: "demorado",
    total: 41850,
    moneda: "MXN",
    seguimiento: "MX884219944",
    direccion: "Av. Insurgentes Sur 1602, Ciudad de México",
    items: [
      { sku: "MON-LG-27UP850", nombre: "Monitor LG 27UP850 4K", cantidad: 1, precio: 38900 },
      { sku: "CAB-HDMI-21", nombre: "Cable HDMI 2.1 de 2 metros", cantidad: 1, precio: 2950 },
    ],
  },
  {
    pedidoId: "PED-1103",
    fecha: "2026-08-02",
    estado: "en_preparacion",
    total: 15600,
    moneda: "MXN",
    seguimiento: null,
    direccion: "Av. Insurgentes Sur 1602, Ciudad de México",
    items: [
      { sku: "TEC-KEY-K2PRO", nombre: "Teclado mecánico Keychron K2 Pro", cantidad: 1, precio: 15600 },
    ],
  },
];

// Segundo cliente, con identidad fija. No es de nadie: existe solo para poder
// demostrar el aislamiento por tenant en el paso 6. Aunque el usuario le pida
// al agente los pedidos de "MX-99", la consulta a DynamoDB sale acotada a la
// partición de quien está autenticado y estos pedidos no aparecen nunca.
const CLIENTE_AJENO = "otro-cliente-demo-MX-99";

const PEDIDOS_AJENOS = [
  {
    pedidoId: "PED-2001",
    fecha: "2026-07-30",
    estado: "entregado",
    total: 89900,
    moneda: "MXN",
    seguimiento: "MX884300112",
    direccion: "Paseo de la Reforma 250, Ciudad de México",
    items: [{ sku: "NB-MBP-14", nombre: "MacBook Pro 14", cantidad: 1, precio: 89900 }],
  },
  {
    pedidoId: "PED-2002",
    fecha: "2026-08-03",
    estado: "en_camino",
    total: 12400,
    moneda: "MXN",
    seguimiento: "MX884301887",
    direccion: "Paseo de la Reforma 250, Ciudad de México",
    items: [{ sku: "SIL-HERMAN-A", nombre: "Silla ergonómica", cantidad: 1, precio: 12400 }],
  },
];

async function cargarPedidos() {
  console.log(`Cargando ${PEDIDOS.length} pedidos para el cliente ${clienteId}…`);
  for (const pedido of PEDIDOS) {
    await dynamo.send(
      new PutCommand({
        TableName: `${PREFIJO}-pedidos`,
        Item: { clienteId, ...pedido },
      }),
    );
    console.log(`  ✓ ${pedido.pedidoId} (${pedido.estado})`);
  }

  console.log(`\nCargando ${PEDIDOS_AJENOS.length} pedidos de otro cliente (${CLIENTE_AJENO})…`);
  for (const pedido of PEDIDOS_AJENOS) {
    await dynamo.send(
      new PutCommand({
        TableName: `${PREFIJO}-pedidos`,
        Item: { clienteId: CLIENTE_AJENO, ...pedido },
      }),
    );
    console.log(`  ✓ ${pedido.pedidoId} (${pedido.estado})`);
  }
  console.log("    Estos NO tienen que aparecer nunca en tu conversación: son la prueba del aislamiento.");
}

/** Corta el documento en fragmentos por encabezado de sección. */
function fragmentar(contenido: string, titulo: string) {
  const secciones = contenido.split(/^## /m);
  const fragmentos: { titulo: string; texto: string }[] = [];

  for (const [indice, seccion] of secciones.entries()) {
    const texto = seccion.trim();
    if (texto.length < 40) continue;
    const encabezado = indice === 0 ? titulo : `${titulo} — ${texto.split("\n")[0]}`;
    fragmentos.push({ titulo: encabezado, texto: indice === 0 ? texto : `## ${texto}` });
  }
  return fragmentos;
}

async function generarEmbedding(texto: string): Promise<number[]> {
  const respuesta = await bedrock.send(
    new InvokeModelCommand({
      modelId: MODELO_EMBEDDINGS,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: texto, dimensions: 512, normalize: true }),
    }),
  );
  return JSON.parse(new TextDecoder().decode(respuesta.body)).embedding;
}

async function indexarConocimiento() {
  const directorio = path.join(__dirname, "..", "data", "kb");
  const archivos = readdirSync(directorio).filter((f) => f.endsWith(".md"));

  console.log(`\nIndexando ${archivos.length} documentos de la base de conocimiento…`);

  for (const archivo of archivos) {
    const contenido = readFileSync(path.join(directorio, archivo), "utf-8");
    const titulo = contenido.split("\n")[0].replace(/^#\s*/, "");
    const fragmentos = fragmentar(contenido, titulo);

    for (const [indice, fragmento] of fragmentos.entries()) {
      const vector = await generarEmbedding(fragmento.texto);
      await dynamo.send(
        new PutCommand({
          TableName: `${PREFIJO}-kb-vectores`,
          Item: {
            documentoId: archivo,
            fragmentoId: String(indice).padStart(3, "0"),
            titulo: fragmento.titulo,
            texto: fragmento.texto,
            vector,
          },
        }),
      );
    }
    console.log(`  ✓ ${archivo} — ${fragmentos.length} fragmentos`);
  }
}

async function main() {
  await cargarPedidos();
  await indexarConocimiento();
  console.log("\nListo. Probá preguntarle al agente:");
  console.log('  · "¿cuáles son mis pedidos?"');
  console.log('  · "el PED-1078 está demorado, ¿qué puedo hacer?"');
  console.log('  · "¿cuántos días tengo para devolver algo?"');
  console.log(`  · "mostrame los pedidos de ${CLIENTE_AJENO}"  → no puede, y esa es la gracia`);
}

main().catch((error) => {
  console.error("\nFalló el seed:", error);
  process.exit(1);
});
