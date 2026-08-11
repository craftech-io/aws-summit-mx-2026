#!/usr/bin/env node
// Punto de entrada del workshop. Cinco stacks, desplegados en orden de dependencia.
import * as cdk from "aws-cdk-lib";
import { DataStack } from "../lib/data-stack";
import { AuthStack } from "../lib/auth-stack";
import { AgentStack } from "../lib/agent-stack";
import { WebStack } from "../lib/web-stack";
import { LakehouseStack } from "../lib/lakehouse-stack";

const app = new cdk.App();

const prefijo = app.node.tryGetContext("prefijo") ?? "summit";
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
};

const tags = {
  Proyecto: "aws-summit-mx",
  Owner: "craftech",
  Ambiente: "workshop",
};

// 1. Datos: tablas DynamoDB + bucket de adjuntos.
const datos = new DataStack(app, `${prefijo}-datos`, { env, prefijo });

// 2. Autenticación: Cognito con login por SMS (custom auth passwordless).
const auth = new AuthStack(app, `${prefijo}-auth`, { env, prefijo });

// 3. Lakehouse: S3 Tables con la capa gold y la de detalle, para el
//    experimento gold vs detalle.
const lakehouse = new LakehouseStack(app, `${prefijo}-lakehouse`, { env, prefijo });

// 4. Agente: Guardrail de Bedrock + Lambda orquestadora + API HTTP.
const agente = new AgentStack(app, `${prefijo}-agente`, {
  env,
  prefijo,
  datos,
  tablaPedidos: datos.tablaPedidos,
  tablaConversaciones: datos.tablaConversaciones,
  tablaTickets: datos.tablaTickets,
  tablaVectores: datos.tablaVectores,
  bucketAdjuntos: datos.bucketAdjuntos,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  lakehouse,
});

// 5. Web: sitio estático en S3 detrás de CloudFront.
new WebStack(app, `${prefijo}-web`, {
  env,
  prefijo,
  apiUrl: agente.apiUrl,
  chatUrl: agente.chatUrl,
  userPoolId: auth.userPool.userPoolId,
  userPoolClientId: auth.userPoolClient.userPoolClientId,
});

for (const [clave, valor] of Object.entries(tags)) {
  cdk.Tags.of(app).add(clave, valor);
}
