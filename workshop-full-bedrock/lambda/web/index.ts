// El puente web al Harness: una Function URL que sirve la página de demo y
// traduce cada mensaje del navegador en un InvokeHarness.
//
// La mejora sobre el chat de terminal está en la identidad: acá el clienteId
// sale del id_token de Cognito VERIFICADO en este handler — el navegador no
// puede elegir ser otro cliente. (El viaje del clienteId hacia las tools
// sigue siendo por prompt: esa discusión está en el README.)
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { BedrockAgentCoreClient, InvokeHarnessCommand } from "@aws-sdk/client-bedrock-agentcore";
import { BedrockRuntimeClient, ApplyGuardrailCommand } from "@aws-sdk/client-bedrock-runtime";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { promptConCliente } from "../../lib/prompt";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const PREFIJO = process.env.PREFIJO ?? "summit";
const HARNESS_ARN = process.env.HARNESS_ARN!;

const agentcore = new BedrockAgentCoreClient({});
const bedrock = new BedrockRuntimeClient({});
const cfn = new CloudFormationClient({});

// El user pool es el del workshop principal, y el guardrail también: se
// resuelven una vez por cold start leyendo las salidas de sus stacks, para
// no acoplar los deploys.
let config: { region: string; userPoolId: string; clientId: string } | null = null;
let guardrail: { id: string; version: string } | null = null;
let verificador: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

async function salidas(stack: string) {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  return (clave: string) =>
    r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === clave)?.OutputValue ?? "";
}

async function cargarConfig() {
  if (config) return config;
  const auth = await salidas(`${PREFIJO}-auth`);
  config = { region: REGION, userPoolId: auth("UserPoolId"), clientId: auth("UserPoolClientId") };
  verificador = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    tokenUse: "id",
    clientId: config.clientId,
  });
  try {
    const agente = await salidas(`${PREFIJO}-agente`);
    const id = agente("GuardrailId");
    const version = agente("GuardrailVersionOut");
    if (id) guardrail = { id, version: version || "DRAFT" };
  } catch {
    // Sin el stack del workshop principal no hay guardrail: se sigue sin él.
    guardrail = null;
  }
  return config;
}

/** El Harness no aplica guardrails por sí mismo (su model config no los
 *  acepta): acá se aplican a mano con ApplyGuardrail, el MISMO guardrail
 *  calibrado del workshop principal, sobre la entrada y sobre la salida. */
async function aplicarGuardrail(texto: string, fuente: "INPUT" | "OUTPUT") {
  if (!guardrail || !texto) return { bloqueado: false as const, texto };
  const r = await bedrock.send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: guardrail.id,
      guardrailVersion: guardrail.version,
      source: fuente,
      content: [{ text: { text: texto } }],
    }),
  );
  if (r.action === "GUARDRAIL_INTERVENED") {
    const mensaje = r.outputs?.[0]?.text ?? "No puedo ayudarte con eso.";
    return { bloqueado: true as const, texto: mensaje };
  }
  return { bloqueado: false as const, texto };
}

const respuesta = (status: number, cuerpo: string, tipo = "application/json") => ({
  statusCode: status,
  headers: { "content-type": tipo },
  body: cuerpo,
});

export const handler = async (event: any) => {
  const metodo = event.requestContext?.http?.method ?? "GET";
  const ruta = event.rawPath ?? "/";
  const cfg = await cargarConfig();

  // La interfaz vive en CloudFront (la webapp React compartida); este puente
  // solo expone la config de Cognito y el chat.
  if (metodo === "GET") {
    if (ruta.endsWith("/config")) return respuesta(200, JSON.stringify(cfg));
    return respuesta(200, JSON.stringify({ info: "La demo vive en la URL del sitio (salida UrlDemo del stack)." }));
  }

  if (metodo === "POST" && ruta.endsWith("/chat")) {
    let sub: string;
    try {
      const token = (event.headers?.authorization ?? "").replace(/^Bearer /i, "");
      sub = String((await verificador!.verify(token)).sub);
    } catch {
      return respuesta(401, JSON.stringify({ error: "Token inválido o vencido: volvé a ingresar." }));
    }

    const { mensaje, sesionId } = JSON.parse(event.body ?? "{}");
    if (!mensaje) return respuesta(400, JSON.stringify({ error: "Falta el mensaje." }));

    const inicio = Date.now();

    // Guardrail sobre la ENTRADA: si interviene, el Harness ni se entera.
    const entrada = await aplicarGuardrail(String(mensaje), "INPUT");
    if (entrada.bloqueado) {
      return respuesta(200, JSON.stringify({
        texto: entrada.texto,
        tools: [],
        guardrail: "entrada",
        ms: Date.now() - inicio,
      }));
    }

    const r = await agentcore.send(
      new InvokeHarnessCommand({
        harnessArn: HARNESS_ARN,
        runtimeSessionId: String(sesionId ?? `web-${sub}`).padEnd(33, "0"),
        actorId: sub,
        systemPrompt: [{ text: promptConCliente(sub) }],
        messages: [{ role: "user", content: [{ text: String(mensaje) }] }],
      }),
    );

    let texto = "";
    const tools: string[] = [];
    let usage: any = null;
    for await (const evento of r.stream ?? []) {
      const delta = (evento as any).contentBlockDelta?.delta;
      if (delta?.text) texto += delta.text;
      const start = (evento as any).contentBlockStart?.start;
      if (start?.toolUse?.name) tools.push(start.toolUse.name);
      const meta = (evento as any).metadata;
      if (meta?.usage) usage = { inputTokens: meta.usage.inputTokens, outputTokens: meta.usage.outputTokens };
    }

    // Guardrail sobre la SALIDA: la respuesta completa pasa una sola vez —
    // entrega por bloques, no streaming fino (el argumento del deck).
    const salida = await aplicarGuardrail(texto, "OUTPUT");
    return respuesta(200, JSON.stringify({
      texto: salida.texto,
      tools,
      usage,
      ...(salida.bloqueado ? { guardrail: "salida" } : {}),
      ms: Date.now() - inicio,
    }));
  }

  return respuesta(404, JSON.stringify({ error: "No existe esa ruta." }));
};
