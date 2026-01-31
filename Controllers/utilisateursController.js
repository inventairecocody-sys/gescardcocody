const bcrypt = require('bcryptjs');
const jwt = require("jsonwebtoken");
const db = require("../db/db");
const journalController = require("./journalController");

// ==================== AUTHENTIFICATION ====================

// Fonction de connexion
exports.loginUser = async (req, res) => {
  const { NomUtilisateur, MotDePasse } = req.body;

  try {
    console.log('🔍 [LOGIN] Tentative de connexion:', NomUtilisateur);

    const result = await db.query(
      "SELECT * FROM utilisateurs WHERE nomutilisateur = $1",
      [NomUtilisateur]
    );

    const utilisateur = result.rows[0];

    if (!utilisateur) {
      console.log('❌ [LOGIN] Utilisateur introuvable');
      return res.status(401).json({ message: "Utilisateur introuvable" });
    }

    // Vérifier si le compte est actif
    if (!utilisateur.actif) {
      console.log('❌ [LOGIN] Compte désactivé');
      return res.status(401).json({ message: "Ce compte est désactivé. Contactez un administrateur." });
    }

    // Vérification du mot de passe
    const isMatch = await bcrypt.compare(MotDePasse, utilisateur.motdepasse);
    console.log('🔍 [LOGIN] Mot de passe valide:', isMatch);

    if (!isMatch) {
      console.log('❌ [LOGIN] Mot de passe incorrect');
      return res.status(401).json({ message: "Mot de passe incorrect" });
    }

    // Génération du token JWT
    const token = jwt.sign(
      {
        id: utilisateur.id,
        NomUtilisateur: utilisateur.nomutilisateur,
        Role: utilisateur.role,
      },
      process.env.JWT_SECRET || 'votre_secret_jwt_fallback',
      { expiresIn: "2h" }
    );

    console.log('✅ [LOGIN] Connexion réussie pour:', utilisateur.nomutilisateur);

    // Journaliser la connexion
    await journalController.logAction({
      utilisateurId: utilisateur.id,
      nomUtilisateur: utilisateur.nomutilisateur,
      nomComplet: utilisateur.nomcomplet,
      role: utilisateur.role,
      agence: utilisateur.agence,
      action: "Connexion au système",
      actionType: "LOGIN",
      tableName: "Utilisateurs",
      recordId: utilisateur.id.toString(),
      ip: req.ip,
      details: "Connexion réussie au système"
    });

    // Retour au frontend
    res.json({
      message: "Connexion réussie",
      token,
      utilisateur: {
        id: utilisateur.id,
        NomComplet: utilisateur.nomcomplet,
        NomUtilisateur: utilisateur.nomutilisateur,
        Email: utilisateur.email,
        Agence: utilisateur.agence,
        Role: utilisateur.role,
      },
    });

  } catch (error) {
    console.error("❌ [LOGIN] Erreur de connexion :", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// ==================== GESTION DES UTILISATEURS ====================

// Récupérer tous les utilisateurs
exports.getAllUsers = async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, nomutilisateur, nomcomplet, email, agence, role, datecreation, actif 
      FROM utilisateurs 
      ORDER BY nomcomplet
    `);

    res.json(result.rows);

  } catch (error) {
    console.error("Erreur récupération utilisateurs:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Récupérer un utilisateur par ID
exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      'SELECT id, nomutilisateur, nomcomplet, email, agence, role, datecreation, actif FROM utilisateurs WHERE id = $1',
      [id]
    );

    const user = result.rows[0];
    
    if (!user) {
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    res.json(user);

  } catch (error) {
    console.error("Erreur récupération utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Créer un nouvel utilisateur
exports.createUser = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { NomUtilisateur, NomComplet, Email, Agence, Role, MotDePasse } = req.body;

    // Vérifier si l'utilisateur existe déjà
    const existingUser = await client.query(
      'SELECT id FROM utilisateurs WHERE nomutilisateur = $1',
      [NomUtilisateur]
    );

    if (existingUser.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: "Ce nom d'utilisateur existe déjà" });
    }

    // Vérifier si l'email existe déjà
    if (Email) {
      const existingEmail = await client.query(
        'SELECT id FROM utilisateurs WHERE email = $1',
        [Email]
      );

      if (existingEmail.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: "Cet email est déjà utilisé" });
      }
    }

    // Hasher le mot de passe
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(MotDePasse, saltRounds);

    // Créer l'utilisateur
    const result = await client.query(`
      INSERT INTO utilisateurs 
      (nomutilisateur, nomcomplet, email, agence, role, motdepasse, datecreation, actif)
      VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)
      RETURNING id, nomutilisateur, nomcomplet, email, agence, role, datecreation, actif
    `, [NomUtilisateur, NomComplet, Email, Agence, Role, hashedPassword, true]);

    const newUser = result.rows[0];

    // Journaliser la création
    await journalController.logAction({
      utilisateurId: req.user.id,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: `Création utilisateur: ${NomUtilisateur}`,
      actionType: "CREATE_USER",
      tableName: "Utilisateurs",
      recordId: newUser.id.toString(),
      details: `Nouvel utilisateur créé: ${NomComplet} (${Role})`
    });

    await client.query('COMMIT');

    res.status(201).json({ 
      message: "Utilisateur créé avec succès", 
      user: newUser 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur création utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

// Modifier un utilisateur
exports.updateUser = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { NomComplet, Email, Agence, Role, Actif } = req.body;

    // Récupérer l'ancien profil pour la journalisation
    const oldUserResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [id]
    );

    const oldUser = oldUserResult.rows[0];
    
    if (!oldUser) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    // Vérifier si l'email existe déjà pour un autre utilisateur
    if (Email && Email !== oldUser.email) {
      const existingEmail = await client.query(
        'SELECT id FROM utilisateurs WHERE email = $1 AND id != $2',
        [Email, id]
      );

      if (existingEmail.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: "Cet email est déjà utilisé par un autre utilisateur" });
      }
    }

    // Mettre à jour l'utilisateur
    const result = await client.query(`
      UPDATE utilisateurs 
      SET nomcomplet = COALESCE($1, nomcomplet), 
          email = COALESCE($2, email), 
          agence = COALESCE($3, agence), 
          role = COALESCE($4, role), 
          actif = COALESCE($5, actif)
      WHERE id = $6
      RETURNING id, nomutilisateur, nomcomplet, email, agence, role, datecreation, actif
    `, [NomComplet, Email, Agence, Role, Actif, id]);

    const updatedUser = result.rows[0];

    // Journaliser la modification
    await journalController.logAction({
      utilisateurId: req.user.id,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: `Modification utilisateur: ${oldUser.nomutilisateur}`,
      actionType: "UPDATE_USER",
      tableName: "Utilisateurs",
      recordId: id,
      oldValue: JSON.stringify({
        nomComplet: oldUser.nomcomplet,
        email: oldUser.email,
        agence: oldUser.agence,
        role: oldUser.role,
        actif: oldUser.actif
      }),
      newValue: JSON.stringify({
        nomComplet: updatedUser.nomcomplet,
        email: updatedUser.email,
        agence: updatedUser.agence,
        role: updatedUser.role,
        actif: updatedUser.actif
      }),
      details: `Utilisateur modifié: ${NomComplet}`
    });

    await client.query('COMMIT');

    res.json({ 
      message: "Utilisateur modifié avec succès",
      user: updatedUser 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur modification utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

// Réinitialiser le mot de passe d'un utilisateur
exports.resetPassword = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;
    const { newPassword } = req.body;

    // Récupérer l'utilisateur
    const userResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [id]
    );

    const user = userResult.rows[0];
    
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    // Hasher le nouveau mot de passe
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    await client.query(
      'UPDATE utilisateurs SET motdepasse = $1 WHERE id = $2',
      [hashedPassword, id]
    );

    // Journaliser la réinitialisation
    await journalController.logAction({
      utilisateurId: req.user.id,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: `Réinitialisation mot de passe utilisateur: ${user.nomutilisateur}`,
      actionType: "RESET_PASSWORD",
      tableName: "Utilisateurs",
      recordId: id,
      details: "Mot de passe réinitialisé par l'administrateur"
    });

    await client.query('COMMIT');

    res.json({ message: "Mot de passe réinitialisé avec succès" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur réinitialisation mot de passe:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

// Supprimer un utilisateur (désactivation)
exports.deleteUser = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;

    // Récupérer les infos de l'utilisateur avant suppression
    const userResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [id]
    );

    const user = userResult.rows[0];
    
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    // Empêcher l'auto-suppression
    if (parseInt(id) === parseInt(req.user.id)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: "Vous ne pouvez pas supprimer votre propre compte" });
    }

    // Désactiver l'utilisateur plutôt que de le supprimer
    await client.query(
      'UPDATE utilisateurs SET actif = false WHERE id = $1',
      [id]
    );

    // Journaliser la suppression
    await journalController.logAction({
      utilisateurId: req.user.id,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: `Désactivation utilisateur: ${user.nomutilisateur}`,
      actionType: "DELETE_USER",
      tableName: "Utilisateurs",
      recordId: id,
      details: `Utilisateur désactivé: ${user.nomcomplet} (${user.role})`
    });

    await client.query('COMMIT');

    res.json({ message: "Utilisateur désactivé avec succès" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur suppression utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

// Réactiver un utilisateur
exports.activateUser = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { id } = req.params;

    // Récupérer l'utilisateur
    const userResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [id]
    );

    const user = userResult.rows[0];
    
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    await client.query(
      'UPDATE utilisateurs SET actif = true WHERE id = $1',
      [id]
    );

    // Journaliser la réactivation
    await journalController.logAction({
      utilisateurId: req.user.id,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: `Réactivation utilisateur: ${user.nomutilisateur}`,
      actionType: "ACTIVATE_USER",
      tableName: "Utilisateurs",
      recordId: id,
      details: "Utilisateur réactivé"
    });

    await client.query('COMMIT');

    res.json({ message: "Utilisateur réactivé avec succès" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur réactivation utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

// ==================== STATISTIQUES ET RAPPORTS ====================

// Récupérer les statistiques des utilisateurs
exports.getUserStats = async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        COUNT(*) as total_utilisateurs,
        COUNT(CASE WHEN actif = true THEN 1 END) as utilisateurs_actifs,
        COUNT(CASE WHEN actif = false THEN 1 END) as utilisateurs_inactifs,
        COUNT(DISTINCT role) as roles_distincts,
        MIN(datecreation) as premier_utilisateur,
        MAX(datecreation) as dernier_utilisateur
      FROM utilisateurs
    `);

    const rolesStats = await db.query(`
      SELECT 
        role,
        COUNT(*) as count,
        COUNT(CASE WHEN actif = true THEN 1 END) as actifs
      FROM utilisateurs 
      GROUP BY role 
      ORDER BY count DESC
    `);

    // Activité récente des utilisateurs
    const recentActivity = await db.query(`
      SELECT 
        u.nomutilisateur,
        u.nomcomplet,
        u.role,
        COUNT(j.journalid) as total_actions,
        MAX(j.dateaction) as derniere_action
      FROM utilisateurs u
      LEFT JOIN journalactivite j ON u.id = j.utilisateurid
      WHERE j.dateaction >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY u.id, u.nomutilisateur, u.nomcomplet, u.role
      ORDER BY total_actions DESC
      LIMIT 10
    `);

    res.json({
      stats: stats.rows[0],
      parRole: rolesStats.rows,
      activiteRecente: recentActivity.rows
    });

  } catch (error) {
    console.error("Erreur statistiques utilisateurs:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Rechercher des utilisateurs
exports.searchUsers = async (req, res) => {
  try {
    const { q, role, actif, page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT id, nomutilisateur, nomcomplet, email, agence, role, datecreation, actif 
      FROM utilisateurs 
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 0;

    if (q && q.trim() !== '') {
      paramCount++;
      query += ` AND (nomutilisateur ILIKE $${paramCount} OR nomcomplet ILIKE $${paramCount} OR email ILIKE $${paramCount})`;
      params.push(`%${q.trim()}%`);
    }

    if (role) {
      paramCount++;
      query += ` AND role = $${paramCount}`;
      params.push(role);
    }

    if (actif !== undefined) {
      paramCount++;
      query += ` AND actif = $${paramCount}`;
      params.push(actif === 'true');
    }

    query += ` ORDER BY nomcomplet LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(parseInt(limit), offset);

    const result = await db.query(query, params);

    // Compter le total
    let countQuery = 'SELECT COUNT(*) as total FROM utilisateurs WHERE 1=1';
    const countParams = [];
    let countParamCount = 0;

    if (q && q.trim() !== '') {
      countParamCount++;
      countQuery += ` AND (nomutilisateur ILIKE $${countParamCount} OR nomcomplet ILIKE $${countParamCount} OR email ILIKE $${countParamCount})`;
      countParams.push(`%${q.trim()}%`);
    }

    if (role) {
      countParamCount++;
      countQuery += ` AND role = $${countParamCount}`;
      countParams.push(role);
    }

    if (actif !== undefined) {
      countParamCount++;
      countQuery += ` AND actif = $${countParamCount}`;
      countParams.push(actif === 'true');
    }

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    res.json({
      utilisateurs: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: total,
        totalPages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("Erreur recherche utilisateurs:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Récupérer l'historique d'un utilisateur
exports.getUserHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;

    // Vérifier que l'utilisateur existe
    const userResult = await db.query(
      'SELECT id, nomutilisateur, nomcomplet FROM utilisateurs WHERE id = $1',
      [id]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    const history = await db.query(`
      SELECT 
        actiontype,
        action,
        dateaction,
        tablename,
        recordid,
        detailsaction
      FROM journalactivite 
      WHERE utilisateurid = $1 
      ORDER BY dateaction DESC 
      LIMIT $2
    `, [id, parseInt(limit)]);

    res.json({
      utilisateur: userResult.rows[0],
      historique: history.rows
    });

  } catch (error) {
    console.error("Erreur historique utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Exporter la liste des utilisateurs
exports.exportUsers = async (req, res) => {
  try {
    const users = await db.query(`
      SELECT 
        nomutilisateur,
        nomcomplet,
        email,
        agence,
        role,
        datecreation,
        CASE WHEN actif = true THEN 'Actif' ELSE 'Inactif' END as statut
      FROM utilisateurs 
      ORDER BY nomcomplet
    `);

    res.json({
      success: true,
      data: users.rows,
      exportDate: new Date().toISOString(),
      total: users.rows.length
    });

  } catch (error) {
    console.error("Erreur export utilisateurs:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Vérifier la disponibilité d'un nom d'utilisateur
exports.checkUsernameAvailability = async (req, res) => {
  try {
    const { username, excludeId } = req.query;

    if (!username) {
      return res.status(400).json({ message: "Nom d'utilisateur requis" });
    }

    let query = 'SELECT id FROM utilisateurs WHERE nomutilisateur = $1';
    const params = [username];

    if (excludeId) {
      query += ' AND id != $2';
      params.push(excludeId);
    }

    const result = await db.query(query, params);

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

// ==================== FONCTIONNALITÉS SUPPLEMENTAIRES ====================

// Déconnexion
exports.logoutUser = async (req, res) => {
  try {
    // Journaliser la déconnexion
    await journalController.logAction({
      utilisateurId: req.user.id,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: "Déconnexion du système",
      actionType: "LOGOUT",
      tableName: "Utilisateurs",
      recordId: req.user.id.toString(),
      ip: req.ip,
      details: "Déconnexion du système"
    });

    res.json({ message: "Déconnexion réussie" });
  } catch (error) {
    console.error("Erreur déconnexion:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Vérifier le token
exports.verifyToken = async (req, res) => {
  try {
    res.json({
      valid: true,
      user: {
        id: req.user.id,
        NomUtilisateur: req.user.NomUtilisateur,
        NomComplet: req.user.NomComplet,
        Role: req.user.Role,
        Agence: req.user.Agence
      }
    });
  } catch (error) {
    console.error("Erreur vérification token:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// ==================== FONCTIONS ADDITIONNELLES POUR FRONTEND ====================

// Récupérer les utilisateurs avec pagination
exports.getUsersPaginated = async (req, res) => {
  try {
    const { page = 1, limit = 10, sortBy = 'nomcomplet', sortOrder = 'asc' } = req.query;
    const offset = (page - 1) * limit;

    // Validation des paramètres de tri
    const validSortColumns = ['nomcomplet', 'nomutilisateur', 'email', 'role', 'datecreation', 'actif'];
    const validSortOrders = ['asc', 'desc'];
    
    const sortColumn = validSortColumns.includes(sortBy) ? sortBy : 'nomcomplet';
    const order = validSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toUpperCase() : 'ASC';

    // Requête principale
    const result = await db.query(`
      SELECT id, nomutilisateur, nomcomplet, email, agence, role, datecreation, actif 
      FROM utilisateurs 
      ORDER BY ${sortColumn} ${order}
      LIMIT $1 OFFSET $2
    `, [parseInt(limit), offset]);

    // Compter le total
    const countResult = await db.query('SELECT COUNT(*) as total FROM utilisateurs');
    const total = parseInt(countResult.rows[0].total);

    res.json({
      users: result.rows,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });

  } catch (error) {
    console.error("Erreur récupération utilisateurs paginés:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Mettre à jour le profil utilisateur (pour l'utilisateur lui-même)
exports.updateProfile = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { NomComplet, Email, Agence } = req.body;
    const userId = req.user.id;

    // Récupérer l'ancien profil
    const oldUserResult = await client.query(
      'SELECT * FROM utilisateurs WHERE id = $1',
      [userId]
    );

    const oldUser = oldUserResult.rows[0];
    
    if (!oldUser) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    // Vérifier si l'email existe déjà pour un autre utilisateur
    if (Email && Email !== oldUser.email) {
      const existingEmail = await client.query(
        'SELECT id FROM utilisateurs WHERE email = $1 AND id != $2',
        [Email, userId]
      );

      if (existingEmail.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ message: "Cet email est déjà utilisé par un autre utilisateur" });
      }
    }

    // Mettre à jour le profil
    const result = await client.query(`
      UPDATE utilisateurs 
      SET nomcomplet = COALESCE($1, nomcomplet), 
          email = COALESCE($2, email), 
          agence = COALESCE($3, agence)
      WHERE id = $4
      RETURNING id, nomutilisateur, nomcomplet, email, agence, role, datecreation, actif
    `, [NomComplet, Email, Agence, userId]);

    const updatedUser = result.rows[0];

    // Journaliser la modification du profil
    await journalController.logAction({
      utilisateurId: userId,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: "Mise à jour du profil",
      actionType: "UPDATE_PROFILE",
      tableName: "Utilisateurs",
      recordId: userId.toString(),
      details: "Profil utilisateur mis à jour"
    });

    await client.query('COMMIT');

    res.json({ 
      message: "Profil mis à jour avec succès",
      user: updatedUser 
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur mise à jour profil:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

// Changer le mot de passe (pour l'utilisateur lui-même)
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

    // Vérifier l'ancien mot de passe
    const isMatch = await bcrypt.compare(currentPassword, user.motdepasse);
    if (!isMatch) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: "Mot de passe actuel incorrect" });
    }

    // Hasher le nouveau mot de passe
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    await client.query(
      'UPDATE utilisateurs SET motdepasse = $1 WHERE id = $2',
      [hashedPassword, userId]
    );

    // Journaliser le changement de mot de passe
    await journalController.logAction({
      utilisateurId: userId,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: "Changement de mot de passe",
      actionType: "CHANGE_PASSWORD",
      tableName: "Utilisateurs",
      recordId: userId.toString(),
      details: "Mot de passe modifié par l'utilisateur"
    });

    await client.query('COMMIT');

    res.json({ message: "Mot de passe changé avec succès" });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error("Erreur changement mot de passe:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  } finally {
    client.release();
  }
};

// Récupérer les utilisateurs par rôle
exports.getUsersByRole = async (req, res) => {
  try {
    const { role } = req.params;
    
    const result = await db.query(`
      SELECT id, nomutilisateur, nomcomplet, email, agence, role, datecreation, actif 
      FROM utilisateurs 
      WHERE role = $1 AND actif = true
      ORDER BY nomcomplet
    `, [role]);

    res.json(result.rows);

  } catch (error) {
    console.error("Erreur récupération utilisateurs par rôle:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Vérifier si l'utilisateur est administrateur
exports.checkAdmin = async (req, res) => {
  try {
    const userId = req.user.id;
    
    const result = await db.query(
      'SELECT role FROM utilisateurs WHERE id = $1',
      [userId]
    );

    const isAdmin = result.rows.length > 0 && result.rows[0].role === 'admin';

    res.json({ isAdmin });

  } catch (error) {
    console.error("Erreur vérification admin:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};