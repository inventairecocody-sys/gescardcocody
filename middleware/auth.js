const jwt = require("jsonwebtoken");

/**
 * Vérifie le token JWT - VERSION CORRIGÉE
 */
exports.verifyToken = (req, res, next) => {
  const header = req.headers["authorization"];
  const token = header && header.split(" ")[1];

  if (!token) {
    return res.status(401).json({ 
      success: false,
      message: "Accès refusé : token manquant" 
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // 🔥 CORRECTION CRITIQUE : Structure cohérente
    req.user = {
      id: decoded.id,
      NomUtilisateur: decoded.NomUtilisateur,
      NomComplet: decoded.NomComplet || decoded.NomUtilisateur,
      Role: decoded.Role,
      role: decoded.Role, // Compatibilité minuscule
      Agence: decoded.Agence || ''
    };
    
    console.log('✅ Token vérifié - User:', req.user.NomUtilisateur, 'Role:', req.user.Role);
    next();
  } catch (error) {
    console.error('❌ Token invalide:', error.message);
    return res.status(403).json({ 
      success: false,
      message: "Token invalide ou expiré" 
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
        message: "Utilisateur non authentifié" 
      });
    }

    if (!rolesAutorises.includes(userRole)) {
      return res.status(403).json({ 
        success: false,
        message: "Accès interdit : rôle non autorisé" 
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
      message: "Rôle non défini" 
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