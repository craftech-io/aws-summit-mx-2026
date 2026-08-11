import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { Config } from "../config";
import {
  cargarHistorial,
  enviarMensaje,
  SesionVencidaError,
  subirImagen,
  type Fuente,
} from "../api";
import Encabezado from "./Encabezado";
import Pildoras, { type PreguntaDemo } from "./Pildoras";
import Burbuja, { type Quien } from "./Burbuja";
import Consumo from "./Consumo";

interface ChatProps {
  config: Config;
  idToken: string;
  telefono: string;
  onSalir: () => void;
}

/** Un turno de la conversación o una línea de consumo, en el orden en que
 *  se van agregando a la pantalla (igual que el DOM de app.js). */
type Entrada =
  | { id: string; tipo: "mensaje"; quien: Quien; texto: string; urlImagen?: string }
  | { id: string; tipo: "consumo"; fuente: Fuente; tokensEntrada: number; tokensSalida: number; fuentesDatos: string[]; segundos: number };

// Omit normal no distribuye sobre uniones discriminadas: colapsaría Entrada
// a solo el campo común "tipo". Esta variante sí distribuye.
type OmitDistributivo<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type NuevaEntrada = OmitDistributivo<Entrada, "id">;

interface Traza {
  herramientas: string[];
  ultimoEntrada: number;
  ultimoSalida: number;
  fuente: Fuente;
}

const SALUDO_LAMBDA =
  "¡Hola! Soy el asistente de Craftech Store. Puedo ayudarte con tus pedidos, " +
  "consultas sobre envíos y devoluciones, o abrir un reclamo. ¿Qué necesitás?";

// Burbuja de bienvenida del modo harness: texto tal cual el que muestra
// pagina.ts al terminar el login.
const SALUDO_HARNESS =
  "¡Hola! Soy el agente de la tienda — la versión gestionada: AgentCore Harness corre mi loop " +
  "y el Gateway me da las herramientas. Preguntame por tus pedidos, políticas o reclamos.";

const TEXTO_GOLD =
  "Fuente cambiada a GOLD: el agente consulta la capa agregada, sin datos personales y solo de tu cuenta.";
const TEXTO_DETALLE =
  "Fuente cambiada a DETALLE: el agente consulta la tabla cruda, tal como haría conectado directo a la base analítica.";

const id = () => crypto.randomUUID();

/** La memoria se ata al teléfono: mismo número, misma conversación. */
function sesionDelTelefono(telefono: string): string {
  const clave = `sesion:${telefono}`;
  let sesion = localStorage.getItem(clave);
  if (!sesion) {
    sesion = crypto.randomUUID();
    localStorage.setItem(clave, sesion);
  }
  return sesion;
}

export default function Chat({ config, idToken, telefono, onSalir }: ChatProps) {
  const [sesionId, setSesionId] = useState<string | null>(null);
  const [entradas, setEntradas] = useState<Entrada[]>([]);
  const [fuente, setFuente] = useState<Fuente>("gold");
  const [entrada, setEntrada] = useState("");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [traza, setTraza] = useState<Traza | null>(null);
  const [tokensTotales, setTokensTotales] = useState({ entrada: 0, salida: 0 });

  const mensajesRef = useRef<HTMLElement>(null);
  const entradaRef = useRef<HTMLInputElement>(null);
  const archivoRef = useRef<HTMLInputElement>(null);

  const agregarEntrada = (nueva: NuevaEntrada) =>
    setEntradas((previas) => [...previas, { ...nueva, id: id() } as Entrada]);

  // Abrir el chat: resuelve la sesión atada al teléfono y repinta el
  // historial (solo modo lambda; en harness la memoria vive server-side
  // en AgentCore Memory, así que solo se muestra la bienvenida).
  useEffect(() => {
    let cancelado = false;
    async function abrir() {
      const nuevaSesion = sesionDelTelefono(telefono);
      if (cancelado) return;
      setSesionId(nuevaSesion);

      if (config.modo === "lambda") {
        try {
          const turnos = await cargarHistorial(config, idToken, nuevaSesion);
          if (cancelado) return;
          if (turnos.length) {
            setEntradas(
              turnos.map((t) => ({ id: id(), tipo: "mensaje", quien: t.quien, texto: t.texto }) as Entrada),
            );
            agregarEntrada({ tipo: "mensaje", quien: "sistema", texto: "Conversación recuperada: el agente recuerda lo anterior." });
            return;
          }
        } catch (error) {
          if (error instanceof SesionVencidaError) {
            onSalir();
            return;
          }
          // Si el historial no responde, la conversación arranca igual.
        }
        agregarEntrada({ tipo: "mensaje", quien: "agente", texto: SALUDO_LAMBDA });
      } else {
        agregarEntrada({ tipo: "mensaje", quien: "agente", texto: SALUDO_HARNESS });
      }
    }
    abrir();
    return () => {
      cancelado = true;
    };
    // Se ejecuta una sola vez al montar: es la apertura inicial del chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mensajesRef.current) mensajesRef.current.scrollTop = mensajesRef.current.scrollHeight;
  }, [entradas, enviando]);

  function manejarCambioFuente(nuevaFuente: Fuente) {
    setFuente(nuevaFuente);
    agregarEntrada({
      tipo: "mensaje",
      quien: "sistema",
      texto: nuevaFuente === "gold" ? TEXTO_GOLD : TEXTO_DETALLE,
    });
  }

  function manejarSeleccionPregunta(pregunta: PreguntaDemo) {
    if (config.modo === "lambda") manejarCambioFuente(pregunta.fuente);
    setEntrada(pregunta.texto);
    entradaRef.current?.focus();
  }

  function manejarArchivo(evento: ChangeEvent<HTMLInputElement>) {
    setArchivo(evento.target.files?.[0] ?? null);
  }

  /** Borra la memoria de este teléfono y arranca una conversación nueva. */
  function reiniciarMemoria() {
    if (config.modo === "lambda") localStorage.removeItem(`sesion:${telefono}`);
    setSesionId(sesionDelTelefono(telefono));
    setTokensTotales({ entrada: 0, salida: 0 });
    setTraza(null);
    setEntradas([]);
    if (config.modo === "lambda") {
      agregarEntrada({ tipo: "mensaje", quien: "sistema", texto: "Memoria reiniciada: conversación nueva desde cero." });
      agregarEntrada({ tipo: "mensaje", quien: "agente", texto: SALUDO_LAMBDA });
    } else {
      agregarEntrada({
        tipo: "mensaje",
        quien: "agente",
        texto: "Memoria reiniciada: sesión nueva en AgentCore Memory. Empecemos de cero.",
      });
    }
    entradaRef.current?.focus();
  }

  async function alEnviar(evento: FormEvent) {
    evento.preventDefault();
    const texto = entrada.trim();
    if (!texto && !archivo) return;
    if (!sesionId) return;

    setEnviando(true);
    setEntrada("");

    const vistaPrevia = archivo ? URL.createObjectURL(archivo) : undefined;
    agregarEntrada({ tipo: "mensaje", quien: "usuario", texto, urlImagen: vistaPrevia });

    try {
      let adjuntoClave: string | null = null;
      if (archivo && config.modo === "lambda") {
        adjuntoClave = await subirImagen(config, idToken, archivo);
        setArchivo(null);
        if (archivoRef.current) archivoRef.current.value = "";
      }

      const resultado = await enviarMensaje(config, idToken, { sesionId, mensaje: texto, adjuntoClave, fuente });

      agregarEntrada({ tipo: "mensaje", quien: "agente", texto: resultado.texto });
      agregarEntrada({
        tipo: "consumo",
        fuente: resultado.fuente,
        tokensEntrada: resultado.tokensEntrada,
        tokensSalida: resultado.tokensSalida,
        fuentesDatos: resultado.fuentesDatos,
        segundos: resultado.segundos,
      });

      if (config.modo === "lambda") {
        setTraza({
          herramientas: resultado.herramientas,
          ultimoEntrada: resultado.tokensEntrada,
          ultimoSalida: resultado.tokensSalida,
          fuente: resultado.fuente,
        });
        setTokensTotales((t) => ({
          entrada: t.entrada + resultado.tokensEntrada,
          salida: t.salida + resultado.tokensSalida,
        }));
      }

      if (resultado.bloqueadoPorGuardrail) {
        agregarEntrada({ tipo: "mensaje", quien: "sistema", texto: "El guardrail intervino en este intercambio." });
      }
    } catch (error) {
      if (error instanceof SesionVencidaError) {
        onSalir();
        return;
      }
      const mensajeError = error instanceof Error ? error.message : String(error);
      agregarEntrada({ tipo: "mensaje", quien: "sistema", texto: `No pude procesar eso: ${mensajeError}` });
    } finally {
      setEnviando(false);
      entradaRef.current?.focus();
    }
  }

  return (
    <section id="pantalla-chat" className="pantalla">
      <Encabezado
        modo={config.modo}
        fuente={fuente}
        onFuenteChange={manejarCambioFuente}
        onReiniciar={reiniciarMemoria}
        onSalir={onSalir}
      />

      <main id="mensajes" className="mensajes" ref={mensajesRef}>
        {entradas.map((e) =>
          e.tipo === "mensaje" ? (
            <Burbuja key={e.id} quien={e.quien} texto={e.texto} urlImagen={e.urlImagen} />
          ) : (
            <Consumo
              key={e.id}
              fuente={e.fuente}
              tokensEntrada={e.tokensEntrada}
              tokensSalida={e.tokensSalida}
              fuentesDatos={e.fuentesDatos}
              segundos={e.segundos}
            />
          ),
        )}
        {enviando && (
          <div className="escribiendo">
            <span />
            <span />
            <span />
          </div>
        )}
      </main>

      {config.modo === "lambda" && traza && (
        <div id="panel-traza" className="panel-traza">
          <div className="traza-fila">
            <span className="traza-etiqueta">Herramientas</span>
            <span>{traza.herramientas.length ? traza.herramientas.join(" · ") : "ninguna (respondió de contexto)"}</span>
          </div>
          <div className="traza-fila">
            <span className="traza-etiqueta">Último intercambio</span>
            <span>{`${traza.ultimoEntrada} entrada · ${traza.ultimoSalida} salida · fuente ${traza.fuente}`}</span>
          </div>
          <div className="traza-fila">
            <span className="traza-etiqueta">Tokens de la sesión</span>
            <span>{`${tokensTotales.entrada.toLocaleString("es")} entrada · ${tokensTotales.salida.toLocaleString("es")} salida`}</span>
          </div>
        </div>
      )}

      <Pildoras modo={config.modo} onSeleccionar={manejarSeleccionPregunta} />

      <form className="barra-envio" onSubmit={alEnviar}>
        {config.modo === "lambda" && (
          <label className="boton-adjuntar" title="Adjuntar una foto">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path
                d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3.5 3.5 0 014.95 4.95l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <input ref={archivoRef} type="file" accept="image/*" hidden onChange={manejarArchivo} />
          </label>
        )}
        <input
          id="entrada"
          ref={entradaRef}
          type="text"
          placeholder="Escribí tu consulta…"
          autoComplete="off"
          required
          value={entrada}
          onChange={(e) => setEntrada(e.target.value)}
        />
        <button type="submit" className="boton-enviar" aria-label="Enviar" disabled={enviando}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path
              d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </form>
      {config.modo === "lambda" && archivo && <p className="adjunto">Foto lista para enviar: {archivo.name}</p>}
    </section>
  );
}
