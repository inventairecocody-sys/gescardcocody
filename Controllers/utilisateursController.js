const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { poolPromise, sql } = require("../db/db");
const journalController = require("./journalController");

// ==================== AUTHENTIFICATION ====================

// Fonction de connexion
exports.loginUser = async (req, res) => {
  const { NomUtilisateur, MotDePasse } = req.body;

  try {
    const pool = await poolPromise;

    // ✅ DEBUG: Log de la tentative
    console.log('🔍 [LOGIN] Tentative de connexion:', NomUtilisateur);

    const result = await pool
      .request()
      .input("NomUtilisateur", NomUtilisateur)
      .query("SELECT * FROM dbo.Utilisateurs WHERE NomUtilisateur = @NomUtilisateur");

    const utilisateur = result.recordset[0];

    // ✅ DEBUG: Log des données récupérées
    console.log('🔍 [LOGIN] Utilisateur trouvé:', utilisateur ? 'OUI' : 'NON');
    if (utilisateur) {
      console.log('🔍 [LOGIN] Détails utilisateur:');
      console.log('   - ID:', utilisateur.Id);
      console.log('   - NomUtilisateur:', utilisateur.NomUtilisateur);
      console.log('   - Role:', utilisateur.Role);
      console.log('   - NomComplet:', utilisateur.NomComplet);
      console.log('   - Agence:', utilisateur.Agence);
    }

    if (!utilisateur) {
      console.log('❌ [LOGIN] Utilisateur introuvable');
      return res.status(401).json({ message: "Utilisateur introuvable" });
    }

    // Vérification du mot de passe
    const isMatch = await bcrypt.compare(MotDePasse, utilisateur.MotDePasse);
    console.log('🔍 [LOGIN] Mot de passe valide:', isMatch);

    if (!isMatch) {
      console.log('❌ [LOGIN] Mot de passe incorrect');
      return res.status(401).json({ message: "Mot de passe incorrect" });
    }

    // ✅ DEBUG: Log avant génération du token
    console.log('🔍 [LOGIN] Génération du token avec:');
    console.log('   - id:', utilisateur.Id);
    console.log('   - NomUtilisateur:', utilisateur.NomUtilisateur);
    console.log('   - Role:', utilisateur.Role);

    // Génération du token JWT
    const token = jwt.sign(
      {
        id: utilisateur.Id,
        NomUtilisateur: utilisateur.NomUtilisateur,
        Role: utilisateur.Role,
      },
      process.env.JWT_SECRET,
      { expiresIn: "2h" }
    );

    // ✅ DEBUG: Log de la réponse
    console.log('✅ [LOGIN] Connexion réussie pour:', utilisateur.NomUtilisateur);
    console.log('   - Rôle:', utilisateur.Role);
    console.log('   - Token généré:', token ? 'OUI' : 'NON');

    // Retour au frontend
    res.json({
      message: "Connexion réussie",
      token,
      utilisateur: {
        id: utilisateur.Id,
        NomComplet: utilisateur.NomComplet,
        NomUtilisateur: utilisateur.NomUtilisateur,
        Email: utilisateur.Email,
        Agence: utilisateur.Agence,
        Role: utilisateur.Role,
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
    const pool = await poolPromise;
    const result = await pool.request()
      .query(`
        SELECT Id, NomUtilisateur, NomComplet, Email, Agence, Role, DateCreation, Actif 
        FROM Utilisateurs 
        ORDER BY NomComplet
      `);

    res.json(result.recordset);

  } catch (error) {
    console.error("Erreur récupération utilisateurs:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Créer un nouvel utilisateur
exports.createUser = async (req, res) => {
  try {
    const { NomUtilisateur, NomComplet, Email, Agence, Role, MotDePasse } = req.body;

    const pool = await poolPromise;
    
    // Vérifier si l'utilisateur existe déjà
    const existingUser = await pool.request()
      .input('NomUtilisateur', sql.NVarChar, NomUtilisateur)
      .query('SELECT Id FROM Utilisateurs WHERE NomUtilisateur = @NomUtilisateur');

    if (existingUser.recordset.length > 0) {
      return res.status(400).json({ message: "Ce nom d'utilisateur existe déjà" });
    }

    // Hasher le mot de passe
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(MotDePasse, saltRounds);

    // Créer l'utilisateur
    const result = await pool.request()
      .input('NomUtilisateur', sql.NVarChar, NomUtilisateur)
      .input('NomComplet', sql.NVarChar, NomComplet)
      .input('Email', sql.NVarChar, Email)
      .input('Agence', sql.NVarChar, Agence)
      .input('Role', sql.NVarChar, Role)
      .input('MotDePasse', sql.NVarChar, hashedPassword)
      .input('DateCreation', sql.DateTime, new Date())
      .input('Actif', sql.Bit, 1)
      .query(`
        INSERT INTO Utilisateurs 
        (NomUtilisateur, NomComplet, Email, Agence, Role, MotDePasse, DateCreation, Actif)
        OUTPUT INSERTED.Id
        VALUES (@NomUtilisateur, @NomComplet, @Email, @Agence, @Role, @MotDePasse, @DateCreation, @Actif)
      `);

    const newUserId = result.recordset[0].Id;

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
      recordId: newUserId.toString(),
      details: `Nouvel utilisateur créé: ${NomComplet} (${Role})`
    });

    res.status(201).json({ 
      message: "Utilisateur créé avec succès", 
      userId: newUserId 
    });

  } catch (error) {
    console.error("Erreur création utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Modifier un utilisateur
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { NomComplet, Email, Agence, Role, Actif } = req.body;

    const pool = await poolPromise;
    
    await pool.request()
      .input('id', sql.Int, id)
      .input('NomComplet', sql.NVarChar, NomComplet)
      .input('Email', sql.NVarChar, Email)
      .input('Agence', sql.NVarChar, Agence)
      .input('Role', sql.NVarChar, Role)
      .input('Actif', sql.Bit, Actif)
      .query(`
        UPDATE Utilisateurs 
        SET NomComplet = @NomComplet, Email = @Email, Agence = @Agence, Role = @Role, Actif = @Actif
        WHERE Id = @id
      `);

    // Journaliser la modification
    await journalController.logAction({
      utilisateurId: req.user.id,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: `Modification utilisateur ID: ${id}`,
      actionType: "UPDATE_USER",
      tableName: "Utilisateurs",
      recordId: id,
      details: `Utilisateur modifié: ${NomComplet}`
    });

    res.json({ message: "Utilisateur modifié avec succès" });

  } catch (error) {
    console.error("Erreur modification utilisateur:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// Réinitialiser le mot de passe d'un utilisateur
exports.resetPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    const pool = await poolPromise;
    
    // Hasher le nouveau mot de passe
    const saltRounds = 10;
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds);

    await pool.request()
      .input('id', sql.Int, id)
      .input('MotDePasse', sql.NVarChar, hashedPassword)
      .query('UPDATE Utilisateurs SET MotDePasse = @MotDePasse WHERE Id = @id');

    // Journaliser la réinitialisation
    await journalController.logAction({
      utilisateurId: req.user.id,
      nomUtilisateur: req.user.NomUtilisateur,
      nomComplet: req.user.NomComplet,
      role: req.user.Role,
      agence: req.user.Agence,
      action: `Réinitialisation mot de passe utilisateur ID: ${id}`,
      actionType: "RESET_PASSWORD",
      tableName: "Utilisateurs",
      recordId: id,
      details: "Mot de passe réinitialisé par l'administrateur"
    });

    res.json({ message: "Mot de passe réinitialisé avec succès" });

  } catch (error) {
    console.error("Erreur réinitialisation mot de passe:", error);
    res.status(500).json({ message: "Erreur serveur", error });
  }
};

// ==================== PROFIL UTILISATEUR ====================

// Récupérer le profil de l'utilisateur connecté
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

// Modifier le mot de passe de l'utilisateur connecté
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

    // Journaliser le changement de mot de passe
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