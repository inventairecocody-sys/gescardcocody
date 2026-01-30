const journalAccess = (req, res, next) => {
    // On récupère le rôle peu importe la casse (Role, role, ROLE…)
    const role = req.user?.Role || req.user?.role || '';
    const userId = req.user?.id || req.user?.Id || 'unknown';
    const userNom = req.user?.NomUtilisateur || req.user?.nomUtilisateur || 'unknown';
    const userAgence = req.user?.Agence || req.user?.agence || 'unknown';

    console.log("🕵️‍♂️ Vérification accès journal →", { 
        user: userNom, 
        userId: userId,
        role: role,
        agence: userAgence,
        ip: req.ip,
        endpoint: req.url,
        timestamp: new Date().toISOString()
    });

    // ✅ AUTORISER SEULEMENT ADMINISTRATEURS ET SUPERVISEURS
    const authorizedRoles = ['Administrateur', 'Superviseur'];
    
    // Normaliser le rôle (insensible à la casse, trim)
    const normalizedRole = role.toString().trim();
    
    // Vérifier si le rôle est autorisé
    if (authorizedRoles.includes(normalizedRole)) {
        console.log(`✅ Accès journal AUTORISÉ pour: ${userNom} (${normalizedRole}) - ${userAgence}`);
        
        // Ajouter les permissions dans la requête pour le frontend
        req.userPermissions = {
            journal: {
                access: true,
                role: normalizedRole,
                canView: true,
                canUndoActions: true,
                canCancelImports: normalizedRole === 'Administrateur', // Seulement admin
                level: normalizedRole === 'Administrateur' ? 'full' : 'view_only'
            },
            backup: {
                canView: true,
                canCreate: normalizedRole === 'Administrateur', // Seulement admin
                canRestore: normalizedRole === 'Administrateur', // Seulement admin
                canDownload: normalizedRole === 'Administrateur' // Seulement admin
            }
        };
        
        next();
    } else {
        console.log('❌ Accès journal REFUSÉ - Rôle:', normalizedRole, 'Utilisateur:', userNom, 'Agence:', userAgence);
        
        // Journaliser le refus d'accès
        try {
            const db = require('../db/db');
            db.query(`
                INSERT INTO journalactivite (
                    utilisateurid, nomutilisateur, nomcomplet, role, agence,
                    dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
                    actiontype, tablename, recordid, adresseip, userid, detailsaction
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
            `, [
                userId, userNom, userNom, normalizedRole, userAgence,
                new Date(), 'Tentative accès non autorisé au journal', 'Journal', 
                'N/A', req.ip, 'ACCES_REFUSE', 'Journal', userId, req.ip, userId,
                `Tentative d'accès au journal avec rôle: ${normalizedRole}`
            ]);
        } catch (logError) {
            console.warn('⚠️ Impossible de journaliser le refus d\'accès:', logError.message);
        }
        
        res.status(403).json({ 
            success: false,
            error: 'Accès réservé',
            message: 'Le journal d\'activité est réservé aux administrateurs et superviseurs.',
            requiredRoles: authorizedRoles,
            yourRole: normalizedRole,
            timestamp: new Date().toISOString(),
            advice: 'Contactez un administrateur si vous avez besoin d\'accéder au journal.'
        });
    }
};

module.exports = journalAccess;