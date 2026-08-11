// Genera el código de un solo uso y lo manda por SMS.
//
// Ojo en el laboratorio: SNS arranca en modo sandbox y solo entrega SMS a
// números verificados en la consola. Con MODO_DEMO=true el código también
// viaja en los parámetros públicos del desafío para que puedas seguir el
// ejercicio aunque el SMS no llegue. Nunca hagas esto en producción.
import { randomInt } from "node:crypto";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import type { CreateAuthChallengeTriggerHandler } from "aws-lambda";

const sns = new SNSClient({});
const MODO_DEMO = process.env.MODO_DEMO === "true";

export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  let codigo: string;

  if (event.request.session && event.request.session.length > 0) {
    // Reintento del mismo login: se reutiliza el código ya emitido.
    const previo = event.request.session[event.request.session.length - 1];
    codigo = previo.challengeMetadata?.replace("CODIGO-", "") ?? generarCodigo();
  } else {
    codigo = generarCodigo();
    const telefono = event.request.userAttributes.phone_number;

    if (telefono) {
      try {
        await sns.send(
          new PublishCommand({
            PhoneNumber: telefono,
            Message: `Tu código de acceso es ${codigo}. Vence en 3 minutos.`,
            MessageAttributes: {
              "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" },
            },
          }),
        );
      } catch (error) {
        // No cortamos el login: en sandbox de SNS el envío falla seguido.
        console.error("No se pudo enviar el SMS", error);
      }
    }
  }

  event.response.publicChallengeParameters = {
    telefono: enmascarar(event.request.userAttributes.phone_number ?? ""),
    ...(MODO_DEMO ? { codigoDemo: codigo } : {}),
  };
  event.response.privateChallengeParameters = { codigo };
  event.response.challengeMetadata = `CODIGO-${codigo}`;

  return event;
};

function generarCodigo(): string {
  return String(randomInt(100000, 1000000));
}

function enmascarar(telefono: string): string {
  if (telefono.length < 4) return "***";
  return `${"*".repeat(Math.max(0, telefono.length - 4))}${telefono.slice(-4)}`;
}
