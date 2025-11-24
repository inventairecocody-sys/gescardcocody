const express = require('express');
const router = express.Router();
const journalController = require('../Controllers/journalController');
const { verifyToken } = require('../middleware/auth');
const journalAccess = require('../middleware/journalAccess');

// ✅ SEULS LES ADMINISTRATEURS PEUVENT ACCÉDER AU JOURNAL
router.use(verifyToken);
router.use(journalAccess);

// ✅ ROUTE GET - Récupérer le journal avec filtres et pagination
router.get('/', (req, res) => journalController.getJournal(req, res));

// ✅ ROUTE GET - Récupérer la liste des imports groupés
router.get('/imports', (req, res) => journalController.getImports(req, res));

// ✅ ROUTE POST - Annuler une importation
router.post('/annuler-import', (req, res) => journalController.annulerImportation(req, res));

// ✅ ROUTE GET - Statistiques d'activité
router.get('/stats', (req, res) => journalController.getStats(req, res));

// ✅ NOUVELLE ROUTE - Annuler une action (modification/création/suppression)
router.post('/undo/:id', (req, res) => journalController.undoAction(req, res));

module.exports = router;