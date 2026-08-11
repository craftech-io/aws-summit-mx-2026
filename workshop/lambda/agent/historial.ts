// Historial de conversación, con dos backends conmutables:
//
//   MEMORY_ID presente → AgentCore Memory de Bedrock, en su capa de corto
//                        plazo: eventos crudos por actor y sesión, sin
//                        estrategias de extracción. Es la capa más económica
//                        del servicio y la que usa este despliegue.
//   sin MEMORY_ID      → DynamoDB con ventana deslizante y TTL, el backend
//                        que el paso 2 del workshop explica por dentro.
//
// En los dos casos la memoria queda atada a la identidad (actor = sub de
// Cognito) y a la sesión: mismo teléfono, misma conversación, aunque el
// navegador se refresque. Al modelo solo viaja una ventana de los últimos
// turnos — mandar la conversación entera en cada request es el error de
// gestión de contexto más caro y más común.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { Message } from "@aws-sdk/client-bedrock-runtime";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const agentCore = new BedrockAgentCoreClient({});

const TABLA = process.env.TABLA_CONVERSACIONES!;
const MEMORY_ID = process.env.MEMORY_ID ?? "";

/** Cantidad de turnos que viajan al modelo en cada request. */
const VENTANA = 12;

/** Los registros del laboratorio se borran solos a las 24 horas (DynamoDB). */
const TTL_HORAS = 24;

export async function cargarHistorial(clienteId: string, sesionId: string): Promise<Message[]> {
  return MEMORY_ID
    ? cargarDeAgentCore(clienteId, sesionId)
    : cargarDeDynamo(clienteId, sesionId);
}

/** Persiste el intercambio completo (turno del usuario + respuesta). */
export async function guardarIntercambio(
  clienteId: string,
  sesionId: string,
  turnoUsuario: Message,
  textoAsistente: string,
): Promise<void> {
  const respuesta: Message = { role: "assistant", content: [{ text: textoAsistente }] };
  if (MEMORY_ID) {
    await guardarEnAgentCore(clienteId, sesionId, turnoUsuario, respuesta);
  } else {
    await guardarEnDynamo(clienteId, sesionId, turnoUsuario, respuesta);
  }
}

/* ── Backend AgentCore Memory ──────────────────────────────────────── */

// Un evento por intercambio, con los dos payloads conversacionales adentro:
// menos eventos, menos costo, y la reconstrucción es directa.
async function guardarEnAgentCore(
  clienteId: string,
  sesionId: string,
  turnoUsuario: Message,
  respuesta: Message,
): Promise<void> {
  await agentCore.send(
    new CreateEventCommand({
      memoryId: MEMORY_ID,
      actorId: clienteId,
      sessionId: sesionId,
      eventTimestamp: new Date(),
      payload: [
        { conversational: { role: "USER", content: { text: textoPlano(turnoUsuario) } } },
        { conversational: { role: "ASSISTANT", content: { text: textoPlano(respuesta) } } },
      ],
    }),
  );
}

async function cargarDeAgentCore(clienteId: string, sesionId: string): Promise<Message[]> {
  const resultado = await agentCore.send(
    new ListEventsCommand({
      memoryId: MEMORY_ID,
      actorId: clienteId,
      sessionId: sesionId,
      includePayloads: true,
      // Cada evento trae un intercambio (usuario + asistente) = 2 turnos.
      maxResults: VENTANA / 2,
    }),
  );

  // ListEvents devuelve lo más nuevo primero; la conversación va al revés.
  const eventos = [...(resultado.events ?? [])].reverse();
  const mensajes: Message[] = [];
  for (const evento of eventos) {
    for (const payload of evento.payload ?? []) {
      const c = payload.conversational;
      if (!c?.content?.text) continue;
      mensajes.push({
        role: c.role === "ASSISTANT" ? "assistant" : "user",
        content: [{ text: c.content.text }],
      });
    }
  }
  return mensajes;
}

/** El contenido puede traer varios bloques; para la memoria alcanza el texto. */
function textoPlano(mensaje: Message): string {
  return (mensaje.content ?? [])
    .map((b) => b.text ?? "")
    .filter(Boolean)
    .join("\n");
}

/* ── Backend DynamoDB ──────────────────────────────────────────────── */

// La clave lleva la identidad adelante: aunque alguien adivine un sesionId
// ajeno, solo puede leer y escribir bajo SU sub.
const claveDynamo = (clienteId: string, sesionId: string) => `${clienteId}#${sesionId}`;

async function cargarDeDynamo(clienteId: string, sesionId: string): Promise<Message[]> {
  const resultado = await dynamo.send(
    new QueryCommand({
      TableName: TABLA,
      KeyConditionExpression: "sesionId = :s",
      ExpressionAttributeValues: { ":s": claveDynamo(clienteId, sesionId) },
      ScanIndexForward: false,
      Limit: VENTANA,
    }),
  );

  const items = (resultado.Items ?? []).sort((a, b) => a.turno - b.turno);

  // Un historial que arranca con un mensaje del asistente no es válido:
  // la conversación siempre empieza del lado del usuario.
  while (items.length > 0 && items[0].rol !== "user") {
    items.shift();
  }

  return items.map((item) => ({
    role: item.rol,
    content: JSON.parse(item.contenido),
  }));
}

async function guardarEnDynamo(
  clienteId: string,
  sesionId: string,
  turnoUsuario: Message,
  respuesta: Message,
): Promise<void> {
  const clave = claveDynamo(clienteId, sesionId);
  const turno = await proximoTurno(clave);
  await guardarTurno(clave, turno, turnoUsuario);
  await guardarTurno(clave, turno + 1, respuesta);
}

async function guardarTurno(clave: string, turno: number, mensaje: Message): Promise<void> {
  await dynamo.send(
    new PutCommand({
      TableName: TABLA,
      Item: {
        sesionId: clave,
        turno,
        rol: mensaje.role,
        contenido: JSON.stringify(mensaje.content),
        creadoEn: new Date().toISOString(),
        expiraEn: Math.floor(Date.now() / 1000) + TTL_HORAS * 3600,
      },
    }),
  );
}

async function proximoTurno(clave: string): Promise<number> {
  const resultado = await dynamo.send(
    new QueryCommand({
      TableName: TABLA,
      KeyConditionExpression: "sesionId = :s",
      ExpressionAttributeValues: { ":s": clave },
      ScanIndexForward: false,
      Limit: 1,
      ProjectionExpression: "turno",
    }),
  );
  const ultimo = resultado.Items?.[0]?.turno ?? -1;
  return ultimo + 1;
}
