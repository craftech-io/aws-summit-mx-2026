import { useEffect, useState } from "react";
import { cargarConfig, telefonoValido, type Config } from "./config";
import Login from "./componentes/Login";
import Chat from "./componentes/Chat";

const CLAVE_TOKEN = "idToken";
const CLAVE_TELEFONO = "ultimoTelefono";

const TITULO_LAMBDA = "Craftech Store — Atención al cliente";
const TITULO_HARNESS = "El mismo agente, gestionado — AgentCore";

/** Higiene: versiones previas podían dejar claves envenenadas. */
function telefonoGuardado(): string | null {
  const guardado = localStorage.getItem(CLAVE_TELEFONO);
  if (!telefonoValido(guardado)) {
    localStorage.removeItem(CLAVE_TELEFONO);
    localStorage.removeItem("sesion:null");
    return null;
  }
  return guardado;
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [errorConfig, setErrorConfig] = useState<string | null>(null);
  const [idToken, setIdToken] = useState<string | null>(() => sessionStorage.getItem(CLAVE_TOKEN));
  const [telefono, setTelefono] = useState<string | null>(telefonoGuardado);

  useEffect(() => {
    let cancelado = false;
    cargarConfig()
      .then((c) => {
        if (cancelado) return;
        setConfig(c);
        document.title = c.modo === "harness" ? TITULO_HARNESS : TITULO_LAMBDA;
      })
      .catch((error: unknown) => {
        if (cancelado) return;
        setErrorConfig(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelado = true;
    };
  }, []);

  function alIngresar(telefonoIngresado: string, token: string) {
    sessionStorage.setItem(CLAVE_TOKEN, token);
    localStorage.setItem(CLAVE_TELEFONO, telefonoIngresado);
    setTelefono(telefonoIngresado);
    setIdToken(token);
  }

  function cerrarSesion() {
    sessionStorage.removeItem(CLAVE_TOKEN);
    setIdToken(null);
  }

  if (errorConfig) {
    return (
      <div className="pantalla-error">No se pudo cargar la configuración: {errorConfig}</div>
    );
  }
  if (!config) {
    return <div className="pantalla-cargando">Cargando…</div>;
  }

  return idToken && telefonoValido(telefono) ? (
    <Chat config={config} idToken={idToken} telefono={telefono} onSalir={cerrarSesion} />
  ) : (
    <Login config={config} onIngresar={alIngresar} />
  );
}
