const bcrypt = require("bcrypt");
const { poolPromise, sql } = require("../db/db");
const journalController = require("./journalController");

exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const pool = await poolPromise;
    const result = await pool.request()
      .input('id', sql.Int, userId)
      .query('SELECT Id, NomUtilisateur, NomComplet, Email, Agence, Role FROM Utilisateurs WHERE Id = @id');

    const user = result.recordset[0];
    
    if (!user) {
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    res.json(user);

  } catch (error) {
    console.error("Erreur récupération profil:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    const pool = await poolPromise;
    
    // Récupérer l'utilisateur
    const userResult = await pool.request()
      .input('id', sql.Int, userId)
      .query('SELECT * FROM Utilisateurs WHERE Id = @id');

    const user = userResult.recordset[0];
    
    if (!user) {
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    // Vérifier le mot de passe actuel
    const isMatch = await bcrypt.compare(currentPassword, user.MotDePasse);
    if (!isMatch) {
      return res.status(401).json({ message: "Mot de passe actuel incorrect" });
    }

    // Hasher le nouveau mot de passe
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Mettre à jour le mot de passe
    await pool.request()
      .input('id', sql.Int, userId)
      .input('MotDePasse', sql.NVarChar, hashedPassword)
      .query('UPDATE Utilisateurs SET MotDePasse = @MotDePasse WHERE Id = @id');

    // ✅ JOURNALISATION avec le système existant
    await journalController.logAction({
      utilisateurId: user.Id,
      nomUtilisateur: user.NomUtilisateur,
      nomComplet: user.NomComplet,
      role: user.Role,
      agence: user.Agence,
      action: "Changement de mot de passe",
      actionType: "UPDATE_PASSWORD",
      tableName: "Utilisateurs",
      recordId: user.Id.toString(),
      details: "Utilisateur a modifié son mot de passe"
    });

    res.json({ message: "Mot de passe modifié avec succès" });

  } catch (error) {
    console.error("Erreur changement mot de passe:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};