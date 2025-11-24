// middleware/importExportAccess.js
const importExportAccess = (req, res, next) => {
    // Administrateurs, Superviseurs et Chefs d'équipe peuvent importer/exporter
    const allowedRoles = ['Administrateur', 'Superviseur', 'Chef d\'équipe'];
    
    // Essayer de récupérer le rôle de différentes manières
    const userRole = req.user?.role || req.headers['x-user-role'];
    
    console.log('🔍 Vérification accès import/export:', {
        userRole: userRole,
        method: req.method,
        url: req.url
    });
    
    if (userRole && allowedRoles.includes(userRole)) {
        console.log('✅ Accès import/export autorisé pour:', userRole);
        next();
    } else {
        console.log('❌ Accès import/export refusé - Rôle:', userRole);
        
        res.status(403).json({ 
            success: false,
            error: 'Accès non autorisé',
            message: 'L\'import/export est réservé aux administrateurs, superviseurs et chefs d\'équipe.'
        });
    }
};

module.exports = importExportAccess;