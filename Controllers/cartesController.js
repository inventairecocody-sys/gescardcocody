const db = require('../db/db');
const journalController = require('./journalController');

// 🎯 CONFIGURATION POUR RENDER GRATUIT
const RENDER_CONFIG = {
  MAX_EXPORT_ROWS: 30000,      // Max pour export direct
  MAX_IMPORT_BATCH: 500,       // Batch d'import réduit
  QUERY_TIMEOUT: 28000,        // 28s (marge de sécurité)
  MEMORY_LIMIT_MB: 400         // Max 400MB sur 512
};

// 🔹 METTRE À JOUR UNE CARTE - OPTIMISÉ POUR POSTGRESQL
exports.updateCarte = async (req, res) => {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        const carte = req.body;
        const carteId = req.params.id;

        console.log('🔄 updateCarte - Début ID:', carteId);

        // Récupérer l'ancienne valeur avant modification
        const ancienneCarte = await client.query(
            `SELECT * FROM cartes WHERE id = $1`,
            [carteId]
        );

        if (ancienneCarte.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: "Carte non trouvée" });
        }

        // ✅ CORRECTION : Vérification des rôles insensible à la casse
        const userRole = (req.user.role || "").toLowerCase();
        let canUpdateAll = ["administrateur", "superviseur", "chef d'équipe", "chef d'equipe"]
            .some(role => userRole.includes(role));
        let canUpdateLimited = userRole.includes("opérateur") || userRole.includes("operateur");

        if (canUpdateAll) {
            // Toutes les colonnes modifiables
            await client.query(`
                UPDATE cartes SET
                    "LIEU D'ENROLEMENT" = $1,
                    "SITE DE RETRAIT" = $2,
                    rangement = $3,
                    nom = $4,
                    prenoms = $5,
                    "DATE DE NAISSANCE" = $6,
                    "LIEU NAISSANCE" = $7,
                    contact = $8,
                    delivrance = $9,
                    "CONTACT DE RETRAIT" = $10,
                    "DATE DE DELIVRANCE" = $11
                WHERE id = $12
            `, [
                carte["LIEU D'ENROLEMENT"] || '',
                carte["SITE DE RETRAIT"] || '',
                carte.RANGEMENT || '',
                carte.NOM || '',
                carte.PRENOMS || '',
                carte["DATE DE NAISSANCE"] || '',
                carte["LIEU NAISSANCE"] || '',
                carte.CONTACT || '',
                carte.DELIVRANCE || '',
                carte["CONTACT DE RETRAIT"] || '',
                carte["DATE DE DELIVRANCE"] || '',
                carteId
            ]);
        } else if (canUpdateLimited) {
            // Opérateurs: seulement 3 colonnes modifiables
            await client.query(`
                UPDATE cartes SET
                    delivrance = $1,
                    "CONTACT DE RETRAIT" = $2,
                    "DATE DE DELIVRANCE" = $3
                WHERE id = $4
            `, [
                carte.DELIVRANCE || '',
                carte["CONTACT DE RETRAIT"] || '',
                carte["DATE DE DELIVRANCE"] || '',
                carteId
            ]);
        } else {
            await client.query('ROLLBACK');
            return res.status(403).json({ success: false, message: "Non autorisé" });
        }

        // Vérifier si des lignes ont été modifiées
        const checkResult = await client.query(
            'SELECT * FROM cartes WHERE id = $1',
            [carteId]
        );

        if (checkResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: "Aucune modification effectuée" });
        }

        // Récupérer la nouvelle valeur après modification
        const nouvelleCarte = await client.query(
            'SELECT * FROM cartes WHERE id = $1',
            [carteId]
        );

        await client.query('COMMIT');

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
            oldValue: JSON.stringify(ancienneCarte.rows[0]),
            newValue: JSON.stringify(nouvelleCarte.rows[0]),
            ip: req.ip,
            details: `Modification carte ID ${carteId} - ${carte.NOM} ${carte.PRENOMS}`
        });
        
        console.log('✅ updateCarte - Succès ID:', carteId);
        res.json({ 
            success: true, 
            message: "Carte mise à jour ✅",
            carteId: carteId
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Erreur updateCarte ID:', req.params.id, ':', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Erreur serveur: " + err.message 
        });
    } finally {
        client.release();
    }
};

// 🔹 OBTENIR UNE CARTE PAR ID - BUG CORRIGÉ
exports.getCarteById = async (req, res) => {
    try {
        // ✅ CORRECTION : WHERE...WHERE → WHERE...AND
        const result = await db.query(
            `SELECT * FROM cartes WHERE id IS NOT NULL AND id = $1`,
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ 
                success: false,
                message: 'Carte non trouvée' 
            });
        }

        res.json({
            success: true,
            carte: result.rows[0]
        });
    } catch (err) {
        console.error('❌ Erreur getCarteById:', err);
        res.status(500).json({ 
            success: false,
            message: err.message 
        });
    }
};

// 🔹 CRÉER UNE NOUVELLE CARTE (inchangé mais optimisé)
exports.createCarte = async (req, res) => {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        const carte = req.body;

        const result = await client.query(`
            INSERT INTO cartes (
                "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, 
                nom, prenoms, "DATE DE NAISSANCE", "LIEU NAISSANCE", 
                contact, delivrance, "CONTACT DE RETRAIT", "DATE DE DELIVRANCE"
            ) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id
        `, [
            carte["LIEU D'ENROLEMENT"] || '',
            carte["SITE DE RETRAIT"] || '',
            carte.RANGEMENT || '',
            carte.NOM || '',
            carte.PRENOMS || '',
            carte["DATE DE NAISSANCE"] || '',
            carte["LIEU NAISSANCE"] || '',
            carte.CONTACT || '',
            carte.DELIVRANCE || '',
            carte["CONTACT DE RETRAIT"] || '',
            carte["DATE DE DELIVRANCE"] || ''
        ]);

        const newId = result.rows[0].id;

        await client.query('COMMIT');

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
        
        console.log('✅ createCarte - Succès ID:', newId);
        res.json({ 
            success: true, 
            message: "Carte créée avec succès ✅",
            id: newId
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Erreur createCarte:', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Erreur serveur: " + err.message 
        });
    } finally {
        client.release();
    }
};

// 🔹 SUPPRIMER UNE CARTE (inchangé)
exports.deleteCarte = async (req, res) => {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        const carteId = req.params.id;

        // Récupérer la carte avant suppression pour la journalisation
        const ancienneCarte = await client.query(
            'SELECT * FROM cartes WHERE id = $1',
            [carteId]
        );

        if (ancienneCarte.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: "Carte non trouvée" });
        }

        const result = await client.query(
            'DELETE FROM cartes WHERE id = $1 RETURNING *',
            [carteId]
        );

        // En PostgreSQL, on vérifie si des lignes ont été retournées
        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: "Aucune carte supprimée" });
        }

        await client.query('COMMIT');

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
            oldValue: JSON.stringify(ancienneCarte.rows[0]),
            newValue: null,
            ip: req.ip,
            details: `Suppression carte ID ${carteId} - ${ancienneCarte.rows[0].nom} ${ancienneCarte.rows[0].prenoms}`
        });
        
        console.log('✅ deleteCarte - Succès ID:', carteId);
        res.json({ 
            success: true, 
            message: "Carte supprimée avec succès ✅"
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('❌ Erreur deleteCarte ID:', req.params.id, ':', err.message);
        res.status(500).json({ 
            success: false, 
            message: "Erreur serveur: " + err.message 
        });
    } finally {
        client.release();
    }
};

// 🔹 OBTENIR LES STATISTIQUES (inchangé)
exports.getStatistiques = async (req, res) => {
    try {
        // Total des cartes
        const totalResult = await db.query('SELECT COUNT(*) as total FROM cartes');

        // Cartes retirées (avec DELIVRANCE non vide)
        const retiresResult = await db.query(
            `SELECT COUNT(*) as retires FROM cartes WHERE delivrance IS NOT NULL AND delivrance != ''`
        );

        // Statistiques par site
        const sitesResult = await db.query(`
            SELECT 
                "SITE DE RETRAIT" as site,
                COUNT(*) as total,
                SUM(CASE WHEN delivrance IS NOT NULL AND delivrance != '' THEN 1 ELSE 0 END) as retires
            FROM cartes 
            WHERE "SITE DE RETRAIT" IS NOT NULL AND "SITE DE RETRAIT" != ''
            GROUP BY "SITE DE RETRAIT"
            ORDER BY total DESC
        `);

        const total = parseInt(totalResult.rows[0].total);
        const retires = parseInt(retiresResult.rows[0].retires);
        const restants = total - retires;

        // Formatage des statistiques par site
        const parSite = {};
        sitesResult.rows.forEach(site => {
            parSite[site.site] = {
                total: parseInt(site.total),
                retires: parseInt(site.retires),
                restants: parseInt(site.total) - parseInt(site.retires)
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

// 🔹 NOUVEAU : ESTIMER LA TAILLE D'UN EXPORT
exports.estimateExportSize = async (req, res) => {
    try {
        const { filters } = req.query || {};
        
        let query = 'SELECT COUNT(*) as count FROM cartes WHERE 1=1';
        let params = [];
        let paramIndex = 1;
        
        if (filters && typeof filters === 'string') {
            try {
                const parsedFilters = JSON.parse(filters);
                
                // Construire dynamiquement les conditions
                if (parsedFilters.site) {
                    query += ` AND "SITE DE RETRAIT" ILIKE $${paramIndex}`;
                    params.push(`%${parsedFilters.site}%`);
                    paramIndex++;
                }
                
                if (parsedFilters.nom) {
                    query += ` AND nom ILIKE $${paramIndex}`;
                    params.push(`%${parsedFilters.nom}%`);
                    paramIndex++;
                }
                
                if (parsedFilters.dateFrom) {
                    query += ` AND "DATE DE DELIVRANCE" >= $${paramIndex}`;
                    params.push(parsedFilters.dateFrom);
                    paramIndex++;
                }
                
                if (parsedFilters.dateTo) {
                    query += ` AND "DATE DE DELIVRANCE" <= $${paramIndex}`;
                    params.push(parsedFilters.dateTo);
                    paramIndex++;
                }
            } catch (e) {
                console.warn('⚠️ Filtres invalides:', e.message);
            }
        }
        
        const result = await db.query(query, params);
        const count = parseInt(result.rows[0].count);
        
        const estimation = {
            totalRows: count,
            canExportDirect: count <= RENDER_CONFIG.MAX_EXPORT_ROWS,
            suggestedMethod: count <= RENDER_CONFIG.MAX_EXPORT_ROWS ? 'direct' : 'streaming',
            estimatedTime: count < 10000 ? '5-10s' : 
                          count < 30000 ? '10-20s' : 
                          count < 50000 ? '20-30s' : '30s+',
            warning: count > RENDER_CONFIG.MAX_EXPORT_ROWS ? 
                `⚠️ Trop de données (${count} > ${RENDER_CONFIG.MAX_EXPORT_ROWS}). Utilisez l'export streaming.` : null
        };
        
        res.json({
            success: true,
            estimation,
            limits: {
                maxDirectExport: RENDER_CONFIG.MAX_EXPORT_ROWS,
                streamingAvailable: true,
                batchSize: 1000
            }
        });
        
    } catch (error) {
        console.error('❌ Erreur estimation export:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur lors de l\'estimation'
        });
    }
};

// 🔹 OBTENIR TOUTES LES CARTES (avec pagination sécurisée)
exports.getAllCartes = async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query; // ⬇️ 100 → 50 pour sécurité
        const offset = (page - 1) * limit;

        // Limiter à 1000 lignes maximum pour sécurité
        const safeLimit = Math.min(parseInt(limit), 1000);
        const safePage = Math.max(1, parseInt(page));

        const result = await db.query(`
            SELECT 
                "LIEU D'ENROLEMENT",
                "SITE DE RETRAIT",
                rangement,
                nom,
                prenoms,
                "DATE DE NAISSANCE",
                "LIEU NAISSANCE",
                contact,
                delivrance,
                "CONTACT DE RETRAIT",
                "DATE DE DELIVRANCE",
                id
            FROM cartes 
            ORDER BY id 
            LIMIT $1 OFFSET $2
        `, [safeLimit, offset]);

        const countResult = await db.query('SELECT COUNT(*) as total FROM cartes');

        const total = parseInt(countResult.rows[0].total);
        const totalPages = Math.ceil(total / safeLimit);

        res.json({
            cartes: result.rows,
            total: total,
            page: safePage,
            totalPages: totalPages,
            limit: safeLimit
        });
    } catch (err) {
        console.error('❌ Erreur getAllCartes:', err);
        res.status(500).json({ 
            success: false,
            message: err.message 
        });
    }
};