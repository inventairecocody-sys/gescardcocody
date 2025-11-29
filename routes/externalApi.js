const express = require('express');
const router = express.Router();
const apiController = require('../Controllers/apiController');
const { authenticateAPI, logAPIAccess } = require('../middleware/apiAuth');

// 🔐 Middleware pour toutes les routes API externes
router.use(logAPIAccess);
router.use(authenticateAPI);

// 📊 Routes API externes avec synchronisation intelligente
router.get('/health', apiController.healthCheck);
router.get('/cartes', apiController.getCartes);
router.post('/sync', apiController.syncData); // ✅ AVEC FUSION INTELLIGENTE MULTI-COLONNES
router.get('/stats', apiController.getStats);
router.get('/modifications', apiController.getModifications);
router.get('/sites', apiController.getSites);

module.exports = router;