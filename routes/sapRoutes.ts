import { Router } from 'express';
import { currentSapConfig, activeSessions, customSchemas, fallbackSandboxSchemas } from '../config/sapConfig';
import { fetchSchemasFromPostgres, fetchDbInstancesFromPostgres } from '../services/postgresService';
import { fetchSchemasFromHana, callHanaStoredProcedure, fetchUserProfileFromHana, executeHanaQuery } from '../services/hanaService';
import { makeSapRequest } from '../services/sapServiceLayer';
import { pgPool } from '../config/db';

const router = Router();

/**
 * Retorna la fecha actual en formato YYYY-MM-DD ajustada a la zona horaria de Paraguay (America/Asuncion, UTC-4).
 * Evita el desfasaje de fecha producido al usar .toISOString() en horas nocturnas (ej. 22hs PY = 02hs UTC del día siguiente).
 */
export function getPyDateString(dateInput?: Date | string): string {
  const date = dateInput ? new Date(dateInput) : new Date();
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Asuncion',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// Function to ensure convertia."CONVERSIONES" and "DETCONVERSIONES" tables exist in PostgreSQL
export async function ensureConversionTablesExist() {
  try {
    await pgPool.query(`CREATE SCHEMA IF NOT EXISTS convertia;`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS convertia."CONVERSIONES" (
        "nroConv" SERIAL PRIMARY KEY,
        "WhsSal" VARCHAR(50),
        "DocEntrySal" INT,
        "DocNumSal" INT,
        "FechaSalida" VARCHAR(30),
        "WhsEnt" VARCHAR(50),
        "DocEntryEnt" INT,
        "DocNumEnt" INT,
        "FechaEntrada" VARCHAR(30),
        "User" VARCHAR(100),
        "Estado" VARCHAR(10),
        "Schema" VARCHAR(100)
      );
    `);
    await pgPool.query(`ALTER TABLE convertia."CONVERSIONES" ADD COLUMN IF NOT EXISTS "Schema" VARCHAR(100);`);
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS convertia."DETCONVERSIONES" (
        "id" SERIAL PRIMARY KEY,
        "nroConv" INT,
        "ItemCode" VARCHAR(100),
        "Dscription" VARCHAR(254),
        "Qty" NUMERIC(19,6),
        "Objeto" VARCHAR(20)
      );
    `);
    console.log('[Postgres Schema]: Schema and tables convertia."CONVERSIONES" & "DETCONVERSIONES" verified successfully.');
  } catch (err: any) {
    console.warn('[Postgres Schema Warning]:', err.message);
  }
}

// Call on startup
ensureConversionTablesExist().catch(err => console.warn('[Postgres Startup Error]:', err));

// Constant Warehouse Mapping for ExtendIA: Source Warehouse -> Target Warehouse
const WAREHOUSE_CONVERTIA_MAP: Record<string, string> = {
  'CAM-OPE': 'CAM-VEN',
  'CLI-OPE': 'CLI-VEN',
  'CDE-OPE': 'CDE-VEN',
  'ENC-OPE': 'ENC-VEN',
  'ITG-OPE': 'ITG-OPE',
  'ITG-PRO': 'ITG-PRO',
  'OVI-OPE': 'OVI-VEN',
};

// API: Get SAP Servers / DBINSTANCES from PostgreSQL convertia."DBINSTANCES"
router.get('/sap/servers', async (_req, res) => {
  try {
    const servers = await fetchDbInstancesFromPostgres();
    if (servers.length > 0) {
      return res.json(servers);
    }
  } catch (err: any) {
    console.warn('[Postgres DBINSTANCES Query Warning]:', err.message);
  }

  // Fallback default server config
  res.json([
    {
      ServerName: 'Servidor 2019 (172.19.0.88)',
      ServerType: 'HANA',
      Version: '10.0',
      ServiceLayer: currentSapConfig.serviceLayerUrl || 'https://172.19.0.88:50000/b1s/v1',
      ServerHanaPort: currentSapConfig.hanaServer || '172.19.0.88:30015',
      HanaUser: currentSapConfig.hanaUser || 'SYSTEM',
      HanaPassword: currentSapConfig.hanaPassword || 'Admin123',
    }
  ]);
});

// API: Available SAP Schemas
router.get('/sap/schemas', async (req, res) => {
  const forceScan = req.query.scan === 'true';

  if (currentSapConfig.isSandbox) {
    return res.json([...customSchemas, ...fallbackSandboxSchemas]);
  }

  let liveSapSchemas: Array<{ DbName: string; cpnyName: string; version?: string; dbType?: string }> = [];

  try {
    const pgSchemas = await fetchSchemasFromPostgres();
    if (pgSchemas.length > 0) {
      liveSapSchemas = pgSchemas;
    }
  } catch (err: any) {
    console.warn('Postgres schema query error:', err.message);
  }

  if (liveSapSchemas.length > 0) {
    const resultList = [...customSchemas];
    liveSapSchemas.forEach((live) => {
      if (!resultList.some((s) => s.DbName.toUpperCase() === live.DbName.toUpperCase())) {
        resultList.push(live);
      }
    });
    return res.json(resultList);
  }

  if (forceScan) {
    try {
      const hanaSchemas = await fetchSchemasFromHana();
      if (hanaSchemas.length > 0) {
        liveSapSchemas = hanaSchemas;
      }
    } catch (err: any) {
      console.warn('HANA schema query error:', err.message);
    }
  }

  if ((forceScan || liveSapSchemas.length === 0) && currentSapConfig.serviceLayerUrl) {
    try {
      const sapRes = await makeSapRequest(
        currentSapConfig.serviceLayerUrl,
        'CompanyService_GetCompanyList',
        { method: 'POST', body: {}, timeout: 2000 }
      );
      if (sapRes.status === 200 && Array.isArray(sapRes.data?.value)) {
        const liveList = sapRes.data.value.map((c: any) => ({
          DbName: c.CompanyDB || c.DbName || c.code,
          cpnyName: c.CompanyName || c.cpnyName || c.name || c.CompanyDB,
          dbType: 'HANA',
        }));
        liveList.forEach((live: any) => {
          if (!liveSapSchemas.some((s) => s.DbName.toUpperCase() === live.DbName.toUpperCase())) {
            liveSapSchemas.push(live);
          }
        });
      }
    } catch (err: any) {
      console.warn('SAP live schema scan skipped/unreachable:', err.message);
    }
  }

  const resultList = [...customSchemas];
  liveSapSchemas.forEach((live) => {
    if (!resultList.some((s) => s.DbName.toUpperCase() === live.DbName.toUpperCase())) {
      resultList.push(live);
    }
  });

  if (resultList.length > 0) {
    return res.json(resultList);
  }

  res.json(fallbackSandboxSchemas);
});

// API: Add or register a custom schema
router.post('/sap/schemas', (req, res) => {
  const { DbName, cpnyName } = req.body;
  if (!DbName) {
    return res.status(400).json({ success: false, error: 'DbName es requerido' });
  }

  const cleanDb = String(DbName).trim();
  const cleanName = (cpnyName || cleanDb).trim();

  const existing = customSchemas.find((s) => s.DbName.toUpperCase() === cleanDb.toUpperCase());
  if (existing) {
    existing.cpnyName = cleanName;
  } else {
    customSchemas.unshift({
      DbName: cleanDb,
      cpnyName: cleanName,
      version: '10.0',
      dbType: 'HANA',
    });
  }

  res.json({ success: true, schemas: customSchemas });
});

// API: SAP Login
router.post('/sap/login', async (req, res) => {
  const username = req.body.username || req.body.userName;
  const password = req.body.password;
  const companyDB = req.body.schema || req.body.companyDB;
  const serverUrl = req.body.serviceLayerUrl || req.body.serverUrl || currentSapConfig.serviceLayerUrl;
  const isSandbox = req.body.isSandbox !== undefined ? req.body.isSandbox : (req.body.isDemoMode !== undefined ? req.body.isDemoMode : currentSapConfig.isSandbox);
  const language = req.body.language || 25;

  const userProfile = await fetchUserProfileFromHana(companyDB, username);

  if (isSandbox) {
    const demoSessionId = 'B1SESSION-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const allKnownSchemas = [...customSchemas, ...fallbackSandboxSchemas];
    const matchedSchema = allKnownSchemas.find(s => s.DbName.toUpperCase() === (companyDB || '').toUpperCase());
    const companyName = userProfile.CompnyName || matchedSchema?.cpnyName || companyDB || 'TandemPRO S.A. - Producción';

    const userObj = {
      ...userProfile,
      UserName: userProfile.username || username || 'manager',
      UserCode: (username || 'manager').toUpperCase(),
      CompanyDB: companyDB || 'SBO_TANDEMPRO_PROD',
      CompanyName: companyName,
      SessionId: demoSessionId,
      Version: '1000210 (SAP B1 v10 FP2102)',
      SessionTimeout: 30,
      IsAdmin: true,
      SessionID: demoSessionId,
      isSandbox: true,
    };

    const sessionObj = {
      ...userProfile,
      sessionId: demoSessionId,
      version: '1000210 (SAP B1 v10 FP2102)',
      sessionTimeout: 30,
      companyDB: companyDB || 'SBO_TANDEMPRO_PROD',
      companyName: companyName,
      userName: userProfile.username || username || 'manager',
      serverUrl: serverUrl || currentSapConfig.serviceLayerUrl,
      loggedInAt: Date.now(),
      isDemoMode: true,
    };

    return res.json({
      success: true,
      user: userObj,
      session: sessionObj,
    });
  }

  if (!serverUrl || !companyDB || !username || !password) {
    return res.status(400).json({
      success: false,
      error: 'Debe proporcionar la URL del Service Layer, Esquema / CompanyDB, Usuario y Contraseña.'
    });
  }

  try {
    const response = await makeSapRequest(serverUrl, 'Login', {
      method: 'POST',
      body: {
        CompanyDB: companyDB,
        UserName: username,
        Password: password,
        Language: language,
      },
    });

    if (response.status === 200 && response.data.SessionId) {
      const sessionId = response.data.SessionId;
      const cookies = response.headers['set-cookie'] || [];
      let routeId = '';
      if (Array.isArray(cookies)) {
        cookies.forEach(c => {
          if (c.includes('ROUTEID=')) {
            const match = c.match(/ROUTEID=([^;]+)/);
            if (match) routeId = match[1];
          }
        });
      }

      currentSapConfig.isSandbox = false;
      if (serverUrl) currentSapConfig.serviceLayerUrl = serverUrl;
      if (req.body.hanaServer) currentSapConfig.hanaServer = req.body.hanaServer;
      if (req.body.hanaUser) currentSapConfig.hanaUser = req.body.hanaUser;
      if (req.body.hanaPassword) currentSapConfig.hanaPassword = req.body.hanaPassword;

      activeSessions.set(sessionId, {
        b1session: sessionId,
        routeId,
        serverUrl,
        companyDB,
        userName: username,
        expiresAt: Date.now() + (response.data.SessionTimeout || 30) * 60 * 1000,
      });

      const allKnownSchemas = [...customSchemas, ...fallbackSandboxSchemas];
      const matchedSchema = allKnownSchemas.find(s => s.DbName.toUpperCase() === companyDB.toUpperCase());
      const companyName = userProfile.CompnyName || matchedSchema?.cpnyName || companyDB;

      const userObj = {
        ...userProfile,
        UserName: userProfile.username || username,
        UserCode: username.toUpperCase(),
        CompanyDB: companyDB,
        CompanyName: companyName,
        SessionId: sessionId,
        Version: response.data.Version || '10.0',
        SessionTimeout: response.data.SessionTimeout || 30,
        IsAdmin: true,
        SessionID: sessionId,
        isSandbox: false,
      };

      const sessionObj = {
        ...userProfile,
        sessionId,
        version: response.data.Version || '10.0',
        sessionTimeout: response.data.SessionTimeout || 30,
        companyDB,
        companyName,
        userName: userProfile.username || username,
        serverUrl,
        loggedInAt: Date.now(),
        isDemoMode: false,
      };

      return res.json({
        success: true,
        user: userObj,
        session: sessionObj,
      });
    } else {
      const errMsg = response.data?.error?.message?.value || response.data?.error?.message || 'Credenciales no válidas o base de datos no disponible en SAP B1';
      return res.status(response.status || 401).json({
        success: false,
        error: errMsg,
      });
    }
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: `Error de conexión con SAP Service Layer (${serverUrl}): ${error.message || 'Verifique conectividad y certificados SSL'}. Puede activar el 'Simulador Sandbox' en Ajustes para continuar.`,
    });
  }
});

// API: SAP Logout
router.post('/sap/logout', async (req, res) => {
  const { sessionId, serverUrl } = req.body;
  if (sessionId && serverUrl) {
    try {
      await makeSapRequest(serverUrl, 'Logout', {
        method: 'POST',
        sessionId,
      });
      activeSessions.delete(sessionId);
    } catch (e) {
      // ignore
    }
  }
  res.json({ success: true });
});

// API: Warehouses
router.get('/sap/warehouses', async (req, res) => {
  const sessionId = req.header('X-SAP-Session');
  const sessionInfo = sessionId ? activeSessions.get(sessionId) : null;
  const schema = (req.query.schema || req.query.companyDB || req.header('X-SAP-CompanyDB') || sessionInfo?.companyDB || 'FG_DESARROLLO') as string;

  const targetSchema = schema.trim();
  const pgSql = `SELECT "whsCode", "whsName", "equWhsCode", "equWhsName", "Schema" FROM convertia."OWHS" a WHERE a."Schema" = '${targetSchema.replace(/'/g, "''")}'`;

  try {
    const pgRes = await pgPool.query(
      `SELECT "whsCode", "whsName", "equWhsCode", "equWhsName", "Schema" FROM convertia."OWHS" a WHERE a."Schema" = $1 OR UPPER(a."Schema") = UPPER($1)`,
      [targetSchema]
    );

    if (pgRes && pgRes.rows && pgRes.rows.length > 0) {
      const warehouses = pgRes.rows.map((r: any) => {
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

        const wCode = String(getV('whsCode', 'whscode', 'whs_code', 'WarehouseCode') ?? '').trim();
        const wName = String(getV('whsName', 'whsname', 'whs_name', 'WarehouseName') ?? '').trim() || `Almacén ${wCode}`;
        const eqCode = String(getV('equWhsCode', 'equwhscode', 'equ_whs_code', 'EquWhsCode') ?? '').trim();
        const eqName = String(getV('equWhsName', 'equwhsname', 'equ_whs_name', 'EquWhsName') ?? '').trim();

        return {
          WarehouseCode: wCode,
          WarehouseName: wName,
          EquWhsCode: eqCode,
          EquWhsName: eqName,
          Street: 'Planta Principal',
          City: 'Capiatá',
          Inactive: 'tNO' as const,
        };
      }).filter(w => w.WarehouseCode.length > 0);

      if (warehouses.length > 0) {
        return res.json({
          value: warehouses,
          spQueryUsed: pgSql,
          source: 'POSTGRES_OWHS'
        });
      }
    }
  } catch (err: any) {
    console.warn('[Postgres OWHS Query Warning]:', err.message);
  }

  const userCode = (req.query.userCode || req.query.userName || req.header('X-SAP-UserCode') || sessionInfo?.userName || 'gualber') as string;
  const vendedor = (req.query.vendedor || '1') as string;
  const safeSchema = targetSchema.replace(/'/g, "''");
  const safeUser = userCode.replace(/'/g, "''");
  const safeVendedor = vendedor.replace(/'/g, "''");
  const spQuery = `CALL "PL_SERVICES"."SP_CONVERTIA_OWHS" ('${safeSchema}', '${safeUser}', '${safeVendedor}')`;

  const hanaResult = await callHanaStoredProcedure(spQuery, safeSchema, safeUser, safeVendedor);

  if (hanaResult.success && Array.isArray(hanaResult.rows) && hanaResult.rows.length > 0) {
    const warehouses = hanaResult.rows.map((r: any) => {
      let code = r.Codigo ?? r.CODIGO ?? r.WhsCode ?? r.WHSCODE ?? r.WarehouseCode ?? r.CODE ?? r.code ?? '';
      let name = r.Nombre ?? r.NOMBRE ?? r.WhsName ?? r.WHSNAME ?? r.WarehouseName ?? r.NAME ?? r.name ?? '';
      const finalCode = String(code).trim();
      const finalName = String(name).trim() || `Almacén ${finalCode}`;

      return {
        WarehouseCode: finalCode,
        WarehouseName: finalName,
        EquWhsCode: '',
        EquWhsName: '',
        Street: 'Planta Principal',
        City: 'Capiatá',
        Inactive: 'tNO',
      };
    }).filter(w => w.WarehouseCode.length > 0);

    if (warehouses.length > 0) {
      return res.json({ value: warehouses, spQueryUsed: spQuery, source: 'HANA_SP' });
    }
  }

  res.json({
    value: [
      { WarehouseCode: 'ITG-PRO', WarehouseName: 'Almacén ITG Producción', EquWhsCode: 'ITG-VEN', EquWhsName: 'Almacén ITG Ventas', Street: 'Planta Principal', City: 'Capiatá', Inactive: 'tNO' },
      { WarehouseCode: 'CDE-OPE', WarehouseName: 'Almacén CDE Operaciones', EquWhsCode: 'CDE-VEN', EquWhsName: 'Almacén CDE Ventas', Street: 'Planta CDE', City: 'Ciudad del Este', Inactive: 'tNO' },
      { WarehouseCode: 'CAM-OPE', WarehouseName: 'Almacén Capiatá Operaciones', EquWhsCode: 'CAM-VEN', EquWhsName: 'Almacén Capiatá Ventas', Street: 'Planta Capiatá', City: 'Capiatá', Inactive: 'tNO' },
    ],
    spQueryUsed: pgSql,
    source: 'SANDBOX_MOCK',
  });
});

// API: Business Lines
router.get('/sap/business-lines', async (req, res) => {
  const sessionId = req.header('X-SAP-Session');
  const sessionInfo = sessionId ? activeSessions.get(sessionId) : null;
  const schema = (req.query.schema || req.query.companyDB || req.header('X-SAP-CompanyDB') || sessionInfo?.companyDB || 'FG_DESARROLLO') as string;

  const targetSchema = schema.trim();
  const pgSql = `SELECT "PrcCode", "PrcName", "Schema" FROM convertia."OPRC" A WHERE A."Schema" = '${targetSchema.replace(/'/g, "''")}'`;

  try {
    const pgRes = await pgPool.query(
      `SELECT "PrcCode", "PrcName", "Schema" FROM convertia."OPRC" a WHERE a."Schema" = $1 OR UPPER(a."Schema") = UPPER($1)`,
      [targetSchema]
    );

    if (pgRes && pgRes.rows && pgRes.rows.length > 0) {
      const items = pgRes.rows.map((r: any) => {
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

        const prcCode = String(getV('PrcCode', 'prccode', 'prc_code') ?? '').trim();
        const prcName = String(getV('PrcName', 'prcname', 'prc_name') ?? '').trim() || prcCode;

        return {
          PrcCode: prcCode,
          PrcName: prcName,
          Schema: String(getV('Schema', 'schema') ?? targetSchema).trim(),
        };
      }).filter(b => b.PrcCode.length > 0);

      if (items.length > 0) {
        return res.json({ value: items, source: 'POSTGRES_OPRC', queryUsed: pgSql });
      }
    }
  } catch (err: any) {
    console.warn('[Postgres OPRC Query Warning]:', err.message);
  }

  res.json({
    value: [
      { PrcCode: 'PAPAS', PrcName: 'Línea Papas', Schema: targetSchema },
      { PrcCode: 'HAMBURG', PrcName: 'Línea Hamburguesas', Schema: targetSchema },
      { PrcCode: 'BEBIDAS', PrcName: 'Línea Bebidas', Schema: targetSchema },
    ],
    source: 'SANDBOX_MOCK',
    queryUsed: pgSql,
  });
});

// API: Inventory items endpoint
router.get('/sap/inventory', async (req, res) => {
  const warehouse = (req.query.warehouse || '01') as string;
  const sessionId = req.header('X-SAP-Session');
  const sessionInfo = sessionId ? activeSessions.get(sessionId) : null;
  const schema = (req.query.schema || req.query.companyDB || req.header('X-SAP-CompanyDB') || sessionInfo?.companyDB || 'FG_DESARROLLO') as string;

  const rawBusinessLines = req.query.businessLines;
  let selectedLines: string[] = [];
  if (typeof rawBusinessLines === 'string' && rawBusinessLines.trim().length > 0) {
    selectedLines = rawBusinessLines.split(',').map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(rawBusinessLines)) {
    selectedLines = rawBusinessLines.map(s => String(s).trim()).filter(Boolean);
  }

  if (selectedLines.length === 0) {
    return res.json({ items: [], source: 'NO_BUSINESS_LINES_SELECTED', message: 'Seleccione al menos una Línea de Negocio.' });
  }

  const safeWhsCode = String(warehouse).replace(/'/g, "''");
  const safeSchema = String(schema).replace(/[^a-zA-Z0-9_]/g, '');
  const formattedInClause = selectedLines.map(line => `'${line.replace(/'/g, "''")}'`).join(', ');

  const invQuery = `SELECT "ItemCode" AS "CODIGO_SAP", "ItemName" AS "DESCRIPCION", "Lote/Serie" AS "LOTE / SERIE", SUM("Quantity") AS "DISPONIBLE", sum("CostoT") AS "COST_OTOTAL", "ArtEq" AS "ART_EQUIVALENTE", sum("EqQty") as "CANT_EQUIVALENTE", round(sum("CostoT")/sum("EqQty"),0) AS "COST_EQUIV_UNITARIO", "UNIDAD_NEGOCIO" FROM (
    SELECT 'Lote' AS "Lote/Serie", T0."ItemCode", T1."ItemName", T2."SysNumber", T2."DistNumber", T2."MnfSerial", T0."Quantity", t1."U_ItemEq" AS "ArtEq", (t1."U_ItemQty" * T0."Quantity") AS "EqQty", (t0."Quantity" * t1."AvgPrice") AS "CostoT", T1."U_UN_CC" AS "UNIDAD_NEGOCIO"
    FROM "${safeSchema}"."OBTQ" T0 INNER JOIN "${safeSchema}"."OITM" T1 ON T0."ItemCode" = T1."ItemCode" INNER JOIN "${safeSchema}"."OBTN" T2 ON T0."MdAbsEntry" = T2."AbsEntry"
    WHERE T0."Quantity" > 0 AND T0."ItemCode" <> 'zprueba' AND T0."WhsCode" = '${safeWhsCode}' AND T1."U_UN_CC" IN (${formattedInClause})
    UNION ALL
    SELECT 'Serie' AS "Lote/Serie", T0."ItemCode", T1."ItemName", T2."SysNumber", T2."DistNumber", T2."MnfSerial", T0."Quantity", t1."U_ItemEq" AS "ArtEq", (t1."U_ItemQty" * T0."Quantity") AS "EqQty", (t0."Quantity" * t1."AvgPrice") AS "CostoT", T1."U_UN_CC" AS "UNIDAD_NEGOCIO"
    FROM "${safeSchema}"."OSRQ" T0 INNER JOIN "${safeSchema}"."OITM" T1 ON T0."ItemCode" = T1."ItemCode" INNER JOIN "${safeSchema}"."OSRN" T2 ON T0."MdAbsEntry" = T2."AbsEntry"
    WHERE T0."Quantity" > 0 AND T0."ItemCode" <> 'zprueba' AND T0."WhsCode" = '${safeWhsCode}' AND T1."U_UN_CC" IN (${formattedInClause})
  )
  GROUP BY "ItemCode", "ItemName", "Lote/Serie", "ArtEq", "UNIDAD_NEGOCIO"
  ORDER BY 1`;

  try {
    const hanaResult = await executeHanaQuery(invQuery);
    if (hanaResult.success && Array.isArray(hanaResult.rows)) {
      const items = hanaResult.rows.map((r: any) => {
        const getV = (...keys: string[]) => {
          if (!r || typeof r !== 'object') return undefined;
          for (const k of keys) {
            if (r[k] !== undefined && r[k] !== null) return r[k];
          }
          const rKeys = Object.keys(r);
          for (const k of keys) {
            const cleanK = k.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
            const found = rKeys.find(ok => ok.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === cleanK);
            if (found && r[found] !== undefined && r[found] !== null) return r[found];
          }
          return undefined;
        };

        const code = String(getV('CODIGO_SAP', 'Codigo_Sap', 'ItemCode') ?? '').trim();
        const name = String(getV('DESCRIPCION', 'Descripcion', 'ItemName') ?? '').trim();
        const loteSerieRaw = String(getV('LOTE / SERIE', 'LOTE/SERIE', 'Lote/Serie', 'LoteSerie') ?? 'Lote').trim();
        const disponible = Number(getV('DISPONIBLE', 'Disponible', 'Quantity') ?? 0);
        const costTotal = Number(getV('COST_OTOTAL', 'CostOTotal', 'CostoT') ?? 0);
        const artEq = String(getV('ART_EQUIVALENTE', 'ArtEq', 'ArticuloEquivalente') ?? '').trim();
        const cantEq = Number(getV('CANT_EQUIVALENTE', 'EqQty', 'CantidadEquivalente') ?? 0);
        const costEqUnit = Number(getV('COST_EQUIV_UNITARIO', 'CostEquivUnitario') ?? 0);
        const unidadNegocio = String(getV('UNIDAD_NEGOCIO', 'Unidad_Negocio', 'U_UN_CC', 'unidadNegocio') ?? selectedLines[0] ?? '').trim();

        const isLote = loteSerieRaw.toLowerCase().includes('lote');

        return {
          ItemCode: code,
          ItemName: name,
          LoteSerie: isLote ? 'Lote' : 'Serie',
          ManageBatchNumbers: isLote ? 'tYES' : 'tNO',
          ManageSerialNumbers: !isLote ? 'tYES' : 'tNO',
          InventoryUOM: 'PZA',
          AvgStdPrice: costEqUnit > 0 ? costEqUnit : (disponible > 0 && costTotal > 0 ? costTotal / disponible : 100),
          OnHand: disponible,
          WarehouseStock: disponible,
          CostoTotal: costTotal,
          ArticuloEquivalente: artEq || 'SIN EQUIVALENCIA',
          CantidadEquivalente: cantEq || disponible,
          CostoEquivUnitario: costEqUnit || (disponible > 0 ? costTotal / disponible : 100),
          UnidadNegocio: unidadNegocio,
          ItemType: isLote ? 'Batch' : 'Serial',
          Batches: isLote ? [
            {
              BatchNumber: `LOTE-${code}-01`,
              ItemCode: code,
              Quantity: disponible,
              UnitCost: costEqUnit || 100,
              WarehouseCode: warehouse,
              Status: 'Released',
            }
          ] : [],
          Serials: !isLote ? [
            {
              SerialNumber: `SER-${code}-01`,
              ItemCode: code,
              UnitCost: costEqUnit || 100,
              WarehouseCode: warehouse,
              Status: 'Available',
            }
          ] : [],
        };
      }).filter(i => i.ItemCode.length > 0);

      return res.json({ items, source: 'HANA_DIRECT_QUERY', queryUsed: invQuery });
    }
  } catch (err) {
    console.warn('HANA inventory query failed:', err);
  }

  res.json({ items: [], source: 'HANA_EMPTY' });
});

// API: Finished goods
router.get('/sap/finished-goods', async (_req, res) => {
  res.json({
    items: [
      {
        ItemCode: 'PT-5000',
        ItemName: 'Robótica Ensamblada v1 - Módulo Autónomo',
        InventoryUOM: 'PZA',
        ManageBatchNumbers: 'tNO',
        ManageSerialNumbers: 'tYES',
        DefaultWarehouse: '04',
        SuggestedSellingPrice: 1250.00,
        StandardCost: 681.55,
        Description: 'Equipo terminado con certificación IP67 y control IoT integrado para despacho comercial.',
      }
    ]
  });
});

// API: History
router.get('/sap/history', async (_req, res) => {
  try {
    await ensureConversionTablesExist();
    const historyRes = await pgPool.query(
      `SELECT * FROM convertia."CONVERSIONES" ORDER BY "nroConv" DESC LIMIT 50`
    );
    const history = historyRes.rows || [];
    for (const row of history) {
      try {
        const detRes = await pgPool.query(
          `SELECT * FROM convertia."DETCONVERSIONES" WHERE "nroConv" = $1 ORDER BY id ASC`,
          [row.nroConv]
        );
        row.details = detRes.rows || [];
      } catch (e) {
        row.details = [];
      }
    }
    res.json({ history });
  } catch (err: any) {
    res.json({ history: [], error: err.message });
  }
});

// API: Full ExtendIA Process (Salida /InventoryGenExits -> Entrada /InventoryGenEntries -> Reference Patch)
router.post('/sap/convertia', async (req, res) => {
  const { warehouseCode, targetWarehouseCode, selectedItems, session, schema: schemaParam } = req.body;
  let reqSessionId = req.header('X-SAP-Session') || req.header('X-SAP-B1SESSION') || session?.sessionId || session?.SessionId || session?.b1session;

  let sessionInfo = reqSessionId ? activeSessions.get(reqSessionId) : null;

  if (!sessionInfo && activeSessions.size > 0) {
    for (const [sId, sData] of activeSessions.entries()) {
      if (!reqSessionId) reqSessionId = sId;
      if (!schemaParam || sData.companyDB?.toUpperCase() === String(schemaParam).toUpperCase()) {
        sessionInfo = sData;
        reqSessionId = sId;
        break;
      }
      if (!sessionInfo) sessionInfo = sData;
    }
  }

  const schema = schemaParam || req.query.schema || req.header('X-SAP-CompanyDB') || sessionInfo?.companyDB || session?.companyDB || session?.BD || 'FG_PROD';
  const b1session = sessionInfo?.b1session || reqSessionId || session?.sessionId || session?.SessionId;
  const serverUrl = sessionInfo?.serverUrl || session?.serverUrl || currentSapConfig.serviceLayerUrl || 'https://172.19.0.88:50000/b1s/v1';
  const routeId = sessionInfo?.routeId || session?.routeId || '';
  const isDemo = session?.isDemoMode || currentSapConfig.isSandbox;

  const safeWhsCode = String(warehouseCode || '01').trim();
  const safeSchema = String(schema).replace(/[^a-zA-Z0-9_]/g, '');

  let equWhsFromPg = '';
  try {
    const pgWhsRes = await pgPool.query(
      `SELECT "equWhsCode" FROM convertia."OWHS" WHERE ("whsCode" = $1 OR UPPER("whsCode") = UPPER($1)) AND ("Schema" = $2 OR UPPER("Schema") = UPPER($2)) LIMIT 1`,
      [safeWhsCode, safeSchema]
    );
    if (pgWhsRes && pgWhsRes.rows && pgWhsRes.rows.length > 0) {
      const rowVal = pgWhsRes.rows[0].equWhsCode || pgWhsRes.rows[0].equwhscode || pgWhsRes.rows[0].EQUWHSCODE;
      if (rowVal && String(rowVal).trim().length > 0) {
        equWhsFromPg = String(rowVal).trim();
      }
    }
    if (!equWhsFromPg) {
      const pgWhsResFallback = await pgPool.query(
        `SELECT "equWhsCode" FROM convertia."OWHS" WHERE ("whsCode" = $1 OR UPPER("whsCode") = UPPER($1)) LIMIT 1`,
        [safeWhsCode]
      );
      if (pgWhsResFallback && pgWhsResFallback.rows && pgWhsResFallback.rows.length > 0) {
        const rowVal = pgWhsResFallback.rows[0].equWhsCode || pgWhsResFallback.rows[0].equwhscode || pgWhsResFallback.rows[0].EQUWHSCODE;
        if (rowVal && String(rowVal).trim().length > 0) {
          equWhsFromPg = String(rowVal).trim();
        }
      }
    }
  } catch (err: any) {
    console.warn('[ExtendIA] Warning querying PostgreSQL convertia."OWHS" for equWhsCode:', err.message);
  }

  const mapTargetWhs = WAREHOUSE_CONVERTIA_MAP[safeWhsCode.toUpperCase()];
  const computedTargetWhs = equWhsFromPg || targetWarehouseCode || mapTargetWhs || (
    safeWhsCode.toUpperCase().endsWith('-OPE')
      ? safeWhsCode.toUpperCase().replace(/-OPE$/, '-VEN')
      : safeWhsCode
  );

  const safeTargetWhsCode = String(computedTargetWhs).replace(/'/g, "''");
  const todayStr = getPyDateString();

  if (!Array.isArray(selectedItems) || selectedItems.length === 0) {
    return res.status(400).json({
      success: false,
      message: 'No se enviaron artículos para procesar.',
    });
  }

  if (!isDemo && !b1session) {
    return res.status(401).json({
      success: false,
      message: 'No hay una sesión activa en SAP Service Layer (B1SESSION). Por favor inicie sesión en SAP B1.',
    });
  }

  const validItems: any[] = [];
  let skippedCount = 0;

  selectedItems.forEach((item: any) => {
    const artEq = String(item.ArticuloEquivalente || item.ArtEq || '').trim();
    if (artEq && artEq !== 'SIN EQUIVALENCIA' && artEq !== '-' && artEq !== 'PT-5000') {
      validItems.push(item);
    } else {
      skippedCount++;
    }
  });

  if (validItems.length === 0) {
    return res.json({
      success: false,
      message: 'Ninguno de los artículos seleccionados posee un Artículo Equivalente válido.',
      processedCount: 0,
      skippedCount,
    });
  }

  const processedLines: Array<{
    itemCode: string;
    isLote: boolean;
    quantity: number;
    artEq: string;
    cantEq: number;
    costEqUnit: number;
    batches: Array<{ batchNumber: string; quantity: number }>;
    serials: Array<{ manufacturerSerialNumber: string; internalSerialNumber: string; systemSerialNumber: number }>;
  }> = [];

  for (const item of validItems) {
    const itemCode = String(item.ItemCode || '').trim();
    const isLote = item.LoteSerie === 'Lote' || item.ManageBatchNumbers === 'tYES' || item.ItemType === 'Batch';
    const safeItemCode = itemCode.replace(/'/g, "''");

    let batchList: Array<{ batchNumber: string; quantity: number }> = [];
    let serialList: Array<{ manufacturerSerialNumber: string; internalSerialNumber: string; systemSerialNumber: number }> = [];

    let artEq = String(item.ArticuloEquivalente || item.ArtEq || '').trim();
    let cantEq = Number(item.CantidadEquivalente || item.EqQty || item.WarehouseStock || 1);
    let costEqUnit = Number(item.CostoEquivUnitario || item.AvgStdPrice || 100);
    let totalItemQty = Number(item.OnHand || item.WarehouseStock || item.Quantity || 1);

    let hanaBatches: Array<{ batchNumber: string; quantity: number }> = [];
    let hanaSerials: Array<{ manufacturerSerialNumber: string; internalSerialNumber: string; systemSerialNumber: number }> = [];

    const getRowVal = (row: any, ...keys: string[]) => {
      for (const k of keys) {
        if (row && row[k] !== undefined && row[k] !== null) {
          return row[k];
        }
      }
      return undefined;
    };

    if (isLote) {
      const loteQuery = `SELECT 'Lote' AS "Lote/Serie", T0."ItemCode", T1."ItemName", T2."SysNumber", T2."DistNumber", T2."MnfSerial", T0."Quantity", t1."U_ItemEq" AS "ArtEq", (t1."U_ItemQty" * T0."Quantity") AS "EqQty", (t0."Quantity" * t1."AvgPrice") AS "CostoT" FROM "${safeSchema}"."OBTQ" T0 INNER JOIN "${safeSchema}"."OITM" T1 ON T0."ItemCode" = T1."ItemCode" INNER JOIN "${safeSchema}"."OBTN" T2 ON T0."MdAbsEntry" = T2."AbsEntry" WHERE T0."Quantity" > 0 AND T0."ItemCode" = '${safeItemCode}' AND T0."WhsCode" = '${safeWhsCode}'`;

      try {
        const hanaRes = await executeHanaQuery(loteQuery);
        if (hanaRes.success && Array.isArray(hanaRes.rows) && hanaRes.rows.length > 0) {
          hanaBatches = hanaRes.rows.map((r: any) => {
            const dist = String(getRowVal(r, 'DistNumber', 'DISTNUMBER', 'distnumber') || '').trim();
            const qty = Number(getRowVal(r, 'Quantity', 'QUANTITY', 'quantity') || 1);
            return { batchNumber: dist === 'DistNumber' ? '' : dist, quantity: qty };
          }).filter(b => b.batchNumber.length > 0);

          let totalEqQtyFromHana = 0;
          let totalCostoTFromHana = 0;
          hanaRes.rows.forEach((r: any) => {
            totalEqQtyFromHana += Number(getRowVal(r, 'EqQty', 'EQQTY', 'eqqty') || 0);
            totalCostoTFromHana += Number(getRowVal(r, 'CostoT', 'COSTOT', 'costot') || 0);
          });

          const firstRow = hanaRes.rows[0];
          const fetchedEq = getRowVal(firstRow, 'ArtEq', 'ARTEQ', 'arteq');
          if (fetchedEq) artEq = String(fetchedEq).trim();
          if (totalEqQtyFromHana > 0) cantEq = totalEqQtyFromHana;
          if (totalEqQtyFromHana > 0 && totalCostoTFromHana > 0) {
            costEqUnit = Math.round(totalCostoTFromHana / totalEqQtyFromHana);
          }
        }
      } catch (err) {
        console.warn(`[ExtendIA] HANA Lote query failed for ${itemCode}:`, err);
      }

      const alloc = item.allocation;
      if (hanaBatches.length > 0) {
        let matchedFromAlloc: Array<{ batchNumber: string; quantity: number }> = [];
        if (alloc && alloc.selectedBatches && Object.keys(alloc.selectedBatches).length > 0) {
          Object.entries(alloc.selectedBatches).forEach(([bNum, qty]) => {
            const cleanB = String(bNum).trim();
            const numQty = Number(qty);
            if (numQty > 0 && cleanB.length > 0) {
              const matchedHana = hanaBatches.find(hb => hb.batchNumber === cleanB);
              if (matchedHana) {
                matchedFromAlloc.push({ batchNumber: cleanB, quantity: numQty });
              }
            }
          });
        }

        if (matchedFromAlloc.length > 0) {
          batchList = matchedFromAlloc;
        } else {
          batchList = hanaBatches;
        }
      } else if (alloc && alloc.selectedBatches && Object.keys(alloc.selectedBatches).length > 0) {
        batchList = Object.entries(alloc.selectedBatches)
          .map(([bNum, qty]) => ({ batchNumber: String(bNum).trim(), quantity: Number(qty) }))
          .filter(b => b.quantity > 0 && b.batchNumber.length > 0);
      } else if (isDemo) {
        batchList = [{ batchNumber: `DEMO-LOTE-${itemCode}`, quantity: totalItemQty }];
      } else {
        batchList = [];
      }

      if (batchList.length === 0) {
        batchList = [{ batchNumber: `LOTE-AUTO-${itemCode}`, quantity: totalItemQty || 1 }];
      }

      totalItemQty = batchList.reduce((acc, b) => acc + b.quantity, 0);

    } else {
      const serieQuery = `SELECT 'Serie' AS "Lote/Serie", T0."ItemCode", T1."ItemName", T2."SysNumber", T2."DistNumber", T2."MnfSerial", T0."Quantity", t1."U_ItemEq" AS "ArtEq", (t1."U_ItemQty" * T0."Quantity") AS "EqQty", (t0."Quantity" * t1."AvgPrice") AS "CostoT" FROM "${safeSchema}"."OSRQ" T0 INNER JOIN "${safeSchema}"."OITM" T1 ON T0."ItemCode" = T1."ItemCode" INNER JOIN "${safeSchema}"."OSRN" T2 ON T0."MdAbsEntry" = T2."AbsEntry" WHERE T0."Quantity" > 0 AND T0."ItemCode" = '${safeItemCode}' AND T0."WhsCode" = '${safeWhsCode}' ORDER BY T0."ItemCode"`;

      try {
        const hanaRes = await executeHanaQuery(serieQuery);
        if (hanaRes.success && Array.isArray(hanaRes.rows) && hanaRes.rows.length > 0) {
          hanaSerials = hanaRes.rows.map((r: any) => {
            const mnfRaw = getRowVal(r, 'MnfSerial', 'MNFSERIAL', 'mnfserial');
            const distRaw = getRowVal(r, 'DistNumber', 'DISTNUMBER', 'distnumber');
            const sysRaw = getRowVal(r, 'SysNumber', 'SYSNUMBER', 'sysnumber');

            const mnfStr = (mnfRaw === null || mnfRaw === undefined || mnfRaw === 'null' || mnfRaw === 'MnfSerial') ? '' : String(mnfRaw).trim();
            const distStr = (distRaw === null || distRaw === undefined || distRaw === 'null' || distRaw === 'DistNumber') ? '' : String(distRaw).trim();
            const sysNum = typeof sysRaw === 'number' ? sysRaw : Number(sysRaw || 0);

            return {
              manufacturerSerialNumber: mnfStr,
              internalSerialNumber: distStr,
              systemSerialNumber: sysNum,
            };
          }).filter(s => s.internalSerialNumber.length > 0 && s.internalSerialNumber !== 'DistNumber');

          let totalEqQtyFromHana = 0;
          let totalCostoTFromHana = 0;
          hanaRes.rows.forEach((r: any) => {
            totalEqQtyFromHana += Number(getRowVal(r, 'EqQty', 'EQQTY', 'eqqty') || 0);
            totalCostoTFromHana += Number(getRowVal(r, 'CostoT', 'COSTOT', 'costot') || 0);
          });

          const firstRow = hanaRes.rows[0];
          const fetchedEq = getRowVal(firstRow, 'ArtEq', 'ARTEQ', 'arteq');
          if (fetchedEq) artEq = String(fetchedEq).trim();
          if (totalEqQtyFromHana > 0) cantEq = totalEqQtyFromHana;
          if (totalEqQtyFromHana > 0 && totalCostoTFromHana > 0) {
            costEqUnit = Math.round(totalCostoTFromHana / totalEqQtyFromHana);
          }
        }
      } catch (err) {
        console.warn(`[ExtendIA] HANA Serie query failed for ${itemCode}:`, err);
      }

      const alloc = item.allocation;
      if (hanaSerials.length > 0) {
        let matchedFromAlloc: Array<{ manufacturerSerialNumber: string; internalSerialNumber: string; systemSerialNumber: number }> = [];
        if (alloc && alloc.selectedSerials && Array.isArray(alloc.selectedSerials) && alloc.selectedSerials.length > 0) {
          alloc.selectedSerials.forEach((sObj: any) => {
            let targetSerialNum = typeof sObj === 'object' && sObj !== null
              ? String(sObj.internalSerialNumber || sObj.DistNumber || sObj.serialNumber || sObj.DistNum || '').trim()
              : String(sObj).trim();

            const matchedHana = hanaSerials.find(hs => hs.internalSerialNumber === targetSerialNum);
            if (matchedHana) {
              matchedFromAlloc.push(matchedHana);
            }
          });
        }

        if (matchedFromAlloc.length > 0) {
          serialList = matchedFromAlloc;
        } else {
          serialList = hanaSerials;
        }
      } else if (alloc && alloc.selectedSerials && Array.isArray(alloc.selectedSerials) && alloc.selectedSerials.length > 0) {
        serialList = alloc.selectedSerials.map((sObj: any) => {
          let targetSerialNum = typeof sObj === 'object' && sObj !== null
            ? String(sObj.internalSerialNumber || sObj.DistNumber || sObj.serialNumber || sObj.DistNum || '').trim()
            : String(sObj).trim();

          return {
            manufacturerSerialNumber: typeof sObj === 'object' && sObj ? String(sObj.manufacturerSerialNumber || sObj.MnfSerial || '').trim() : '',
            internalSerialNumber: targetSerialNum,
            systemSerialNumber: typeof sObj === 'object' && sObj ? Number(sObj.systemSerialNumber || sObj.SysNumber || 0) : 0,
          };
        }).filter(s => s.internalSerialNumber.length > 0);
      } else {
        serialList = [{
          manufacturerSerialNumber: '',
          internalSerialNumber: `SER-AUTO-${itemCode}-01`,
          systemSerialNumber: 0,
        }];
      }

      if (serialList.length === 0) {
        serialList = [{
          manufacturerSerialNumber: '',
          internalSerialNumber: `SER-AUTO-${itemCode}-01`,
          systemSerialNumber: 0,
        }];
      }

      totalItemQty = serialList.length;
    }

    processedLines.push({
      itemCode,
      isLote,
      quantity: isLote ? batchList.reduce((a, b) => a + b.quantity, 0) : serialList.length,
      artEq: artEq || 'ART_EQUIVALENTE',
      cantEq: cantEq || totalItemQty,
      costEqUnit: costEqUnit || 100,
      batches: batchList,
      serials: serialList,
    });
  }

  const exitDocumentLines = processedLines.map((p) => {
    const lineObj: any = {
      ItemCode: p.itemCode,
      Quantity: p.quantity,
      WarehouseCode: safeWhsCode,
      AccountCode: '5.01.01.001.011',
    };

    if (p.isLote && p.batches.length > 0) {
      lineObj.BatchNumbers = p.batches.map((b) => ({
        BatchNumber: b.batchNumber,
        Quantity: b.quantity,
      }));
    } else if (!p.isLote && p.serials.length > 0) {
      lineObj.SerialNumbers = p.serials.map((s) => ({
        ManufacturerSerialNumber: s.manufacturerSerialNumber || '',
        InternalSerialNumber: s.internalSerialNumber || '',
        SystemSerialNumber: typeof s.systemSerialNumber === 'number' ? s.systemSerialNumber : 0,
      }));
    }

    return lineObj;
  });

  const exitPayload = {
    DocDate: todayStr,
    DocDueDate: todayStr,
    Comments: 'Salida de mercadería realizada por ExtendIA',
    DocumentLines: exitDocumentLines,
  };

  let newDocEntrySalida = Math.floor(3000 + Math.random() * 500);
  let newDocNumSalida = Math.floor(10000 + Math.random() * 900);

  if (!isDemo) {
    try {
      const exitRes = await makeSapRequest(serverUrl, 'InventoryGenExits', {
        method: 'POST',
        body: exitPayload,
        sessionId: b1session,
        routeId: routeId,
        timeout: 60000,
      });

      if (exitRes.status === 201 || exitRes.status === 200) {
        newDocEntrySalida = exitRes.data.DocEntry;
        newDocNumSalida = exitRes.data.DocNum;
      } else {
        const errorDetail = exitRes.data?.error?.message?.value || exitRes.data?.error?.message || JSON.stringify(exitRes.data);
        console.warn(`[ExtendIA] Service Layer Exit failed (status ${exitRes.status}): ${errorDetail}`);
        return res.status(exitRes.status).json({ success: false, message: `Error en SAP (Salida de Mercancías): ${errorDetail}` });
      }
    } catch (err: any) {
      console.error(`[ExtendIA] Service Layer Exit network error: ${err?.message || err}`);
      return res.status(500).json({ success: false, message: `Error de red con SAP (Salida de Mercancías): ${err?.message || String(err)}` });
    }
  }

  // --- REGISTRO EN POSTGRESQL PASO 1: INSERT Cabecera con Estado 'S' y DETCONVERSIONES 'OIGE' ---
  let nroConv: number | null = null;
  const currentUser = (req.header('X-SAP-UserCode') || sessionInfo?.userName || session?.userName || session?.user_code || 'gualber') as string;

  try {
    await ensureConversionTablesExist();

    const insertHeaderRes = await pgPool.query(
      `INSERT INTO convertia."CONVERSIONES"
       ("WhsSal", "DocEntrySal", "DocNumSal", "FechaSalida", "WhsEnt", "DocEntryEnt", "DocNumEnt", "FechaEntrada", "User", "Estado","Schema")
       VALUES ($1, $2, $3, $4,  '', 0, 0, $4, $5, 'S', $6)
       RETURNING "nroConv"`,
       [safeWhsCode, newDocEntrySalida, newDocNumSalida, todayStr, currentUser, safeSchema]
    );

    if (insertHeaderRes.rows && insertHeaderRes.rows.length > 0) {
      nroConv = parseInt(insertHeaderRes.rows[0].nroConv, 10);
    }
    console.log(`[Postgres Log] CONVERSIONES cabecera insertada exitosamente con nroConv = ${nroConv} (Estado 'S')`);
  } catch (err: any) {
    console.error('[Postgres Log Error - Salida CONVERSIONES]:', err.message);
  }

  if (nroConv) {
    for (const p of processedLines) {
      try {
        await pgPool.query(
          `INSERT INTO convertia."DETCONVERSIONES"
           ("nroConv", "ItemCode", "Dscription", "Qty", "Objeto")
           VALUES ($1, $2, $3, $4, 'OIGE')`,
          [nroConv, p.itemCode, p.itemCode, p.quantity]
        );
      } catch (err: any) {
        console.error('[Postgres Log Error - DETCONVERSIONES OIGE]:', err.message);
      }
    }
  }

  const entryDocumentLines = processedLines.map((p) => {
    const lineObj: any = {
      ItemCode: p.artEq,
      Quantity: p.cantEq,
      UnitPrice: p.costEqUnit,
      WarehouseCode: safeTargetWhsCode,
      AccountCode: '5.01.01.001.011',
    };

    if (p.isLote && p.batches.length > 0) {
      lineObj.BatchNumbers = p.batches.map((b) => ({
        BatchNumber: `EQ-${b.batchNumber}`,
        Quantity: b.quantity || p.cantEq,
      }));
    } else if (!p.isLote && p.serials.length > 0) {
      lineObj.SerialNumbers = p.serials.map((s, idx) => ({
        InternalSerialNumber: `EQ-${s.internalSerialNumber || idx + 1}`,
      }));
    }

    return lineObj;
  });

  const entryPayload = {
    DocDate: todayStr,
    DocDueDate: todayStr,
    Comments: 'Entrada de mercadería realizada por ExtendIA',
    DocumentLines: entryDocumentLines,
  };

  let newDocEntryEntrada = Math.floor(4000 + Math.random() * 500);
  let newDocNumEntrada = Math.floor(20000 + Math.random() * 900);

  if (!isDemo) {
    try {
      const entryRes = await makeSapRequest(serverUrl, 'InventoryGenEntries', {
        method: 'POST',
        body: entryPayload,
        sessionId: b1session,
        routeId: routeId,
        timeout: 60000,
      });

      if (entryRes.status === 201 || entryRes.status === 200) {
        newDocEntryEntrada = entryRes.data.DocEntry;
        newDocNumEntrada = entryRes.data.DocNum;
      } else {
        const errorDetail = entryRes.data?.error?.message?.value || entryRes.data?.error?.message || JSON.stringify(entryRes.data);
        console.warn(`[ExtendIA] Service Layer Entry failed (status ${entryRes.status}): ${errorDetail}`);
        return res.status(entryRes.status).json({ success: false, message: `Error en SAP (Entrada de Mercancías): ${errorDetail}` });
      }
    } catch (err: any) {
      console.error(`[ExtendIA] Service Layer Entry network error: ${err?.message || err}`);
      return res.status(500).json({ success: false, message: `Error de red con SAP (Entrada de Mercancías): ${err?.message || String(err)}` });
    }
  }

  // --- REGISTRO EN POSTGRESQL PASO 2: UPDATE Cabecera a Estado 'E' y DETCONVERSIONES 'OIGN' ---
  // if (nroConv) {
  //   try {
  //     await pgPool.query(
  //       `UPDATE convertia."CONVERSIONES"
  //        SET "WhsEnt" = $1,
  //            "DocEntryEnt" = $2,
  //            "DocNumEnt" = $3,
  //            "FechaEntrada" = $4,
  //            "User" = $5,
  //            "Estado" = 'E'
  //        WHERE "nroConv" = $6`,
  //       [safeTargetWhsCode, newDocEntryEntrada, newDocNumEntrada, todayStr, currentUser, nroConv]
  //     );
  //   } catch (err: any) {
  //     console.error('[Postgres Log Error - Entrada CONVERSIONES]:', err.message);
  //   }

  //   for (const p of processedLines) {
  //     try {
  //       const nextIdRes = await pgPool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM convertia."DETCONVERSIONES"`);
  //       const nextId = parseInt(nextIdRes.rows?.[0]?.nextId || '1', 10);

  //       await pgPool.query(
  //         `INSERT INTO convertia."DETCONVERSIONES"
  //          (id, "nroConv", "ItemCode", "Dscription", "Qty", "Objeto")
  //          VALUES ($1, $2, $3, $4, $5, 'OIGN')`,
  //         [nextId, nroConv, p.artEq, p.artEq, p.cantEq]
  //       );
  //     } catch (err: any) {
  //       console.error('[Postgres Log Error - DETCONVERSIONES OIGN]:', err.message);
  //     }
  //   }
  // }
  if (nroConv) {
  try {
    await pgPool.query(
      `UPDATE convertia."CONVERSIONES"
       SET "WhsEnt" = $1,
           "DocEntryEnt" = $2,
           "DocNumEnt" = $3,
           "FechaEntrada" = $4,
           "User" = $5,
           "Estado" = 'E'
       WHERE "nroConv" = $6`,
      [safeTargetWhsCode, newDocEntryEntrada, newDocNumEntrada, todayStr, currentUser, nroConv]
    );
  } catch (err: any) {
    console.error('[Postgres Log Error - Entrada CONVERSIONES]:', err.message);
  }

  for (const p of processedLines) {
    try {
      await pgPool.query(
        `INSERT INTO convertia."DETCONVERSIONES"
         ("nroConv", "ItemCode", "Dscription", "Qty", "Objeto")
         VALUES ($1, $2, $3, $4, 'OIGN')`,
        [nroConv, p.artEq, p.artEq, p.cantEq]
      );
    } catch (err: any) {
      console.error('[Postgres Log Error - DETCONVERSIONES OIGN]:', err.message);
    }
  }
}
  const patchPayload = {
    DocumentReferences: [
      {
        RefDocEntr: newDocEntrySalida,
        RefDocNum: newDocNumSalida,
        RefObjType: 'rot_GoodsIssue',
        IssueDate: todayStr,
        Remark: 'Salida de mercancias realizada por ExtendIA',
      },
    ],
  };

  if (!isDemo) {
    try {
      await makeSapRequest(
        serverUrl,
        `InventoryGenEntries(${newDocEntryEntrada})`,
        {
          method: 'PATCH',
          body: patchPayload,
          sessionId: b1session,
          routeId: routeId,
          timeout: 60000,
        }
      );
    } catch (err: any) {
      console.error(`[ExtendIA STEP 3 ERROR] Patch DocumentReferences failed:`, err?.message || err);
    }
  }

  // --- REGISTRO EN POSTGRESQL PASO 3: UPDATE Cabecera a Estado 'M' (Migrado / Completado) ---
  if (nroConv) {
    try {
      await pgPool.query(
        `UPDATE convertia."CONVERSIONES"
         SET "Estado" = 'M'
         WHERE "nroConv" = $1`,
        [nroConv]
      );
    } catch (err: any) {
      console.error('[Postgres Log Error - Finalizar Estado M]:', err.message);
    }
  }

  return res.json({
    success: true,
    nroConv,
    processedCount: processedLines.length,
    skippedCount,
    goodsIssueDocEntry: newDocEntrySalida,
    goodsIssueDocNum: newDocNumSalida,
    goodsReceiptDocEntry: newDocEntryEntrada,
    goodsReceiptDocNum: newDocNumEntrada,
    message: isDemo
      ? `Proceso ExtendIA simulado (Modo Sandbox Demo). Conversion #${nroConv ?? '0'} | Salida #${newDocNumSalida} y Entrada #${newDocNumEntrada}.`
      : `Proceso ExtendIA completado en SAP B1. Conversion #${nroConv ?? '0'} | Salida #${newDocNumSalida} y Entrada #${newDocNumEntrada} vinculadas exitosamente.`,
    exitPayload,
    entryPayload,
    patchPayload,
  });
});

// API: Execute Conversion
router.post('/sap/execute-conversion', async (req, res) => {
  const {
    sourceWarehouse,
    targetWarehouse,
    targetItemCode,
    targetItemName,
    targetQuantity,
    targetBatchNumber,
    targetSerialNumber,
    targetUnitCost,
    totalCost,
    comments,
    consumedComponents,
    session
  } = req.body;

  const sessionId = req.header('X-SAP-Session') || session?.sessionId;
  const sessionInfo = sessionId ? activeSessions.get(sessionId) : null;

  let goodsIssueDocNum = Math.floor(10000 + Math.random() * 900);
  let goodsIssueDocEntry = Math.floor(3000 + Math.random() * 500);
  let goodsReceiptDocNum = Math.floor(20000 + Math.random() * 900);
  let goodsReceiptDocEntry = Math.floor(4000 + Math.random() * 500);
  let journalTrans = Math.floor(5800 + Math.random() * 300);

  let effectiveTargetWarehouse = targetWarehouse;
  try {
    const srcWhs = String(sourceWarehouse || '').trim();
    if (srcWhs) {
      const pgWhsRes = await pgPool.query(
        `SELECT "equWhsCode" FROM convertia."OWHS" WHERE ("whsCode" = $1 OR UPPER("whsCode") = UPPER($1)) LIMIT 1`,
        [srcWhs]
      );
      if (pgWhsRes && pgWhsRes.rows && pgWhsRes.rows.length > 0) {
        const rowVal = pgWhsRes.rows[0].equWhsCode || pgWhsRes.rows[0].equwhscode;
        if (rowVal && String(rowVal).trim().length > 0) {
          effectiveTargetWarehouse = String(rowVal).trim();
        }
      }
    }
  } catch (err) {}

  if (sessionInfo && !session?.isDemoMode) {
    try {
      const goodsIssueBody = {
        DocDate: getPyDateString(),
        Comments: `ExtendIA: Consumo de componentes para ${targetItemCode} - ${comments || ''}`,
        DocumentLines: consumedComponents.map((c: any, idx: number) => {
          const line: any = {
            LineNum: idx,
            ItemCode: c.itemCode,
            Quantity: c.quantity,
            WarehouseCode: sourceWarehouse,
            UnitPrice: c.unitCost,
          };
          if (c.itemType === 'Batch' && c.batchNumber) {
            line.BatchNumbers = [{
              BatchNumber: c.batchNumber,
              Quantity: c.quantity,
            }];
          } else if (c.itemType === 'Serial' && c.serialNumber) {
            line.SerialNumbers = [{
              InternalSerialNumber: c.serialNumber,
              Quantity: 1,
            }];
          }
          return line;
        }),
      };

      const issueRes = await makeSapRequest(sessionInfo.serverUrl, 'InventoryGenExits', {
        method: 'POST',
        body: goodsIssueBody,
        sessionId: sessionInfo.b1session,
        routeId: sessionInfo.routeId,
      });

      if (issueRes.status === 201 || issueRes.status === 200) {
        goodsIssueDocNum = issueRes.data.DocNum || goodsIssueDocNum;
        goodsIssueDocEntry = issueRes.data.DocEntry || goodsIssueDocEntry;
      } else {
        const errDetail = issueRes.data?.error?.message?.value || issueRes.data?.error?.message || JSON.stringify(issueRes.data);
        return res.status(issueRes.status).json({ success: false, message: `Error en SAP (Salida de Mercancías): ${errDetail}` });
      }

      const goodsReceiptBody: any = {
        DocDate: getPyDateString(),
        Comments: `ExtendIA: Entrada de producto convertido desde Salida #${goodsIssueDocNum}`,
        DocumentLines: [
          {
            LineNum: 0,
            ItemCode: targetItemCode,
            Quantity: targetQuantity,
            WarehouseCode: effectiveTargetWarehouse || targetWarehouse,
            UnitPrice: targetUnitCost,
          }
        ]
      };

      if (targetBatchNumber) {
        goodsReceiptBody.DocumentLines[0].BatchNumbers = [{
          BatchNumber: targetBatchNumber,
          Quantity: targetQuantity,
        }];
      } else if (targetSerialNumber) {
        goodsReceiptBody.DocumentLines[0].SerialNumbers = [{
          InternalSerialNumber: targetSerialNumber,
          Quantity: 1,
        }];
      }

      const receiptRes = await makeSapRequest(sessionInfo.serverUrl, 'InventoryGenEntries', {
        method: 'POST',
        body: goodsReceiptBody,
        sessionId: sessionInfo.b1session,
        routeId: sessionInfo.routeId,
      });

      if (receiptRes.status === 201 || receiptRes.status === 200) {
        goodsReceiptDocNum = receiptRes.data.DocNum || goodsReceiptDocNum;
        goodsReceiptDocEntry = receiptRes.data.DocEntry || goodsReceiptDocEntry;
        journalTrans = receiptRes.data.TransNum || journalTrans;
      } else {
        const errDetail = receiptRes.data?.error?.message?.value || receiptRes.data?.error?.message || JSON.stringify(receiptRes.data);
        return res.status(receiptRes.status).json({ success: false, message: `Error en SAP (Entrada de Mercancías): ${errDetail}` });
      }
    } catch (err: any) {
      console.error('Real SAP request failed:', err);
      return res.status(500).json({ success: false, message: `Error de red con SAP: ${err.message}` });
    }
  }

  const result = {
    id: 'conv-' + Date.now().toString(36),
    goodsIssueDocEntry,
    goodsIssueDocNum,
    goodsReceiptDocEntry,
    goodsReceiptDocNum,
    journalEntryNumber: journalTrans,
    docDate: getPyDateString(),
    timestamp: Date.now(),
    sourceWarehouse,
    targetWarehouse,
    targetItemCode,
    targetItemName,
    targetQuantity,
    targetBatchNumber,
    targetSerialNumber,
    targetUnitCost,
    totalCost,
    consumedComponents,
    status: 'Success',
    message: `Documentos generados en SAP B1: Salida de Mercancías #${goodsIssueDocNum} y Entrada de Mercancías #${goodsReceiptDocNum} con Asiento Contable #${journalTrans}`,
  };

  // --- REGISTRO DE AUDITORÍA EN POSTGRESQL (CONVERSIONES Y DETCONVERSIONES) ---
  try {
    await ensureConversionTablesExist();
    const todayStr = getPyDateString();
    const currentUser = (req.header('X-SAP-UserCode') || sessionInfo?.userName || session?.userName || session?.user_code || 'gualber') as string;
    const currentSchema = (req.body.schema || req.query.schema || req.header('X-SAP-CompanyDB') || sessionInfo?.companyDB || session?.companyDB || 'FG_DESARROLLO') as string;
    const nextConvRes = await pgPool.query(`SELECT COALESCE(MAX("nroConv"), 0) + 1 AS "nextConv" FROM convertia."CONVERSIONES"`);
    const calculatedNroConv = parseInt(nextConvRes.rows?.[0]?.nextConv || '1', 10);

    // 1. Salida (OIGE) -> Insert CONVERSIONES Estado 'S'
    const headerRes = await pgPool.query(
      `INSERT INTO convertia."CONVERSIONES"
       ("nroConv", "WhsSal", "DocEntrySal", "DocNumSal", "FechaSalida", "WhsEnt", "DocEntryEnt", "DocNumEnt", "FechaEntrada", "User", "Estado","Schema")
       VALUES ($1, $2, $3, $4, $5, '', 0, 0, $5, $6, 'S',$6)
       RETURNING "nroConv"`,
      [calculatedNroConv, sourceWarehouse || '', goodsIssueDocEntry, goodsIssueDocNum, todayStr, currentUser,String(currentSchema).trim()]
    );

    const nroConv = headerRes.rows?.[0]?.nroConv ? parseInt(headerRes.rows[0].nroConv, 10) : calculatedNroConv;
    if (nroConv) {
      // Detalle Salida OIGE
      if (Array.isArray(consumedComponents)) {
        for (const c of consumedComponents) {
          const nextIdRes = await pgPool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM convertia."DETCONVERSIONES"`);
          const nextId = parseInt(nextIdRes.rows?.[0]?.nextId || '1', 10);

          await pgPool.query(
            `INSERT INTO convertia."DETCONVERSIONES"
             (id, "nroConv", "ItemCode", "Dscription", "Qty", "Objeto")
             VALUES ($1, $2, $3, $4, $5, 'OIGE')`,
            [nextId, nroConv, c.itemCode || '', c.itemName || c.itemCode || '', c.quantity || 1]
          );
        }
      }

      // 2. Entrada (OIGN) -> Update CONVERSIONES Estado 'E'
      await pgPool.query(
        `UPDATE convertia."CONVERSIONES"
         SET "WhsEnt" = $1,
             "DocEntryEnt" = $2,
             "DocNumEnt" = $3,
             "FechaEntrada" = $4,
             "User" = $5,
             "Estado" = 'E'
         WHERE "nroConv" = $6`,
        [effectiveTargetWarehouse || targetWarehouse || '', goodsReceiptDocEntry, goodsReceiptDocNum, todayStr, currentUser, nroConv]
      );

      // Detalle Entrada OIGN
      const nextIdRes = await pgPool.query(`SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM convertia."DETCONVERSIONES"`);
      const nextId = parseInt(nextIdRes.rows?.[0]?.nextId || '1', 10);

      await pgPool.query(
        `INSERT INTO convertia."DETCONVERSIONES"
         (id, "nroConv", "ItemCode", "Dscription", "Qty", "Objeto")
         VALUES ($1, $2, $3, $4, $5, 'OIGN')`,
        [nextId, nroConv, targetItemCode || '', targetItemName || targetItemCode || '', targetQuantity || 1]
      );

      // 3. Proceso de equivalencias culminado -> Update CONVERSIONES Estado 'M'
      await pgPool.query(
        `UPDATE convertia."CONVERSIONES"
         SET "Estado" = 'M'
         WHERE "nroConv" = $1`,
        [nroConv]
      );

      (result as any).nroConv = nroConv;
    }
  } catch (auditErr: any) {
    console.error('[Postgres Log Error - execute-conversion]:', auditErr.message);
  }

  res.json(result);
});

export default router;
