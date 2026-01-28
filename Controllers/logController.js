const db = require('../db/db');

exports.getAllLogs = async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM log ORDER BY dateheure DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.createLog = async (req, res) => {
    try {
        const { Utilisateur, Action } = req.body;
        await db.query(
            'INSERT INTO log (utilisateur, action, dateheure) VALUES ($1, $2, NOW())',
            [Utilisateur, Action]
        );
        res.json({ message: 'Log ajouté !' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getLogsByUser = async (req, res) => {
    try {
        const { utilisateur } = req.params;
        const result = await db.query(
            'SELECT * FROM log WHERE utilisateur = $1 ORDER BY dateheure DESC',
            [utilisateur]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getLogsByDateRange = async (req, res) => {
    try {
        const { dateDebut, dateFin } = req.query;
        const result = await db.query(
            'SELECT * FROM log WHERE dateheure BETWEEN $1 AND $2 ORDER BY dateheure DESC',
            [dateDebut, dateFin + ' 23:59:59']
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getRecentLogs = async (req, res) => {
    try {
        const { limit = 100 } = req.query;
        const result = await db.query(
            'SELECT * FROM log ORDER BY dateheure DESC LIMIT $1',
            [parseInt(limit)]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.deleteOldLogs = async (req, res) => {
    try {
        const { days = 90 } = req.query;
        const result = await db.query(
            'DELETE FROM log WHERE dateheure < CURRENT_DATE - INTERVAL \'$1 days\' RETURNING *',
            [parseInt(days)]
        );
        res.json({ 
            message: `Logs supprimés avec succès`,
            deletedCount: result.rows.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.getLogStats = async (req, res) => {
    try {
        // Statistiques par utilisateur
        const userStats = await db.query(`
            SELECT 
                utilisateur,
                COUNT(*) as total_actions,
                MAX(dateheure) as derniere_action
            FROM log 
            GROUP BY utilisateur 
            ORDER BY total_actions DESC
        `);

        // Statistiques par jour
        const dailyStats = await db.query(`
            SELECT 
                CAST(dateheure AS DATE) as date,
                COUNT(*) as total_actions
            FROM log 
            WHERE dateheure >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY CAST(dateheure AS DATE)
            ORDER BY date DESC
        `);

        // Actions les plus fréquentes
        const actionStats = await db.query(`
            SELECT 
                action,
                COUNT(*) as count
            FROM log 
            GROUP BY action 
            ORDER BY count DESC 
            LIMIT 10
        `);

        res.json({
            parUtilisateur: userStats.rows,
            parJour: dailyStats.rows,
            actionsFrequentes: actionStats.rows,
            totalLogs: userStats.rows.reduce((sum, user) => sum + parseInt(user.total_actions), 0)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.searchLogs = async (req, res) => {
    try {
        const { q, page = 1, limit = 50 } = req.query;
        const offset = (page - 1) * limit;

        if (!q || q.trim() === '') {
            return res.status(400).json({ error: 'Le terme de recherche est requis' });
        }

        const searchTerm = `%${q.trim()}%`;
        
        const result = await db.query(
            `SELECT * FROM log 
             WHERE utilisateur ILIKE $1 OR action ILIKE $1 
             ORDER BY dateheure DESC 
             LIMIT $2 OFFSET $3`,
            [searchTerm, parseInt(limit), offset]
        );

        const countResult = await db.query(
            `SELECT COUNT(*) as total FROM log 
             WHERE utilisateur ILIKE $1 OR action ILIKE $1`,
            [searchTerm]
        );

        const total = parseInt(countResult.rows[0].total);

        res.json({
            logs: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.clearAllLogs = async (req, res) => {
    const client = await db.getClient();
    
    try {
        await client.query('BEGIN');
        
        // Vérifier les permissions (optionnel - à adapter selon votre système d'authentification)
        if (!req.user || !req.user.role || !req.user.role.includes('admin')) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Permission refusée' });
        }

        const result = await client.query('DELETE FROM log RETURNING *');
        
        await client.query('COMMIT');
        
        res.json({ 
            message: 'Tous les logs ont été supprimés avec succès',
            deletedCount: result.rows.length
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
};

exports.exportLogs = async (req, res) => {
    try {
        const { format = 'json' } = req.query;
        
        const result = await db.query(`
            SELECT 
                logid,
                utilisateur,
                action,
                dateheure,
                EXTRACT(EPOCH FROM dateheure) as timestamp
            FROM log 
            ORDER BY dateheure DESC
        `);

        if (format === 'csv') {
            // Format CSV simple
            const csvHeaders = 'ID,Utilisateur,Action,DateHeure\n';
            const csvData = result.rows.map(row => 
                `${row.logid},"${row.utilisateur}","${row.action}","${row.dateheure}"`
            ).join('\n');
            
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=logs-export.csv');
            res.send(csvHeaders + csvData);
        } else {
            // Format JSON par défaut
            res.json({
                success: true,
                logs: result.rows,
                exportDate: new Date().toISOString(),
                total: result.rows.length
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Méthode utilitaire pour logger les actions (peut être utilisée par d'autres contrôleurs)
exports.logAction = async (utilisateur, action) => {
    try {
        await db.query(
            'INSERT INTO log (utilisateur, action, dateheure) VALUES ($1, $2, NOW())',
            [utilisateur, action]
        );
    } catch (err) {
        console.error('Erreur lors de la journalisation:', err.message);
    }
};

// Récupérer les logs avec filtres avancés
exports.getFilteredLogs = async (req, res) => {
    try {
        const {
            utilisateur,
            action,
            dateDebut,
            dateFin,
            page = 1,
            limit = 50
        } = req.query;

        let query = 'SELECT * FROM log WHERE 1=1';
        const params = [];
        let paramCount = 0;

        if (utilisateur) {
            paramCount++;
            query += ` AND utilisateur ILIKE $${paramCount}`;
            params.push(`%${utilisateur}%`);
        }

        if (action) {
            paramCount++;
            query += ` AND action ILIKE $${paramCount}`;
            params.push(`%${action}%`);
        }

        if (dateDebut) {
            paramCount++;
            query += ` AND dateheure >= $${paramCount}`;
            params.push(new Date(dateDebut));
        }

        if (dateFin) {
            paramCount++;
            query += ` AND dateheure <= $${paramCount}`;
            params.push(new Date(dateFin + ' 23:59:59'));
        }

        const offset = (page - 1) * limit;
        query += ` ORDER BY dateheure DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
        params.push(parseInt(limit), offset);

        const result = await db.query(query, params);

        // Compter le total
        let countQuery = 'SELECT COUNT(*) as total FROM log WHERE 1=1';
        const countParams = [];
        let countParamCount = 0;

        if (utilisateur) {
            countParamCount++;
            countQuery += ` AND utilisateur ILIKE $${countParamCount}`;
            countParams.push(`%${utilisateur}%`);
        }

        if (action) {
            countParamCount++;
            countQuery += ` AND action ILIKE $${countParamCount}`;
            countParams.push(`%${action}%`);
        }

        if (dateDebut) {
            countParamCount++;
            countQuery += ` AND dateheure >= $${countParamCount}`;
            countParams.push(new Date(dateDebut));
        }

        if (dateFin) {
            countParamCount++;
            countQuery += ` AND dateheure <= $${countParamCount}`;
            countParams.push(new Date(dateFin + ' 23:59:59'));
        }

        const countResult = await db.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].total);

        res.json({
            logs: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};