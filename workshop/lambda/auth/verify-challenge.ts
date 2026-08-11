// Compara el código que tipeó el usuario con el que emitimos.
import { timingSafeEqual } from "node:crypto";
import type { VerifyAuthChallengeResponseTriggerHandler } from "aws-lambda";

export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event) => {
  const esperado = event.request.privateChallengeParameters?.codigo ?? "";
  const recibido = event.request.challengeAnswer ?? "";

  event.response.answerCorrect = comparar(esperado, recibido);
  return event;
};

// Comparación de tiempo constante: no filtra cuántos dígitos acertaste.
function comparar(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
