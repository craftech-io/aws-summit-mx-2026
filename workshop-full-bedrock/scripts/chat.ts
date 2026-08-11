// Chat de terminal contra el Harness gestionado.
//
//   npm run chat -- <clienteId>              # sesión nueva, interactivo
//   npm run chat -- <clienteId> "mensaje"    # un solo turno y sale
//   SESION=mi-sesion npm run chat -- <id>    # retomar una sesión (memoria)
//
// El clienteId es el «sub» de Cognito que usaste en el workshop principal
// (aparece en la app después del login). El historial NO viaja desde acá:
// vive en AgentCore Memory, atado al actor y la sesión — mandamos solo el
// mensaje nuevo en cada turno, igual que hace la UI del workshop.
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { promptConCliente } from "../lib/prompt";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const PREFIJO = process.env.PREFIJO ?? "summit";

const clienteId = process.argv[2];
if (!clienteId) {
  console.error("Falta el clienteId.\n\n  npm run chat -- <clienteId>\n");
  process.exit(1);
}

const agentcore = new BedrockAgentCoreClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

async function salidaStack(nombre: string, clave: string): Promise<{ valor: string; cuenta: string }> {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: nombre }));
  const stack = r.Stacks?.[0];
  const valor = stack?.Outputs?.find((o) => o.OutputKey === clave)?.OutputValue;
  if (!valor) throw new Error(`No encontré la salida ${clave} del stack ${nombre}. ¿Está desplegado?`);
  // El StackId es un ARN: la cuenta viaja ahí, sin depender del entorno.
  const cuenta = stack!.StackId!.split(":")[4];
  return { valor, cuenta };
}

async function main() {
  const { valor: harnessId, cuenta } = await salidaStack(`${PREFIJO}-full`, "HarnessId");
  const harnessArn = `arn:aws:bedrock-agentcore:${REGION}:${cuenta}:harness/${harnessId}`;

  // El servicio exige sesiones de al menos 33 caracteres; las cortas se
  // paddean de forma determinística para que retomarlas siga funcionando.
  const sesion = (process.env.SESION ?? `full-${randomUUID()}`).padEnd(33, "0");
  console.log(`Harness: ${harnessId} · sesión: ${sesion}`);

  const enviar = async (mensaje: string) => {
    const inicio = Date.now();
    const r = await agentcore.send(
      new InvokeHarnessCommand({
        harnessArn,
        runtimeSessionId: sesion,
        actorId: clienteId,
        systemPrompt: [{ text: promptConCliente(clienteId) }],
        messages: [{ role: "user", content: [{ text: mensaje }] }],
      }),
    );
    process.stdout.write("\nagente › ");
    let tools = 0;
    for await (const evento of r.stream ?? []) {
      const delta = (evento as any).contentBlockDelta?.delta;
      if (delta?.text) process.stdout.write(delta.text);
      const start = (evento as any).contentBlockStart?.start;
      if (start?.toolUse?.name) {
        tools++;
        process.stdout.write(`\n  ⚙ ${start.toolUse.name}\n`);
      }
      const meta = (evento as any).metadata;
      if (meta?.usage) {
        const u = meta.usage;
        process.stdout.write(
          `\n\n  ⏱ ${((Date.now() - inicio) / 1000).toFixed(1)}s · ` +
            `tokens: ${u.inputTokens ?? "?"} entrada / ${u.outputTokens ?? "?"} salida` +
            (tools ? ` · ${tools} tool calls` : ""),
        );
      }
    }
    process.stdout.write("\n\n");
  };

  // Modo one-shot: un turno y sale. Lo usa el test end-to-end.
  const unSolo = process.argv[3];
  if (unSolo) {
    await enviar(unSolo);
    return;
  }

  console.log("La memoria es por sesión: retomala con  SESION=" + sesion + " npm run chat -- " + clienteId);
  console.log("Escribí tu mensaje (Ctrl+C para salir):\n");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("close", () => process.exit(0));
  const preguntar = () =>
    rl.question("vos › ", async (texto) => {
      const mensaje = texto.trim();
      if (mensaje) {
        try {
          await enviar(mensaje);
        } catch (error) {
          console.error("\nError invocando el Harness:", error instanceof Error ? error.message : error);
        }
      }
      preguntar();
    });
  preguntar();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
