const bcrypt = require("bcrypt");
const db = require("../db/db");
const journalController = require("./journalController");

exports.getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const result = await db.query(
      'SELECT id, nomutilisateur, nomcomplet, email, agence, role FROM utilisateurs WHERE id = $1',
      [userId]
    );

    const user = result.rows[0];
    
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
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    // Récupérer l'utilisateur
    const userResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [userId]
    );

    const user = userResult.rows[0];
    
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    // Vérifier le mot de passe actuel
    const isMatch = await bcrypt.compare(currentPassword, user.motdepasse);
    if (!isMatch) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: "Mot de passe actuel incorrect" });
    }

    // Hasher le nouveau mot de passe
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    // Mettre à jour le mot de passe
    await client.query(
      'UPDATE utilisateurs SET motdepasse = $1 WHERE id = $2',
      [hashedPassword, userId]
    );

    // ✅ JOURNALISATION avec le système existant
    await journalController.logAction({
      utilisateurId: user.id,
      nomUtilisateur: user.nomutilisateur,
      nomComplet: user.nomcomplet,
      role: user.role,
      agence: user.agence,
      action: "Changement de mot de passe",
      actionType: "UPDATE_PASSWORD",
      tableName: "Utilisateurs",
      recordId: user.id.toString(),
      details: "Utilisateur a modifié son mot de passe"
    });

    await client.query('COMMIT');

    res.json({ message: "Mot de passe modifié avec succès" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur changement mot de passe:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

exports.updateProfile = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { nomComplet, email, agence } = req.body;
    const userId = req.user.id;

    // Récupérer l'ancien profil
    const oldProfileResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [userId]
    );

    const oldProfile = oldProfileResult.rows[0];
    
    if (!oldProfile) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    // Mettre à jour le profil
    await client.query(
      'UPDATE utilisateurs SET nomcomplet = $1, email = $2, agence = $3 WHERE id = $4',
      [nomComplet, email, agence, userId]
    );

    // Récupérer le nouveau profil
    const newProfileResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [userId]
    );

    const newProfile = newProfileResult.rows[0];

    // ✅ JOURNALISATION
    await journalController.logAction({
      utilisateurId: userId,
      nomUtilisateur: oldProfile.nomutilisateur,
      nomComplet: oldProfile.nomcomplet,
      role: oldProfile.role,
      agence: oldProfile.agence,
      action: "Modification du profil",
      actionType: "UPDATE_PROFILE",
      tableName: "Utilisateurs",
      recordId: userId.toString(),
      oldValue: JSON.stringify({
        nomComplet: oldProfile.nomcomplet,
        email: oldProfile.email,
        agence: oldProfile.agence
      }),
      newValue: JSON.stringify({
        nomComplet: newProfile.nomcomplet,
        email: newProfile.email,
        agence: newProfile.agence
      }),
      details: "Utilisateur a modifié son profil"
    });

    await client.query('COMMIT');

    res.json({ 
      message: "Profil mis à jour avec succès",
      user: {
        id: newProfile.id,
        nomUtilisateur: newProfile.nomutilisateur,
        nomComplet: newProfile.nomcomplet,
        email: newProfile.email,
        agence: newProfile.agence,
        role: newProfile.role
      }
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur mise à jour profil:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

exports.getUserActivity = async (req, res) => {
  try {
    const userId = req.user.id;
    const { limit = 20 } = req.query;

    const result = await db.query(
      `SELECT 
        actiontype,
        action,
        dateaction,
        tablename,
        detailsaction
       FROM journalactivite 
       WHERE utilisateurid = $1 
       ORDER BY dateaction DESC 
       LIMIT $2`,
      [userId, parseInt(limit)]
    );

    res.json({
      activities: result.rows,
      total: result.rows.length
    });

  } catch (error) {
    console.error("Erreur récupération activités:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

exports.checkUsernameAvailability = async (req, res) => {
  try {
    const { username } = req.query;
    const userId = req.user.id;

    if (!username) {
      return res.status(400).json({ message: "Nom d'utilisateur requis" });
    }

    const result = await db.query(
      'SELECT id FROM utilisateurs WHERE nomutilisateur = $1 AND id != $2',
      [username, userId]
    );

    const isAvailable = result.rows.length === 0;

    res.json({
      available: isAvailable,
      message: isAvailable ? "Nom d'utilisateur disponible" : "Nom d'utilisateur déjà utilisé"
    });

  } catch (error) {
    console.error("Erreur vérification nom d'utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

exports.updateUsername = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { newUsername } = req.body;
    const userId = req.user.id;

    if (!newUsername || newUsername.trim() === '') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: "Nouveau nom d'utilisateur requis" });
    }

    // Vérifier si le nom d'utilisateur est disponible
    const checkResult = await client.query(
      'SELECT id FROM utilisateurs WHERE nomutilisateur = $1 AND id != $2',
      [newUsername, userId]
    );

    if (checkResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: "Ce nom d'utilisateur est déjà utilisé" });
    }

    // Récupérer l'ancien profil
    const oldProfileResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [userId]
    );

    const oldProfile = oldProfileResult.rows[0];

    // Mettre à jour le nom d'utilisateur
    await client.query(
      'UPDATE utilisateurs SET nomutilisateur = $1 WHERE id = $2',
      [newUsername, userId]
    );

    // ✅ JOURNALISATION
    await journalController.logAction({
      utilisateurId: userId,
      nomUtilisateur: oldProfile.nomutilisateur,
      nomComplet: oldProfile.nomcomplet,
      role: oldProfile.role,
      agence: oldProfile.agence,
      action: "Changement de nom d'utilisateur",
      actionType: "UPDATE_USERNAME",
      tableName: "Utilisateurs",
      recordId: userId.toString(),
      oldValue: JSON.stringify({ nomUtilisateur: oldProfile.nomutilisateur }),
      newValue: JSON.stringify({ nomUtilisateur: newUsername }),
      details: `Changement de nom d'utilisateur: ${oldProfile.nomutilisateur} → ${newUsername}`
    });

    await client.query('COMMIT');

    res.json({ 
      message: "Nom d'utilisateur modifié avec succès",
      newUsername: newUsername
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur changement nom d'utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

exports.getProfileStats = async (req, res) => {
  try {
    const userId = req.user.id;

    // Statistiques des actions récentes
    const activityStats = await db.query(
      `SELECT 
        COUNT(*) as total_actions,
        COUNT(CASE WHEN dateaction >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as actions_7j,
        COUNT(CASE WHEN dateaction >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as actions_30j
       FROM journalactivite 
       WHERE utilisateurid = $1`,
      [userId]
    );

    // Dernière connexion
    const lastLoginResult = await db.query(
      `SELECT dateaction 
       FROM journalactivite 
       WHERE utilisateurid = $1 AND actiontype = 'LOGIN' 
       ORDER BY dateaction DESC 
       LIMIT 1`,
      [userId]
    );

    // Actions les plus fréquentes
    const frequentActions = await db.query(
      `SELECT 
        actiontype,
        COUNT(*) as count
       FROM journalactivite 
       WHERE utilisateurid = $1 
       GROUP BY actiontype 
       ORDER BY count DESC 
       LIMIT 5`,
      [userId]
    );

    res.json({
      stats: {
        totalActions: parseInt(activityStats.rows[0].total_actions),
        actionsLast7Days: parseInt(activityStats.rows[0].actions_7j),
        actionsLast30Days: parseInt(activityStats.rows[0].actions_30j),
        lastLogin: lastLoginResult.rows[0]?.dateaction || null
      },
      frequentActions: frequentActions.rows
    });

  } catch (error) {
    console.error("Erreur statistiques profil:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

exports.deactivateAccount = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { password } = req.body;
    const userId = req.user.id;

    // Vérifier le mot de passe
    const userResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [userId]
    );

    const user = userResult.rows[0];
    
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    const isMatch = await bcrypt.compare(password, user.motdepasse);
    if (!isMatch) {
      await client.query('ROLLBACK');
      return res.status(401).json({ message: "Mot de passe incorrect" });
    }

    // Désactiver le compte (marquer comme inactif au lieu de supprimer)
    await client.query(
      'UPDATE utilisateurs SET actif = false WHERE id = $1',
      [userId]
    );

    // ✅ JOURNALISATION
    await journalController.logAction({
      utilisateurId: userId,
      nomUtilisateur: user.nomutilisateur,
      nomComplet: user.nomcomplet,
      role: user.role,
      agence: user.agence,
      action: "Désactivation du compte",
      actionType: "DEACTIVATE_ACCOUNT",
      tableName: "Utilisateurs",
      recordId: userId.toString(),
      details: "Utilisateur a désactivé son compte"
    });

    await client.query('COMMIT');

    res.json({ 
      message: "Compte désactivé avec succès",
      note: "Votre compte a été désactivé. Contactez un administrateur pour le réactiver."
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur désactivation compte:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

exports.exportProfileData = async (req, res) => {
  try {
    const userId = req.user.id;

    // Données du profil
    const profileResult = await db.query(
      'SELECT id, nomutilisateur, nomcomplet, email, agence, role, datecreation FROM utilisateurs WHERE id = $1',
      [userId]
    );

    // Historique des activités
    const activitiesResult = await db.query(
      `SELECT 
        actiontype,
        action,
        dateaction,
        tablename,
        detailsaction
       FROM journalactivite 
       WHERE utilisateurid = $1 
       ORDER BY dateaction DESC`,
      [userId]
    );

    const exportData = {
      profile: profileResult.rows[0],
      activities: activitiesResult.rows,
      exportDate: new Date().toISOString(),
      totalActivities: activitiesResult.rows.length
    };

    res.json({
      success: true,
      data: exportData,
      message: "Données exportées avec succès"
    });

  } catch (error) {
    console.error("Erreur export données profil:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};