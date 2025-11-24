const express = require('express');
const router = express.Router();
const inventaireController = require('../Controllers/inventaire');

// 🔍 Route de recherche multicritères
router.get('/recherche', inventaireController.rechercheCartes);

module.exports = router;