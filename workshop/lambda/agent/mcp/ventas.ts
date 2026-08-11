// Servidor MCP de analítica de compras, con dos herramientas que NUNCA
// conviven: cuál existe lo decide la fuente elegida en la interfaz.
//
//   fuente=gold    → ventas__resumen: lee la capa gold (agregada, sin PII)
//                    y la plataforma fija el tenant en el WHERE. El modelo
//                    no puede pedir datos de otro cliente ni queriendo.
//   fuente=detalle → ventas__detalle: lee la tabla cruda tal como haría el
//                    atajo de la primera semana. Sin filtro de tenant y con
//                    las columnas de datos personales a la vista.
//
// La segunda existe A PROPÓSITO, como experimento: las
// mismas preguntas contra una capa y contra la otra muestran la diferencia
// en tokens consumidos y en lo que el agente puede llegar a decir.
import { consultarAthena, literalSQL } from "../athena";
import type { ServidorMCP } from "./tipos";

const TABLA_GOLD = process.env.TABLA_VENTAS_GOLD ?? "ventas_gold";
const TABLA_DETALLE = process.env.TABLA_VENTAS_DETALLE ?? "ventas_detalle";

const MES_VALIDO = /^\d{4}-(0[1-9]|1[0-2])$/;
const ANIO_VALIDO = /^\d{4}$/;

export const servidorVentas: ServidorMCP = {
  nombre: "ventas",
  version: "1.0.0",
  descripcion: "Historial de compras del cliente en la plataforma analítica.",
  herramientas: [
    {
      nombre: "resumen",
      fuentes: ["gold"],
      descripcion:
        "Resumen de las compras del cliente autenticado. UNA sola llamada devuelve el panorama " +
        "completo: total general, desglose por categoría y evolución por mes. Usala para cualquier " +
        "pregunta sobre cuánto compró, en qué gastó o cómo evolucionaron sus compras. Los datos " +
        "son agregados: no existe el detalle pedido por pedido.",
      esquemaEntrada: {
        type: "object",
        properties: {
          anio: {
            type: "string",
            description: "Limitar a un año, formato YYYY.",
          },
          mes: {
            type: "string",
            description: "Limitar a un mes puntual, formato YYYY-MM.",
          },
          categoria: {
            type: "string",
            description: "Limitar a una categoría de producto.",
          },
        },
      },
      async ejecutar(argumentos, contexto) {
        // El tenant lo pone la plataforma desde el token, no el modelo:
        // esta línea es la garantía de seguridad de la capa gold.
        const condiciones = [`tenant_id = ${literalSQL(contexto.clienteId)}`];

        if (typeof argumentos.anio === "string" && ANIO_VALIDO.test(argumentos.anio)) {
          condiciones.push(`mes LIKE ${literalSQL(`${argumentos.anio}-%`)}`);
        }
        if (typeof argumentos.mes === "string" && MES_VALIDO.test(argumentos.mes)) {
          condiciones.push(`mes = ${literalSQL(argumentos.mes)}`);
        }
        if (typeof argumentos.categoria === "string" && argumentos.categoria.trim()) {
          condiciones.push(`categoria = ${literalSQL(argumentos.categoria.trim().toLowerCase())}`);
        }
        const donde = `WHERE ${condiciones.join(" AND ")}`;

        // Las tres vistas en paralelo: una vuelta de herramienta, una espera.
        const [total, porCategoria, porMes] = await Promise.all([
          consultarAthena(
            `SELECT SUM(pedidos) AS pedidos, SUM(unidades) AS unidades,
                    ROUND(SUM(monto_total), 2) AS monto_total,
                    ROUND(SUM(monto_total) / NULLIF(SUM(pedidos), 0), 2) AS ticket_promedio
             FROM ${TABLA_GOLD} ${donde}`,
          ),
          consultarAthena(
            `SELECT categoria, SUM(pedidos) AS pedidos,
                    ROUND(SUM(monto_total), 2) AS monto_total
             FROM ${TABLA_GOLD} ${donde} GROUP BY categoria ORDER BY monto_total DESC`,
          ),
          consultarAthena(
            `SELECT mes, SUM(pedidos) AS pedidos, ROUND(SUM(monto_total), 2) AS monto_total
             FROM ${TABLA_GOLD} ${donde} GROUP BY mes ORDER BY mes`,
          ),
        ]);

        if (total.cantidad === 0 || total.filas[0]?.pedidos === null) {
          return {
            resultados: [],
            mensaje:
              "No hay datos para ese filtro en la cuenta del cliente autenticado. " +
              "Si preguntó por otro cliente, decile que solo podés ver los datos de su cuenta.",
          };
        }
        return {
          moneda: "MXN",
          total: total.filas[0],
          por_categoria: porCategoria.filas,
          por_mes: porMes.filas,
        };
      },
    },
    {
      nombre: "detalle",
      fuentes: ["detalle"],
      descripcion:
        "Consulta directa a la tabla de ventas de la plataforma analítica, pedido por pedido. " +
        "Usala para cualquier pregunta sobre compras, gastos o clientes. Podés filtrar por " +
        "nombre de cliente, empresa, mes o categoría.",
      esquemaEntrada: {
        type: "object",
        properties: {
          empresa: {
            type: "string",
            description: "Filtrar por empresa (tenant), por ejemplo craftech-demo.",
          },
          cliente_nombre: {
            type: "string",
            description: "Filtrar por nombre de la persona que compró (búsqueda parcial).",
          },
          anio: { type: "string", description: "Año puntual, formato YYYY." },
          mes: { type: "string", description: "Mes puntual, formato YYYY-MM." },
          categoria: { type: "string", description: "Categoría de producto." },
          limite: {
            type: "integer",
            description: "Máximo de filas a devolver (por defecto 180).",
            minimum: 1,
            maximum: 250,
          },
        },
      },
      async ejecutar(argumentos) {
        // Ojo: acá NO hay filtro por tenant ni columnas excluidas. Es la
        // consulta que escribe cualquiera que apunta el agente a la tabla
        // cruda «porque ya estaba». Probalo y mirá lo que cuesta.
        const condiciones: string[] = [];
        if (typeof argumentos.empresa === "string" && argumentos.empresa.trim()) {
          condiciones.push(`tenant_id LIKE ${literalSQL(`%${argumentos.empresa.trim()}%`)}`);
        }
        if (typeof argumentos.cliente_nombre === "string" && argumentos.cliente_nombre.trim()) {
          condiciones.push(
            `LOWER(cliente_nombre) LIKE ${literalSQL(`%${argumentos.cliente_nombre.trim().toLowerCase()}%`)}`,
          );
        }
        if (typeof argumentos.anio === "string" && ANIO_VALIDO.test(argumentos.anio)) {
          condiciones.push(`fecha LIKE ${literalSQL(`${argumentos.anio}-%`)}`);
        }
        if (typeof argumentos.mes === "string" && MES_VALIDO.test(argumentos.mes)) {
          condiciones.push(`fecha LIKE ${literalSQL(`${argumentos.mes}%`)}`);
        }
        if (typeof argumentos.categoria === "string" && argumentos.categoria.trim()) {
          condiciones.push(`categoria = ${literalSQL(argumentos.categoria.trim().toLowerCase())}`);
        }
        const donde = condiciones.length ? `WHERE ${condiciones.join(" AND ")}` : "";
        // Tope duro en 250: filas de sobra para que el problema se vea, sin
        // volcar al contexto un payload que ningún modelo debería recibir.
        const limite = Math.min(Math.max(Number(argumentos.limite ?? 180) || 180, 1), 250);

        const sql = `SELECT pedido_id, tenant_id, fecha, cliente_nombre, cliente_email,
                            cliente_telefono, cliente_documento, direccion_entrega, producto,
                            categoria, cantidad, precio_unitario, monto, tarjeta_ultimos4, estado
                     FROM ${TABLA_DETALLE} ${donde}
                     ORDER BY fecha DESC
                     LIMIT ${limite}`;

        const resultado = await consultarAthena(sql);
        return { moneda: "MXN", filas: resultado.cantidad, resultados: resultado.filas };
      },
    },
  ],
};
