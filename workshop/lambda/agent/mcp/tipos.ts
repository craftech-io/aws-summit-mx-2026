// Contratos compartidos de los servidores MCP.
//
// La idea del workshop: cada capacidad del agente es un "servidor" con sus
// herramientas. El agente no sabe si por debajo hay DynamoDB, un índice
// vectorial o una API externa — solo ve herramientas con su esquema.
// Sumar una capacidad = sumar un servidor, sin tocar el orquestador.

/**
 * Fuente de datos analíticos de la sesión. La elige la persona con el
 * switch de la interfaz — nunca el modelo — y viaja en cada request:
 *   gold    → la capa agregada y sin datos personales (lo correcto)
 *   detalle → la tabla cruda, con PII y todos los tenants (el anti-patrón,
 *             expuesto a propósito para el experimento gold vs detalle)
 */
export type FuenteDatos = "gold" | "detalle";

export interface ContextoEjecucion {
  /** Identidad del usuario autenticado (viene del id_token de Cognito). */
  clienteId: string;
  /** Sesión de chat actual. */
  sesionId: string;
  /** Qué capa del lakehouse ve el agente en esta conversación. */
  fuente: FuenteDatos;
}

export interface HerramientaMCP {
  nombre: string;
  descripcion: string;
  /** JSON Schema de los parámetros de entrada. */
  esquemaEntrada: Record<string, any>;
  /**
   * Si está presente, la herramienta solo existe cuando la fuente activa
   * es una de estas. El filtro pasa por el catálogo que ve el modelo Y por
   * la ejecución: en modo gold, la herramienta de detalle no se puede
   * invocar ni sabiendo su nombre.
   */
  fuentes?: FuenteDatos[];
  /** El resultado viaja como documento JSON hacia el modelo. */
  ejecutar(argumentos: Record<string, any>, contexto: ContextoEjecucion): Promise<any>;
}

export interface ServidorMCP {
  nombre: string;
  version: string;
  descripcion: string;
  herramientas: HerramientaMCP[];
}

/** Nombre calificado que ve el modelo: servidor__herramienta. */
export function nombreCalificado(servidor: string, herramienta: string): string {
  return `${servidor}__${herramienta}`;
}
