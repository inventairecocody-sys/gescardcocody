const rateLimit = require('express-rate-limit');

// Configuration du rate limiting spécifique
const importExportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req) => {
    // Limites adaptatives selon le rôle
    const userRole = req.user?.role || req.user?.Role;
    if (userRole === 'Administrateur') return 200;
    if (userRole === 'Superviseur') return 100;
    return 50; // Chef d'équipe et autres
  },
  message: {
    success: false,
    error: 'Trop de requêtes d\'import/export',
    message: 'Veuillez réessayer dans 15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Ne pas appliquer aux routes de santé
    return req.url.includes('/health') || req.url.includes('/test-db');
  }
});

const importExportAccess = (req, res, next) => {
    // 1. VÉRIFIER LE TOKEN D'API EXTERNE (si présent)
    const apiToken = req.headers['x-api-token'] || req.headers['authorization'];
    const externalToken = process.env.EXTERNAL_API_TOKEN;
    
    if (apiToken && externalToken && apiToken === `Bearer ${externalToken}`) {
        console.log('🔑 Accès API externe autorisé');
        return next(); // Bypass les vérifications de rôle
    }
    
    // 2. VÉRIFIER L'AUTHENTIFICATION UTILISATEUR
    if (!req.user) {
        console.log('❌ Utilisateur non authentifié');
        return res.status(401).json({ 
            success: false,
            error: 'Authentification requise'
        });
    }
    
    // 3. RÉCUPÉRER LE RÔLE
    const userRole = req.user?.role || req.user?.Role || req.headers['x-user-role'];
    
    console.log('🔍 Vérification accès import/export:', {
        userRole: userRole,
        method: req.method,
        url: req.url,
        user: req.user?.nomUtilisateur || req.user?.NomUtilisateur
    });
    
    // 4. DÉFINIR LES PERMISSIONS PAR RÔLE
    const rolePermissions = {
        'Administrateur': {
            allowed: ['import', 'export', 'smart-sync', 'filtered', 'admin', 'stream'],
            description: 'Accès complet'
        },
        'Superviseur': {
            allowed: ['import', 'export', 'filtered', 'stream'],
            description: 'Import/export standard'
        },
        'Chef d\'équipe': {
            allowed: ['export', 'stream'],
            description: 'Export seulement'
        }
    };
    
    // 5. VÉRIFIER SI LE RÔLE EST AUTORISÉ
    if (!userRole || !rolePermissions[userRole]) {
        console.log('❌ Rôle non autorisé:', userRole);
        return res.status(403).json({ 
            success: false,
            error: 'Rôle insuffisant',
            message: 'Votre rôle ne vous permet pas d\'accéder à cette fonctionnalité.'
        });
    }
    
    // 6. VÉRIFIER LES PERMISSIONS SPÉCIFIQUES PAR ROUTE
    const routeType = getRouteType(req.url, req.method);
    const userPerms = rolePermissions[userRole];
    
    if (!userPerms.allowed.includes(routeType)) {
        console.log(`❌ Permission refusée: ${userRole} ne peut pas ${routeType}`);
        return res.status(403).json({ 
            success: false,
            error: 'Permission refusée',
            message: `Votre rôle (${userRole}) ne vous permet pas d'effectuer cette action.`
        });
    }
    
    console.log(`✅ Accès autorisé: ${userRole} - ${routeType}`);
    next();
};

// Fonction utilitaire pour déterminer le type de route
function getRouteType(url, method) {
    const urlPath = url.toLowerCase();
    
    // Routes admin
    if (urlPath.includes('imports-batch') || urlPath.includes('annuler-import')) {
        return 'admin';
    }
    
    // Smart sync
    if (urlPath.includes('smart-sync')) {
        return 'smart-sync';
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
    
    return 'unknown';
}

// Middleware de rate limiting spécifique
const applyRateLimit = (req, res, next) => {
    // Ne pas appliquer le rate limiting pour les administrateurs
    const userRole = req.user?.role || req.user?.Role;
    if (userRole === 'Administrateur') {
        return next();
    }
    
    // Appliquer le rate limiting pour les autres rôles
    return importExportLimiter(req, res, next);
};

module.exports = {
    importExportAccess,
    importExportRateLimit: applyRateLimit
};