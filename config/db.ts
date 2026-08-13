import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// PostgreSQL Connection Pool (convertia DB at 172.19.0.232)
export const pgConfig = {
  host: process.env.POSTGRES_HOST || '172.19.0.232',
  port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
  database: process.env.POSTGRES_DB || 'convertia',
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || '1234',
  connectionTimeoutMillis: 3000,
};

export const pgPool = new Pool(pgConfig);

pgPool.on('error', (err) => {
  console.warn('⚠️ [Postgres Pool Warning]:', err.message);
});
