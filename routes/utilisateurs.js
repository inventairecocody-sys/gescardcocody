const express = require('express');
const router = express.Router();
const utilisateursController = require('../Controllers/utilisateursController');
const authMiddleware = require('../middleware/auth'); // Middleware d'authentification

// ==================== ROUTES PUBLIQUES ====================

/**
 * @route POST /api/utilisateurs/login
 * @desc Connexion d'un utilisateur
 * @access Public
 */
router.post('/login', utilisateursController.loginUser);

/**
 * @route GET /api/utilisateurs/check-username
 * @desc Vérifier la disponibilité d'un nom d'utilisateur
 * @access Public
 */
router.get('/check-username', (req, res) => {
  utilisateursController.checkUsernameAvailability(req, res);
});

// ==================== ROUTES PROTÉGÉES (TOUS LES UTILISATEURS AUTHENTIFIÉS) ====================

/**
 * @route POST /api/utilisateurs/logout
 * @desc Déconnexion de l'utilisateur
 * @access Private (Authentifié)
 */
router.post('/logout', authMiddleware.verifyToken, (req, res) => {
  utilisateursController.logoutUser(req, res);
});

/**
 * @route GET /api/utilisateurs/verify
 * @desc Vérifier la validité du token
 * @access Private (Authentifié)
 */
router.get('/verify', authMiddleware.verifyToken, (req, res) => {
  utilisateursController.verifyToken(req, res);
});

/**
 * @route GET /api/utilisateurs/check-admin
 * @desc Vérifier si l'utilisateur est administrateur
 * @access Private (Authentifié)
 */
router.get('/check-admin', authMiddleware.verifyToken, (req, res) => {
  utilisateursController.checkAdmin(req, res);
});

/**
 * @route GET /api/utilisateurs/profile
 * @desc Récupérer le profil de l'utilisateur connecté
 * @access Private (Authentifié)
 */
router.get('/profile', authMiddleware.verifyToken, (req, res) => {
  // Passer l'ID de l'utilisateur connecté via req.params
  const originalParams = { ...req.params };
  req.params = { id: req.user.id };
  
  utilisateursController.getUserById(req, res);
  
  // Restaurer les params originaux
  req.params = originalParams;
});

/**
 * @route PUT /api/utilisateurs/profile
 * @desc Mettre à jour le profil de l'utilisateur connecté
 * @access Private (Authentifié)
 */
router.put('/profile', authMiddleware.verifyToken, (req, res) => {
  utilisateursController.updateProfile(req, res);
});

/**
 * @route PUT /api/utilisateurs/change-password
 * @desc Changer le mot de passe de l'utilisateur connecté
 * @access Private (Authentifié)
 */
router.put('/change-password', authMiddleware.verifyToken, (req, res) => {
  utilisateursController.changePassword(req, res);
});

// ==================== MIDDLEWARE DE VÉRIFICATION ADMIN ====================

/**
 * Middleware pour vérifier si l'utilisateur est administrateur
 */
const checkAdminMiddleware = (req, res, next) => {
  try {
    // Vérifier si l'utilisateur est connecté
    if (!req.user) {
      return res.status(401).json({ 
        success: false,
        message: "Authentification requise",
        code: "AUTH_REQUIRED"
      });
    }
    
    // Vérifier le rôle de l'utilisateur
    const userRole = req.user.Role || req.user.role;
    
    if (!userRole) {
      return res.status(403).json({ 
        success: false,
        message: "Rôle utilisateur non défini",
        code: "ROLE_UNDEFINED"
      });
    }
    
    const normalizedRole = userRole.toString().trim();
    
    if (normalizedRole !== 'Administrateur') {
      console.log(`❌ Accès admin refusé - Utilisateur: ${req.user.NomUtilisateur}, Rôle: ${normalizedRole}`);
      
      return res.status(403).json({ 
        success: false,
        message: "Accès réservé aux administrateurs",
        code: "ADMIN_ACCESS_REQUIRED",
        details: {
          votreRole: normalizedRole,
          roleRequis: 'Administrateur',
          utilisateur: req.user.NomUtilisateur
        }
      });
    }
    
    console.log(`✅ Accès admin autorisé - Utilisateur: ${req.user.NomUtilisateur}, Rôle: ${normalizedRole}`);
    next();
  } catch (error) {
    console.error('❌ Erreur vérification admin:', error);
    res.status(500).json({ 
      success: false,
      message: "Erreur de vérification des permissions",
      code: "ADMIN_CHECK_ERROR",
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// ==================== ROUTES ADMINISTRATEURS SEULEMENT ====================

/**
 * @route GET /api/utilisateurs
 * @desc Récupérer tous les utilisateurs
 * @access Private (Admin seulement)
 */
router.get('/', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.getAllUsers(req, res);
});

/**
 * @route GET /api/utilisateurs/paginated
 * @desc Récupérer les utilisateurs avec pagination
 * @access Private (Admin seulement)
 */
router.get('/paginated', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.getUsersPaginated(req, res);
});

/**
 * @route GET /api/utilisateurs/search
 * @desc Rechercher des utilisateurs
 * @access Private (Admin seulement)
 */
router.get('/search', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.searchUsers(req, res);
});

/**
 * @route GET /api/utilisateurs/stats
 * @desc Récupérer les statistiques des utilisateurs
 * @access Private (Admin seulement)
 */
router.get('/stats', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.getUserStats(req, res);
});

/**
 * @route GET /api/utilisateurs/export
 * @desc Exporter la liste des utilisateurs
 * @access Private (Admin seulement)
 */
router.get('/export', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.exportUsers(req, res);
});

/**
 * @route GET /api/utilisateurs/role/:role
 * @desc Récupérer les utilisateurs par rôle
 * @access Private (Admin seulement)
 */
router.get('/role/:role', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.getUsersByRole(req, res);
});

// ==================== CRUD DES UTILISATEURS (ADMIN SEULEMENT) ====================

/**
 * @route POST /api/utilisateurs
 * @desc Créer un nouvel utilisateur
 * @access Private (Admin seulement)
 */
router.post('/', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.createUser(req, res);
});

/**
 * @route GET /api/utilisateurs/:id
 * @desc Récupérer un utilisateur spécifique
 * @access Private (Admin seulement)
 */
router.get('/:id', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.getUserById(req, res);
});

/**
 * @route PUT /api/utilisateurs/:id
 * @desc Modifier un utilisateur
 * @access Private (Admin seulement)
 */
router.put('/:id', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.updateUser(req, res);
});

/**
 * @route DELETE /api/utilisateurs/:id
 * @desc Supprimer/désactiver un utilisateur
 * @access Private (Admin seulement)
 */
router.delete('/:id', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.deleteUser(req, res);
});

/**
 * @route PUT /api/utilisateurs/:id/activate
 * @desc Réactiver un utilisateur
 * @access Private (Admin seulement)
 */
router.put('/:id/activate', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.activateUser(req, res);
});

/**
 * @route PUT /api/utilisateurs/:id/reset-password
 * @desc Réinitialiser le mot de passe d'un utilisateur
 * @access Private (Admin seulement)
 */
router.put('/:id/reset-password', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.resetPassword(req, res);
});

/**
 * @route GET /api/utilisateurs/:id/history
 * @desc Récupérer l'historique d'un utilisateur
 * @access Private (Admin seulement)
 */
router.get('/:id/history', authMiddleware.verifyToken, checkAdminMiddleware, (req, res) => {
  utilisateursController.getUserHistory(req, res);
});

// ==================== ROUTES DE DIAGNOSTIC ET SANTÉ ====================

/**
 * @route GET /api/utilisateurs/health
 * @desc Vérifier la santé du module utilisateurs
 * @access Public
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: "Module utilisateurs opérationnel",
    timestamp: new Date().toISOString(),
    routes: {
      public: ['POST /login', 'GET /check-username', 'GET /health'],
      authenticated: [
        'POST /logout',
        'GET /verify', 
        'GET /check-admin',
        'GET /profile',
        'PUT /profile',
        'PUT /change-password'
      ],
      admin: [
        'GET /',
        'GET /paginated',
        'GET /search',
        'GET /stats',
        'GET /export',
        'GET /role/:role',
        'POST /',
        'GET /:id',
        'PUT /:id',
        'DELETE /:id',
        'PUT /:id/activate',
        'PUT /:id/reset-password',
        'GET /:id/history'
      ]
    }
  });
});

/**
 * @route GET /api/utilisateurs/me
 * @desc Récupérer les informations de l'utilisateur connecté (alias de /profile)
 * @access Private (Authentifié)
 */
router.get('/me', authMiddleware.verifyToken, (req, res) => {
  const user = req.user;
  res.json({
    success: true,
    user: {
      id: user.id,
      NomUtilisateur: user.NomUtilisateur,
      NomComplet: user.NomComplet,
      Role: user.Role,
      Agence: user.Agence,
      email: user.email || null
    },
    permissions: {
      isAdmin: user.Role === 'Administrateur',
      canManageUsers: user.Role === 'Administrateur',
      canManageSystem: user.Role === 'Administrateur',
      canViewAllData: ['Administrateur', 'Superviseur'].includes(user.Role),
      canEditData: ['Administrateur', 'Superviseur', "Chef d'équipe"].includes(user.Role)
    }
  });
});

// ==================== GESTION DES ERREURS SPÉCIFIQUES AUX UTILISATEURS ====================

// Middleware pour gérer les erreurs 404 spécifiques aux utilisateurs
router.use((req, res, next) => {
  res.status(404).json({
    success: false,
    message: "Route utilisateur non trouvée",
    requestedUrl: req.originalUrl,
    availableRoutes: [
      'POST   /api/utilisateurs/login',
      'GET    /api/utilisateurs/check-username',
      'GET    /api/utilisateurs/health',
      'POST   /api/utilisateurs/logout (auth)',
      'GET    /api/utilisateurs/verify (auth)',
      'GET    /api/utilisateurs/check-admin (auth)',
      'GET    /api/utilisateurs/profile (auth)',
      'PUT    /api/utilisateurs/profile (auth)',
      'PUT    /api/utilisateurs/change-password (auth)',
      'GET    /api/utilisateurs/me (auth)',
      'GET    /api/utilisateurs/ (admin)',
      'POST   /api/utilisateurs/ (admin)',
      'GET    /api/utilisateurs/:id (admin)',
      'PUT    /api/utilisateurs/:id (admin)',
      'DELETE /api/utilisateurs/:id (admin)'
    ],
    help: "Consultez /api/utilisateurs/health pour la liste complète des routes"
  });
});

// Middleware pour gérer les erreurs
router.use((err, req, res, next) => {
  console.error('❌ Erreur route utilisateurs:', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    url: req.url,
    method: req.method,
    user: req.user ? req.user.NomUtilisateur : 'non authentifié'
  });
  
  // Erreur d'authentification
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: "Erreur d'authentification",
      error: err.message,
      code: "AUTH_ERROR"
    });
  }
  
  // Erreur de permission
  if (err.message && err.message.includes('admin') || err.message.includes('permission')) {
    return res.status(403).json({
      success: false,
      message: "Erreur de permission",
      error: "Vous n'avez pas les permissions nécessaires",
      code: "PERMISSION_ERROR"
    });
  }
  
  // Erreur de base de données
  if (err.code && err.code.startsWith('23') || err.message.includes('database')) {
    return res.status(500).json({
      success: false,
      message: "Erreur de base de données",
      error: "Une erreur est survenue avec la base de données",
      code: "DATABASE_ERROR"
    });
  }
  
  // Erreur générique
  res.status(err.status || 500).json({
    success: false,
    message: "Erreur serveur",
    error: process.env.NODE_ENV === 'development' ? err.message : 'Une erreur est survenue',
    code: "SERVER_ERROR"
  });
});

module.exports = router;