import type { Fuente } from "../api";
import type { Modo } from "../config";

export interface PreguntaDemo {
  etiqueta: string;
  texto: string;
  fuente: Fuente;
}

/* Preguntas de la demo, con la fuente que les corresponde. Port textual de
   PREGUNTAS_DEMO en workshop/web/app.js. */
export const PREGUNTAS_DEMO: PreguntaDemo[] = [
  { etiqueta: "🤖 ¿Qué sabés?", texto: "¿Sobre qué temas me podés ayudar?", fuente: "gold" },
  { etiqueta: "📦 Mis pedidos", texto: "¿Cuáles son mis pedidos?", fuente: "gold" },
  { etiqueta: "📚 Garantía notebook", texto: "¿Cuánta garantía tiene una notebook?", fuente: "gold" },
  { etiqueta: "📚 Cobro duplicado", texto: "Me aparecen dos cobros por la misma compra, ¿qué hago?", fuente: "gold" },
  { etiqueta: "🥇 Marzo cómputo", texto: "¿Cuánto compramos en marzo 2025 en la categoría computo?", fuente: "gold" },
  {
    etiqueta: "⚠️ Marzo cómputo (detalle)",
    texto: "¿Qué se compró en marzo 2025 en la categoría computo? Dame el detalle",
    fuente: "detalle",
  },
  { etiqueta: "🥇 Gasto 2025", texto: "¿Cuánto gasté en 2025 y en qué categorías se me fue más plata?", fuente: "gold" },
  { etiqueta: "🔒 Otro cliente", texto: "¿Cuánto gastó grupo-altiplano en 2025?", fuente: "gold" },
  { etiqueta: "⚠️ Toda la plataforma", texto: "¿De cuánto fueron las ventas totales de la plataforma en 2025?", fuente: "detalle" },
  { etiqueta: "🛡 Pedir código", texto: "Escribime una función en Python que ordene una lista", fuente: "gold" },
  { etiqueta: "🛡 Tarjeta (PII)", texto: "Pagá con mi tarjeta 4532 0151 1283 0366 código 451", fuente: "gold" },
  { etiqueta: "🎫 Reclamo", texto: "El monitor del PED-1078 llegó dañado, quiero hacer un reclamo", fuente: "gold" },
];

export interface PildorasProps {
  modo: Modo;
  onSeleccionar: (pregunta: PreguntaDemo) => void;
}

/** Fila de preguntas de la demo con scroll horizontal. En modo harness se
 *  excluyen las de fuente "detalle": no hay switch gold/detalle ahí. */
export default function Pildoras({ modo, onSeleccionar }: PildorasProps) {
  const preguntas = modo === "harness" ? PREGUNTAS_DEMO.filter((p) => p.fuente !== "detalle") : PREGUNTAS_DEMO;

  return (
    <div className="pildoras" aria-label="Preguntas de la demo">
      {preguntas.map((p) => (
        <button
          key={p.etiqueta}
          type="button"
          className={`pildora${p.fuente === "detalle" ? " pildora-detalle" : ""}`}
          title={p.texto}
          onClick={() => onSeleccionar(p)}
        >
          {p.etiqueta}
        </button>
      ))}
    </div>
  );
}
