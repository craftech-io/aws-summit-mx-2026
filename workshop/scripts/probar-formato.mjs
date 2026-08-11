// Prueba de formatearRespuesta contra lo que el modelo escribe de verdad.
//
//   npm run probar:formato
//
// La web no tiene bundler ni módulos —es un solo <script> sin build—, así que
// la función se saca del fuente y se evalúa acá. Feo pero honesto: prueba
// exactamente el código que se sirve.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raiz = dirname(dirname(fileURLToPath(import.meta.url)));
const fuente = readFileSync(join(raiz, "web", "app.js"), "utf8");
const desde = fuente.indexOf("function formatearRespuesta");
const hasta = fuente.indexOf("\n}", desde) + 2;
const formatearRespuesta = eval(`(${fuente.slice(desde, hasta)})`);

const casos = [
  {
    nombre: "negrita, que es el caso que se veía roto",
    entrada: "- **PED-1103** (02/08) — Teclado Keychron K2 Pro, $15.600 MXN — en preparación.",
    espera: ["<ul>", "<strong>PED-1103</strong>", "$15.600 MXN", "</ul>"],
    noEspera: ["**"],
  },
  {
    nombre: "lista numerada",
    entrada: "1. Primero\n2. Segundo\n3) Tercero",
    espera: ["<ol>", "<li>Primero</li>", "<li>Tercero</li>", "</ol>"],
    noEspera: ["<ul>", "1."],
  },
  {
    nombre: "código inline",
    entrada: "Usé la herramienta `pedidos__listar` para eso.",
    espera: ["<code>pedidos__listar</code>"],
    noEspera: ["`", "<em>"],
  },
  {
    nombre: "no formatear el guion bajo de un identificador",
    entrada: "El servidor conocimiento__buscar y otro_nombre_largo quedan intactos.",
    espera: ["conocimiento__buscar", "otro_nombre_largo"],
    noEspera: ["<em>"],
  },
  {
    nombre: "cursiva de verdad",
    entrada: "Esto va en *cursiva* y esto en _cursiva_ también.",
    espera: ["<em>cursiva</em>"],
    noEspera: ["*cursiva*", "_cursiva_"],
  },
  {
    nombre: "multiplicación y asteriscos sueltos no rompen nada",
    entrada: "El total es 2 * 3 * 4 unidades.",
    espera: ["2 * 3 * 4"],
    noEspera: ["<em>"],
  },
  {
    nombre: "HTML del modelo se escapa, nunca se ejecuta",
    entrada: 'Mirá <script>alert("hola")</script> y <img src=x onerror=alert(1)>',
    espera: ["&lt;script&gt;", "&lt;img"],
    noEspera: ["<script>", "<img src"],
  },
  {
    nombre: "párrafos separados",
    entrada: "Primer párrafo.\n\nSegundo párrafo.",
    espera: ["<p>Primer párrafo.</p>", "<p>Segundo párrafo.</p>"],
    noEspera: [],
  },
  {
    nombre: "encabezado markdown",
    entrada: "## Estado de tus pedidos\nTenés tres.",
    espera: ["<strong>Estado de tus pedidos</strong>", "<p>Tenés tres.</p>"],
    noEspera: ["##"],
  },
  {
    nombre: "lista con viñeta de asterisco",
    entrada: "* Uno\n* Dos",
    espera: ["<ul>", "<li>Uno</li>", "<li>Dos</li>"],
    noEspera: ["<em>"],
  },
  {
    nombre: "asterisco sin cerrar no rompe",
    entrada: "Esto quedó a medias **sin cerrar y sigue.",
    espera: ["sin cerrar y sigue"],
    noEspera: ["<strong>"],
  },
  {
    nombre: "lista que termina y sigue un párrafo",
    entrada: "- Uno\n- Dos\n\n¿Querés que abra el reclamo?",
    espera: ["</ul>", "<p>¿Querés que abra el reclamo?</p>"],
    noEspera: [],
  },
  {
    nombre: "cursiva después de signo de apertura",
    entrada: "¿*Seguro* querés eso?",
    espera: ["<em>Seguro</em>"],
    noEspera: ["*Seguro*"],
  },
  {
    nombre: "ampersand y comillas",
    entrada: 'El pedido de "Juan & Cía" está listo.',
    espera: ["&amp;", "&quot;"],
    noEspera: [],
  },
  {
    nombre: "tabla markdown",
    entrada: "| Producto | Unidades | Monto |\n|---|---|---|\n| MacBook Air M3 | 30 | $869.700 |\n| ThinkPad T14 | 29 | $724.710 |",
    espera: ["<table>", "<th>Producto</th>", "<td>MacBook Air M3</td>", "<td>$724.710</td>", "</table>"],
    noEspera: ["|---", "<p>|"],
  },
  {
    nombre: "respuesta larga real del agente",
    entrada:
      "Tenés tres pedidos:\n\n- **PED-1103** (02/08) — Teclado Keychron K2 Pro, $15.600 MXN — *en preparación*.\n- **PED-1078** (01/08) — Monitor LG 27UP850 4K — demorado.\n\n## Qué podés hacer\n1. Esperar el envío\n2. Abrir un reclamo con `reclamos__crear`\n\n¿Te ayudo con alguno?",
    espera: [
      "<strong>PED-1103</strong>",
      "<em>en preparación</em>",
      "<strong>Qué podés hacer</strong>",
      "<ol>",
      "<code>reclamos__crear</code>",
      "<p>¿Te ayudo con alguno?</p>",
    ],
    noEspera: ["**", "##", "`re"],
  },
];

let fallas = 0;
for (const caso of casos) {
  const salida = formatearRespuesta(caso.entrada);
  const faltan = caso.espera.filter((e) => !salida.includes(e));
  const sobran = (caso.noEspera ?? []).filter((e) => salida.includes(e));
  if (faltan.length || sobran.length) {
    fallas++;
    console.log(`✗ ${caso.nombre}`);
    if (faltan.length) console.log(`    falta:  ${faltan.join(" | ")}`);
    if (sobran.length) console.log(`    sobra:  ${sobran.join(" | ")}`);
    console.log(`    salida: ${salida.slice(0, 220)}`);
  } else {
    console.log(`✓ ${caso.nombre}`);
  }
}
console.log(`\n${casos.length - fallas}/${casos.length} casos en verde`);
process.exit(fallas ? 1 : 0);
