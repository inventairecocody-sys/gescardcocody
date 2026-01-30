// middleware/adminOnly.js
const adminOnly = (req, res, next) => {
    // Récupérer les informations utilisateur avec support des deux cas d'écriture
    const userId = req.user?.id || req.user?.Id;
    const userNom = req.user?.nomUtilisateur || req.user?.NomUtilisateur;
    const userRole = req.user?.role || req.user?.Role;
    const userAgence = req.user?.agence || req.user?.Agence;
    
    // Journaliser la vérification
    console.log('🔐 Vérification adminOnly:', {
        userId: userId,
        user: userNom,
        role: userRole,
        agence: userAgence,
        ip: req.ip,
        endpoint: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
    
    // Vérifier si l'utilisateur est connecté
    if (!req.user) {
        console.log('❌ AdminOnly: Utilisateur non authentifié');
        return res.status(401).json({ 
            success: false,
            error: 'Authentification requise',
            message: 'Vous devez être connecté pour accéder à cette ressource.',
            timestamp: new Date().toISOString()
        });
    }
    
    // Vérifier si l'utilisateur a le rôle admin (insensible à la casse)
    const normalizedRole = userRole ? userRole.toString().trim() : '';
    
    if (normalizedRole === 'Administrateur') {
        console.log(`✅ Accès admin AUTORISÉ pour: ${userNom} (${normalizedRole}) - ${userAgence}`);
        
        // Ajouter les permissions admin à la requête pour référence
        req.userPermissions = {
            ...req.userPermissions,
            isAdmin: true,
            adminAccess: {
                level: 'full',
                canManageSystem: true,
                canManageUsers: true,
                canManageBackups: true,
                canManageJournal: true,
                canManageExports: true
            }
        };
        
        next();
    } else {
        // Journaliser le refus d'accès dans la base de données
        logAdminAccessDenied(req, userNom, normalizedRole, userAgence);
        
        console.log('❌ Accès admin REFUSÉ:', {
            user: userNom,
            role: normalizedRole,
            requiredRole: 'Administrateur',
            ip: req.ip,
            endpoint: req.url,
            timestamp: new Date().toISOString()
        });
        
        res.status(403).json({ 
            success: false,
            error: 'Accès réservé aux administrateurs',
            message: 'Cette fonctionnalité est réservée exclusivement aux administrateurs.',
            details: {
                yourRole: normalizedRole || 'Non défini',
                requiredRole: 'Administrateur',
                endpoint: req.url,
                timestamp: new Date().toISOString()
            },
            advice: [
                'Contactez un administrateur si vous avez besoin d\'accéder à cette fonctionnalité',
                'Les superviseurs peuvent accéder au journal en lecture seule',
                'Les chefs d\'équipe et opérateurs ont des accès limités'
            ],
            permissions: {
                administrateur: [
                    'Accès complet au système',
                    'Gestion des utilisateurs',
                    'Gestion des sauvegardes',
                    'Restauration de base de données',
                    'Configuration système'
                ],
                votre_role: getRolePermissions(normalizedRole)
            }
        });
    }
};

// Fonction pour journaliser les refus d'accès admin
async function logAdminAccessDenied(req, userName, userRole, userAgence) {
    try {
        const db = require('../db/db');
        
        await db.query(`
            INSERT INTO journalactivite (
                utilisateurid, nomutilisateur, nomcomplet, role, agence,
                dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
                actiontype, tablename, recordid, adresseip, userid, detailsaction
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        `, [
            req.user?.id || req.user?.Id,
            userName || 'Unknown',
            userName || 'Unknown',
            userRole || 'Unknown',
            userAgence || 'Unknown',
            new Date(),
            'Tentative accès fonction admin',
            'System',
            req.url,
            req.ip,
            'ADMIN_ACCESS_DENIED',
            'System',
            'admin_access',
            req.ip,
            req.user?.id || req.user?.Id,
            `Tentative d'accès admin refusée - Rôle: ${userRole || 'Non défini'}, Endpoint: ${req.url}`
        ]);
        
    } catch (error) {
        console.warn('⚠️ Impossible de journaliser le refus d\'accès admin:', error.message);
    }
}

// Fonction pour obtenir les permissions par rôle (pour le message d'erreur)
function getRolePermissions(role) {
    const permissions = {
        'Superviseur': [
            'Accès au journal en lecture',
            'Consultation des sauvegardes',
            'Export de données',
            'Gestion limitée des équipes'
        ],
        'Chef d\'équipe': [
            'Gestion des cartes',
            'Recherche avancée',
            'Export limité',
            'Tableau de bord équipe'
        ],
        'Chef d\'equipe': [
            'Gestion des cartes',
            'Recherche avancée',
            'Export limité',
            'Tableau de bord équipe'
        ],
        'Opérateur': [
            'Recherche de cartes',
            'Visualisation des données',
            'Export personnel'
        ],
        'Operateur': [
            'Recherche de cartes',
            'Visualisation des données',
            'Export personnel'
        ]
    };
    
    return permissions[role] || ['Permissions non définies'];
}

// Middleware pour vérifier les permissions spécifiques
adminOnly.checkPermission = (permission) => {
    return (req, res, next) => {
        // Vérifier d'abord que c'est un admin
        const userRole = req.user?.role || req.user?.Role;
        
        if (userRole !== 'Administrateur') {
            return res.status(403).json({
                success: false,
                error: 'Permission insuffisante',
                message: `La permission "${permission}" est réservée aux administrateurs.`,
                requiredRole: 'Administrateur',
                yourRole: userRole || 'Non défini'
            });
        }
        
        // Ici vous pourriez ajouter des vérifications de permissions plus fines
        // Par exemple: 'manage_users', 'manage_backups', 'system_config', etc.
        
        console.log(`✅ Permission "${permission}" accordée à ${req.user?.nomUtilisateur || req.user?.NomUtilisateur}`);
        next();
    };
};

// Fonction utilitaire pour vérifier si un utilisateur est admin
adminOnly.isAdmin = (user) => {
    if (!user) return false;
    const role = user.role || user.Role;
    return role === 'Administrateur';
};

// Fonction pour obtenir le niveau d'accès
adminOnly.getAccessLevel = (user) => {
    if (!user) return 'none';
    
    const role = user.role || user.Role;
    
    const accessLevels = {
        'Administrateur': 'full',
        'Superviseur': 'limited',
        'Chef d\'équipe': 'team',
        'Chef d\'equipe': 'team',
        'Opérateur': 'basic',
        'Operateur': 'basic'
    };
    
    return accessLevels[role] || 'none';
};

module.exports = adminOnly;