// Servidor MCP de reclamos. En producción esto pega contra Jira; acá es un
// mock que guarda en DynamoDB y devuelve un identificador con UUID, para que
// el ejercicio no dependa de credenciales de un sistema externo.
//
// Punto de diseño importante: crear un reclamo es una acción con efecto.
// El agente puede crearlo, pero no puede cerrarlo ni modificar importes:
// las acciones irreversibles no se le delegan al modelo.
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { ServidorMCP } from "./tipos";

const cliente = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLA = process.env.TABLA_TICKETS!;

const MOTIVOS = [
  "producto_danado",
  "producto_incorrecto",
  "demora_entrega",
  "falta_pieza",
  "cobro_incorrecto",
  "otro",
] as const;

export const servidorReclamos: ServidorMCP = {
  nombre: "reclamos",
  version: "1.0.0",
  descripcion: "Alta y consulta de reclamos. Integración simulada con el sistema de tickets.",
  herramientas: [
    {
      nombre: "crear",
      descripcion:
        "Crea un reclamo formal y devuelve su número de ticket. Usala solo cuando el cliente " +
        "confirmó que quiere dejar el reclamo y ya tenés el pedido y el motivo. Si falta alguno " +
        "de los dos, preguntáselo antes en vez de inventarlo.",
      esquemaEntrada: {
        type: "object",
        properties: {
          pedidoId: { type: "string", description: "Pedido afectado, por ejemplo PED-1042." },
          motivo: {
            type: "string",
            enum: [...MOTIVOS],
            description: "Motivo del reclamo.",
          },
          descripcion: {
            type: "string",
            description: "Resumen en una o dos frases de lo que reporta el cliente.",
          },
          adjuntoUrl: {
            type: "string",
            description: "Ruta en S3 de la foto que envió el cliente, si la hay.",
          },
        },
        required: ["pedidoId", "motivo", "descripcion"],
      },
      async ejecutar(argumentos, contexto) {
        const ticketId = `REC-${randomUUID().slice(0, 8).toUpperCase()}`;
        const creadoEn = new Date().toISOString();

        const ticket = {
          ticketId,
          clienteId: contexto.clienteId,
          sesionId: contexto.sesionId,
          pedidoId: String(argumentos.pedidoId),
          motivo: String(argumentos.motivo),
          descripcion: String(argumentos.descripcion),
          adjuntoUrl: argumentos.adjuntoUrl ? String(argumentos.adjuntoUrl) : null,
          estado: "abierto",
          creadoEn,
        };

        await cliente.send(new PutCommand({ TableName: TABLA, Item: ticket }));

        // Así se vería la respuesta de Jira al crear el issue.
        return {
          ticketId,
          estado: "abierto",
          creadoEn,
          mensaje: `Reclamo ${ticketId} creado correctamente. El equipo responde dentro de las 48 horas hábiles.`,
        };
      },
    },
    {
      nombre: "consultar",
      descripcion: "Consulta el estado de un reclamo ya existente por su número de ticket.",
      esquemaEntrada: {
        type: "object",
        properties: {
          ticketId: { type: "string", description: "Número de ticket, por ejemplo REC-A1B2C3D4." },
        },
        required: ["ticketId"],
      },
      async ejecutar(argumentos, contexto) {
        const resultado = await cliente.send(
          new GetCommand({ TableName: TABLA, Key: { ticketId: String(argumentos.ticketId) } }),
        );
        // Filtrado por tenant: un ticket de otro cliente no existe para este.
        if (!resultado.Item || resultado.Item.clienteId !== contexto.clienteId) {
          return {
            encontrado: false,
            mensaje: `No encontré el reclamo ${argumentos.ticketId} a nombre de este cliente.`,
          };
        }
        return { encontrado: true, reclamo: resultado.Item };
      },
    },
  ],
};
