import fs from 'fs';
import path from 'path';

// Configurar escritura automática de logs en log.txt dentro de la raíz del backend
const logFilePath = path.resolve(process.cwd(), 'log.txt');
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

function formatLogMessage(level: string, args: any[]): string {
  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) => (typeof arg === 'object' ? (arg instanceof Error ? arg.stack || arg.message : JSON.stringify(arg, null, 2)) : String(arg)))
    .join(' ');
  return `[${timestamp}] [${level}] ${message}\n`;
}

// Sobrescribir los métodos estándar de console para duplicar salida a PowerShell y a log.txt
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;
const originalInfo = console.info;

console.log = (...args: any[]) => {
  originalLog.apply(console, args);
  try { logStream.write(formatLogMessage('INFO', args)); } catch (_e) {}
};

console.error = (...args: any[]) => {
  originalError.apply(console, args);
  try { logStream.write(formatLogMessage('ERROR', args)); } catch (_e) {}
};

console.warn = (...args: any[]) => {
  originalWarn.apply(console, args);
  try { logStream.write(formatLogMessage('WARN', args)); } catch (_e) {}
};

console.info = (...args: any[]) => {
  originalInfo.apply(console, args);
  try { logStream.write(formatLogMessage('INFO', args)); } catch (_e) {}
};

// Capturar excepciones o rechazos no manejados
process.on('uncaughtException', (err) => {
  console.error('[Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

// Carga segura de archivo .env (Soporta Node 20+ nativo process.loadEnvFile y fallback)
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    if (typeof (process as any).loadEnvFile === 'function') {
      (process as any).loadEnvFile(envPath);
    } else {
      try {
        const dotenv = require('dotenv');
        dotenv.config({ path: envPath });
      } catch (_e) {
        // Fallback manual para parsear .env si dotenv no esta presente
        const envContent = fs.readFileSync(envPath, 'utf8');
        envContent.split(/\r?\n/).forEach((line) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
            const eqIdx = trimmed.indexOf('=');
            const key = trimmed.substring(0, eqIdx).trim();
            const val = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (key && process.env[key] === undefined) {
              process.env[key] = val;
            }
          }
        });
      }
    }
  }
} catch (err) {
  console.warn('[Backend Notice] No se pudo cargar el archivo .env automáticamente:', err);
}

import app from './app';

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || '5510', 10);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ExtendIA Backend API corriendo en http://localhost:${PORT}`);
  console.log(`📝 Registrando logs en: ${logFilePath}`);
});


