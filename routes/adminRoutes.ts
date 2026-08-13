import { Router } from 'express';
import { pgPool } from '../config/db';

const router = Router();

// =========================================================================
// ADMIN CRUD API FOR convertia."OWHS" (Gestión de Almacenes)
// =========================================================================

// GET /api/admin/owhs
router.get('/admin/owhs', async (req, res) => {
  const schema = (req.query.schema || 'FG_DESARROLLO') as string;
  try {
    let sql: string;
    let params: any[] = [];

    if (schema === 'ALL') {
      sql = `SELECT "whsCode", "whsName", "equWhsCode", "equWhsName", "Schema" FROM convertia."OWHS" ORDER BY "Schema", "whsCode" ASC`;
    } else {
      sql = `SELECT "whsCode", "whsName", "equWhsCode", "equWhsName", "Schema" FROM convertia."OWHS" WHERE "Schema" = $1 OR UPPER("Schema") = UPPER($1) ORDER BY "whsCode" ASC`;
      params = [schema];
    }

    const pgRes = await pgPool.query(sql, params);
    return res.json({ success: true, data: pgRes.rows });
  } catch (err: any) {
    console.error('Error in GET /api/admin/owhs:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/owhs
router.post('/admin/owhs', async (req, res) => {
  const { whsCode, whsName, equWhsCode, equWhsName, schema, Schema } = req.body;
  const targetWhsCode = String(whsCode || '').trim();
  const targetSchema = String(Schema || schema || 'FG_DESARROLLO').trim();

  if (!targetWhsCode) {
    return res.status(400).json({ success: false, error: 'El código de almacén (whsCode) es obligatorio.' });
  }

  try {
    const insertSql = `
      INSERT INTO convertia."OWHS"
      ("whsCode", "whsName", "equWhsCode", "equWhsName", "Schema")
      VALUES ($1, $2, $3, $4, $5)
      RETURNING "whsCode", "whsName", "equWhsCode", "equWhsName", "Schema"
    `;
    const pgRes = await pgPool.query(insertSql, [
      targetWhsCode,
      String(whsName || '').trim(),
      String(equWhsCode || '').trim(),
      String(equWhsName || '').trim(),
      targetSchema
    ]);

    return res.json({ success: true, data: pgRes.rows[0] });
  } catch (err: any) {
    console.error('Error in POST /api/admin/owhs:', err.message);
    if (err.code === '23505') {
      return res.status(400).json({
        success: false,
        error: `Ya existe el almacén '${targetWhsCode}' registrado para el esquema '${targetSchema}'.`
      });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/owhs
router.put('/admin/owhs', async (req, res) => {
  const { whsCode, whsName, equWhsCode, equWhsName, schema, Schema, oldWhsCode, oldSchema } = req.body;
  const targetWhsCode = String(whsCode || '').trim();
  const targetSchema = String(Schema || schema || 'FG_DESARROLLO').trim();
  const filterWhsCode = String(oldWhsCode || targetWhsCode).trim();
  const filterSchema = String(oldSchema || targetSchema).trim();

  if (!filterWhsCode) {
    return res.status(400).json({ success: false, error: 'El código de almacén es obligatorio.' });
  }

  try {
    let updateSql = `
      UPDATE convertia."OWHS"
      SET "whsCode" = $1, "whsName" = $2, "equWhsCode" = $3, "equWhsName" = $4, "Schema" = $5
      WHERE "whsCode" = $6 AND ("Schema" = $7 OR UPPER("Schema") = UPPER($7))
      RETURNING "whsCode", "whsName", "equWhsCode", "equWhsName", "Schema"
    `;
    let pgRes = await pgPool.query(updateSql, [
      targetWhsCode,
      String(whsName || '').trim(),
      String(equWhsCode || '').trim(),
      String(equWhsName || '').trim(),
      targetSchema,
      filterWhsCode,
      filterSchema
    ]);

    if (pgRes.rows.length === 0) {
      updateSql = `
        UPDATE convertia."OWHS"
        SET "whsCode" = $1, "whsName" = $2, "equWhsCode" = $3, "equWhsName" = $4, "Schema" = $5
        WHERE "whsCode" = $6
        RETURNING "whsCode", "whsName", "equWhsCode", "equWhsName", "Schema"
      `;
      pgRes = await pgPool.query(updateSql, [
        targetWhsCode,
        String(whsName || '').trim(),
        String(equWhsCode || '').trim(),
        String(equWhsName || '').trim(),
        targetSchema,
        filterWhsCode
      ]);
    }

    if (pgRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: `No se encontró el almacén '${filterWhsCode}' para actualizar.` });
    }

    return res.json({ success: true, data: pgRes.rows[0] });
  } catch (err: any) {
    console.error('Error in PUT /api/admin/owhs:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/owhs
router.delete('/admin/owhs', async (req, res) => {
  const whsCode = String(req.query.whsCode || req.body.whsCode || '').trim();
  const schema = String(req.query.schema || req.body.schema || req.body.Schema || 'FG_DESARROLLO').trim();

  if (!whsCode) {
    return res.status(400).json({ success: false, error: 'El parámetro whsCode es requerido.' });
  }

  try {
    let deleteSql = `DELETE FROM convertia."OWHS" WHERE "whsCode" = $1 AND ("Schema" = $2 OR UPPER("Schema") = UPPER($2))`;
    let pgRes = await pgPool.query(deleteSql, [whsCode, schema]);

    if (pgRes.rowCount === 0) {
      deleteSql = `DELETE FROM convertia."OWHS" WHERE "whsCode" = $1`;
      pgRes = await pgPool.query(deleteSql, [whsCode]);
    }

    return res.json({ success: true, count: pgRes.rowCount });
  } catch (err: any) {
    console.error('Error in DELETE /api/admin/owhs:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// ADMIN CRUD API FOR convertia."SRGC" (Gestión de Esquemas de Base de Datos)
// =========================================================================

// GET /api/admin/srgc
router.get('/admin/srgc', async (_req, res) => {
  try {
    const sql = `SELECT * FROM convertia."SRGC" ORDER BY "dbName" ASC`;
    const pgRes = await pgPool.query(sql);

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

      return {
        dbName: String(getV('dbName', 'dbname') ?? '').trim(),
        cmpName: String(getV('cmpName', 'cmpname') ?? '').trim(),
        cmpStatus: String(getV('cmpStatus', 'cmpstatus') ?? 'A').trim(),
      };
    }).filter(s => s.dbName.length > 0);

    return res.json({ success: true, data: items });
  } catch (err: any) {
    console.error('Error in GET /api/admin/srgc:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/srgc
router.post('/admin/srgc', async (req, res) => {
  const { dbName, cmpName, cmpStatus } = req.body;
  const targetDbName = String(dbName || '').trim();
  const targetCmpName = String(cmpName || targetDbName).trim();
  const targetStatus = String(cmpStatus || 'A').trim().toUpperCase() === 'I' ? 'I' : 'A';

  if (!targetDbName) {
    return res.status(400).json({ success: false, error: 'El nombre de base de datos / esquema (dbName) es obligatorio.' });
  }

  try {
    const insertSql = `
      INSERT INTO convertia."SRGC"
      ("dbName", "cmpName", "cmpStatus")
      VALUES ($1, $2, $3)
      RETURNING "dbName", "cmpName", "cmpStatus"
    `;
    const pgRes = await pgPool.query(insertSql, [targetDbName, targetCmpName, targetStatus]);
    return res.json({ success: true, data: pgRes.rows[0] });
  } catch (err: any) {
    console.error('Error in POST /api/admin/srgc:', err.message);
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: `Ya existe la base de datos / esquema '${targetDbName}' en la tabla convertia."SRGC".` });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/srgc
router.put('/admin/srgc', async (req, res) => {
  const { dbName, cmpName, cmpStatus, oldDbName } = req.body;
  const targetDbName = String(dbName || '').trim();
  const filterDbName = String(oldDbName || targetDbName).trim();
  const targetCmpName = String(cmpName || targetDbName).trim();
  const targetStatus = String(cmpStatus || 'A').trim().toUpperCase() === 'I' ? 'I' : 'A';

  if (!filterDbName) {
    return res.status(400).json({ success: false, error: 'El nombre de esquema actual (dbName) es obligatorio.' });
  }

  try {
    const updateSql = `
      UPDATE convertia."SRGC"
      SET "dbName" = $1, "cmpName" = $2, "cmpStatus" = $3
      WHERE "dbName" = $4 OR UPPER("dbName") = UPPER($4)
      RETURNING "dbName", "cmpName", "cmpStatus"
    `;
    const pgRes = await pgPool.query(updateSql, [targetDbName, targetCmpName, targetStatus, filterDbName]);

    if (pgRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: `No se encontró el esquema '${filterDbName}' para actualizar.` });
    }

    return res.json({ success: true, data: pgRes.rows[0] });
  } catch (err: any) {
    console.error('Error in PUT /api/admin/srgc:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/srgc
router.delete('/admin/srgc', async (req, res) => {
  const dbName = String(req.query.dbName || req.body.dbName || '').trim();

  if (!dbName) {
    return res.status(400).json({ success: false, error: 'El parámetro dbName es requerido.' });
  }

  try {
    const deleteSql = `DELETE FROM convertia."SRGC" WHERE "dbName" = $1 OR UPPER("dbName") = UPPER($1)`;
    const pgRes = await pgPool.query(deleteSql, [dbName]);

    return res.json({ success: true, count: pgRes.rowCount });
  } catch (err: any) {
    console.error('Error in DELETE /api/admin/srgc:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// =========================================================================
// ADMIN CRUD API FOR convertia."OPRC" (Gestión de Líneas de Negocio / Centros de Costo)
// =========================================================================

// GET /api/admin/oprc
router.get('/admin/oprc', async (req, res) => {
  const schema = (req.query.schema || 'FG_DESARROLLO') as string;
  try {
    let sql: string;
    let params: any[] = [];

    if (schema === 'ALL') {
      sql = `SELECT "PrcCode", "PrcName", "Schema" FROM convertia."OPRC" ORDER BY "Schema", "PrcCode" ASC`;
    } else {
      sql = `SELECT "PrcCode", "PrcName", "Schema" FROM convertia."OPRC" WHERE "Schema" = $1 OR UPPER("Schema") = UPPER($1) ORDER BY "PrcCode" ASC`;
      params = [schema];
    }

    const pgRes = await pgPool.query(sql, params);
    const items = pgRes.rows.map((r: any) => ({
      PrcCode: String(r.PrcCode || r.prccode || r.PRCCODE || '').trim(),
      PrcName: String(r.PrcName || r.prcname || r.PRCNAME || '').trim(),
      Schema: String(r.Schema || r.schema || r.SCHEMA || '').trim(),
    })).filter(i => i.PrcCode.length > 0);

    return res.json({ success: true, data: items });
  } catch (err: any) {
    console.error('Error in GET /api/admin/oprc:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/oprc
router.post('/admin/oprc', async (req, res) => {
  const { PrcCode, PrcName, Schema, prcCode, prcName, schema } = req.body;
  const targetPrcCode = String(PrcCode || prcCode || '').trim();
  const targetPrcName = String(PrcName || prcName || targetPrcCode).trim();
  const targetSchema = String(Schema || schema || 'FG_DESARROLLO').trim();

  if (!targetPrcCode) {
    return res.status(400).json({ success: false, error: 'El código de centro de costo / línea (PrcCode) es obligatorio.' });
  }

  try {
    const insertSql = `
      INSERT INTO convertia."OPRC"
      ("PrcCode", "PrcName", "Schema")
      VALUES ($1, $2, $3)
      RETURNING "PrcCode", "PrcName", "Schema"
    `;
    const pgRes = await pgPool.query(insertSql, [targetPrcCode, targetPrcName, targetSchema]);
    return res.json({ success: true, data: pgRes.rows[0] });
  } catch (err: any) {
    console.error('Error in POST /api/admin/oprc:', err.message);
    if (err.code === '23505') {
      return res.status(400).json({ success: false, error: `Ya existe la línea de negocio / centro de costo '${targetPrcCode}' registrada para el esquema '${targetSchema}'.` });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/admin/oprc
router.put('/admin/oprc', async (req, res) => {
  const { PrcCode, PrcName, Schema, oldPrcCode, oldSchema } = req.body;
  const targetPrcCode = String(PrcCode || '').trim();
  const targetPrcName = String(PrcName || targetPrcCode).trim();
  const targetSchema = String(Schema || 'FG_DESARROLLO').trim();
  const filterPrcCode = String(oldPrcCode || targetPrcCode).trim();
  const filterSchema = String(oldSchema || targetSchema).trim();

  if (!filterPrcCode) {
    return res.status(400).json({ success: false, error: 'El código de línea actual (PrcCode) es obligatorio.' });
  }

  try {
    let updateSql = `
      UPDATE convertia."OPRC"
      SET "PrcCode" = $1, "PrcName" = $2, "Schema" = $3
      WHERE "PrcCode" = $4 AND ("Schema" = $5 OR UPPER("Schema") = UPPER($5))
      RETURNING "PrcCode", "PrcName", "Schema"
    `;
    let pgRes = await pgPool.query(updateSql, [targetPrcCode, targetPrcName, targetSchema, filterPrcCode, filterSchema]);

    if (pgRes.rows.length === 0) {
      updateSql = `
        UPDATE convertia."OPRC"
        SET "PrcCode" = $1, "PrcName" = $2, "Schema" = $3
        WHERE "PrcCode" = $4
        RETURNING "PrcCode", "PrcName", "Schema"
      `;
      pgRes = await pgPool.query(updateSql, [targetPrcCode, targetPrcName, targetSchema, filterPrcCode]);
    }

    if (pgRes.rows.length === 0) {
      return res.status(404).json({ success: false, error: `No se encontró la línea de negocio '${filterPrcCode}' para actualizar.` });
    }

    return res.json({ success: true, data: pgRes.rows[0] });
  } catch (err: any) {
    console.error('Error in PUT /api/admin/oprc:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/admin/oprc
router.delete('/admin/oprc', async (req, res) => {
  const prcCode = String(req.query.PrcCode || req.query.prcCode || req.body.PrcCode || req.body.prcCode || '').trim();
  const schema = String(req.query.schema || req.body.schema || req.body.Schema || 'FG_DESARROLLO').trim();

  if (!prcCode) {
    return res.status(400).json({ success: false, error: 'El parámetro PrcCode es requerido.' });
  }

  try {
    let deleteSql = `DELETE FROM convertia."OPRC" WHERE "PrcCode" = $1 AND ("Schema" = $2 OR UPPER("Schema") = UPPER($2))`;
    let pgRes = await pgPool.query(deleteSql, [prcCode, schema]);

    if (pgRes.rowCount === 0) {
      deleteSql = `DELETE FROM convertia."OPRC" WHERE "PrcCode" = $1`;
      pgRes = await pgPool.query(deleteSql, [prcCode]);
    }

    return res.json({ success: true, count: pgRes.rowCount });
  } catch (err: any) {
    console.error('Error in DELETE /api/admin/oprc:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/pg-test (Verificación de Diagnóstico de Tablas PostgreSQL convertia."CONVERSIONES" y "DETCONVERSIONES")
router.get('/admin/pg-test', async (_req, res) => {
  try {
    const convCountRes = await pgPool.query(`SELECT COUNT(*) FROM convertia."CONVERSIONES"`);
    const detCountRes = await pgPool.query(`SELECT COUNT(*) FROM convertia."DETCONVERSIONES"`);
    const convRowsRes = await pgPool.query(`SELECT * FROM convertia."CONVERSIONES" ORDER BY "nroConv" DESC LIMIT 10`);
    const detRowsRes = await pgPool.query(`SELECT * FROM convertia."DETCONVERSIONES" ORDER BY id DESC LIMIT 20`);

    return res.json({
      success: true,
      message: 'Tablas de PostgreSQL convertia."CONVERSIONES" y "DETCONVERSIONES" verificadas correctamente.',
      conversionesCount: parseInt(convCountRes.rows[0].count || '0', 10),
      detConversionesCount: parseInt(detCountRes.rows[0].count || '0', 10),
      recentConversiones: convRowsRes.rows,
      recentDetalles: detRowsRes.rows,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

export default router;
