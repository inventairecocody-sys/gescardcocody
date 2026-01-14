const rateLimit = require('express-rate-limit');

// ==================== CONFIGURATION RATE LIMITING ====================

// Configuration du rate limiting spécifique aux imports/exports
const importExportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req) => {
    // Limites adaptatives selon le rôle et le type de route
    const userRole = req.user?.role || req.user?.Role;
    const routeType = getRouteType(req.url, req.method);
    
    console.log('⚙️ Rate limiting - Role:', userRole, 'Route:', routeType);
    
    // Limites plus élevées pour les administrateurs
    if (userRole === 'Administrateur') {
      if (routeType === 'bulk-import') return 10;    // 10 imports massifs/15min
      if (routeType === 'stream') return 30;         // 30 exports/15min
      return 100;                                    // 100 autres req/15min
    }
    
    if (userRole === 'Superviseur') {
      if (routeType === 'bulk-import') return 5;     // 5 imports massifs/15min
      if (routeType === 'stream') return 20;         // 20 exports/15min
      return 60;                                     // 60 autres req/15min
    }
    
    if (userRole === 'Chef d\'équipe' || userRole === 'Chef d\'equipe') {
      if (routeType === 'bulk-import') return 2;     // 2 imports massifs/15min
      if (routeType === 'stream') return 10;         // 10 exports/15min
      return 30;                                     // 30 autres req/15min
    }
    
    // Opérateurs et autres rôles
    if (routeType === 'bulk-import') return 0;       // Pas d'accès aux imports massifs
    if (routeType === 'stream') return 5;            // 5 exports/15min
    return 20;                                       // 20 autres req/15min
  },
  message: {
    success: false,
    error: 'Trop de requêtes d\'import/export',
    message: 'Veuillez réessayer dans 15 minutes',
    advice: 'Contactez un administrateur si vous avez besoin d\'accès plus fréquent'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Ne pas appliquer le rate limiting aux routes suivantes
    const exemptRoutes = [
      '/health',
      '/test-db',
      '/cors-test',
      '/diagnostic',
      '/template'
    ];
    
    const isExempt = exemptRoutes.some(route => req.url.includes(route));
    
    // Journaliser les requêtes rate limited
    if (!isExempt) {
      console.log('📊 Rate limiting check:', {
        url: req.url,
        method: req.method,
        user: req.user?.nomUtilisateur || req.user?.NomUtilisateur || 'unknown',
        role: req.user?.role || req.user?.Role || 'unknown'
      });
    }
    
    return isExempt;
  }
});

// ==================== MIDDLEWARE D'ACCÈS ====================

const importExportAccess = (req, res, next) => {
  console.log('🔐 Vérification accès import/export:', {
    url: req.url,
    method: req.method,
    user: req.user?.nomUtilisateur || req.user?.NomUtilisateur || 'unknown',
    ip: req.ip
  });
  
  // 1. VÉRIFIER LE TOKEN D'API EXTERNE (si présent)
  const apiToken = req.headers['x-api-token'] || req.headers['authorization'];
  const externalToken = process.env.EXTERNAL_API_TOKEN;
  
  if (apiToken && externalToken && apiToken === `Bearer ${externalToken}`) {
    console.log('🔑 Accès API externe autorisé');
    req.apiClient = {
      authenticated: true,
      clientType: 'external_api',
      ip: req.ip,
      bypassPermissions: true
    };
    return next(); // Bypass les vérifications de rôle
  }
  
  // 2. VÉRIFIER L'AUTHENTIFICATION UTILISATEUR
  if (!req.user) {
    console.log('❌ Utilisateur non authentifié');
    return res.status(401).json({ 
      success: false,
      error: 'Authentification requise',
      message: 'Veuillez vous connecter pour accéder à cette fonctionnalité'
    });
  }
  
  // 3. RÉCUPÉRER LE RÔLE
  const userRole = req.user?.role || req.user?.Role || req.headers['x-user-role'];
  
  if (!userRole) {
    console.log('❌ Rôle utilisateur non défini');
    return res.status(403).json({ 
      success: false,
      error: 'Rôle non défini',
      message: 'Votre compte ne possède pas de rôle défini. Contactez un administrateur.'
    });
  }
  
  // Normalisation du rôle (insensible à la casse)
  const normalizedRole = userRole.toLowerCase().trim();
  
  console.log('🔍 Vérification accès import/export:', {
    userRole: userRole,
    normalizedRole: normalizedRole,
    method: req.method,
    url: req.url,
    user: req.user?.nomUtilisateur || req.user?.NomUtilisateur
  });
  
  // 4. DÉFINIR LES PERMISSIONS PAR RÔLE
  const rolePermissions = {
    'administrateur': {
      allowed: ['import', 'export', 'smart-sync', 'filtered', 'admin', 'stream', 'bulk-import', 'optimized', 'all'],
      description: 'Accès complet à toutes les fonctionnalités',
      maxFileSize: '50MB',
      maxRowsPerImport: 100000
    },
    'superviseur': {
      allowed: ['import', 'export', 'filtered', 'stream', 'optimized', 'smart-sync'],
      description: 'Import/export standard et intelligent',
      maxFileSize: '30MB',
      maxRowsPerImport: 50000
    },
    'chef d\'équipe': {
      allowed: ['chef d\'equipe'].includes(normalizedRole) ? ['export', 'stream', 'optimized', 'filtered'] : [],
      description: 'Export seulement avec filtres',
      maxFileSize: '20MB',
      maxRowsPerImport: 10000
    },
    'opérateur': {
      allowed: ['operateur'].includes(normalizedRole) ? ['export'] : [],
      description: 'Export limité (pas d\'import)',
      maxFileSize: '10MB',
      maxRowsPerImport: 0 // Pas d'import
    }
  };
  
  // Trouver les permissions du rôle (avec fallback)
  let userPerms = rolePermissions[normalizedRole];
  
  // Fallback pour les variations de "Chef d'équipe"
  if (!userPerms && (normalizedRole.includes('chef') || normalizedRole.includes('équipe') || normalizedRole.includes('equipe'))) {
    userPerms = rolePermissions['chef d\'équipe'];
  }
  
  // Fallback pour les variations de "Opérateur"
  if (!userPerms && (normalizedRole.includes('opérateur') || normalizedRole.includes('operateur'))) {
    userPerms = rolePermissions['opérateur'];
  }
  
  // 5. VÉRIFIER SI LE RÔLE EST AUTORISÉ
  if (!userPerms) {
    console.log('❌ Rôle non autorisé:', userRole);
    return res.status(403).json({ 
      success: false,
      error: 'Rôle insuffisant',
      message: `Votre rôle "${userRole}" ne vous permet pas d'accéder aux fonctionnalités d'import/export.`,
      requiredRoles: ['Administrateur', 'Superviseur', 'Chef d\'équipe'],
      contact: 'Contactez un administrateur pour obtenir les permissions nécessaires.'
    });
  }
  
  // 6. VÉRIFIER LES PERMISSIONS SPÉCIFIQUES PAR ROUTE
  const routeType = getRouteType(req.url, req.method);
  
  if (!userPerms.allowed.includes('all') && !userPerms.allowed.includes(routeType)) {
    console.log(`❌ Permission refusée: ${userRole} ne peut pas ${routeType}`);
    
    const errorMessage = {
      'bulk-import': 'Les imports massifs sont réservés aux administrateurs et superviseurs.',
      'import': 'Les imports sont réservés aux administrateurs et superviseurs.',
      'smart-sync': 'La synchronisation intelligente est réservée aux administrateurs et superviseurs.',
      'stream': 'L\'export streaming est réservé aux administrateurs, superviseurs et chefs d\'équipe.',
      'optimized': 'L\'export optimisé est réservé aux administrateurs, superviseurs et chefs d\'équipe.',
      'admin': 'Les fonctionnalités d\'administration sont réservées aux administrateurs.'
    };
    
    return res.status(403).json({ 
      success: false,
      error: 'Permission refusée',
      message: errorMessage[routeType] || `Votre rôle (${userRole}) ne vous permet pas d'effectuer cette action.`,
      yourRole: userRole,
      requiredForThisAction: getRequiredRoleForRoute(routeType),
      yourPermissions: userPerms.allowed,
      actionType: routeType
    });
  }
  
  // 7. AJOUTER LES INFORMATIONS DE PERMISSIONS À LA REQUÊTE
  req.userPermissions = {
    role: userRole,
    normalizedRole: normalizedRole,
    allowedActions: userPerms.allowed,
    limits: {
      maxFileSize: userPerms.maxFileSize,
      maxRowsPerImport: userPerms.maxRowsPerImport
    }
  };
  
  console.log(`✅ Accès autorisé: ${userRole} - ${routeType}`);
  next();
};

// ==================== FONCTIONS UTILITAIRES ====================

/**
 * Déterminer le type de route pour les permissions
 */
function getRouteType(url, method) {
  const urlPath = url.toLowerCase();
  
  // Routes bulk import (NOUVEAU)
  if (urlPath.includes('bulk-import')) {
    if (method === 'POST') return 'bulk-import';
    if (method === 'GET' && urlPath.includes('status')) return 'monitoring';
    if (method === 'GET' && urlPath.includes('active')) return 'monitoring';
    if (method === 'GET' && urlPath.includes('stats')) return 'monitoring';
    if (method === 'POST' && urlPath.includes('cancel')) return 'management';
  }
  
  // Routes admin
  if (urlPath.includes('imports-batch') || urlPath.includes('annuler-import')) {
    return 'admin';
  }
  
  // Smart sync
  if (urlPath.includes('smart-sync')) {
    return 'smart-sync';
  }
  
  // Export optimisé
  if (urlPath.includes('optimized')) {
    return 'optimized';
  }
  
  // Import filtered
  if (urlPath.includes('filtered') && method === 'POST') {
    return 'filtered';
  }
  
  // Import standard
  if (urlPath.includes('import') && method === 'POST') {
    return 'import';
  }
  
  // Export streaming
  if (urlPath.includes('stream')) {
    return 'stream';
  }
  
  // Export (toutes les autres routes GET/POST d'export)
  if (urlPath.includes('export') || 
      urlPath.includes('template') ||
      urlPath.includes('sites') ||
      urlPath.includes('stats')) {
    return 'export';
  }
  
  // Routes de diagnostic et test
  if (urlPath.includes('test-upload') || urlPath.includes('diagnostic')) {
    return 'diagnostic';
  }
  
  return 'unknown';
}

/**
 * Obtenir le rôle requis pour une route
 */
function getRequiredRoleForRoute(routeType) {
  const roleRequirements = {
    'bulk-import': ['Administrateur', 'Superviseur'],
    'import': ['Administrateur', 'Superviseur'],
    'smart-sync': ['Administrateur', 'Superviseur'],
    'stream': ['Administrateur', 'Superviseur', 'Chef d\'équipe'],
    'optimized': ['Administrateur', 'Superviseur', 'Chef d\'équipe'],
    'admin': ['Administrateur'],
    'export': ['Administrateur', 'Superviseur', 'Chef d\'équipe', 'Opérateur'],
    'filtered': ['Administrateur', 'Superviseur'],
    'management': ['Administrateur', 'Superviseur'],
    'monitoring': ['Administrateur', 'Superviseur', 'Chef d\'équipe'],
    'diagnostic': ['Administrateur', 'Superviseur']
  };
  
  return roleRequirements[routeType] || ['Administrateur'];
}

/**
 * Middleware de rate limiting spécifique
 */
const applyRateLimit = (req, res, next) => {
  // Vérifier si l'utilisateur a des permissions spéciales
  const userRole = req.user?.role || req.user?.Role;
  const routeType = getRouteType(req.url, req.method);
  
  // Ne pas appliquer le rate limiting aux administrateurs pour certaines routes
  if (userRole === 'Administrateur') {
    if (routeType === 'diagnostic' || routeType === 'monitoring') {
      return next();
    }
  }
  
  // Appliquer le rate limiting
  return importExportLimiter(req, res, next);
};

// ==================== MIDDLEWARE DE JOURNALISATION ====================

const logImportExportAccess = (req, res, next) => {
  const startTime = Date.now();
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
  
  // Stocker l'ID de requête pour le suivi
  req.requestId = requestId;
  
  // Journaliser la requête
  console.log('📨 Requête import/export:', {
    id: requestId,
    method: req.method,
    url: req.url,
    user: req.user?.nomUtilisateur || req.user?.NomUtilisateur || 'unknown',
    role: req.user?.role || req.user?.Role || 'unknown',
    ip: req.ip,
    timestamp: new Date().toISOString()
  });
  
  // Surcharger res.json pour capturer la réponse
  const originalJson = res.json;
  res.json = function(data) {
    const duration = Date.now() - startTime;
    
    // Journaliser seulement les requêtes importantes ou lentes
    const isImportant = duration > 1000 || 
                       res.statusCode >= 400 || 
                       req.url.includes('bulk-import') ||
                       req.url.includes('export/stream');
    
    if (isImportant) {
      console.log('📤 Réponse import/export:', {
        id: requestId,
        status: res.statusCode,
        duration: `${duration}ms`,
        success: data?.success || false,
        rowsExported: data?.stats?.exported || data?.stats?.imported || 0,
        user: req.user?.nomUtilisateur || req.user?.NomUtilisateur
      });
    }
    
    return originalJson.call(this, data);
  };
  
  next();
};

// ==================== MIDDLEWARE DE VALIDATION ====================

const validateFileUpload = (req, res, next) => {
  // Vérifier seulement pour les routes d'upload
  if (!req.url.includes('import') || req.method !== 'POST') {
    return next();
  }
  
  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'Aucun fichier fourni',
      message: 'Veuillez sélectionner un fichier Excel à importer'
    });
  }
  
  // Vérifier la taille du fichier par rapport aux permissions
  const userPerms = req.userPermissions;
  if (userPerms && userPerms.limits) {
    const maxSizeMB = parseInt(userPerms.limits.maxFileSize);
    const fileSizeMB = req.file.size / 1024 / 1024;
    
    if (fileSizeMB > maxSizeMB) {
      console.log('❌ Fichier trop volumineux:', {
        fileSize: `${fileSizeMB.toFixed(2)}MB`,
        maxAllowed: `${maxSizeMB}MB`,
        user: req.user?.nomUtilisateur
      });
      
      return res.status(400).json({
        success: false,
        error: 'Fichier trop volumineux',
        message: `La taille maximale autorisée pour votre rôle est de ${maxSizeMB}MB`,
        fileSize: `${fileSizeMB.toFixed(2)}MB`,
        maxAllowed: `${maxSizeMB}MB`,
        advice: 'Divisez votre fichier en plusieurs parties ou contactez un administrateur'
      });
    }
  }
  
  next();
};

module.exports = {
  importExportAccess,
  importExportRateLimit: applyRateLimit,
  logImportExportAccess,
  validateFileUpload
};