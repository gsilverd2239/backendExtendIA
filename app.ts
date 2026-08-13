import express from 'express';
import cors from 'cors';

import configRoutes from './routes/configRoutes';
import adminRoutes from './routes/adminRoutes';
import sapRoutes from './routes/sapRoutes';

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Middleware para registrar peticiones HTTP en consola y archivo log.txt
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} -> Status ${res.statusCode} (${duration}ms)`);
  });
  next();
});

// Register API Routes under /api
app.use('/api', configRoutes);
app.use('/api', adminRoutes);
app.use('/api', sapRoutes);

export default app;
