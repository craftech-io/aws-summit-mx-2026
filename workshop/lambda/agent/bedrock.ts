// El loop del agente sobre la Converse API de Bedrock.
//
// Converse es la interfaz única de Bedrock: mismo contrato para cualquier
// modelo, con soporte de imágenes y de tool use. Cambiar de modelo es
// cambiar un string, no reescribir el cliente.
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
  type ContentBlock,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { toolConfigBedrock, ejecutarHerramienta } from "./mcp/registro";
import type { ContextoEjecucion, FuenteDatos } from "./mcp/tipos";

const cliente = new BedrockRuntimeClient({});

const MODELO_ID = process.env.MODELO_ID ?? "us.anthropic.claude-opus-5";
const GUARDRAIL_ID = process.env.GUARDRAIL_ID;
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION;

// Tope de vueltas del loop. Sin esto, un modelo que se obstina con una
// herramienta rota consume tokens hasta el timeout de la Lambda.
const MAX_VUELTAS = 8;

export const PROMPT_SISTEMA = `Sos el asistente de atención al cliente de Craftech Store, una tienda de electrónica.

## Cómo trabajás
- Respondés en español rioplatense, con un tono cordial y directo. Sin exceso de formalidad.
- Sos breve: dos o tres frases por respuesta salvo que te pidan el detalle.
- Nunca inventás datos. Si no sabés algo, lo decís y ofrecés abrir un reclamo.
- Tenés memoria de la conversación: los mensajes anteriores de esta sesión quedan
  guardados y los recibís en cada turno, incluso si el cliente cerró y volvió.
  Nunca digas que no podés recordar lo hablado en esta conversación.

## Herramientas
- Para cualquier consulta sobre políticas, plazos, garantías o devoluciones usá SIEMPRE
  "conocimiento__buscar". No respondas de memoria: la información oficial está ahí.
- Para pedidos usá "pedidos__listar" o "pedidos__detalle".
- Para dejar un reclamo usá "reclamos__crear", pero solo cuando ya tengas el pedido y el
  motivo, y el cliente haya confirmado que quiere dejarlo.

## Límites
- No ofrecés descuentos, reembolsos ni condiciones que no estén en la base de conocimiento.
- No ayudás con temas ajenos a la tienda (programación, consejos generales, otros rubros).
- Si el cliente manda una foto, describí lo que ves y usalo para el reclamo.`;

// El bloque de analítica cambia con la fuente. Es texto del sistema, no una
// decisión del modelo: la fuente la eligió la persona en la interfaz.
//
// En gold, la regla de aislamiento vive en el prompt Y en la plataforma (el
// WHERE por tenant lo arma el código). En detalle el prompt es el ingenuo de
// la primera semana, sin advertencias — ese es justamente el experimento que
// la demo muestra: lo que pasa cuando la única defensa era el prompt.
const PROMPT_FUENTE: Record<FuenteDatos, string> = {
  gold:
    "\n\n## Analítica de compras\n" +
    "- Para preguntas sobre cuánto compró el cliente, en qué gastó o cómo evolucionan sus " +
    "compras, usá \"ventas__resumen\": una sola llamada devuelve total, categorías y meses.\n" +
    "- Los datos de otros clientes no existen para vos: solo ves los del cliente autenticado.",
  detalle:
    "\n\n## Analítica de compras\n" +
    "- El historial completo de compras vive en la tabla analítica: usá \"ventas__detalle\" " +
    "para cualquier consulta sobre compras, gastos, montos o clientes. " +
    "\"pedidos__listar\" solo muestra los pedidos operativos recientes.",
};

// Errores 5xx transitorios de Bedrock. El SDK ya reintenta alguno, pero no
// todos ni siempre: sin esto, un hipo del servicio corta la conversación.
const TRANSITORIOS = new Set([
  "InternalServerException",
  "ServiceUnavailableException",
  "ThrottlingException",
]);

async function conReintentos<T>(fn: () => Promise<T>): Promise<T> {
  const esperas = [500, 1200, 2500, 5000];
  for (let intento = 0; ; intento++) {
    try {
      return await fn();
    } catch (error) {
      const nombre = error instanceof Error ? error.name : "";
      if (intento >= esperas.length || !TRANSITORIOS.has(nombre)) throw error;
      console.warn(`Bedrock ${nombre}: reintento ${intento + 1}`);
      await new Promise((r) => setTimeout(r, esperas[intento]));
    }
  }
}

export interface ResultadoConversacion {
  texto: string;
  herramientasUsadas: string[];
  uso: { tokensEntrada: number; tokensSalida: number };
  bloqueadoPorGuardrail: boolean;
}

export async function conversar(
  mensajes: Message[],
  contexto: ContextoEjecucion,
): Promise<ResultadoConversacion> {
  const herramientasUsadas: string[] = [];
  let tokensEntrada = 0;
  let tokensSalida = 0;
  let bloqueadoPorGuardrail = false;

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const respuesta: ConverseCommandOutput = await conReintentos(() =>
      cliente.send(
        new ConverseCommand({
          modelId: MODELO_ID,
          messages: mensajes,
          system: [{ text: PROMPT_SISTEMA + PROMPT_FUENTE[contexto.fuente] }],
          toolConfig: toolConfigBedrock(contexto.fuente),
          inferenceConfig: { maxTokens: 2048 },
          ...(GUARDRAIL_ID && GUARDRAIL_VERSION
            ? {
                guardrailConfig: {
                  guardrailIdentifier: GUARDRAIL_ID,
                  guardrailVersion: GUARDRAIL_VERSION,
                  // El trace dice QUÉ política intervino. Sin esto, un bloqueo
                  // es una adivinanza.
                  trace: "enabled" as const,
                },
              }
            : {}),
        }),
      ),
    );

    tokensEntrada += respuesta.usage?.inputTokens ?? 0;
    tokensSalida += respuesta.usage?.outputTokens ?? 0;

    if (respuesta.stopReason === "guardrail_intervened") {
      bloqueadoPorGuardrail = true;
      const g = respuesta.trace?.guardrail as any;
      console.warn(
        "Guardrail intervino. Entrada:",
        JSON.stringify(g?.inputAssessment ?? {}).slice(0, 1500),
        "· Salida:",
        JSON.stringify(g?.outputAssessments ?? {}).slice(0, 1500),
      );
    }

    const salida = respuesta.output?.message;
    if (!salida) break;

    mensajes.push(salida);

    // El modelo terminó de hablar.
    if (respuesta.stopReason !== "tool_use") {
      return {
        texto: extraerTexto(salida.content ?? []),
        herramientasUsadas,
        uso: { tokensEntrada, tokensSalida },
        bloqueadoPorGuardrail,
      };
    }

    // Pidió herramientas: se ejecutan todas y los resultados vuelven en un
    // único mensaje de usuario (partirlos degrada el uso de paralelismo).
    const pedidos = (salida.content ?? []).filter((b) => b.toolUse);
    const resultados: ContentBlock[] = [];

    for (const bloque of pedidos) {
      const uso = bloque.toolUse!;
      const nombre = uso.name!;
      herramientasUsadas.push(nombre);
      console.log("Herramienta", nombre, JSON.stringify(uso.input));

      const resultado = await ejecutarHerramienta(
        nombre,
        (uso.input ?? {}) as Record<string, any>,
        contexto,
      );

      resultados.push({
        toolResult: {
          toolUseId: uso.toolUseId!,
          content: [{ json: resultado }],
        },
      });
    }

    mensajes.push({ role: "user", content: resultados });
  }

  return {
    texto:
      "Se me complicó resolver esto. ¿Querés que abra un reclamo para que lo vea una persona del equipo?",
    herramientasUsadas,
    uso: { tokensEntrada, tokensSalida },
    bloqueadoPorGuardrail,
  };
}

function extraerTexto(bloques: ContentBlock[]): string {
  return bloques
    .filter((b) => b.text)
    .map((b) => b.text)
    .join("\n")
    .trim();
}
