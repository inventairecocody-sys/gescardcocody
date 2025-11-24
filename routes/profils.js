const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middleware/auth");
const { getProfile, changePassword } = require("../Controllers/profilController");

// Toutes les routes sont protégées par le token
router.use(verifyToken);

// GET /api/profil - Récupérer les infos du profil
router.get("/", getProfile);

// PUT /api/profil/password - Modifier le mot de passe
router.put("/password", changePassword);

module.exports = router;