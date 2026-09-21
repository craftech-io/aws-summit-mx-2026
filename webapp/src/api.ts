// Cliente de la API: Cognito directo (custom auth por SMS, igual en los dos
// modos porque el user pool es compartido) y el chat/historial/adjuntos,
// que sí difieren según el modo — ver enviarMensaje.
import type { Config } from "./config";

export type Fuente = "gold" | "detalle";

/** Error puntual de Cognito: trae el tipo aparte porque el mensaje es texto
 *  libre y no sirve para decidir nada en el código (p.ej. "ya existe"). */
export class ErrorCognito extends Error {
  tipo: string;
  constructor(mensaje: string, tipo: string) {
    super(mensaje);
    this.name = "ErrorCognito";
    this.tipo = tipo;
  }
}

/** El backend devolvió 401: el token venció y hay que volver al login. */
export class SesionVencidaError extends Error {
  constructor() {
    super("La sesión venció. Volvé a ingresar.");
    this.name = "SesionVencidaError";
  }
}

const urlCognito = (config: Config) => `https://cognito-idp.${config.region}.amazonaws.com/`;

async function cognito(config: Config, accion: string, cuerpo: unknown): Promise<any> {
  const respuesta = await fetch(urlCognito(config), {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityProviderService.${accion}`,
    },
    body: JSON.stringify(cuerpo),
  });
  const datos = await respuesta.json();
  if (!respuesta.ok) {
    const tipo = String(datos.__type ?? "").split("#").pop() ?? "";
    throw new ErrorCognito(datos.message || datos.__type || "Error de autenticación", tipo);
  }
  return datos;
}

/** Alta silenciosa: si el número ya existe seguimos de largo. */
async function registrarSiHaceFalta(config: Config, telefono: string): Promise<void> {
  // La contraseña existe porque Cognito la pide, pero nunca se usa: el
  // ingreso es siempre por el código que llega al celular.
  const passwordDescartable =
    crypto.randomUUID().toUpperCase() + crypto.randomUUID().toLowerCase() + "!9";

  try {
    await cognito(config, "SignUp", {
      ClientId: config.userPoolClientId,
      Username: telefono,
      Password: passwordDescartable,
      UserAttributes: [{ Name: "phone_number", Value: telefono }],
    });
  } catch (error) {
    // Que el número ya exista es el caso normal a partir del segundo ingreso.
    if (!(error instanceof ErrorCognito) || error.tipo !== "UsernameExistsException") throw error;
  }
}

export interface RespuestaCodigo {
  session: string;
  codigoDemo?: string;
  telefonoDestino?: string;
}

export async function pedirCodigo(config: Config, telefono: string): Promise<RespuestaCodigo> {
  await registrarSiHaceFalta(config, telefono);

  const respuesta = await cognito(config, "InitiateAuth", {
    AuthFlow: "CUSTOM_AUTH",
    ClientId: config.userPoolClientId,
    AuthParameters: { USERNAME: telefono },
  });

  const parametros = respuesta.ChallengeParameters ?? {};
  return {
    session: respuesta.Session,
    codigoDemo: parametros.codigoDemo,
    telefonoDestino: parametros.telefono,
  };
}

export interface ResultadoVerificacion {
  idToken?: string;
  /** Cognito devuelve una sesión nueva por cada intento fallido. */
  session?: string;
}

export async function verificarCodigo(
  config: Config,
  telefono: string,
  session: string,
  codigo: string,
): Promise<ResultadoVerificacion> {
  const respuesta = await cognito(config, "RespondToAuthChallenge", {
    ChallengeName: "CUSTOM_CHALLENGE",
    ClientId: config.userPoolClientId,
    Session: session,
    ChallengeResponses: { USERNAME: telefono, ANSWER: codigo },
  });

  if (!respuesta.AuthenticationResult) {
    return { session: respuesta.Session };
  }
  return { idToken: respuesta.AuthenticationResult.IdToken };
}

/* ── Chat ──────────────────────────────────────────────────────────── */

export interface ResultadoChat {
  texto: string;
  herramientas: string[];
  fuentesDatos: string[];
  fuente: Fuente;
  bloqueadoPorGuardrail: boolean;
  tokensEntrada: number;
  tokensSalida: number;
  segundos: number;
}

export interface ParametrosMensaje {
  sesionId: string;
  mensaje: string;
  adjuntoClave: string | null;
  fuente: Fuente;
}

async function leerError(respuesta: Response): Promise<string> {
  try {
    const datos = await respuesta.json();
    return datos.error ?? "Error del servidor";
  } catch {
    return "Error del servidor";
  }
}

/**
 * Manda un mensaje al agente. El shape de request/response cambia según el
 * modo: en lambda hablamos con workshop/lambda/agent/index.ts (POST /chat,
 * auth sin "Bearer "); en harness, con el puente de
 * workshop-full-bedrock/lambda/web/index.ts
 * (body {mensaje, sesionId}, auth "Bearer <token>", respuesta {texto, tools,
 * usage, ms}). Acá se normaliza todo a un único ResultadoChat.
 */
export async function enviarMensaje(
  config: Config,
  idToken: string,
  parametros: ParametrosMensaje,
): Promise<ResultadoChat> {
  const inicio = performance.now();

  if (config.modo === "harness") {
    const respuesta = await fetch(config.chatUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ mensaje: parametros.mensaje, sesionId: parametros.sesionId }),
    });
    if (respuesta.status === 401) throw new SesionVencidaError();
    if (!respuesta.ok) throw new Error(await leerError(respuesta));
    const datos = await respuesta.json();
    return {
      texto: datos.texto || "(sin respuesta)",
      herramientas: datos.tools ?? [],
      fuentesDatos: datos.tools ?? [],
      // Modo harness: siempre gold, no hay switch.
      fuente: "gold",
      bloqueadoPorGuardrail: false,
      tokensEntrada: datos.usage?.inputTokens ?? 0,
      tokensSalida: datos.usage?.outputTokens ?? 0,
      segundos: typeof datos.ms === "number" ? datos.ms / 1000 : (performance.now() - inicio) / 1000,
    };
  }

  const respuesta = await fetch(config.chatUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: idToken },
    body: JSON.stringify(parametros),
  });
  if (respuesta.status === 401) throw new SesionVencidaError();
  if (!respuesta.ok) throw new Error(await leerError(respuesta));
  const datos = await respuesta.json();
  return {
    texto: datos.respuesta,
    herramientas: datos.herramientasUsadas ?? [],
    fuentesDatos: datos.fuentesDatos ?? [],
    fuente: datos.fuente === "detalle" ? "detalle" : "gold",
    bloqueadoPorGuardrail: Boolean(datos.bloqueadoPorGuardrail),
    tokensEntrada: datos.uso?.tokensEntrada ?? 0,
    tokensSalida: datos.uso?.tokensSalida ?? 0,
    segundos: (performance.now() - inicio) / 1000,
  };
}

/* ── Historial (solo modo lambda: la memoria del harness vive en
   AgentCore Memory, server-side, sin endpoint propio) ─────────────── */

export interface TurnoHistorial {
  quien: "usuario" | "agente";
  texto: string;
}

export async function cargarHistorial(
  config: Config,
  idToken: string,
  sesionId: string,
): Promise<TurnoHistorial[]> {
  if (config.modo !== "lambda" || !config.apiUrl) return [];

  const respuesta = await fetch(`${config.apiUrl}/historial`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: idToken },
    body: JSON.stringify({ sesionId }),
  });
  if (respuesta.status === 401) throw new SesionVencidaError();
  if (!respuesta.ok) throw new Error(await leerError(respuesta));
  const datos = await respuesta.json();
  return datos.turnos ?? [];
}

/* ── Adjuntos (solo modo lambda) ──────────────────────────────────── */

export async function subirImagen(config: Config, idToken: string, archivo: File): Promise<string> {
  if (!config.apiUrl) throw new Error("Los adjuntos no están disponibles en este modo.");

  const respuestaUrl = await fetch(`${config.apiUrl}/adjuntos/url`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: idToken },
    body: JSON.stringify({}),
  });
  if (respuestaUrl.status === 401) throw new SesionVencidaError();
  if (!respuestaUrl.ok) throw new Error(await leerError(respuestaUrl));
  const { url, clave } = await respuestaUrl.json();

  await fetch(url, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: archivo,
  });
  return clave;
}
