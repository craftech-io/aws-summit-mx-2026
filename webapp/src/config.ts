// Configuración de la app, inyectada por el stack que la despliega vía
// /config.js (window.CONFIG). En modo "harness" los ids de Cognito no vienen
// directo: hay que resolverlos con un fetch a configUrl antes de arrancar.

export type Modo = "lambda" | "harness";

export interface Config {
  modo: Modo;
  region: string;
  chatUrl: string;
  apiUrl?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  configUrl?: string;
}

declare global {
  interface Window {
    CONFIG: Config;
  }
}

/** Forma que devuelve el fetch a configUrl en modo harness. */
interface ConfigHarness {
  region: string;
  userPoolId: string;
  clientId: string;
}

/**
 * Devuelve la config lista para usar. En modo lambda, window.CONFIG ya trae
 * todo. En modo harness, si faltan los ids de Cognito, se completan con un
 * fetch a configUrl (la Lambda del harness los resuelve leyendo el stack de
 * auth compartido).
 */
export async function cargarConfig(): Promise<Config> {
  const base = window.CONFIG;
  if (!base) {
    throw new Error("Falta window.CONFIG: revisá que /config.js se haya cargado antes del bundle.");
  }

  const modo: Modo = base.modo === "harness" ? "harness" : "lambda";

  if (modo === "harness" && base.configUrl && (!base.userPoolId || !base.userPoolClientId)) {
    const respuesta = await fetch(base.configUrl);
    if (!respuesta.ok) throw new Error("No se pudo obtener la configuración del harness.");
    const datos: ConfigHarness = await respuesta.json();
    return {
      ...base,
      modo,
      region: datos.region || base.region,
      userPoolId: datos.userPoolId,
      userPoolClientId: datos.clientId,
    };
  }

  return { ...base, modo };
}

/** Un teléfono utilizable: con código de país, nunca el string "null". */
export const telefonoValido = (t: string | null | undefined): t is string =>
  typeof t === "string" && t.startsWith("+");
