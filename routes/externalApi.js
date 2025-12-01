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
router.get('/changes', apiController.getChanges); // ✅ NOUVELLE ROUTE AJOUTÉE
router.get('/sites', apiController.getSites);

// Route test CORS
router.get('/cors-test', (req, res) => {
  res.json({
    success: true,
    message: 'API externe accessible via CORS',
    origin: req.headers.origin || 'undefined',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;