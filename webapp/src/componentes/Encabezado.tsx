import type { Fuente } from "../api";
import type { Modo } from "../config";

export interface EncabezadoProps {
  modo: Modo;
  fuente: Fuente;
  onFuenteChange: (fuente: Fuente) => void;
  onReiniciar: () => void;
  onSalir: () => void;
}

// Texto del subtítulo en modo harness: tal cual lo pide la consigna, no
// existe en pagina.ts como constante propia pero es el mismo <span class=sub>.
const SUBTITULO_HARNESS =
  "AgentCore Harness corre el loop · Gateway expone las tools MCP · Memory recuerda por sesión";

export default function Encabezado({ modo, fuente, onFuenteChange, onReiniciar, onSalir }: EncabezadoProps) {
  return (
    <header className="cabecera">
      <img src="/craftech-logo-oscuro.png" alt="Craftech" className="logo-chico" />
      <div className="titulo-cabecera">
        <strong>Craftech Store</strong>
        <span>{modo === "harness" ? SUBTITULO_HARNESS : "Asistente en línea"}</span>
      </div>

      {modo === "harness" && <span className="badge">FULL BEDROCK</span>}

      {modo === "lambda" && (
        // Demo gold vs detalle: elige qué capa del lakehouse ve el agente.
        // Es una decisión de plataforma que viaja en cada request; el
        // modelo no participa.
        <div
          className={`selector-fuente${fuente === "detalle" ? " riesgo" : ""}`}
          role="group"
          aria-label="Fuente de datos analíticos"
        >
          <button
            type="button"
            className={`opcion-fuente${fuente === "gold" ? " activa" : ""}`}
            onClick={() => onFuenteChange("gold")}
          >
            Gold
          </button>
          <button
            type="button"
            className={`opcion-fuente${fuente === "detalle" ? " activa" : ""}`}
            onClick={() => onFuenteChange("detalle")}
          >
            Detalle
          </button>
        </div>
      )}

      <button
        type="button"
        className="boton-texto"
        title="Borra la memoria de este teléfono y arranca de cero"
        onClick={onReiniciar}
      >
        Reiniciar memoria
      </button>
      <button type="button" className="boton-texto" onClick={onSalir}>
        Salir
      </button>
    </header>
  );
}
