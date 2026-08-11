// Registro de servidores MCP: el único lugar donde se enchufan capacidades.
//
// EJERCICIO DEL WORKSHOP (paso 5): creá tu propio servidor en un archivo
// nuevo, importalo acá y sumalo al array. No hay que tocar nada más — ni el
// orquestador, ni el prompt, ni la infraestructura.
import type { Tool, ToolConfiguration } from "@aws-sdk/client-bedrock-runtime";
import { servidorPedidos } from "./pedidos";
import { servidorConocimiento } from "./conocimiento";
import { servidorReclamos } from "./reclamos";
import { servidorVentas } from "./ventas";
import { nombreCalificado } from "./tipos";
import type { ContextoEjecucion, FuenteDatos, HerramientaMCP, ServidorMCP } from "./tipos";

export const servidores: ServidorMCP[] = [
  servidorPedidos,
  servidorConocimiento,
  servidorReclamos,
  servidorVentas,
];

/** ¿Esta herramienta existe para la fuente activa? */
const visible = (herramienta: HerramientaMCP, fuente: FuenteDatos) =>
  !herramienta.fuentes || herramienta.fuentes.includes(fuente);

/** Índice plano nombre-calificado → herramienta. */
const indice = new Map<string, { servidor: ServidorMCP; herramienta: HerramientaMCP }>();
for (const servidor of servidores) {
  for (const herramienta of servidor.herramientas) {
    indice.set(nombreCalificado(servidor.nombre, herramienta.nombre), { servidor, herramienta });
  }
}

/** Herramientas en el formato que espera la Converse API de Bedrock.
 *  El catálogo depende de la fuente: en modo gold, la herramienta de
 *  detalle directamente no existe para el modelo. */
export function toolConfigBedrock(fuente: FuenteDatos): ToolConfiguration {
  const tools: Tool[] = [...indice.entries()]
    .filter(([, { herramienta }]) => visible(herramienta, fuente))
    .map(([nombre, { herramienta }]) => ({
      toolSpec: {
        name: nombre,
        description: herramienta.descripcion,
        inputSchema: { json: herramienta.esquemaEntrada },
      },
    }));
  return { tools };
}

/** Catálogo en formato MCP (respuesta de tools/list). */
export function listarHerramientasMCP(fuente: FuenteDatos = "gold") {
  return [...indice.entries()]
    .filter(([, { herramienta }]) => visible(herramienta, fuente))
    .map(([nombre, { herramienta }]) => ({
      name: nombre,
      description: herramienta.descripcion,
      inputSchema: herramienta.esquemaEntrada,
    }));
}

export async function ejecutarHerramienta(
  nombre: string,
  argumentos: Record<string, any>,
  contexto: ContextoEjecucion,
): Promise<any> {
  const entrada = indice.get(nombre);
  if (!entrada) {
    return { error: `La herramienta ${nombre} no existe.` };
  }
  // La visibilidad se chequea también acá: aunque alguien le dicte el nombre
  // de la herramienta al modelo, en la fuente equivocada no se ejecuta.
  if (!visible(entrada.herramienta, contexto.fuente)) {
    return { error: `La herramienta ${nombre} no está disponible con la fuente ${contexto.fuente}.` };
  }
  try {
    return await entrada.herramienta.ejecutar(argumentos ?? {}, contexto);
  } catch (error) {
    console.error(`Error ejecutando ${nombre}`, error);
    // El error vuelve al modelo como resultado: puede reintentar o explicarle
    // al cliente qué pasó, en vez de cortar la conversación.
    return {
      error: true,
      mensaje: error instanceof Error ? error.message : "Error desconocido en la herramienta.",
    };
  }
}
