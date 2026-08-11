// Embeddings con Amazon Titan. Se usa tanto al indexar (script de seed)
// como al consultar (servidor MCP de conocimiento).
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const cliente = new BedrockRuntimeClient({});
const MODELO = process.env.MODELO_EMBEDDINGS ?? "amazon.titan-embed-text-v2:0";

export async function generarEmbedding(texto: string): Promise<number[]> {
  const respuesta = await cliente.send(
    new InvokeModelCommand({
      modelId: MODELO,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: texto, dimensions: 512, normalize: true }),
    }),
  );

  const cuerpo = JSON.parse(new TextDecoder().decode(respuesta.body));
  return cuerpo.embedding as number[];
}
