#!/usr/bin/env node
// Punto de entrada de la versión full Bedrock. Un solo stack: el plano de
// datos (tablas, KB, lakehouse) ya lo desplegó el workshop principal.
import * as cdk from "aws-cdk-lib";
import { FullBedrockStack } from "../lib/full-stack";

const app = new cdk.App();
const prefijo = app.node.tryGetContext("prefijo") ?? "summit";

new FullBedrockStack(app, `${prefijo}-full`, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
  prefijo,
});

cdk.Tags.of(app).add("Proyecto", "aws-summit-mx");
cdk.Tags.of(app).add("Owner", "craftech");
cdk.Tags.of(app).add("Ambiente", "workshop-full-bedrock");
