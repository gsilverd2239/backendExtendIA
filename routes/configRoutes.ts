import { Router } from 'express';
import { currentSapConfig } from '../config/sapConfig';

const router = Router();

// API: Server Config (GET & POST)
router.get('/config', (_req, res) => {
  res.json({
    serviceLayerUrl: currentSapConfig.serviceLayerUrl,
    hanaServer: currentSapConfig.hanaServer,
    hanaUser: currentSapConfig.hanaUser,
    hanaPassword: currentSapConfig.hanaPassword,
    isSandbox: currentSapConfig.isSandbox,
  });
});

router.post('/config', (req, res) => {
  const { serviceLayerUrl, hanaServer, hanaUser, hanaPassword, isSandbox } = req.body;
  if (serviceLayerUrl !== undefined) currentSapConfig.serviceLayerUrl = serviceLayerUrl;
  if (hanaServer !== undefined) currentSapConfig.hanaServer = hanaServer;
  if (hanaUser !== undefined) currentSapConfig.hanaUser = hanaUser;
  if (hanaPassword !== undefined) currentSapConfig.hanaPassword = hanaPassword;
  if (isSandbox !== undefined) currentSapConfig.isSandbox = Boolean(isSandbox);

  res.json({ success: true, config: currentSapConfig });
});

export default router;
