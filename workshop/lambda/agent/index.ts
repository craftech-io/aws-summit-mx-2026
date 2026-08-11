// Handler único de la API. Tres rutas:
//   POST /chat          → conversar con el agente
//   POST /adjuntos/url  → URL prefirmada para subir una foto
//   POST /mcp           → endpoint MCP (JSON-RPC) para clientes externos
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import type { ContentBlock, Message } from "@aws-sdk/client-bedrock-runtime";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { conversar } from "./bedrock";
import { cargarHistorial, guardarIntercambio } from "./historial";
import { listarHerramientasMCP, ejecutarHerramienta, servidores } from "./mcp/registro";

const s3 = new S3Client({});
const BUCKET_ADJUNTOS = process.env.BUCKET_ADJUNTOS!;

// Por API Gateway el token lo valida el autorizador JWT. Por la Function URL
// (la ruta del chat, que no tiene el techo de 30 segundos de API Gateway) lo
// validamos acá, contra el mismo user pool. La identidad sale SIEMPRE de un
// token verificado, entre por donde entre.
const verificadorJWT = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID!,
  tokenUse: "id",
  clientId: process.env.USER_POOL_CLIENT_ID!,
});

// Sin cabeceras CORS acá: las ponen API Gateway y la Function URL según su
// configuración. Si la Lambda las duplica, el navegador rechaza la respuesta
// («*, *» no es un origen válido).
const CABECERAS = {
  "content-type": "application/json",
};

export const handler = async (
  evento: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> => {
  const ruta = evento.requestContext.http.path;
  const claims = evento.requestContext.authorizer?.jwt?.claims ?? {};

  // La identidad viene del token, nunca del cuerpo del request.
  let clienteId = String(claims.sub ?? "");
  if (!clienteId) {
    // Sin autorizador delante (Function URL): verificamos el token nosotros.
    try {
      const token = evento.headers?.authorization ?? "";
      const payload = await verificadorJWT.verify(token.replace(/^Bearer /i, ""));
      clienteId = String(payload.sub);
    } catch {
      return respuesta(401, { error: "No autenticado." });
    }
  }

  // La Function URL tiene una sola ruta ("/"): siempre es el chat.
  const esFunctionURL = !evento.requestContext.authorizer;

  try {
    if (esFunctionURL || ruta.endsWith("/chat")) return await manejarChat(evento, clienteId);
    if (ruta.endsWith("/historial")) return await manejarHistorial(evento, clienteId);
    if (ruta.endsWith("/adjuntos/url")) return await manejarAdjunto(clienteId);
    if (ruta.endsWith("/mcp")) return await manejarMCP(evento, clienteId);
    return respuesta(404, { error: "Ruta no encontrada." });
  } catch (error) {
    console.error("Error no controlado", error);
    return respuesta(500, {
      error: "Se rompió algo del lado del servidor.",
      detalle: error instanceof Error ? error.message : String(error),
    });
  }
};

/* ── /chat ─────────────────────────────────────────────────────────── */

async function manejarChat(
  evento: APIGatewayProxyEventV2WithJWTAuthorizer,
  clienteId: string,
): Promise<APIGatewayProxyResultV2> {
  const cuerpo = JSON.parse(evento.body ?? "{}");
  const texto = String(cuerpo.mensaje ?? "").trim();
  const sesionId = sesionValida(cuerpo.sesionId);
  const adjuntoClave: string | undefined = cuerpo.adjuntoClave;
  // La fuente analítica la elige la persona con el switch de la UI. Todo lo
  // que no sea exactamente "detalle" cae en gold: el modo seguro es default.
  const fuente = cuerpo.fuente === "detalle" ? ("detalle" as const) : ("gold" as const);

  if (!texto && !adjuntoClave) {
    return respuesta(400, { error: "Mandá un mensaje o una imagen." });
  }

  const contenido: ContentBlock[] = [];

  // Imagen: Converse la acepta como bytes dentro del mensaje del usuario.
  if (adjuntoClave) {
    const imagen = await leerAdjunto(adjuntoClave, clienteId);
    if (imagen) contenido.push(imagen);
  }
  contenido.push({ text: texto || "¿Qué ves en esta foto?" });

  const mensajeUsuario: Message = { role: "user", content: contenido };

  const historial = await cargarHistorial(clienteId, sesionId);
  const mensajes: Message[] = [...historial, mensajeUsuario];

  const resultado = await conversar(mensajes, { clienteId, sesionId, fuente });

  // Se persiste el turno del usuario y la respuesta final del asistente.
  //
  // Del turno del usuario NO se guardan los bytes de la imagen: un item de
  // DynamoDB no puede pasar de 400 KB y una foto lo revienta. Queda en su
  // lugar la referencia a S3, que además evita reenviar la imagen entera en
  // cada turno siguiente de la conversación.
  const paraHistorial: Message = {
    role: "user",
    content: contenido.map((bloque) =>
      bloque.image ? { text: `[el cliente adjuntó una foto: ${adjuntoClave}]` } : bloque,
    ),
  };

  await guardarIntercambio(clienteId, sesionId, paraHistorial, resultado.texto);

  return respuesta(200, {
    sesionId,
    fuente,
    respuesta: resultado.texto,
    herramientasUsadas: resultado.herramientasUsadas,
    // A qué backends fue de verdad cada herramienta: es lo que la interfaz
    // muestra junto a los tokens para que se vea el recorrido del dato.
    fuentesDatos: fuentesDeDatos(resultado.herramientasUsadas),
    bloqueadoPorGuardrail: resultado.bloqueadoPorGuardrail,
    // Devolver el uso permite mostrar el costo de la sesión en pantalla:
    // es el paso 6 del workshop, y en la demo gold vs detalle es el número
    // que se compara en vivo.
    uso: resultado.uso,
  });
}

async function leerAdjunto(clave: string, clienteId: string): Promise<ContentBlock | null> {
  // La clave siempre arranca con el id del cliente: nadie lee adjuntos ajenos.
  if (!clave.startsWith(`adjuntos/${clienteId}/`)) {
    console.warn("Intento de leer un adjunto de otro cliente:", clave);
    return null;
  }

  const objeto = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET_ADJUNTOS, Key: clave }),
  );
  const bytes = await objeto.Body!.transformToByteArray();

  const formato = clave.toLowerCase().endsWith(".png")
    ? "png"
    : clave.toLowerCase().endsWith(".webp")
      ? "webp"
      : "jpeg";

  return { image: { format: formato, source: { bytes } } };
}

/* ── /historial ────────────────────────────────────────────────────── */

// La memoria vive en DynamoDB; esta ruta la trae de vuelta para que un
// refresh del navegador no borre la conversación de la pantalla.
async function manejarHistorial(
  evento: APIGatewayProxyEventV2WithJWTAuthorizer,
  clienteId: string,
): Promise<APIGatewayProxyResultV2> {
  const cuerpo = JSON.parse(evento.body ?? "{}");
  if (!cuerpo.sesionId) return respuesta(400, { error: "Falta el sesionId." });
  const sesionId = sesionValida(cuerpo.sesionId);

  const historial = await cargarHistorial(clienteId, sesionId);
  const turnos = historial
    .map((m) => ({
      quien: m.role === "assistant" ? "agente" : "usuario",
      texto: (m.content ?? [])
        .map((b) => b.text ?? "")
        .filter(Boolean)
        .join("\n"),
    }))
    .filter((t) => t.texto);
  return respuesta(200, { turnos });
}

/* ── /adjuntos/url ─────────────────────────────────────────────────── */

async function manejarAdjunto(clienteId: string): Promise<APIGatewayProxyResultV2> {
  const clave = `adjuntos/${clienteId}/${randomUUID()}.jpg`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: BUCKET_ADJUNTOS, Key: clave, ContentType: "image/jpeg" }),
    { expiresIn: 300 },
  );
  return respuesta(200, { url, clave });
}

/* ── /mcp ──────────────────────────────────────────────────────────── */

// Implementación mínima de MCP sobre HTTP (JSON-RPC 2.0). Sirve para
// conectar un cliente MCP externo a las mismas herramientas que usa el
// agente, sin duplicar la lógica.
async function manejarMCP(
  evento: APIGatewayProxyEventV2WithJWTAuthorizer,
  clienteId: string,
): Promise<APIGatewayProxyResultV2> {
  const peticion = JSON.parse(evento.body ?? "{}");
  const { id, method, params } = peticion;

  switch (method) {
    case "initialize":
      return respuesta(200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "craftech-atencion-cliente",
            version: "1.0.0",
            servidores: servidores.map((s) => ({ nombre: s.nombre, version: s.version })),
          },
        },
      });

    case "tools/list":
      return respuesta(200, {
        jsonrpc: "2.0",
        id,
        result: { tools: listarHerramientasMCP(fuenteMCP(evento)) },
      });

    case "tools/call": {
      const resultado = await ejecutarHerramienta(
        params?.name,
        params?.arguments ?? {},
        { clienteId, sesionId: `mcp-${clienteId}`, fuente: fuenteMCP(evento) },
      );
      return respuesta(200, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(resultado, null, 2) }] },
      });
    }

    default:
      return respuesta(200, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Método no soportado: ${method}` },
      });
  }
}

/** Mapa herramienta → dónde vive el dato, para el panel de la interfaz. */
function fuentesDeDatos(herramientas: string[]): string[] {
  const kbManaged = (process.env.KB_MODE ?? "local") === "managed";
  const mapa: Record<string, string> = {
    pedidos: "DynamoDB",
    reclamos: "DynamoDB",
    conocimiento: kbManaged ? "Knowledge Base (S3 Vectors)" : "DynamoDB vectores (RAG local)",
    ventas: "", // depende de la herramienta, se resuelve abajo
  };
  const fuentes = new Set<string>();
  for (const h of herramientas) {
    const [servidor, herramienta] = h.split("__");
    if (servidor === "ventas") {
      fuentes.add(herramienta === "detalle" ? "S3 Tables · detalle (Athena)" : "S3 Tables · gold (Athena)");
    } else if (mapa[servidor]) {
      fuentes.add(mapa[servidor]);
    }
  }
  return [...fuentes];
}

/** AgentCore Memory solo acepta [a-zA-Z0-9_-] en el sessionId: cualquier
 *  otra cosa se descarta y la conversación arranca con un id propio. */
function sesionValida(valor: unknown): string {
  const id = String(valor ?? "");
  return /^[a-zA-Z0-9_-]{1,100}$/.test(id) ? id : randomUUID();
}

function respuesta(codigo: number, cuerpo: unknown): APIGatewayProxyResultV2 {
  return { statusCode: codigo, headers: CABECERAS, body: JSON.stringify(cuerpo) };
}

/** Fuente para el endpoint MCP externo: viene por query string (?fuente=detalle). */
function fuenteMCP(evento: APIGatewayProxyEventV2WithJWTAuthorizer): "gold" | "detalle" {
  return evento.queryStringParameters?.fuente === "detalle" ? "detalle" : "gold";
}
