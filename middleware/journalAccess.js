const journalAccess = (req, res, next) => {
    // On récupère le rôle peu importe la casse (Role, role, ROLE…)
    const role = req.user?.Role || req.user?.role;

    console.log("🕵️‍♂️ Vérification rôle journal →", req.user);
    console.log("➡️ Rôle détecté:", role);

    if (role === 'Administrateur') {
        next();
    } else {
        console.log('❌ Accès journal refusé - Rôle:', role);
        res.status(403).json({ 
            success: false,
            error: 'Accès réservé aux administrateurs',
            message: 'Le journal d\'activité est réservé aux administrateurs.'
        });
    }
};

module.exports = journalAccess;