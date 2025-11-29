const db = require('../db/db');

class JournalController {
    
    // Récupérer tous les logs avec pagination et filtres
    async getJournal(req, res) {
        try {
            const {
                page = 1,
                pageSize = 50,
                dateDebut,
                dateFin,
                utilisateur,
                actionType,
                tableName
            } = req.query;

            let query = `
                SELECT 
                    journalid,
                    utilisateurid,
                    nomutilisateur,
                    nomcomplet,
                    role,
                    agence,
                    dateaction,
                    action,
                    tableaffectee,
                    ligneaffectee,
                    iputilisateur,
                    systeme,
                    username,
                    roleutilisateur,
                    actiontype,
                    tablename,
                    recordid,
                    oldvalue,
                    newvalue,
                    adresseip,
                    userid,
                    importbatchid,
                    detailsaction
                FROM journalactivite 
                WHERE 1=1
            `;
            
            const params = [];
            let paramCount = 0;

            // Appliquer les filtres
            if (dateDebut) {
                paramCount++;
                query += ` AND dateaction >= $${paramCount}`;
                params.push(new Date(dateDebut));
            }

            if (dateFin) {
                paramCount++;
                query += ` AND dateaction <= $${paramCount}`;
                params.push(new Date(dateFin + ' 23:59:59'));
            }

            if (utilisateur) {
                paramCount++;
                query += ` AND nomutilisateur ILIKE $${paramCount}`;
                params.push(`%${utilisateur}%`);
            }

            if (actionType) {
                paramCount++;
                query += ` AND actiontype = $${paramCount}`;
                params.push(actionType);
            }

            if (tableName) {
                paramCount++;
                query += ` AND (tablename = $${paramCount} OR tableaffectee = $${paramCount})`;
                params.push(tableName);
            }

            // Pagination PostgreSQL
            const offset = (page - 1) * pageSize;
            query += `
                ORDER BY dateaction DESC
                LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}
            `;
            params.push(parseInt(pageSize), offset);

            const logs = await db.query(query, params);

            // Compter le total pour la pagination
            let countQuery = `
                SELECT COUNT(*) as total FROM journalactivite WHERE 1=1
            `;
            const countParams = [];
            let countParamCount = 0;

            if (dateDebut) {
                countParamCount++;
                countQuery += ` AND dateaction >= $${countParamCount}`;
                countParams.push(new Date(dateDebut));
            }

            if (dateFin) {
                countParamCount++;
                countQuery += ` AND dateaction <= $${countParamCount}`;
                countParams.push(new Date(dateFin + ' 23:59:59'));
            }

            if (utilisateur) {
                countParamCount++;
                countQuery += ` AND nomutilisateur ILIKE $${countParamCount}`;
                countParams.push(`%${utilisateur}%`);
            }

            if (actionType) {
                countParamCount++;
                countQuery += ` AND actiontype = $${countParamCount}`;
                countParams.push(actionType);
            }

            if (tableName) {
                countParamCount++;
                countQuery += ` AND (tablename = $${countParamCount} OR tableaffectee = $${countParamCount})`;
                countParams.push(tableName);
            }

            const totalResult = await db.query(countQuery, countParams);

            res.json({
                logs: logs.rows,
                pagination: {
                    page: parseInt(page),
                    pageSize: parseInt(pageSize),
                    total: parseInt(totalResult.rows[0].total),
                    totalPages: Math.ceil(parseInt(totalResult.rows[0].total) / pageSize)
                }
            });

        } catch (error) {
            console.error('Erreur journal:', error);
            res.status(500).json({ 
                error: 'Erreur lors de la récupération du journal',
                details: error.message 
            });
        }
    }

    // Récupérer les imports groupés pour l'annulation
    async getImports(req, res) {
        try {
            const result = await db.query(`
                SELECT 
                    j.importbatchid,
                    COUNT(c.id) as nombrecartes,
                    MIN(j.dateaction) as dateimport,
                    j.nomutilisateur,
                    j.nomcomplet,
                    j.agence
                FROM journalactivite j
                LEFT JOIN cartes c ON j.importbatchid = c.importbatchid
                WHERE j.actiontype = 'IMPORT_CARTE' 
                AND j.importbatchid IS NOT NULL
                GROUP BY j.importbatchid, j.nomutilisateur, j.nomcomplet, j.agence
                ORDER BY dateimport DESC
            `);

            res.json(result.rows);
        } catch (error) {
            console.error('Erreur récupération imports:', error);
            res.status(500).json({ 
                error: 'Erreur lors de la récupération des imports',
                details: error.message 
            });
        }
    }

    // Statistiques d'activité
    async getStats(req, res) {
        try {
            const result = await db.query(`
                SELECT 
                    actiontype,
                    COUNT(*) as count,
                    MAX(dateaction) as derniereaction
                FROM journalactivite 
                WHERE dateaction >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY actiontype
                ORDER BY count DESC
            `);
            res.json(result.rows);
        } catch (error) {
            console.error('Erreur stats:', error);
            res.status(500).json({ 
                error: 'Erreur lors de la récupération des statistiques',
                details: error.message 
            });
        }
    }
}

module.exports = new JournalController();