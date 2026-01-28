const express = require('express');
const router = express.Router();
const utilisateursController = require('../Controllers/utilisateursController');

// LOGIN
router.post('/login', utilisateursController.loginUser);

module.exports = router;