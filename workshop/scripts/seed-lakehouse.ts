// Seed del lakehouse: llena ventas_detalle y ventas_gold vía Athena.
//
//   CLIENTE_ID=<sub de Cognito> npm run seed:lakehouse
//
// El CLIENTE_ID es el tenant "propio": el que ve el agente cuando le
// preguntás por tus compras. El resto de los tenants son empresas
// inventadas que existen para demostrar el aislamiento (o su ausencia).
//
// TODOS los datos personales de este archivo son inventados de forma
// determinística: mismos inputs, mismas filas. No hay una sola persona real.
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
} from "@aws-sdk/client-athena";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

const PREFIJO = process.env.PREFIJO ?? "summit";
const athena = new AthenaClient({});
const cfn = new CloudFormationClient({});

/* ── Generador determinístico ──────────────────────────────────────── */

// mulberry32: alcanza y sobra para datos de demo reproducibles.
function crearRng(semilla: number) {
  let a = semilla >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = crearRng(20260811);
const elegir = <T>(lista: T[]): T => lista[Math.floor(rng() * lista.length)];
const entre = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1));

/* ── Catálogos de datos inventados ─────────────────────────────────── */

const NOMBRES = [
  "María", "José", "Guadalupe", "Juan", "Verónica", "Luis", "Fernanda", "Carlos",
  "Ximena", "Miguel", "Sofía", "Alejandro", "Valeria", "Ricardo", "Daniela",
  "Eduardo", "Regina", "Andrés", "Camila", "Jorge",
];
const APELLIDOS = [
  "Hernández", "García", "Martínez", "López", "González", "Pérez", "Rodríguez",
  "Sánchez", "Ramírez", "Cruz", "Flores", "Gómez", "Vázquez", "Torres", "Mendoza",
];
const CALLES = [
  "Av. Insurgentes Sur", "Calz. de Tlalpan", "Av. Revolución", "Paseo de la Reforma",
  "Av. Universidad", "Calle Madero", "Av. Chapultepec", "Blvd. Manuel Ávila Camacho",
];
const CIUDADES = ["CDMX", "Guadalajara", "Monterrey", "Puebla", "Querétaro", "Mérida"];

const PRODUCTOS: Record<string, [string, number][]> = {
  monitores: [["Monitor LG 27UP850", 8990], ["Monitor Dell U2723QE", 12490], ["Monitor Samsung Odyssey G5", 6990]],
  teclados: [["Teclado Keychron K2 Pro", 2290], ["Teclado Logitech MX Keys", 2790], ["Teclado Razer BlackWidow", 3190]],
  audio: [["Auriculares Sony WH-1000XM5", 6990], ["Auriculares Bose QC45", 6490], ["Parlante JBL Charge 5", 3290]],
  computo: [["Notebook ThinkPad T14", 24990], ["MacBook Air M3", 28990], ["Mini PC Beelink SER5", 7490]],
  accesorios: [["Hub USB-C Anker", 1190], ["Webcam Logitech Brio", 3490], ["Dock ThinkPad Thunderbolt", 5990]],
  redes: [["Router TP-Link AX3000", 1890], ["Switch Netgear GS308", 890], ["Access Point Ubiquiti U6", 2990]],
  almacenamiento: [["SSD Samsung T7 1TB", 2190], ["HDD WD Elements 4TB", 2390], ["NAS Synology DS224+", 8990]],
  impresion: [["Impresora Brother HL-L2350", 2790], ["Multifunción Epson EcoTank", 4990], ["Etiquetadora Brother PT", 1290]],
};
const CATEGORIAS = Object.keys(PRODUCTOS);

/** Tenants ajenos: existen para probar el aislamiento. Todo inventado. */
const TENANTS_AJENOS = [
  "grupo-altiplano", "logistica-bajio", "muebleria-condesa", "tecno-satelite", "farmacias-roma",
];

/* ── Generación de filas ───────────────────────────────────────────── */

interface FilaDetalle {
  pedido_id: string; tenant_id: string; fecha: string; cliente_nombre: string;
  cliente_email: string; cliente_telefono: string; cliente_documento: string;
  direccion_entrega: string; producto: string; categoria: string; cantidad: number;
  precio_unitario: number; monto: number; tarjeta_ultimos4: string; estado: string;
}

function generarPersona(tenant: string) {
  const nombre = `${elegir(NOMBRES)} ${elegir(APELLIDOS)} ${elegir(APELLIDOS)}`;
  const usuario = nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ /g, ".");
  return {
    nombre,
    email: `${usuario}@${tenant.replace(/-/g, "")}.mx`,
    telefono: `+52${entre(55, 81)}${entre(10000000, 99999999)}`,
    documento: `CURP-${String.fromCharCode(65 + entre(0, 25))}${String.fromCharCode(65 + entre(0, 25))}${entre(100000, 999999)}`,
    direccion: `${elegir(CALLES)} ${entre(100, 3999)}, ${elegir(CIUDADES)}`,
  };
}

function generarDetalle(tenantPropio: string, totalFilas: number): FilaDetalle[] {
  const filas: FilaDetalle[] = [];
  // Cada tenant tiene un plantel de compradores recurrentes, como en la vida real.
  const planteles = new Map<string, ReturnType<typeof generarPersona>[]>();
  for (const tenant of [tenantPropio, ...TENANTS_AJENOS]) {
    planteles.set(tenant, Array.from({ length: 12 }, () => generarPersona(tenant)));
  }

  let secuencia = 30000;
  for (let i = 0; i < totalFilas; i++) {
    // Una de cada cuatro filas es del tenant propio: hay volumen para
    // preguntar y volumen ajeno para filtrar (o para filtrarse, en detalle).
    const tenant = i % 4 === 0 ? tenantPropio : elegir(TENANTS_AJENOS);
    const persona = elegir(planteles.get(tenant)!);
    const categoria = elegir(CATEGORIAS);
    const [producto, precio] = elegir(PRODUCTOS[categoria]);
    const cantidad = entre(1, 5);
    const anio = elegir([2024, 2025]);
    const mes = entre(1, 12);
    const dia = entre(1, 28);
    filas.push({
      pedido_id: `PED-${secuencia++}`,
      tenant_id: tenant,
      fecha: `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`,
      cliente_nombre: persona.nombre,
      cliente_email: persona.email,
      cliente_telefono: persona.telefono,
      cliente_documento: persona.documento,
      direccion_entrega: persona.direccion,
      producto,
      categoria,
      cantidad,
      precio_unitario: precio,
      monto: Math.round(precio * cantidad * 100) / 100,
      tarjeta_ultimos4: String(entre(1000, 9999)),
      estado: elegir(["entregado", "entregado", "entregado", "en_camino", "devuelto"]),
    });
  }
  return filas;
}

/** Gold = detalle agregado por tenant, mes y categoría. Sin personas. */
function agregarGold(detalle: FilaDetalle[]) {
  const grupos = new Map<string, { pedidos: number; unidades: number; monto: number }>();
  for (const f of detalle) {
    const clave = `${f.tenant_id}|${f.fecha.slice(0, 7)}|${f.categoria}`;
    const g = grupos.get(clave) ?? { pedidos: 0, unidades: 0, monto: 0 };
    g.pedidos += 1;
    g.unidades += f.cantidad;
    g.monto += f.monto;
    grupos.set(clave, g);
  }
  return [...grupos.entries()].map(([clave, g]) => {
    const [tenant_id, mes, categoria] = clave.split("|");
    return {
      tenant_id, mes, categoria,
      pedidos: g.pedidos,
      unidades: g.unidades,
      monto_total: Math.round(g.monto * 100) / 100,
      ticket_promedio: Math.round((g.monto / g.pedidos) * 100) / 100,
    };
  });
}

/* ── Athena ────────────────────────────────────────────────────────── */

const sq = (v: string) => `'${v.replace(/'/g, "''")}'`;

async function correr(sql: string, workgroup: string, catalogo: string, base: string) {
  const inicio = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: workgroup,
      QueryExecutionContext: { Catalog: catalogo, Database: base },
    }),
  );
  const id = inicio.QueryExecutionId!;
  for (;;) {
    const estado = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const s = estado.QueryExecution?.Status?.State;
    if (s === "SUCCEEDED") return;
    if (s === "FAILED" || s === "CANCELLED") {
      throw new Error(estado.QueryExecution?.Status?.StateChangeReason ?? s);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function salidaStack(stack: string, clave: string): Promise<string> {
  const r = await cfn.send(new DescribeStacksCommand({ StackName: stack }));
  const valor = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === clave)?.OutputValue;
  if (!valor) throw new Error(`No encontré la salida ${clave} en ${stack}`);
  return valor;
}

/* ── Main ──────────────────────────────────────────────────────────── */

async function main() {
  const tenantPropio = process.env.CLIENTE_ID;
  if (!tenantPropio) {
    console.error("Falta CLIENTE_ID (el sub de Cognito del usuario de la demo).");
    console.error("  CLIENTE_ID=xxxx npm run seed:lakehouse");
    process.exit(1);
  }

  const stack = `${PREFIJO}-lakehouse`;
  const catalogo = await salidaStack(stack, "Catalogo");
  const base = await salidaStack(stack, "BaseDatos");
  const workgroup = await salidaStack(stack, "WorkgroupSalida");
  const correrSQL = (sql: string) => correr(sql, workgroup, catalogo, base);

  const TOTAL = Number(process.env.FILAS ?? 5000);
  console.log(`Generando ${TOTAL} filas de detalle (tenant propio: ${tenantPropio})…`);
  const detalle = generarDetalle(tenantPropio, TOTAL);
  const gold = agregarGold(detalle);
  console.log(`  detalle: ${detalle.length} filas · gold: ${gold.length} filas agregadas`);

  // Idempotencia simple: se vacían las tablas antes de sembrar (Iceberg
  // soporta DELETE). Correr dos veces no duplica nada.
  console.log("Vaciando tablas…");
  await correrSQL("DELETE FROM ventas_detalle");
  await correrSQL("DELETE FROM ventas_gold");

  const LOTE = 250;
  console.log("Insertando detalle…");
  for (let i = 0; i < detalle.length; i += LOTE) {
    const valores = detalle
      .slice(i, i + LOTE)
      .map(
        (f) =>
          `(${sq(f.pedido_id)}, ${sq(f.tenant_id)}, ${sq(f.fecha)}, ${sq(f.cliente_nombre)}, ` +
          `${sq(f.cliente_email)}, ${sq(f.cliente_telefono)}, ${sq(f.cliente_documento)}, ` +
          `${sq(f.direccion_entrega)}, ${sq(f.producto)}, ${sq(f.categoria)}, ${f.cantidad}, ` +
          `${f.precio_unitario}, ${f.monto}, ${sq(f.tarjeta_ultimos4)}, ${sq(f.estado)})`,
      )
      .join(",\n");
    await correrSQL(
      `INSERT INTO ventas_detalle (pedido_id, tenant_id, fecha, cliente_nombre, cliente_email,
        cliente_telefono, cliente_documento, direccion_entrega, producto, categoria, cantidad,
        precio_unitario, monto, tarjeta_ultimos4, estado) VALUES\n${valores}`,
    );
    console.log(`  ${Math.min(i + LOTE, detalle.length)}/${detalle.length}`);
  }

  console.log("Insertando gold…");
  for (let i = 0; i < gold.length; i += LOTE) {
    const valores = gold
      .slice(i, i + LOTE)
      .map(
        (g) =>
          `(${sq(g.tenant_id)}, ${sq(g.mes)}, ${sq(g.categoria)}, ${g.pedidos}, ${g.unidades}, ` +
          `${g.monto_total}, ${g.ticket_promedio})`,
      )
      .join(",\n");
    await correrSQL(
      `INSERT INTO ventas_gold (tenant_id, mes, categoria, pedidos, unidades, monto_total, ticket_promedio) VALUES\n${valores}`,
    );
    console.log(`  ${Math.min(i + LOTE, gold.length)}/${gold.length}`);
  }

  const propias = detalle.filter((f) => f.tenant_id === tenantPropio).length;
  console.log(`\nListo. ${detalle.length} filas de detalle (${propias} del tenant propio), ${gold.length} de gold.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
