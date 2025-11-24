const express = require('express');
const router = express.Router();
const apiController = require('../Controllers/apiController');
const { authenticateAPI, logAPIAccess } = require('../middleware/apiAuth');

// 🔐 Middleware pour toutes les routes API externes
router.use(logAPIAccess);
router.use(authenticateAPI);

// 📊 Routes API externes (pour votre collègue)
router.get('/health', apiController.healthCheck);
router.get('/cartes', apiController.getCartes);
router.post('/sync', apiController.syncData);
router.get('/stats', apiController.getStats);

module.exports = router;