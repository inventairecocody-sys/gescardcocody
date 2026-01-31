// middleware/adminOnly.js
const db = require('../db/db');

// Configuration des rôles
const ROLE_CONFIG = {
    ADMIN: 'Administrateur',
    SUPERVISOR: 'Superviseur',
    TEAM_LEAD: 'Chef d\'équipe',
    OPERATOR: 'Opérateur'
};

// Permissions par rôle
const ROLE_PERMISSIONS = {
    [ROLE_CONFIG.ADMIN]: {
        level: 'full',
        permissions: [
            'manage_users',
            'manage_backups',
            'manage_journal',
            'manage_exports',
            'system_config',
            'view_all_data',
            'delete_data',
            'restore_data'
        ]
    },
    [ROLE_CONFIG.SUPERVISOR]: {
        level: 'limited',
        permissions: [
            'view_journal',
            'view_backups',
            'export_data',
            'view_team_data'
        ]
    },
    [ROLE_CONFIG.TEAM_LEAD]: {
        level: 'team',
        permissions: [
            'manage_cards',
            'advanced_search',
            'limited_export',
            'team_dashboard'
        ]
    },
    [ROLE_CONFIG.OPERATOR]: {
        level: 'basic',
        permissions: [
            'search_cards',
            'view_data',
            'personal_export'
        ]
    }
};

const adminOnly = (req, res, next) => {
    try {
        // Récupérer et normaliser les données utilisateur
        const user = normalizeUserData(req.user);
        
        // Journaliser la vérification
        logAccessCheck(req, user);
        
        // Vérifier si l'utilisateur est connecté
        if (!user.id) {
            console.log('❌ AdminOnly: Utilisateur non authentifié');
            return sendUnauthorizedResponse(res, {
                endpoint: req.url,
                method: req.method
            });
        }
        
        // Vérifier si l'utilisateur est administrateur
        if (user.role === ROLE_CONFIG.ADMIN) {
            console.log(`✅ Accès admin AUTORISÉ pour: ${user.nomUtilisateur} (${user.role})`);
            
            // Ajouter les permissions admin à la requête
            enhanceRequestWithPermissions(req, user);
            
            next();
        } else {
            // Journaliser et refuser l'accès
            handleAccessDenied(req, res, user);
        }
    } catch (error) {
        console.error('❌ Erreur dans middleware adminOnly:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur de vérification des permissions',
            message: 'Une erreur est survenue lors de la vérification de vos permissions.',
            timestamp: new Date().toISOString()
        });
    }
};

// ==================== FONCTIONS UTILITAIRES ====================

// Normaliser les données utilisateur
function normalizeUserData(userData) {
    if (!userData) return {};
    
    return {
        id: userData.id || userData.Id,
        nomUtilisateur: userData.nomUtilisateur || userData.NomUtilisateur,
        nomComplet: userData.nomComplet || userData.NomComplet,
        role: (userData.role || userData.Role || '').toString().trim(),
        agence: userData.agence || userData.Agence,
        email: userData.email || userData.Email
    };
}

// Journaliser la vérification d'accès
function logAccessCheck(req, user) {
    console.log('🔐 Vérification adminOnly:', {
        userId: user.id,
        user: user.nomUtilisateur,
        role: user.role,
        agence: user.agence,
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress,
        endpoint: req.originalUrl || req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
}

// Réponse non autorisée
function sendUnauthorizedResponse(res, context) {
    return res.status(401).json({
        success: false,
        error: 'Authentification requise',
        message: 'Vous devez être connecté pour accéder à cette ressource.',
        details: {
            timestamp: new Date().toISOString(),
            ...context
        }
    });
}

// Améliorer la requête avec les permissions
function enhanceRequestWithPermissions(req, user) {
    req.userPermissions = {
        isAdmin: true,
        accessLevel: ROLE_PERMISSIONS[user.role]?.level || 'none',
        permissions: ROLE_PERMISSIONS[user.role]?.permissions || [],
        userDetails: user
    };
    
    // Ajouter les informations utilisateur normalisées
    req.normalizedUser = user;
}

// Gérer l'accès refusé
async function handleAccessDenied(req, res, user) {
    // Journaliser dans la base de données
    await logAccessDeniedToDatabase(req, user);
    
    // Journaliser dans la console
    console.log('❌ Accès admin REFUSÉ:', {
        user: user.nomUtilisateur,
        role: user.role,
        requiredRole: ROLE_CONFIG.ADMIN,
        endpoint: req.originalUrl || req.url,
        timestamp: new Date().toISOString()
    });
    
    // Construire la réponse
    const response = buildAccessDeniedResponse(req, user);
    
    res.status(403).json(response);
}

// Journaliser le refus d'accès dans la base de données
async function logAccessDeniedToDatabase(req, user) {
    try {
        await db.query(`
            INSERT INTO journalactivite (
                utilisateurid, nomutilisateur, nomcomplet, role, agence,
                dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
                actiontype, tablename, recordid, adresseip, userid, detailsaction
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            RETURNING journalid
        `, [
            user.id,
            user.nomUtilisateur || 'Inconnu',
            user.nomComplet || 'Inconnu',
            user.role || 'Inconnu',
            user.agence || 'Inconnu',
            new Date(),
            'Tentative d\'accès à une fonctionnalité administrateur',
            'System',
            req.originalUrl || req.url,
            getClientIp(req),
            'ADMIN_ACCESS_DENIED',
            'System',
            'admin_access',
            getClientIp(req),
            user.id,
            JSON.stringify({
                message: 'Tentative d\'accès refusée',
                userRole: user.role,
                requiredRole: ROLE_CONFIG.ADMIN,
                endpoint: req.originalUrl || req.url,
                method: req.method,
                userAgent: req.headers['user-agent']
            })
        ]);
        
        console.log('📝 Refus d\'accès journalisé avec succès');
    } catch (error) {
        console.warn('⚠️ Impossible de journaliser le refus d\'accès:', error.message);
        // Ne pas bloquer le flux en cas d'erreur de journalisation
    }
}

// Construire la réponse d'accès refusé
function buildAccessDeniedResponse(req, user) {
    const userPermissions = ROLE_PERMISSIONS[user.role] || { level: 'none', permissions: [] };
    
    return {
        success: false,
        error: 'Accès réservé aux administrateurs',
        message: 'Cette fonctionnalité est réservée exclusivement aux administrateurs.',
        details: {
            votreRole: user.role || 'Non défini',
            roleRequis: ROLE_CONFIG.ADMIN,
            endpoint: req.originalUrl || req.url,
            timestamp: new Date().toISOString(),
            votreNiveauAcces: userPermissions.level
        },
        conseils: [
            'Contactez un administrateur si vous avez besoin d\'accéder à cette fonctionnalité',
            `En tant que ${user.role}, vous avez accès aux fonctionnalités de niveau "${userPermissions.level}"`,
            'Les demandes d\'accès spécial doivent être approuvées par un administrateur'
        ],
        permissions: {
            administrateur: {
                niveau: ROLE_PERMISSIONS[ROLE_CONFIG.ADMIN].level,
                permissions: ROLE_PERMISSIONS[ROLE_CONFIG.ADMIN].permissions
            },
            votreRole: {
                niveau: userPermissions.level,
                permissions: userPermissions.permissions
            }
        },
        documentation: {
            guidePermissions: '/api/documentation/permissions',
            contactAdmin: '/api/help/contact-admin',
            demandeAcces: '/api/access/request'
        }
    };
}

// Obtenir l'adresse IP du client
function getClientIp(req) {
    return req.ip || 
           req.headers['x-forwarded-for'] || 
           req.connection.remoteAddress || 
           '0.0.0.0';
}

// ==================== FONCTIONS EXPORTÉES ====================

// Middleware pour vérifier des permissions spécifiques
adminOnly.checkPermission = (permission) => {
    return (req, res, next) => {
        try {
            const user = normalizeUserData(req.user);
            
            if (user.role !== ROLE_CONFIG.ADMIN) {
                return res.status(403).json({
                    success: false,
                    error: 'Permission insuffisante',
                    message: `La permission "${permission}" est réservée aux administrateurs.`,
                    details: {
                        permissionRequis: permission,
                        votreRole: user.role,
                        roleRequis: ROLE_CONFIG.ADMIN
                    }
                });
            }
            
            console.log(`✅ Permission "${permission}" accordée à ${user.nomUtilisateur}`);
            next();
        } catch (error) {
            console.error('❌ Erreur dans checkPermission:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur de vérification de permission'
            });
        }
    };
};

// Vérifier si un utilisateur est admin
adminOnly.isAdmin = (userData) => {
    const user = normalizeUserData(userData);
    return user.role === ROLE_CONFIG.ADMIN;
};

// Obtenir le niveau d'accès d'un utilisateur
adminOnly.getAccessLevel = (userData) => {
    const user = normalizeUserData(userData);
    return ROLE_PERMISSIONS[user.role]?.level || 'none';
};

// Obtenir les permissions d'un utilisateur
adminOnly.getUserPermissions = (userData) => {
    const user = normalizeUserData(userData);
    return ROLE_PERMISSIONS[user.role]?.permissions || [];
};

// Vérifier si un utilisateur a une permission spécifique
adminOnly.hasPermission = (userData, permission) => {
    const user = normalizeUserData(userData);
    const permissions = ROLE_PERMISSIONS[user.role]?.permissions || [];
    return permissions.includes(permission);
};

// Obtenir la configuration des rôles (pour le frontend)
adminOnly.getRoleConfig = () => {
    return {
        roles: Object.values(ROLE_CONFIG),
        permissions: ROLE_PERMISSIONS,
        hierarchy: {
            [ROLE_CONFIG.ADMIN]: 4,
            [ROLE_CONFIG.SUPERVISOR]: 3,
            [ROLE_CONFIG.TEAM_LEAD]: 2,
            [ROLE_CONFIG.OPERATOR]: 1
        }
    };
};

// Middleware pour vérifier le niveau d'accès minimum
adminOnly.minimumAccessLevel = (requiredLevel) => {
    const levelHierarchy = {
        'none': 0,
        'basic': 1,
        'team': 2,
        'limited': 3,
        'full': 4
    };
    
    return (req, res, next) => {
        try {
            const user = normalizeUserData(req.user);
            const userLevel = adminOnly.getAccessLevel(user);
            
            if (levelHierarchy[userLevel] >= levelHierarchy[requiredLevel]) {
                console.log(`✅ Niveau d'accès ${userLevel} suffisant pour ${requiredLevel}`);
                next();
            } else {
                res.status(403).json({
                    success: false,
                    error: 'Niveau d\'accès insuffisant',
                    message: `Cette fonctionnalité nécessite un niveau d'accès minimum: ${requiredLevel}`,
                    details: {
                        votreNiveau: userLevel,
                        niveauRequis: requiredLevel,
                        hierarchy: levelHierarchy
                    }
                });
            }
        } catch (error) {
            console.error('❌ Erreur dans minimumAccessLevel:', error);
            res.status(500).json({
                success: false,
                error: 'Erreur de vérification du niveau d\'accès'
            });
        }
    };
};

module.exports = adminOnly;