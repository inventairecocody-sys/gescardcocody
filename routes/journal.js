const express = require('express');
const router = express.Router();
const journalController = require('../Controllers/journalController');
const { verifyToken } = require('../middleware/auth');

// ✅ TOUS LES UTILISATEURS AUTHENTIFIÉS PEUVENT ACCÉDER AU JOURNAL
router.use(verifyToken);

// ✅ ROUTE GET - Récupérer le journal avec filtres et pagination
router.get('/', (req, res) => journalController.getJournal(req, res));

// ✅ ROUTE GET - Récupérer la liste des imports groupés
router.get('/imports', (req, res) => journalController.getImports(req, res));

// ✅ ROUTE GET - Statistiques d'activité
router.get('/stats', (req, res) => journalController.getStats(req, res));

module.exports = router;