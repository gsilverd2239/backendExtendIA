import dotenv from 'dotenv';
import { createRequire } from 'module';

dotenv.config();

// In-memory session store for server-side proxy
export interface ActiveSessionData {
  b1session: string;
  routeId?: string;
  serverUrl: string;
  companyDB: string;
  userName: string;
  expiresAt: number;
}

export const activeSessions = new Map<string, ActiveSessionData>();

// Config store for SAP Servers
export interface SapConfigState {
  serviceLayerUrl: string;
  hanaServer: string;
  hanaUser: string;
  hanaPassword: string;
  isSandbox: boolean;
}

export const currentSapConfig: SapConfigState = {
  serviceLayerUrl: process.env.SAP_SERVICE_LAYER_URL || 'https://172.19.0.88:50000/b1s/v1',
  hanaServer: process.env.SAP_HANA_SERVER || '172.19.0.88:30015',
  hanaUser: process.env.SAP_HANA_USER || 'SYSTEM',
  hanaPassword: process.env.SAP_HANA_PASSWORD || 'Admin123',
  isSandbox: false,
};

// Fallback Sandbox Schemas
export const fallbackSandboxSchemas = [
  { DbName: 'SBODEMOMX', cpnyName: 'SAP B1 Demostración US S.A.', version: '10.0 Demo', dbType: 'HANA' },
  { DbName: 'SBODEMOUS', cpnyName: 'SAP B1 Demonstration Company US', version: '10.0 Demo', dbType: 'SQLServer' },
];

// Custom / User-Registered Schemas Store
export const customSchemas: Array<{ DbName: string; cpnyName: string; version?: string; dbType?: string }> = [];

// Initialize custom schemas from environment variables if present
if (process.env.SAP_COMPANY_DB) {
  const envDb = process.env.SAP_COMPANY_DB.trim();
  if (!customSchemas.some((s) => s.DbName.toUpperCase() === envDb.toUpperCase())) {
    customSchemas.unshift({
      DbName: envDb,
      cpnyName: `${envDb} (Servidor Configurado)`,
      version: '10.0',
      dbType: 'HANA',
    });
  }
}

if (process.env.SAP_SCHEMAS) {
  const customList = process.env.SAP_SCHEMAS.split(',');
  customList.forEach((item) => {
    const [db, name] = item.split(':');
    if (db && !customSchemas.some((s) => s.DbName.toUpperCase() === db.trim().toUpperCase())) {
      customSchemas.unshift({
        DbName: db.trim(),
        cpnyName: (name || db).trim(),
        version: '10.0',
        dbType: 'HANA',
      });
    }
  });
}

// Load HDB driver dynamically
export let hdbModule: any = null;
try {
  if (typeof require !== 'undefined') {
    hdbModule = require('hdb');
  } else if (import.meta && import.meta.url) {
    const req = createRequire(import.meta.url);
    hdbModule = req('hdb');
  }
} catch (err) {
  console.warn('⚠️ Módulo "hdb" no encontrado en node_modules.');
}
