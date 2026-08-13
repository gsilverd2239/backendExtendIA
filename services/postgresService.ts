import { pgPool } from '../config/db';

// Helper: Query PostgreSQL convertia."SRGC" for active SAP schemas
export async function fetchSchemasFromPostgres(): Promise<Array<{ DbName: string; cpnyName: string; dbType?: string }>> {
  const queries = [
    `SELECT * FROM convertia."SRGC"`,
    `SELECT * FROM convertia.srgc`,
    `SELECT * FROM convertia."srgc"`,
  ];

  for (const sql of queries) {
    try {
      console.log('[Postgres Query SRGC] Trying:', sql);
      const res = await pgPool.query(sql);
      if (res && res.rows && res.rows.length > 0) {
        console.log(`[Postgres SRGC Success] Found ${res.rows.length} total rows in convertia."SRGC"`);
        const activeRows = res.rows.filter((r: any) => {
          const st = r.cmpStatus ?? r.cmpstatus ?? r.CMPSTATUS ?? r.cmp_status ?? 'A';
          return String(st).trim().toUpperCase() === 'A';
        });
        const mapped = activeRows.map((r: any) => ({
          DbName: String(r.dbName ?? r.dbname ?? r.DBNAME ?? r.DbName ?? '').trim(),
          cpnyName: String(r.cmpName ?? r.cmpname ?? r.CMPNAME ?? r.cpnyName ?? r.dbName ?? r.dbname ?? '').trim(),
          dbType: 'HANA' as const,
        })).filter(s => s.DbName.length > 0);

        console.log(`[Postgres SRGC Filtered] ${mapped.length} active schemas returned from Postgres.`);
        if (mapped.length > 0) return mapped;
      }
    } catch (err: any) {
      console.warn(`[Postgres SRGC Query Warning with '${sql}']:`, err.message);
    }
  }
  return [];
}

// Helper: Query PostgreSQL convertia."DBINSTANCES"
export async function fetchDbInstancesFromPostgres(): Promise<any[]> {
  const queries = [
    `SELECT * FROM convertia."DBINSTANCES"`,
    `SELECT * FROM convertia.dbinstances`,
    `SELECT * FROM convertia."dbinstances"`,
  ];

  for (const query of queries) {
    try {
      console.log('[Postgres Query DBINSTANCES] Trying:', query);
      const result = await pgPool.query(query);
      if (result && result.rows && result.rows.length > 0) {
        console.log(`[Postgres DBINSTANCES Success] Found ${result.rows.length} rows`);
        const mapped = result.rows.map((r: any) => {
          const getV = (...keys: string[]) => {
            for (const k of keys) {
              if (r[k] !== undefined && r[k] !== null) return r[k];
            }
            const rKeys = Object.keys(r);
            for (const k of keys) {
              const matched = rKeys.find(rk => rk.toLowerCase() === k.toLowerCase());
              if (matched && r[matched] !== undefined && r[matched] !== null) return r[matched];
            }
            return undefined;
          };

          return {
            ServerName: String(getV('ServerName', 'servername', 'server_name') ?? 'Servidor').trim(),
            ServerType: String(getV('ServerType', 'servertype', 'server_type') ?? 'HANA').trim(),
            Version: String(getV('Version', 'version') ?? '10.0').trim(),
            ServiceLayer: String(getV('ServiceLayer', 'servicelayer', 'service_layer') ?? 'https://172.19.0.88:50000/b1s/v1').trim(),
            ServerHanaPort: String(getV('ServerHanaPort', 'serverhanaport', 'server_hana_port', 'hanaport') ?? '172.19.0.88:30015').trim(),
            HanaUser: String(getV('HanaUser', 'hanauser', 'hana_user') ?? 'SYSTEM').trim(),
            HanaPassword: String(getV('HanaPassword', 'hanapassword', 'hana_password') ?? 'Admin123').trim(),
          };
        });
        return mapped;
      }
    } catch (err: any) {
      console.warn(`[Postgres DBINSTANCES Query Warning with '${query}']:`, err.message);
    }
  }
  return [];
}
