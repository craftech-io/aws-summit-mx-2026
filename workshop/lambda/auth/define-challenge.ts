// Decide el siguiente paso del login. Con tres intentos fallidos, corta.
import type { DefineAuthChallengeTriggerHandler } from "aws-lambda";

const MAX_INTENTOS = 3;

export const handler: DefineAuthChallengeTriggerHandler = async (event) => {
  const sesiones = event.request.session ?? [];

  // Usuario inexistente: Cognito lo marca así. Cortamos sin filtrar
  // si el número existe o no (evita enumeración de usuarios).
  if (event.request.userNotFound) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  const ultima = sesiones[sesiones.length - 1];

  if (ultima?.challengeName === "CUSTOM_CHALLENGE" && ultima.challengeResult === true) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
    return event;
  }

  if (sesiones.length >= MAX_INTENTOS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  event.response.issueTokens = false;
  event.response.failAuthentication = false;
  event.response.challengeName = "CUSTOM_CHALLENGE";
  return event;
};
