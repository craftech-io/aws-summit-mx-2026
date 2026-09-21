import { formatearRespuesta } from "../formato";

export type Quien = "usuario" | "agente" | "sistema";

export interface BurbujaProps {
  quien: Quien;
  texto: string;
  urlImagen?: string;
}

/** Una burbuja de mensaje: usuario, agente o sistema (avisos de la UI). */
export default function Burbuja({ quien, texto, urlImagen }: BurbujaProps) {
  return (
    <div className={`mensaje ${quien}`}>
      {urlImagen && <img src={urlImagen} alt="Imagen adjunta" />}
      {texto &&
        (quien === "usuario" ? (
          // Lo del usuario se inserta como texto plano: no hay nada que
          // interpretar ahí.
          texto
        ) : (
          <div dangerouslySetInnerHTML={{ __html: formatearRespuesta(texto) }} />
        ))}
    </div>
  );
}
