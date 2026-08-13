import util from 'util';
import { hdbModule, currentSapConfig } from '../config/sapConfig';

export function normalizeHanaRows(rows: any): any[] {
  try {
    console.log('[HANA DEBUG] normalizeHanaRows input type:', typeof rows);
    if (rows && (Array.isArray(rows) || typeof rows === 'object')) {
      const preview = Array.isArray(rows) ? (rows.length > 3 ? rows.slice(0,3) : rows) : Object.keys(rows).slice(0,5);
      console.log('[HANA DEBUG] normalizeHanaRows preview:', preview);
    }
  } catch (e) {
    // ignore
  }

  if (!rows) return [];
  if (Array.isArray(rows)) {
    if (rows.length > 0 && Array.isArray(rows[0])) {
      return rows[0];
    }
    return rows;
  }
  if (typeof rows === 'object') {
    const keys = Object.keys(rows);
    for (const key of keys) {
      const val = (rows as any)[key];
      if (Array.isArray(val)) {
        if (val.length > 0 && Array.isArray(val[0])) {
          return val[0];
        }
        return val;
      }
    }
  }
  return [];
}

export async function fetchSchemasFromHana(): Promise<Array<{ DbName: string; cpnyName: string; dbType?: string }>> {
  if (!hdbModule || currentSapConfig.isSandbox || !currentSapConfig.hanaServer) {
    return [];
  }

  const serverPart = currentSapConfig.hanaServer.replace(/^https?:\/\//i, '');
  const [host, portStr] = serverPart.split(':');
  const port = portStr ? parseInt(portStr, 10) : 30015;

  return new Promise((resolve) => {
    let client: any;
    let isResolved = false;

    const cleanupAndResolve = (result: Array<{ DbName: string; cpnyName: string; dbType?: string }>) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        if (client) {
          try { client.end(); } catch (_) {}
        }
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      console.log(`[HANA DB] Conexión a ${host}:${port} cancelada por tiempo de espera.`);
      cleanupAndResolve([]);
    }, 1500);

    try {
      client = hdbModule.createClient({
        host,
        port,
        user: currentSapConfig.hanaUser || 'SYSTEM',
        password: currentSapConfig.hanaPassword || '',
        connectTimeout: 1200,
      });

      if (client.on) {
        client.on('error', (err: any) => {
          console.log(`[HANA DB] Aviso de conexión (${host}:${port}): ${err?.message || 'Error de red'}`);
          cleanupAndResolve([]);
        });
      }

      client.connect((err: any) => {
        if (err) {
          console.log(`[HANA DB] Servidor ${host}:${port} no disponible directamente: ${err.message}`);
          return cleanupAndResolve([]);
        }

        const sql = 'select "dbName" as "DbName","cmpName" as "cpnyName" from "SBOCOMMON"."SRGC" order by 1';
        client.exec(sql, (execErr: any, rows: any[]) => {
          if (execErr) {
            console.log(`[HANA DB] Error en consulta SRGC: ${execErr.message}`);
            return cleanupAndResolve([]);
          }

          if (Array.isArray(rows) && rows.length > 0) {
            const list = rows.map((r: any) => ({
              DbName: r.DbName || r.DBNAME || r.dbname,
              cpnyName: r.cpnyName || r.CPNYNAME || r.cmpName || r.DbName,
              dbType: 'HANA' as const,
            }));
            return cleanupAndResolve(list);
          }
          cleanupAndResolve([]);
        });
      });
    } catch (e: any) {
      console.log(`[HANA DB] Inicialización del cliente HANA omitida: ${e.message}`);
      cleanupAndResolve([]);
    }
  });
}

export async function callHanaStoredProcedure(
  spCallQuery: string,
  schema: string,
  userCode: string,
  vendedor: string = '1',
  overrideHanaUser?: string,
  overrideHanaPassword?: string
): Promise<{ success: boolean; rows: any[]; error?: string }> {
  if (!hdbModule) {
    return { success: false, rows: [], error: 'El controlador Node.js "hdb" para SAP HANA no está disponible.' };
  }

  let serverPart = currentSapConfig.hanaServer;
  if (!serverPart || serverPart.trim() === '') {
    if (currentSapConfig.serviceLayerUrl) {
      try {
        const parsed = new URL(currentSapConfig.serviceLayerUrl);
        serverPart = `${parsed.hostname}:30015`;
      } catch (_) {
        serverPart = '172.19.0.88:30015';
      }
    } else {
      serverPart = '172.19.0.88:30015';
    }
  }

  const cleanServerPart = serverPart.replace(/^https?:\/\//i, '');
  const [host, portStr] = cleanServerPart.split(':');
  const port = portStr ? parseInt(portStr, 10) : 30015;

  const hanaUser = overrideHanaUser || currentSapConfig.hanaUser || 'SYSTEM';
  const hanaPassword = overrideHanaPassword || currentSapConfig.hanaPassword || '';

  return new Promise((resolve) => {
    let client: any;
    let isResolved = false;

    const cleanupAndResolve = (result: { success: boolean; rows: any[]; error?: string }) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        if (client) {
          try { client.end(); } catch (_) {}
        }
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      cleanupAndResolve({
        success: false,
        rows: [],
        error: `Timeout al conectar a SAP HANA (${host}:${port}) con usuario '${hanaUser}' (3s)`
      });
    }, 3000);

    try {
      client = hdbModule.createClient({
        host,
        port,
        user: hanaUser,
        password: hanaPassword,
        connectTimeout: 2500,
      });

      if (client.on) {
        client.on('error', (err: any) => cleanupAndResolve({
          success: false,
          rows: [],
          error: `Error socket HANA (${host}:${port}, usuario '${hanaUser}'): ${err?.message || 'Socket cerrado'}`
        }));
      }

      client.connect((err: any) => {
        if (err) return cleanupAndResolve({
          success: false,
          rows: [],
          error: `Error de autenticación/conexión HANA (${host}:${port}, usuario '${hanaUser}'): ${err.message}`
        });

        try {
          console.log(`[HANA DEBUG] connected to HANA ${host}:${port} as '${hanaUser}' - executing SP: ${spCallQuery}`);
        } catch (e) { /* ignore */ }

        client.exec(spCallQuery, function(execErr: any, ...rest: any[]) {
          const rows = rest[0];

          if (execErr) {
            console.warn(`HANA SP execution error [${spCallQuery}]:`, execErr);
            return cleanupAndResolve({
              success: false,
              rows: [],
              error: `Error ejecutando SP en HANA (${host}:${port}, usuario '${hanaUser}'): ${execErr.message}`
            });
          }

          const resultRows = normalizeHanaRows(rows);

          if (resultRows.length === 0) {
            const prepareCall = spCallQuery.replace(/\('(?:[^']*)',\s*'(?:[^']*)',\s*'(?:[^']*)'\)/, '(?,?,?)');
            try {
              client.prepare(prepareCall, (prepErr: any, statement: any) => {
                if (prepErr || !statement) {
                  return cleanupAndResolve({
                    success: true,
                    rows: [],
                    error: `Conectado a SAP HANA (${host}:${port}) como '${hanaUser}', pero '${spCallQuery}' no devolvió registros.`
                  });
                }

                statement.exec([schema, userCode, vendedor], (stmtErr: any, stmtRows: any[]) => {
                  try { statement.drop(); } catch (_) {}
                  if (stmtErr) {
                    return cleanupAndResolve({ success: false, rows: [], error: `Error exec prepared SP: ${stmtErr.message || stmtErr}` });
                  }

                  const altRows = normalizeHanaRows(stmtRows);
                  if (altRows && altRows.length > 0) {
                    return cleanupAndResolve({ success: true, rows: altRows });
                  }

                  return cleanupAndResolve({
                    success: true,
                    rows: [],
                    error: `El SP se ejecutó (prepared) pero no devolvió registros.`
                  });
                });
              });
            } catch (prepEx: any) {
              return cleanupAndResolve({
                success: true,
                rows: [],
                error: `Conectado a SAP HANA (${host}:${port}) como '${hanaUser}', pero '${spCallQuery}' no devolvió registros.`
              });
            }

            return;
          }

          cleanupAndResolve({ success: true, rows: resultRows });
        });
      });
    } catch (err: any) {
      cleanupAndResolve({ success: false, rows: [], error: `Excepción cliente HANA: ${err.message}` });
    }
  });
}

export async function fetchUserProfileFromHana(schema: string, username: string) {
  const defaultProfile = {
    user_code: username || 'manager',
    username: (username || 'manager') === 'manager' ? 'Manager de Producción' : `Usuario: ${(username || 'manager').toUpperCase()}`,
    u_email: `${username || 'manager'}@tandempro.com.py`,
    CompnyName: 'TandemPRO S.A.',
    CompnyAddr: 'Av. Las Industrias 1024, Complejo Industrial Tandem',
    phone1: '+595 21 555-1234',
    e_mail: 'contacto@tandempro.com.py',
    BD: schema || 'SBO_TANDEMPRO_PROD',
    Sucursal: 'Planta Principal Capiatá',
    Departamento: 'Operaciones de Producción',
    SucursalCode: 'PL-01',
    SucursalName: 'Planta Industrial de Extrusión',
    origen: schema && schema.startsWith('FG_') ? 1 : 2,
    PDF: '/reports/pdf_gen',
    XML: '/reports/xml_gen',
    IMG: '/reports/img_gen',
    isSandbox: true,
    SUPERUSER: (username || 'manager').toLowerCase() === 'manager' ? 'Y' : 'N',
  };

  if (!hdbModule || currentSapConfig.isSandbox || !currentSapConfig.hanaServer || !schema) {
    return defaultProfile;
  }

  const serverPart = currentSapConfig.hanaServer.replace(/^https?:\/\//i, '');
  const [host, portStr] = serverPart.split(':');
  const port = portStr ? parseInt(portStr, 10) : 30015;

  return new Promise<typeof defaultProfile>((resolve) => {
    let client: any;
    let isResolved = false;

    const cleanupAndResolve = (profileData: typeof defaultProfile) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        if (client) {
          try { client.end(); } catch (_) {}
        }
        resolve(profileData);
      }
    };

    const timer = setTimeout(() => {
      cleanupAndResolve({ ...defaultProfile, isSandbox: false });
    }, 2000);

    try {
      client = hdbModule.createClient({
        host,
        port,
        user: currentSapConfig.hanaUser || 'SYSTEM',
        password: currentSapConfig.hanaPassword || '',
        connectTimeout: 1500,
      });

      if (client.on) {
        client.on('error', () => cleanupAndResolve({ ...defaultProfile, isSandbox: false }));
      }

      client.connect((err: any) => {
        if (err) return cleanupAndResolve({ ...defaultProfile, isSandbox: false });

        const q1 = `SELECT A."CompnyName", A."CompnyAddr", A."Phone1", A."E_Mail" FROM "${schema}"."OADM" A`;
        client.exec(q1, (err1: any, rows1: any[]) => {
          let compnyName = defaultProfile.CompnyName;
          let compnyAddr = defaultProfile.CompnyAddr;
          let phone1 = defaultProfile.phone1;
          let e_mail = defaultProfile.e_mail;

          if (!err1 && Array.isArray(rows1) && rows1.length > 0) {
            const r1 = rows1[0];
            compnyName = r1.CompnyName || r1.COMPNYNAME || compnyName;
            compnyAddr = r1.CompnyAddr || r1.COMPNYADDR || compnyAddr;
            phone1 = r1.Phone1 || r1.PHONE1 || phone1;
            e_mail = r1.E_Mail || r1.E_MAIL || e_mail;
          }

          const safeUser = (username || 'manager').replace(/'/g, "''");
          const q2 = `
            SELECT T0."USERID", T0."U_NAME", ifnull(T0."E_Mail", '') as "E_Mail", T0."SUPERUSER",
                   T1."Name" as "Sucursal", T2."Name" as "Departamento", T1."Code" as "SucursalCode", T1."Remarks" as "SucursalName"
            FROM "${schema}"."OUSR" T0
            LEFT OUTER JOIN "${schema}"."OUBR" T1 ON T0."Branch" = T1."Code"
            LEFT OUTER JOIN "${schema}"."OUDP" T2 ON T0."Department" = T2."Code"
            WHERE T0."USER_CODE" = '${safeUser}'
          `;

          client.exec(q2, (err2: any, rows2: any[]) => {
            let uName = defaultProfile.username;
            let uEmail = defaultProfile.u_email;
            let sucursal = defaultProfile.Sucursal;
            let departamento = defaultProfile.Departamento;
            let sucursalCode = defaultProfile.SucursalCode;
            let sucursalName = defaultProfile.SucursalName;
            let superUser = defaultProfile.SUPERUSER;

            if (!err2 && Array.isArray(rows2) && rows2.length > 0) {
              const r2 = rows2[0];
              uName = r2.U_NAME || r2.u_name || uName;
              uEmail = r2.E_Mail || r2.e_mail || uEmail;
              sucursal = r2.Sucursal || r2.SUCURSAL || sucursal;
              departamento = r2.Departamento || r2.DEPARTAMENTO || departamento;
              sucursalCode = r2.SucursalCode || r2.SUCURSALCODE || sucursalCode;
              sucursalName = r2.SucursalName || r2.SUCURSALNAME || sucursalName;
              superUser = r2.SUPERUSER || r2.superuser || r2.SuperUser || superUser || 'N';
            }

            cleanupAndResolve({
              user_code: username || 'manager',
              username: uName,
              u_email: uEmail,
              CompnyName: compnyName,
              CompnyAddr: compnyAddr,
              phone1: phone1,
              e_mail: e_mail,
              BD: schema,
              Sucursal: sucursal,
              Departamento: departamento,
              SucursalCode: sucursalCode,
              SucursalName: sucursalName,
              origen: schema && schema.startsWith('FG_') ? 1 : 2,
              PDF: '/reports/pdf_gen',
              XML: '/reports/xml_gen',
              IMG: '/reports/img_gen',
              isSandbox: false,
              SUPERUSER: String(superUser).trim().toUpperCase() === 'Y' ? 'Y' : 'N',
            });
          });
        });
      });
    } catch (_) {
      cleanupAndResolve({ ...defaultProfile, isSandbox: false });
    }
  });
}

export async function executeHanaQuery(
  query: string,
  overrideHanaUser?: string,
  overrideHanaPassword?: string
): Promise<{ success: boolean; rows: any[]; error?: string }> {
  if (!hdbModule) {
    return { success: false, rows: [], error: 'El controlador Node.js "hdb" para SAP HANA no está disponible.' };
  }

  let serverPart = currentSapConfig.hanaServer || '';
  if (!serverPart || serverPart.trim() === '') {
    if (currentSapConfig.serviceLayerUrl) {
      try {
        const parsed = new URL(currentSapConfig.serviceLayerUrl);
        serverPart = `${parsed.hostname}:30015`;
      } catch (_) {
        serverPart = '172.19.0.88:30015';
      }
    } else {
      serverPart = '172.19.0.88:30015';
    }
  }

  const cleanServerPart = serverPart.replace(/^https?:\/\//i, '');
  const [host, portStr] = cleanServerPart.split(':');
  const port = portStr ? parseInt(portStr, 10) : 30015;

  const hanaUser = overrideHanaUser || currentSapConfig.hanaUser || 'SYSTEM';
  const hanaPassword = overrideHanaPassword || currentSapConfig.hanaPassword || '';

  return new Promise((resolve) => {
    let client: any;
    let isResolved = false;

    const cleanupAndResolve = (result: { success: boolean; rows: any[]; error?: string }) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timer);
        if (client) {
          try { client.end(); } catch (_) {}
        }
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      cleanupAndResolve({ success: false, rows: [], error: `Timeout al conectar a SAP HANA (${host}:${port}) con usuario '${hanaUser}' (3s)` });
    }, 3000);

    try {
      client = hdbModule.createClient({ host, port, user: hanaUser, password: hanaPassword, connectTimeout: 2500 });

      if (client.on) {
        client.on('error', (err: any) => cleanupAndResolve({ success: false, rows: [], error: `Error socket HANA (${host}:${port}, usuario '${hanaUser}'): ${err?.message || 'Socket cerrado'}` }));
      }

      client.connect((err: any) => {
        if (err) return cleanupAndResolve({ success: false, rows: [], error: `Error de autenticación/conexión HANA (${host}:${port}, usuario '${hanaUser}'): ${err.message}` });

        try { console.log(`[HANA DEBUG] connected to HANA ${host}:${port} as '${hanaUser}' - executing QUERY`); } catch (e) {}

        client.exec(query, (execErr: any, rows: any[]) => {
          if (execErr) {
            console.warn(`HANA QUERY execution error [${query}]:`, execErr);
            return cleanupAndResolve({ success: false, rows: [], error: `Error ejecutando QUERY en HANA: ${execErr.message}` });
          }

          const resultRows = normalizeHanaRows(rows);
          if (!resultRows || resultRows.length === 0) {
            return cleanupAndResolve({ success: true, rows: [], error: 'Query ejecutado correctamente pero no devolvió filas.' });
          }

          cleanupAndResolve({ success: true, rows: resultRows });
        });
      });
    } catch (err: any) {
      cleanupAndResolve({ success: false, rows: [], error: `Excepción cliente HANA (query): ${err.message}` });
    }
  });
}
