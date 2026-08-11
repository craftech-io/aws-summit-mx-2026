// Auto-confirma el alta. En un login sin contraseña no hay nada que
// confirmar por separado: la prueba de identidad es el SMS del paso siguiente.
//
// En producción acá va la validación de quién puede registrarse (dominio de
// correo, lista blanca de teléfonos, invitación previa).
import type { PreSignUpTriggerHandler } from "aws-lambda";

export const handler: PreSignUpTriggerHandler = async (event) => {
  event.response.autoConfirmUser = true;
  event.response.autoVerifyPhone = true;
  return event;
};
