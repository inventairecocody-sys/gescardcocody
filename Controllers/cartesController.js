const { poolPromise, sql } = require('../db/db');
const journalController = require('./journalController');

// 🔹 METTRE À JOUR UNE CARTE - CORRIGÉ
exports.updateCarte = async (req, res) => {
    const transaction = new sql.Transaction(await poolPromise);
    
    try {
        await transaction.begin();
        const carte = req.body;
        const carteId = req.params.id;

        console.log('🔄 updateCarte - Début ID:', carteId);

        // Récupérer l'ancienne valeur avant modification
        const oldRequest = new sql.Request(transaction);
        oldRequest.input('id', sql.Int, carteId);
        const ancienneCarte = await oldRequest.query(`
            SELECT * FROM Cartes WHERE ID = @id
        `);

        if (ancienneCarte.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: "Carte non trouvée" });
        }

        // ✅ CORRECTION : Vérification des rôles insensible à la casse
        const userRole = (req.user.role || "").toLowerCase();
        let canUpdateAll = ["administrateur", "superviseur", "chef d'équipe", "chef d'equipe"]
            .some(role => userRole.includes(role));
        let canUpdateLimited = userRole.includes("opérateur") || userRole.includes("operateur");

        const request = new sql.Request(transaction);
        request.input('id', sql.Int, carteId);

        if (canUpdateAll) {
            // Toutes les colonnes modifiables
            request.input('lieuEnrolement', sql.NVarChar(255), carte["LIEU D'ENROLEMENT"] || '');
            request.input('siteRetrait', sql.NVarChar(255), carte["SITE DE RETRAIT"] || '');
            request.input('rangement', sql.NVarChar(100), carte.RANGEMENT || '');
            request.input('nom', sql.NVarChar(100), carte.NOM || '');
            request.input('prenoms', sql.NVarChar(100), carte.PRENOMS || '');
            request.input('dateNaissance', sql.NVarChar(50), carte["DATE DE NAISSANCE"] || '');
            request.input('lieuNaissance', sql.NVarChar(100), carte["LIEU NAISSANCE"] || '');
            request.input('contact', sql.NVarChar(50), carte.CONTACT || '');
            request.input('delivrance', sql.NVarChar(100), carte.DELIVRANCE || '');
            request.input('contactRetrait', sql.NVarChar(50), carte["CONTACT DE RETRAIT"] || '');
            request.input('dateDelivrance', sql.NVarChar(50), carte["DATE DE DELIVRANCE"] || '');
        } else if (canUpdateLimited) {
            // Opérateurs: seulement 3 colonnes modifiables
            request.input('delivrance', sql.NVarChar(100), carte.DELIVRANCE || '');
            request.input('contactRetrait', sql.NVarChar(50), carte["CONTACT DE RETRAIT"] || '');
            request.input('dateDelivrance', sql.NVarChar(50), carte["DATE DE DELIVRANCE"] || '');
        } else {
            await transaction.rollback();
            return res.status(403).json({ success: false, message: "Non autorisé" });
        }

        // Construction de la requête UPDATE selon rôle
        let updateQuery = "UPDATE Cartes SET ";
        if (canUpdateAll) {
            updateQuery += `
                [LIEU D'ENROLEMENT]=@lieuEnrolement,
                [SITE DE RETRAIT]=@siteRetrait,
                RANGEMENT=@rangement,
                NOM=@nom,
                PRENOMS=@prenoms,
                [DATE DE NAISSANCE]=@dateNaissance,
                [LIEU NAISSANCE]=@lieuNaissance,
                CONTACT=@contact,
                DELIVRANCE=@delivrance,
                [CONTACT DE RETRAIT]=@contactRetrait,
                [DATE DE DELIVRANCE]=@dateDelivrance
            `;
        } else if (canUpdateLimited) {
            updateQuery += `
                DELIVRANCE=@delivrance,
                [CONTACT DE RETRAIT]=@contactRetrait,
                [DATE DE DELIVRANCE]=@dateDelivrance
            `;
        }

        updateQuery += " WHERE ID=@id";
        const result = await request.query(updateQuery);

        console.log('📊 updateCarte - Lignes affectées:', result.rowsAffected[0]);

        if (result.rowsAffected[0] === 0) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: "Aucune modification effectuée" });
        }

        // Récupérer la nouvelle valeur après modification
        const newRequest = new sql.Request(transaction);
        newRequest.input('id', sql.Int, carteId);
        const nouvelleCarte = await newRequest.query(`
            SELECT * FROM Cartes WHERE ID = @id
        `);

        // JOURNALISATION
        await journalController.logAction({
            utilisateurId: req.user.id,
            nomUtilisateur: req.user.nomUtilisateur,
            nomComplet: req.user.nomComplet,
            role: req.user.role,
            agence: req.user.agence,
            actionType: 'MODIFICATION_CARTE',
            tableName: 'Cartes',
            recordId: carteId.toString(),
            oldValue: JSON.stringify(ancienneCarte.recordset[0]),
            newValue: JSON.stringify(nouvelleCarte.recordset[0]),
            ip: req.ip,
            details: `Modification carte ID ${carteId} - ${carte.NOM} ${carte.PRENOMS}`
        });

        await transaction.commit();
        
        console.log('✅ updateCarte - Succès ID:', carteId);
        res.json({ 
            success: true, 
            message: "Carte mise à jour ✅",
            carteId: carteId
        });

    } catch (err) {
        await transaction.rollback();
        console.error('❌ Erreur updateCarte ID:', req.params.id, ':', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Erreur serveur: " + err.message 
        });
    }
};

// 🔹 OBTENIR TOUTES LES CARTES
exports.getAllCartes = async (req, res) => {
    try {
        const { page = 1, limit = 100 } = req.query;
        const offset = (page - 1) * limit;

        const pool = await poolPromise;

        const result = await pool.request()
            .query(`
                SELECT 
                    [LIEU D'ENROLEMENT],
                    [SITE DE RETRAIT],
                    RANGEMENT,
                    NOM,
                    PRENOMS,
                    [DATE DE NAISSANCE],
                    [LIEU NAISSANCE],
                    CONTACT,
                    DELIVRANCE,
                    [CONTACT DE RETRAIT],
                    [DATE DE DELIVRANCE],
                    ID
                FROM Cartes 
                ORDER BY ID 
                OFFSET ${offset} ROWS 
                FETCH NEXT ${limit} ROWS ONLY
            `);

        const countResult = await pool.request()
            .query('SELECT COUNT(*) as total FROM Cartes');

        const total = countResult.recordset[0].total;
        const totalPages = Math.ceil(total / limit);

        res.json({
            cartes: result.recordset,
            total: total,
            page: parseInt(page),
            totalPages: totalPages,
            limit: parseInt(limit)
        });
    } catch (err) {
        console.error('❌ Erreur getAllCartes:', err);
        res.status(500).json({ 
            success: false,
            message: err.message 
        });
    }
};

// 🔹 OBTENIR UNE CARTE PAR ID
exports.getCarteById = async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('ID', sql.Int, req.params.id)
            .query(`
                SELECT * FROM Cartes WHERE ID = @ID
            `);

        if (result.recordset.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'Carte non trouvée' 
            });
        }

        res.json({
            success: true,
            carte: result.recordset[0]
        });
    } catch (err) {
        console.error('❌ Erreur getCarteById:', err);
        res.status(500).json({ 
            success: false,
            message: err.message 
        });
    }
};

// 🔹 CRÉER UNE NOUVELLE CARTE
exports.createCarte = async (req, res) => {
    const transaction = new sql.Transaction(await poolPromise);
    
    try {
        await transaction.begin();
        const carte = req.body;

        const request = new sql.Request(transaction);
        request.input('lieuEnrolement', sql.NVarChar(255), carte["LIEU D'ENROLEMENT"] || '');
        request.input('siteRetrait', sql.NVarChar(255), carte["SITE DE RETRAIT"] || '');
        request.input('rangement', sql.NVarChar(100), carte.RANGEMENT || '');
        request.input('nom', sql.NVarChar(100), carte.NOM || '');
        request.input('prenoms', sql.NVarChar(100), carte.PRENOMS || '');
        request.input('dateNaissance', sql.NVarChar(50), carte["DATE DE NAISSANCE"] || '');
        request.input('lieuNaissance', sql.NVarChar(100), carte["LIEU NAISSANCE"] || '');
        request.input('contact', sql.NVarChar(50), carte.CONTACT || '');
        request.input('delivrance', sql.NVarChar(100), carte.DELIVRANCE || '');
        request.input('contactRetrait', sql.NVarChar(50), carte["CONTACT DE RETRAIT"] || '');
        request.input('dateDelivrance', sql.NVarChar(50), carte["DATE DE DELIVRANCE"] || '');

        const result = await request.query(`
            INSERT INTO Cartes (
                [LIEU D'ENROLEMENT], [SITE DE RETRAIT], RANGEMENT, 
                NOM, PRENOMS, [DATE DE NAISSANCE], [LIEU NAISSANCE], 
                CONTACT, DELIVRANCE, [CONTACT DE RETRAIT], [DATE DE DELIVRANCE]
            ) 
            OUTPUT INSERTED.ID
            VALUES (
                @lieuEnrolement, @siteRetrait, @rangement,
                @nom, @prenoms, @dateNaissance, @lieuNaissance,
                @contact, @delivrance, @contactRetrait, @dateDelivrance
            )
        `);

        const newId = result.recordset[0].ID;

        // JOURNALISATION
        await journalController.logAction({
            utilisateurId: req.user.id,
            nomUtilisateur: req.user.nomUtilisateur,
            nomComplet: req.user.nomComplet,
            role: req.user.role,
            agence: req.user.agence,
            actionType: 'CREATION_CARTE',
            tableName: 'Cartes',
            recordId: newId.toString(),
            oldValue: null,
            newValue: JSON.stringify(carte),
            ip: req.ip,
            details: `Création nouvelle carte - ${carte.NOM} ${carte.PRENOMS}`
        });

        await transaction.commit();
        
        console.log('✅ createCarte - Succès ID:', newId);
        res.json({ 
            success: true, 
            message: "Carte créée avec succès ✅",
            id: newId
        });

    } catch (err) {
        await transaction.rollback();
        console.error('❌ Erreur createCarte:', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Erreur serveur: " + err.message 
        });
    }
};

// 🔹 SUPPRIMER UNE CARTE
exports.deleteCarte = async (req, res) => {
    const transaction = new sql.Transaction(await poolPromise);
    
    try {
        await transaction.begin();
        const carteId = req.params.id;

        // Récupérer la carte avant suppression pour la journalisation
        const oldRequest = new sql.Request(transaction);
        oldRequest.input('id', sql.Int, carteId);
        const ancienneCarte = await oldRequest.query(`
            SELECT * FROM Cartes WHERE ID = @id
        `);

        if (ancienneCarte.recordset.length === 0) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: "Carte non trouvée" });
        }

        const deleteRequest = new sql.Request(transaction);
        deleteRequest.input('id', sql.Int, carteId);
        const result = await deleteRequest.query(`
            DELETE FROM Cartes WHERE ID = @id
        `);

        if (result.rowsAffected[0] === 0) {
            await transaction.rollback();
            return res.status(404).json({ success: false, message: "Aucune carte supprimée" });
        }

        // JOURNALISATION
        await journalController.logAction({
            utilisateurId: req.user.id,
            nomUtilisateur: req.user.nomUtilisateur,
            nomComplet: req.user.nomComplet,
            role: req.user.role,
            agence: req.user.agence,
            actionType: 'SUPPRESSION_CARTE',
            tableName: 'Cartes',
            recordId: carteId.toString(),
            oldValue: JSON.stringify(ancienneCarte.recordset[0]),
            newValue: null,
            ip: req.ip,
            details: `Suppression carte ID ${carteId} - ${ancienneCarte.recordset[0].NOM} ${ancienneCarte.recordset[0].PRENOMS}`
        });

        await transaction.commit();
        
        console.log('✅ deleteCarte - Succès ID:', carteId);
        res.json({ 
            success: true, 
            message: "Carte supprimée avec succès ✅"
        });

    } catch (err) {
        await transaction.rollback();
        console.error('❌ Erreur deleteCarte ID:', req.params.id, ':', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Erreur serveur: " + err.message 
        });
    }
};

// 🔹 OBTENIR LES STATISTIQUES
exports.getStatistiques = async (req, res) => {
    try {
        const pool = await poolPromise;

        // Total des cartes
        const totalResult = await pool.request()
            .query('SELECT COUNT(*) as total FROM Cartes');

        // Cartes retirées (avec DELIVRANCE non vide)
        const retiresResult = await pool.request()
            .query(`SELECT COUNT(*) as retires FROM Cartes WHERE DELIVRANCE IS NOT NULL AND DELIVRANCE != ''`);

        // Statistiques par site
        const sitesResult = await pool.request()
            .query(`
                SELECT 
                    [SITE DE RETRAIT] as site,
                    COUNT(*) as total,
                    SUM(CASE WHEN DELIVRANCE IS NOT NULL AND DELIVRANCE != '' THEN 1 ELSE 0 END) as retires
                FROM Cartes 
                WHERE [SITE DE RETRAIT] IS NOT NULL AND [SITE DE RETRAIT] != ''
                GROUP BY [SITE DE RETRAIT]
                ORDER BY total DESC
            `);

        const total = totalResult.recordset[0].total;
        const retires = retiresResult.recordset[0].retires;
        const restants = total - retires;

        // Formatage des statistiques par site
        const parSite = {};
        sitesResult.recordset.forEach(site => {
            parSite[site.site] = {
                total: site.total,
                retires: site.retires,
                restants: site.total - site.retires
            };
        });

        res.json({
            success: true,
            total: total,
            retires: retires,
            disponibles: restants,
            parSite: parSite
        });

    } catch (err) {
        console.error('❌ Erreur getStatistiques:', err);
        res.status(500).json({ 
            success: false,
            message: err.message 
        });
    }
};