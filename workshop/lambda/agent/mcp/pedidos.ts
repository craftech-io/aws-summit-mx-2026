// Servidor MCP sobre DynamoDB: consulta de pedidos del cliente.
//
// Nota de seguridad: el clienteId NO viene del
// modelo, viene del token. Aunque el usuario pida "mostrame los pedidos de
// otro cliente", la consulta siempre queda acotada a su propia partición.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { ServidorMCP } from "./tipos";

const cliente = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLA = process.env.TABLA_PEDIDOS!;

export const servidorPedidos: ServidorMCP = {
  nombre: "pedidos",
  version: "1.0.0",
  descripcion: "Consulta de pedidos, estado de envío e historial del cliente.",
  herramientas: [
    {
      nombre: "listar",
      descripcion:
        "Lista los pedidos del cliente autenticado, del más reciente al más antiguo. " +
        "Usala cuando el cliente pregunta por sus compras, envíos o el estado de un pedido sin dar un número.",
      esquemaEntrada: {
        type: "object",
        properties: {
          limite: {
            type: "integer",
            description: "Cantidad máxima de pedidos a devolver (por defecto 5).",
            minimum: 1,
            maximum: 20,
          },
        },
      },
      async ejecutar(argumentos, contexto) {
        const limite = Math.min(Number(argumentos.limite ?? 5), 20);
        const resultado = await cliente.send(
          new QueryCommand({
            TableName: TABLA,
            KeyConditionExpression: "clienteId = :c",
            ExpressionAttributeValues: { ":c": contexto.clienteId },
            ScanIndexForward: false,
            Limit: limite,
          }),
        );
        const pedidos = resultado.Items ?? [];
        if (pedidos.length === 0) {
          return { pedidos: [], mensaje: "El cliente no tiene pedidos registrados." };
        }
        return { pedidos };
      },
    },
    {
      nombre: "detalle",
      descripcion:
        "Devuelve el detalle completo de un pedido: items, importe, estado y número de seguimiento. " +
        "Usala cuando el cliente menciona un número de pedido concreto.",
      esquemaEntrada: {
        type: "object",
        properties: {
          pedidoId: {
            type: "string",
            description: "Identificador del pedido, por ejemplo PED-1042.",
          },
        },
        required: ["pedidoId"],
      },
      async ejecutar(argumentos, contexto) {
        const resultado = await cliente.send(
          new GetCommand({
            TableName: TABLA,
            Key: { clienteId: contexto.clienteId, pedidoId: String(argumentos.pedidoId) },
          }),
        );
        if (!resultado.Item) {
          return {
            encontrado: false,
            mensaje: `No existe el pedido ${argumentos.pedidoId} para este cliente.`,
          };
        }
        return { encontrado: true, pedido: resultado.Item };
      },
    },
  ],
};
