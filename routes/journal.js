const express = require('express');
const router = express.Router();
const journalController = require('../Controllers/journalController');
const { verifyToken } = require('../middleware/auth');
const journalAccess = require('../middleware/journalAccess');

// ✅ TOUTES LES ROUTES PROTÉGÉES PAR AUTHENTIFICATION
router.use(verifyToken);

// ✅ ROUTE GET - Récupérer le journal avec filtres et pagination
router.get('/', (req, res) => journalController.getJournal(req, res));

// ✅ ROUTE GET - Récupérer la liste des imports groupés
router.get('/imports', (req, res) => journalController.getImports(req, res));

// ✅ ROUTE POST - Annuler une importation
router.post('/annuler-import', (req, res) => journalController.annulerImportation(req, res));

// ✅ ROUTE GET - Statistiques d'activité
router.get('/stats', (req, res) => journalController.getStats(req, res));

// ✅ ROUTE POST - Annuler une action (modification/création/suppression)
router.post('/undo/:id', (req, res) => journalController.undoAction(req, res));

// ✅ ROUTE POST - Nettoyer le journal (supprimer les vieilles entrées)
router.post('/nettoyer', (req, res) => journalController.nettoyerJournal(req, res));

// ✅ ROUTE POST - Journaliser une action (utilitaire pour autres contrôleurs)
router.post('/log', (req, res) => {
    journalController.logAction(req.body)
        .then(() => res.json({ success: true, message: 'Action journalisée' }))
        .catch(error => res.status(500).json({ error: 'Erreur journalisation' }));
});

module.exports = router;