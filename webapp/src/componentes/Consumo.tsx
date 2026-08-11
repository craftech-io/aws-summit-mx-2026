import type { Fuente } from "../api";

export interface ConsumoProps {
  fuente: Fuente;
  tokensEntrada: number;
  tokensSalida: number;
  fuentesDatos: string[];
  segundos: number;
}

const fmt = (n: number) => n.toLocaleString("es-AR");

/**
 * Línea de consumo debajo de cada respuesta: cuánto costó ESTA interacción.
 * Es el número que se compara en vivo al alternar entre gold y detalle
 * (modo lambda) o simplemente el costo del turno (modo harness, siempre
 * gold). Port directo de agregarConsumo en workshop/web/app.js.
 */
export default function Consumo({ fuente, tokensEntrada, tokensSalida, fuentesDatos, segundos }: ConsumoProps) {
  const partes = [
    `⏱ ${segundos ? segundos.toFixed(1).replace(".", ",") : "?"} s`,
    `${fmt(tokensEntrada)} + ${fmt(tokensSalida)} = ${fmt(tokensEntrada + tokensSalida)} tokens`,
    `modo ${fuente}`,
  ];
  if (fuentesDatos.length) partes.push(`fue a: ${fuentesDatos.join(" · ")}`);

  return (
    <div className={`consumo ${fuente === "detalle" ? "consumo-detalle" : "consumo-gold"}`}>
      {partes.join("  ·  ")}
    </div>
  );
}
