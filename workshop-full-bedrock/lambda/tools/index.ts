// El puente entre AgentCore Gateway y las herramientas del workshop.
//
// El Gateway invoca esta Lambda una vez por tool call: los argumentos llegan
// en el event, y el nombre de la herramienta viaja en el client context como
// «target___herramienta» (delimitador de tres guiones bajos). Acá se traduce
// al nombre calificado del registro («target__herramienta») y se ejecuta el
// MISMO código que usa la Lambda del workshop principal: mismos módulos,
// mismo DynamoDB, misma Knowledge Base, mismo lakehouse.
import { ejecutarHerramienta } from "../../../workshop/lambda/agent/mcp/registro";

export const handler = async (event: Record<string, any>, context: any) => {
  const custom = context?.clientContext?.custom ?? context?.clientContext?.Custom ?? {};
  const crudo: string = custom.bedrockAgentCoreToolName ?? "";
  const separador = crudo.indexOf("___");
  if (separador < 0) {
    return { error: `Nombre de herramienta inesperado: «${crudo}»` };
  }
  const target = crudo.slice(0, separador);
  const herramienta = crudo.slice(separador + 3);
  const nombre = `${target}__${herramienta}`;

  // El clienteId llega como argumento declarado en el esquema de cada tool
  // (en esta versión la identidad viaja por prompt — ver el README). El
  // resto de los argumentos pasa tal cual al código original.
  const { clienteId, ...argumentos } = event ?? {};
  if (!clienteId) {
    return { error: "Falta clienteId: toda herramienta lo necesita para acotar la consulta." };
  }

  console.log(JSON.stringify({ nombre, clienteId, argumentos }));
  return ejecutarHerramienta(nombre, argumentos, {
    clienteId: String(clienteId),
    sesionId: "full-bedrock",
    // La versión gestionada trabaja siempre contra la capa gold: el
    // experimento gold vs detalle vive en el workshop principal.
    fuente: "gold",
  });
};
