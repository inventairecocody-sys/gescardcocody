const express = require("express");
const router = express.Router();
const { loginUser } = require("../Controllers/utilisateursController");

// Route publique : connexion
router.post("/login", loginUser);

module.exports = router;