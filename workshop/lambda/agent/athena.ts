// Cliente mínimo de Athena para consultar las tablas Iceberg del lakehouse.
//
// Athena es asíncrono: se lanza la consulta, se sondea hasta que termina y
// recién ahí se piden los resultados. Para las consultas del workshop (tablas
// chicas) el ciclo completo tarda uno o dos segundos.
import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-athena";

const athena = new AthenaClient({});

const WORKGROUP = process.env.ATHENA_WORKGROUP!;
const CATALOGO = process.env.LAKEHOUSE_CATALOGO!;
const BASE = process.env.LAKEHOUSE_DB!;

// Una consulta del agente no debería tardar más que esto.
const TIMEOUT_MS = 45_000;
const INTERVALO_MS = 400;

export interface ResultadoAthena {
  filas: Record<string, string | number | null>[];
  /** Cuántas filas devolvió, para que el modelo lo pueda citar. */
  cantidad: number;
}

export async function consultarAthena(sql: string): Promise<ResultadoAthena> {
  const inicio = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      WorkGroup: WORKGROUP,
      QueryExecutionContext: { Catalog: CATALOGO, Database: BASE },
    }),
  );
  const id = inicio.QueryExecutionId!;

  const limite = Date.now() + TIMEOUT_MS;
  for (;;) {
    const estado = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: id }));
    const s = estado.QueryExecution?.Status?.State;
    if (s === "SUCCEEDED") break;
    if (s === "FAILED" || s === "CANCELLED") {
      throw new Error(
        `La consulta falló: ${estado.QueryExecution?.Status?.StateChangeReason ?? s}`,
      );
    }
    if (Date.now() > limite) throw new Error("La consulta a Athena superó el tiempo máximo.");
    await new Promise((r) => setTimeout(r, INTERVALO_MS));
  }

  // Una sola página alcanza: las herramientas ya acotan con LIMIT.
  const resultados = await athena.send(
    new GetQueryResultsCommand({ QueryExecutionId: id, MaxResults: 1000 }),
  );

  const info = resultados.ResultSet?.ResultSetMetadata?.ColumnInfo ?? [];
  const columnas = info.map((c) => c.Name ?? "");
  const numericas = new Set(
    info
      .filter((c) => ["integer", "bigint", "double", "float", "decimal"].includes(c.Type ?? ""))
      .map((c) => c.Name ?? ""),
  );

  // La primera fila de Athena repite los encabezados: se salta.
  const filas = (resultados.ResultSet?.Rows ?? []).slice(1).map((fila) => {
    const objeto: Record<string, string | number | null> = {};
    fila.Data?.forEach((celda, i) => {
      const crudo = celda.VarCharValue ?? null;
      objeto[columnas[i]] =
        crudo !== null && numericas.has(columnas[i]) ? Number(crudo) : crudo;
    });
    return objeto;
  });

  return { filas, cantidad: filas.length };
}

/** Escapa un literal de texto para SQL: comillas simples duplicadas. */
export function literalSQL(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}
