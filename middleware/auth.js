const jwt = require("jsonwebtoken");

/**
 * Middleware principal d'authentification
 * Vérifie le token JWT et ajoute l'utilisateur à req.user
 */
exports.verifyToken = (req, res, next) => {
  const header = req.headers["authorization"];
  
  if (!header) {
    return res.status(401).json({ 
      success: false,
      message: "Accès refusé : token manquant",
      code: "TOKEN_MISSING"
    });
  }
  
  const token = header.split(" ")[1];
  
  if (!token) {
    return res.status(401).json({ 
      success: false,
      message: "Accès refusé : token manquant",
      code: "TOKEN_MISSING"
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    
    // Structure cohérente pour l'utilisateur
    req.user = {
      id: decoded.id,
      NomUtilisateur: decoded.NomUtilisateur,
      NomComplet: decoded.NomComplet || decoded.NomUtilisateur,
      Role: decoded.Role,
      role: decoded.Role, // Compatibilité minuscule
      Agence: decoded.Agence || '',
      email: decoded.email || null
    };
    
    console.log('✅ Token vérifié - User:', req.user.NomUtilisateur, 'Role:', req.user.Role);
    next();
  } catch (error) {
    console.error('❌ Token invalide:', error.message);
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false,
        message: "Token expiré. Veuillez vous reconnecter.",
        code: "TOKEN_EXPIRED"
      });
    }
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false,
        message: "Token invalide",
        code: "TOKEN_INVALID"
      });
    }
    
    return res.status(401).json({ 
      success: false,
      message: "Erreur d'authentification",
      code: "AUTH_ERROR"
    });
  }
};

/**
 * Vérifie que le rôle de l'utilisateur fait partie des rôles autorisés
 */
exports.verifyRole = (rolesAutorises = []) => {
  return (req, res, next) => {
    const userRole = req.user?.Role || req.user?.role;
    
    if (!req.user || !userRole) {
      return res.status(401).json({ 
        success: false,
        message: "Utilisateur non authentifié",
        code: "USER_NOT_AUTHENTICATED"
      });
    }

    if (!rolesAutorises.includes(userRole)) {
      return res.status(403).json({ 
        success: false,
        message: "Accès interdit : rôle non autorisé",
        code: "ROLE_NOT_AUTHORIZED",
        details: {
          votreRole: userRole,
          rolesAutorises: rolesAutorises
        }
      });
    }

    next();
  };
};

/**
 * Middleware spécialisé : contrôle des colonnes modifiables selon le rôle
 */
exports.canEditColumns = (req, res, next) => {
  const role = req.user?.Role || req.user?.role;

  if (!role) {
    return res.status(401).json({ 
      success: false,
      message: "Rôle non défini",
      code: "ROLE_UNDEFINED"
    });
  }

  const ROLE_COLUMNS = {
    Administrateur: [
      "LIEU D'ENROLEMENT", "SITE DE RETRAIT", "RANGEMENT",
      "NOM", "PRENOMS", "DATE DE NAISSANCE", "LIEU NAISSANCE",
      "CONTACT", "DELIVRANCE", "CONTACT DE RETRAIT", "DATE DE DELIVRANCE"
    ],
    Superviseur: [
      "LIEU D'ENROLEMENT", "SITE DE RETRAIT", "RANGEMENT",
      "NOM", "PRENOMS", "DATE DE NAISSANCE", "LIEU NAISSANCE",
      "CONTACT", "DELIVRANCE", "CONTACT DE RETRAIT", "DATE DE DELIVRANCE"
    ],
    "Chef d'équipe": [
      "LIEU D'ENROLEMENT", "SITE DE RETRAIT", "RANGEMENT",
      "NOM", "PRENOMS", "DATE DE NAISSANCE", "LIEU NAISSANCE",
      "CONTACT", "DELIVRANCE", "CONTACT DE RETRAIT", "DATE DE DELIVRANCE"
    ],
    Opérateur: [
      "DELIVRANCE", "CONTACT DE RETRAIT", "DATE DE DELIVRANCE"
    ]
  };

  req.allowedColumns = ROLE_COLUMNS[role] || [];
  next();
};

// Export par défaut pour compatibilité avec le code existant
module.exports = exports;