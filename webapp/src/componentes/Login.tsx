import { useState, type FormEvent } from "react";
import type { Config } from "../config";
import { pedirCodigo, verificarCodigo } from "../api";

interface LoginProps {
  config: Config;
  onIngresar: (telefono: string, idToken: string) => void;
}

type Paso = "telefono" | "codigo";

export default function Login({ config, onIngresar }: LoginProps) {
  const [paso, setPaso] = useState<Paso>("telefono");
  const [telefono, setTelefono] = useState("");
  const [codigo, setCodigo] = useState("");
  const [sesionCognito, setSesionCognito] = useState<string | null>(null);
  const [pistaCodigo, setPistaCodigo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function alEnviarTelefono(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      const numero = telefono.replace(/[\s-()]/g, "");
      if (!numero.startsWith("+")) {
        throw new Error("Poné el número con código de país, por ejemplo +5215512345678");
      }
      setTelefono(numero);

      const { session, codigoDemo, telefonoDestino } = await pedirCodigo(config, numero);
      setSesionCognito(session);
      setPistaCodigo(
        codigoDemo ? `Modo demo — tu código es ${codigoDemo}` : `Te lo mandamos al ${telefonoDestino ?? "número indicado"}`,
      );
      setPaso("codigo");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnviando(false);
    }
  }

  async function alEnviarCodigo(evento: FormEvent) {
    evento.preventDefault();
    setError(null);
    setEnviando(true);
    try {
      if (!sesionCognito) throw new Error("Pedí el código de nuevo.");
      const resultado = await verificarCodigo(config, telefono, sesionCognito, codigo.trim());
      if (!resultado.idToken) {
        // Cognito devuelve una sesión nueva por cada intento fallido.
        setSesionCognito(resultado.session ?? null);
        throw new Error("El código no coincide. Probá de nuevo.");
      }
      onIngresar(telefono, resultado.idToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCodigo("");
    } finally {
      setEnviando(false);
    }
  }

  function volver() {
    setPaso("telefono");
    setError(null);
  }

  return (
    <section id="pantalla-login" className="pantalla">
      <div className="tarjeta-login">
        <img src="/craftech-logo.png" alt="Craftech" className="logo" />
        <h1>Atención al cliente</h1>
        <p className="bajada">Ingresá con tu celular. Te mandamos un código por SMS.</p>

        {paso === "telefono" && (
          <form onSubmit={alEnviarTelefono}>
            <label htmlFor="telefono">Número de celular</label>
            <input
              id="telefono"
              type="tel"
              placeholder="+52 55 1234 5678"
              autoComplete="tel"
              required
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
            />
            <small>Con código de país, por ejemplo +5215512345678</small>
            <button type="submit" className="boton-primario" disabled={enviando}>
              {enviando ? "Enviando…" : "Enviarme el código"}
            </button>
          </form>
        )}

        {paso === "codigo" && (
          <form onSubmit={alEnviarCodigo}>
            <label htmlFor="codigo">Código de 6 dígitos</label>
            <input
              id="codigo"
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              autoComplete="one-time-code"
              required
              autoFocus
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
            />
            <small id="pista-codigo">{pistaCodigo}</small>
            <button type="submit" className="boton-primario" disabled={enviando}>
              {enviando ? "Verificando…" : "Ingresar"}
            </button>
            <button type="button" className="boton-secundario" onClick={volver}>
              Cambiar número
            </button>
          </form>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}
