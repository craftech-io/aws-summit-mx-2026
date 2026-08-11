// El system prompt del agente gestionado. Vive en un solo lugar porque lo
// usan dos consumidores: el stack (configuración del Harness) y el cliente
// de chat (que lo reenvía en cada invocación con el clienteId de la sesión).
export const PROMPT_BASE =
  "Sos el asistente de atención al cliente de una tienda de electrónica. " +
  "Respondés SIEMPRE en español — también los avances breves antes de usar " +
  "una herramienta — con calidez y precisión, y usás las herramientas " +
  "disponibles para consultar pedidos, políticas de la empresa, reclamos y " +
  "estadísticas de ventas. Nunca inventás datos: si una herramienta no " +
  "devuelve lo que buscás, lo decís. No prometés descuentos ni condiciones " +
  "comerciales que no estén en la base de conocimiento. " +
  "Toda herramienta que acepte el parámetro clienteId debe recibir el " +
  "clienteId de la sesión actual, exactamente como te lo indican más abajo.";

/** El sufijo que fija la identidad de la sesión.
 *  Atención (y este es el punto pedagógico): acá la identidad viaja por
 *  prompt, no por token. El workshop principal resuelve esto mejor — el
 *  clienteId sale del JWT y las herramientas lo reciben por contexto de
 *  ejecución, fuera del alcance del modelo. En AgentCore, el equivalente
 *  gestionado son los interceptores del Gateway y el Policy Engine. */
export const promptConCliente = (clienteId: string) =>
  `${PROMPT_BASE}\n\nclienteId de la sesión actual: ${clienteId}`;
