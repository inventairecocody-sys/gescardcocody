// middleware/adminOnly.js
const adminOnly = (req, res, next) => {
    // Vérifier si l'utilisateur est connecté et a le rôle admin
    if (req.user && req.user.role === 'Administrateur') {
        next();
    } else {
        console.log('❌ Accès refusé - Rôle admin requis. Utilisateur:', {
            id: req.user?.id,
            nomUtilisateur: req.user?.nomUtilisateur,
            role: req.user?.role
        });
        
        res.status(403).json({ 
            success: false,
            error: 'Accès réservé aux administrateurs',
            message: 'Vous n\'avez pas les permissions nécessaires pour accéder à cette ressource.'
        });
    }
};

module.exports = adminOnly;