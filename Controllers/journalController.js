const db = require('../db/db');

class JournalController {
    
    // Récupérer tous les logs avec pagination et filtres - VERSION COMPLÈTE
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

    // Annuler une importation - VERSION POSTGRESQL
    async annulerImportation(req, res) {
        const client = await db.connect(); // PostgreSQL utilise connect()
        
        try {
            await client.query('BEGIN');
            
            const { importBatchID } = req.body;
            const utilisateurId = req.user.id;
            const nomUtilisateur = req.user.NomUtilisateur;
            const nomComplet = req.user.NomComplet;
            const role = req.user.Role;
            const agence = req.user.Agence;

            // 1. Compter le nombre de cartes à supprimer
            const countResult = await client.query(`
                SELECT COUNT(*) as count FROM cartes WHERE importbatchid = $1
            `, [importBatchID]);

            const count = parseInt(countResult.rows[0].count);

            if (count === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Aucune carte trouvée pour ce batch d\'importation' });
            }

            // 2. Journaliser l'action avant suppression
            await client.query(`
                INSERT INTO journalactivite (
                    utilisateurid, nomutilisateur, nomcomplet, role, agence,
                    dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
                    actiontype, tablename, recordid, adresseip, userid, importbatchid, detailsaction
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
            `, [
                utilisateurId, nomUtilisateur, nomComplet, role, agence,
                new Date(), `Annulation importation batch ${importBatchID}`, 'Cartes', 
                `Batch: ${importBatchID}`, req.ip,
                'ANNULATION_IMPORT', 'Cartes', importBatchID, req.ip, utilisateurId, 
                importBatchID, `Annulation de l'importation - ${count} cartes supprimées`
            ]);

            // 3. Supprimer les cartes de ce batch
            const deleteResult = await client.query(`
                DELETE FROM cartes WHERE importbatchid = $1 RETURNING *
            `, [importBatchID]);

            await client.query('COMMIT');

            res.json({
                success: true,
                message: `Importation annulée avec succès - ${deleteResult.rows.length} cartes supprimées`,
                count: deleteResult.rows.length
            });

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Erreur annulation import:', error);
            res.status(500).json({ 
                error: 'Erreur lors de l\'annulation de l\'importation',
                details: error.message 
            });
        } finally {
            client.release();
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

    // ✅ FONCTION FINALE - Annuler une action (modification/création/suppression)
    async undoAction(req, res) {
        const { id } = req.params;
        const user = req.user;
        const client = await db.connect();

        try {
            await client.query('BEGIN');
            
            console.log(`🔄 Tentative d'annulation (JournalID: ${id})`);

            // 🔍 1. On récupère le log correspondant
            const result = await client.query(
                'SELECT * FROM journalactivite WHERE journalid = $1',
                [id]
            );

            if (result.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Entrée de journal non trouvée.' });
            }

            const log = result.rows[0];
            const oldData = log.oldvalue ? JSON.parse(log.oldvalue) : null;
            const newData = log.newvalue ? JSON.parse(log.newvalue) : null;
            const tableName = log.tablename || log.tableaffectee;
            const recordId = log.recordid || log.ligneaffectee;

            if (!oldData && !newData) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Aucune donnée à restaurer.' });
            }

            console.log(`🕓 Action: ${log.actiontype}, Table: ${tableName}, ID: ${recordId}`);

            // 🔄 2. Exécuter l'annulation selon le type d'action
            if (log.actiontype === 'MODIFICATION_CARTE') {
                await this.executeManualUpdate(client, tableName, recordId, oldData);
            } else if (log.actiontype === 'CREATION_CARTE') {
                await client.query(
                    `DELETE FROM ${tableName} WHERE id = $1`,
                    [recordId]
                );
            } else if (log.actiontype === 'SUPPRESSION_CARTE') {
                await this.executeManualInsert(client, tableName, oldData);
            } else {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: `Type d'action non supporté: ${log.actiontype}` });
            }

            // 🧾 3. Journaliser cette restauration
            await this.logUndoAction(client, user, req, log, newData, oldData);

            await client.query('COMMIT');

            console.log('✅ Action annulée avec succès');
            return res.json({ 
                success: true, 
                message: '✅ Action annulée avec succès.' 
            });

        } catch (err) {
            await client.query('ROLLBACK');
            console.error('❌ Erreur annulation:', err);
            return res.status(500).json({ 
                success: false,
                message: 'Erreur serveur pendant l\'annulation.',
                details: err.message 
            });
        } finally {
            client.release();
        }
    }

    // ✅ MÉTHODE CORRIGÉE POUR UPDATE - Exclut les colonnes non modifiables
    async executeManualUpdate(client, tableName, recordId, oldData) {
        let setClauses = [];
        const params = [recordId];
        let paramCount = 1;
        
        Object.entries(oldData).forEach(([key, value]) => {
            // ✅ EXCLURE les colonnes non modifiables
            if (key === 'ID' || key === 'HashDoublon' || key === 'id') {
                console.log(`⚠️ Colonne exclue: ${key} (non modifiable)`);
                return; // Skip cette colonne
            }
            
            paramCount++;
            setClauses.push(`"${key}" = $${paramCount}`);
            
            // ✅ GESTION CORRECTE DES TYPES
            if (value === null) {
                params.push(null);
            } else if (key === 'ImportBatchID' || key === 'importbatchid') {
                params.push(value);
            } else if (key.includes('DATE') || key.includes('date') || key === 'DateImport' || key === 'dateimport') {
                params.push(value ? new Date(value) : null);
            } else {
                params.push(value);
            }
        });

        // Vérifier qu'il reste des colonnes à mettre à jour
        if (setClauses.length === 0) {
            throw new Error('Aucune colonne modifiable à mettre à jour');
        }

        const updateQuery = `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE id = $1`;
        console.log('🔧 Requête UPDATE corrigée:', updateQuery);
        await client.query(updateQuery, params);
    }

    // ✅ MÉTHODE CORRIGÉE POUR INSERT - Exclut ID pour les nouvelles insertions
    async executeManualInsert(client, tableName, oldData) {
        // Filtrer les colonnes - exclure ID pour l'insertion
        const filteredData = { ...oldData };
        delete filteredData.ID;
        delete filteredData.id;
        
        const columns = Object.keys(filteredData).map(k => `"${k}"`).join(', ');
        const placeholders = Object.keys(filteredData).map((_, index) => `$${index + 1}`).join(', ');

        const params = Object.values(filteredData).map(value => {
            if (value === null) return null;
            // Gestion des dates
            if (typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}/)) {
                return new Date(value);
            }
            return value;
        });

        const insertQuery = `INSERT INTO ${tableName} (${columns}) VALUES (${placeholders})`;
        console.log('🔧 Requête INSERT corrigée:', insertQuery);
        await client.query(insertQuery, params);
    }

    // ✅ MÉTHODE POUR JOURNALISER L'ANNULATION
    async logUndoAction(client, user, req, log, newData, oldData) {
        const tableName = log.tablename || log.tableaffectee;
        const recordId = log.recordid || log.ligneaffectee;

        await client.query(`
            INSERT INTO journalactivite 
            (utilisateurid, nomutilisateur, nomcomplet, role, agence, dateaction, action, 
             tableaffectee, ligneaffectee, iputilisateur, actiontype, tablename, recordid, 
             oldvalue, newvalue, adresseip, userid, detailsaction)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        `, [
            user.id, user.NomUtilisateur, user.NomComplet || user.NomUtilisateur, user.Role, 
            user.Agence || '', new Date(), `Annulation de ${log.actiontype}`,
            tableName, recordId.toString(), req.ip || '', 'ANNULATION', tableName, 
            recordId.toString(), JSON.stringify(newData), JSON.stringify(oldData), 
            req.ip || '', user.id, `Annulation de: ${log.actiontype}`
        ]);
    }

    // Méthode utilitaire pour journaliser les actions (à utiliser dans autres contrôleurs)
    async logAction(logData) {
        try {
            await db.query(`
                INSERT INTO journalactivite (
                    utilisateurid, nomutilisateur, nomcomplet, role, agence,
                    dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
                    actiontype, tablename, recordid, oldvalue, newvalue, adresseip,
                    userid, importbatchid, detailsaction
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            `, [
                logData.utilisateurId || null,
                logData.nomUtilisateur || 'System',
                logData.nomComplet || 'System', 
                logData.role || 'System',
                logData.agence || null,
                new Date(),
                logData.action || logData.actionType,
                logData.tableName || null,
                logData.recordId || null,
                logData.ip || null,
                logData.actionType,
                logData.tableName || null,
                logData.recordId || null,
                logData.oldValue || null,
                logData.newValue || null,
                logData.ip || null,
                logData.utilisateurId || null,
                logData.importBatchID || null,
                logData.details || null
            ]);
        } catch (error) {
            console.error('Erreur journalisation:', error);
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

    // Nettoyer le journal (supprimer les vieilles entrées)
    async nettoyerJournal(req, res) {
        const client = await db.connect();
        
        try {
            await client.query('BEGIN');
            
            const { jours = 90 } = req.body;
            
            const result = await client.query(`
                DELETE FROM journalactivite 
                WHERE dateaction < CURRENT_DATE - INTERVAL '${jours} days'
                RETURNING *
            `);
            
            await client.query('COMMIT');
            
            res.json({
                success: true,
                message: `Journal nettoyé avec succès - ${result.rows.length} entrées supprimées`,
                deletedCount: result.rows.length
            });
            
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Erreur nettoyage journal:', error);
            res.status(500).json({ 
                error: 'Erreur lors du nettoyage du journal',
                details: error.message 
            });
        } finally {
            client.release();
        }
    }
}

module.exports = new JournalController();