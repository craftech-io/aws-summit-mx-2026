# AWS Summit México — Craftech

Material de las dos sesiones de Craftech en el AWS Summit México: las
presentaciones y el laboratorio hands-on.

| Sesión | Tema |
|---|---|
| **Data** | Datos listos para IA: lakehouse, gobierno y seguridad |
| **AI** | De la POC a producción: optimizar, asegurar y escalar agentes en AWS |

## Contenido

```
.
├── presentaciones/         Las dos presentaciones en PDF
├── workshop/               El laboratorio: agente de atención al cliente con AWS CDK
└── workshop-full-bedrock/  El mismo agente sobre la suite gestionada (AgentCore)
```

### [`presentaciones/`](presentaciones/)

| Archivo | Qué es |
|---|---|
| [`01-data-para-ia.pdf`](presentaciones/01-data-para-ia.pdf) | Sesión de Data |
| [`02-ai-agentes-en-aws.pdf`](presentaciones/02-ai-agentes-en-aws.pdf) | Sesión de AI |

### [`workshop/`](workshop/)

El laboratorio de la sesión de AI: un agente de atención al cliente 100%
serverless que desplegás con AWS CDK en tu propia cuenta.

- Login por SMS con Cognito (passwordless)
- Claude Opus 5 en Bedrock vía Converse API, con soporte de imágenes
- Memoria de conversación en Bedrock AgentCore Memory
- Cuatro servidores MCP: pedidos (DynamoDB), base de conocimiento
  (Bedrock Knowledge Bases sobre S3 Vectors), reclamos y ventas
  (un lakehouse en S3 Tables consultado por Athena)
- Guardrails de Bedrock activos
- Endpoint MCP (JSON-RPC) para conectar clientes externos

La guía paso a paso está en [`workshop/README.md`](workshop/README.md):

```bash
cd workshop
npm install
npx cdk bootstrap   # solo la primera vez en la cuenta
npm run deploy
```

### [`workshop-full-bedrock/`](workshop-full-bedrock/)

El mismo agente, con el andamiaje gestionado: **AgentCore Harness** corre el
loop, **AgentCore Gateway** expone las mismas herramientas como servidor MCP
y la memoria sigue en **AgentCore Memory**. Se despliega encima del workshop
principal (reutiliza sus datos) y se conversa por terminal con streaming.
El contraste entre las dos versiones — el loop a mano vs. el loop como
servicio — es parte del contenido de la sesión.

---

Hecho por [Craftech](https://craftech.io) · AWS Advanced Tier Partner
