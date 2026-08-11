export type Quien = "usuario" | "agente" | "sistema";

export interface BurbujaProps {
  quien: Quien;
  texto: string;
  urlImagen?: string;
}

/**
 * Markdown mínimo: negritas, itálicas, código, listas, tablas y párrafos,
 * que es lo que el modelo usa de verdad al contestar. Todo se escapa antes
 * de cualquier sustitución: la respuesta viene de un LLM y jamás se inserta
 * como HTML crudo. Port directo de formatearRespuesta en workshop/web/app.js.
 */
function formatearRespuesta(texto: string): string {
  const escapar = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);

  // Una sola pasada con alternancia: lo que ya matcheó como código no se
  // vuelve a tocar, así que no hacen falta marcadores intermedios.
  //
  // El delimitador no puede estar pegado a un espacio —igual que en Markdown
  // de verdad—, así «2 * 3 * 4» queda como está y no se vuelve una cursiva.
  const enLinea = (s: string) =>
    escapar(s).replace(
      /`([^`]+)`|\*\*(?!\s)([^*]+?)(?<!\s)\*\*|(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*|(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_/g,
      (_match, codigo, fuerte, cursiva, cursivaBaja) => {
        if (codigo !== undefined) return `<code>${codigo}</code>`;
        if (fuerte !== undefined) return `<strong>${fuerte}</strong>`;
        return `<em>${cursiva ?? cursivaBaja}</em>`;
      },
    );

  const html: string[] = [];
  let lista: "ul" | "ol" | null = null;
  let tabla: string[][] | null = null;

  const cerrarLista = () => {
    if (lista) html.push(`</${lista}>`);
    lista = null;
  };
  const cerrarTabla = () => {
    if (!tabla) return;
    const [cabecera, ...cuerpo] = tabla;
    html.push("<table><thead><tr>");
    for (const c of cabecera) html.push(`<th>${enLinea(c)}</th>`);
    html.push("</tr></thead><tbody>");
    for (const fila of cuerpo) {
      html.push("<tr>");
      for (const c of fila) html.push(`<td>${enLinea(c)}</td>`);
      html.push("</tr>");
    }
    html.push("</tbody></table>");
    tabla = null;
  };
  const abrirLista = (tipo: "ul" | "ol") => {
    if (lista !== tipo) {
      cerrarLista();
      html.push(`<${tipo}>`);
      lista = tipo;
    }
  };

  for (const cruda of texto.split("\n")) {
    const linea = cruda.trim();
    if (!linea) {
      cerrarLista();
      cerrarTabla();
      continue;
    }

    // Fila de tabla: | a | b | c |
    if (/^\|.*\|$/.test(linea)) {
      const celdas = linea
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      // La fila separadora |---|---| no lleva contenido.
      if (!celdas.every((c) => /^:?-{2,}:?$/.test(c))) {
        (tabla ??= []).push(celdas);
      }
      continue;
    }
    cerrarTabla();

    const vineta = linea.match(/^[-*•]\s+(.*)$/);
    const numerada = linea.match(/^\d+[.)]\s+(.*)$/);
    const titulo = linea.match(/^#{1,6}\s+(.*)$/);

    if (vineta) {
      abrirLista("ul");
      html.push(`<li>${enLinea(vineta[1])}</li>`);
    } else if (numerada) {
      abrirLista("ol");
      html.push(`<li>${enLinea(numerada[1])}</li>`);
    } else if (titulo) {
      cerrarLista();
      html.push(`<p class="subtitulo"><strong>${enLinea(titulo[1])}</strong></p>`);
    } else {
      cerrarLista();
      html.push(`<p>${enLinea(linea)}</p>`);
    }
  }
  cerrarLista();
  cerrarTabla();
  return html.join("");
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
