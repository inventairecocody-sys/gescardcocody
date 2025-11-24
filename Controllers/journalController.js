const { poolPromise, sql } = require('../db/db');

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

            const pool = await poolPromise;
            let query = `
                SELECT 
                    JournalID,
                    UtilisateurID,
                    NomUtilisateur,
                    NomComplet,
                    Role,
                    Agence,
                    DateAction,
                    Action,
                    TableAffectee,
                    LigneAffectee,
                    IPUtilisateur,
                    Systeme,
                    UserName,
                    RoleUtilisateur,
                    ActionType,
                    TableName,
                    RecordId,
                    OldValue,
                    NewValue,
                    AdresseIP,
                    UserId,
                    ImportBatchID,
                    DetailsAction
                FROM dbo.JournalActivite 
                WHERE 1=1
            `;
            
            const params = [];
            let paramCount = 0;

            // Appliquer les filtres
            if (dateDebut) {
                paramCount++;
                query += ` AND DateAction >= @dateDebut${paramCount}`;
                params.push({ name: `dateDebut${paramCount}`, type: sql.DateTime, value: new Date(dateDebut) });
            }

            if (dateFin) {
                paramCount++;
                query += ` AND DateAction <= @dateFin${paramCount}`;
                params.push({ name: `dateFin${paramCount}`, type: sql.DateTime, value: new Date(dateFin + ' 23:59:59') });
            }

            if (utilisateur) {
                paramCount++;
                query += ` AND NomUtilisateur LIKE @utilisateur${paramCount}`;
                params.push({ name: `utilisateur${paramCount}`, type: sql.NVarChar, value: `%${utilisateur}%` });
            }

            if (actionType) {
                paramCount++;
                query += ` AND ActionType = @actionType${paramCount}`;
                params.push({ name: `actionType${paramCount}`, type: sql.NVarChar, value: actionType });
            }

            if (tableName) {
                paramCount++;
                query += ` AND (TableName = @tableName${paramCount} OR TableAffectee = @tableName${paramCount})`;
                params.push({ name: `tableName${paramCount}`, type: sql.NVarChar, value: tableName });
            }

            // Pagination
            const offset = (page - 1) * pageSize;
            query += `
                ORDER BY DateAction DESC
                OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
            `;

            const request = pool.request();
            params.forEach(param => {
                request.input(param.name, param.type, param.value);
            });
            
            const logs = await request.query(query);

            // Compter le total pour la pagination
            let countQuery = `
                SELECT COUNT(*) as total FROM dbo.JournalActivite WHERE 1=1
            `;
            const countParams = params;

            const countRequest = pool.request();
            countParams.forEach(param => {
                countRequest.input(param.name, param.type, param.value);
            });
            
            const totalResult = await countRequest.query(countQuery);

            res.json({
                logs: logs.recordset,
                pagination: {
                    page: parseInt(page),
                    pageSize: parseInt(pageSize),
                    total: totalResult.recordset[0].total,
                    totalPages: Math.ceil(totalResult.recordset[0].total / pageSize)
                }
            });

        } catch (error) {
            console.error('Erreur journal:', error);
            res.status(500).json({ error: 'Erreur lors de la récupération du journal' });
        }
    }

    // Annuler une importation
    async annulerImportation(req, res) {
        const pool = await poolPromise;
        const transaction = new sql.Transaction(pool);
        
        try {
            await transaction.begin();
            
            const { importBatchID } = req.body;
            const utilisateurId = req.user.id;
            const nomUtilisateur = req.user.NomUtilisateur;
            const nomComplet = req.user.NomComplet;
            const role = req.user.Role;
            const agence = req.user.Agence;

            // 1. Compter le nombre de cartes à supprimer
            const countRequest = new sql.Request(transaction);
            countRequest.input('importBatchID', sql.UniqueIdentifier, importBatchID);
            const countResult = await countRequest.query(`
                SELECT COUNT(*) as count FROM dbo.Cartes WHERE ImportBatchID = @importBatchID
            `);

            const count = countResult.recordset[0].count;

            if (count === 0) {
                await transaction.rollback();
                return res.status(404).json({ error: 'Aucune carte trouvée pour ce batch d\'importation' });
            }

            // 2. Journaliser l'action avant suppression
            const logRequest = new sql.Request(transaction);
            await logRequest
                .input('UtilisateurID', sql.Int, utilisateurId)
                .input('NomUtilisateur', sql.NVarChar, nomUtilisateur)
                .input('NomComplet', sql.NVarChar, nomComplet)
                .input('Role', sql.NVarChar, role)
                .input('Agence', sql.NVarChar, agence)
                .input('DateAction', sql.DateTime, new Date())
                .input('Action', sql.NVarChar, `Annulation importation batch ${importBatchID}`)
                .input('TableAffectee', sql.NVarChar, 'Cartes')
                .input('LigneAffectee', sql.NVarChar, `Batch: ${importBatchID}`)
                .input('IPUtilisateur', sql.NVarChar, req.ip)
                .input('ActionType', sql.NVarChar, 'ANNULATION_IMPORT')
                .input('TableName', sql.NVarChar, 'Cartes')
                .input('RecordId', sql.NVarChar, importBatchID)
                .input('AdresseIP', sql.NVarChar, req.ip)
                .input('UserId', sql.Int, utilisateurId)
                .input('ImportBatchID', sql.UniqueIdentifier, importBatchID)
                .input('DetailsAction', sql.NVarChar, `Annulation de l'importation - ${count} cartes supprimées`)
                .query(`
                    INSERT INTO dbo.JournalActivite (
                        UtilisateurID, NomUtilisateur, NomComplet, Role, Agence,
                        DateAction, Action, TableAffectee, LigneAffectee, IPUtilisateur,
                        ActionType, TableName, RecordId, AdresseIP, UserId, ImportBatchID, DetailsAction
                    ) VALUES (
                        @UtilisateurID, @NomUtilisateur, @NomComplet, @Role, @Agence,
                        @DateAction, @Action, @TableAffectee, @LigneAffectee, @IPUtilisateur,
                        @ActionType, @TableName, @RecordId, @AdresseIP, @UserId, @ImportBatchID, @DetailsAction
                    )
                `);

            // 3. Supprimer les cartes de ce batch
            const deleteRequest = new sql.Request(transaction);
            deleteRequest.input('importBatchID', sql.UniqueIdentifier, importBatchID);
            const deleteResult = await deleteRequest.query(`
                DELETE FROM dbo.Cartes WHERE ImportBatchID = @importBatchID
            `);

            await transaction.commit();

            res.json({
                success: true,
                message: `Importation annulée avec succès - ${deleteResult.rowsAffected[0]} cartes supprimées`,
                count: deleteResult.rowsAffected[0]
            });

        } catch (error) {
            await transaction.rollback();
            console.error('Erreur annulation import:', error);
            res.status(500).json({ error: 'Erreur lors de l\'annulation de l\'importation' });
        }
    }

    // Récupérer les imports groupés pour l'annulation
    async getImports(req, res) {
        try {
            const pool = await poolPromise;
            const result = await pool.request().query(`
                SELECT 
                    j.ImportBatchID,
                    COUNT(c.ID) as nombreCartes,
                    MIN(j.DateAction) as dateImport,
                    j.NomUtilisateur,
                    j.NomComplet,
                    j.Agence
                FROM dbo.JournalActivite j
                LEFT JOIN dbo.Cartes c ON j.ImportBatchID = c.ImportBatchID
                WHERE j.ActionType = 'IMPORT_CARTE' 
                AND j.ImportBatchID IS NOT NULL
                GROUP BY j.ImportBatchID, j.NomUtilisateur, j.NomComplet, j.Agence
                ORDER BY dateImport DESC
            `);

            res.json(result.recordset);
        } catch (error) {
            console.error('Erreur récupération imports:', error);
            res.status(500).json({ error: 'Erreur lors de la récupération des imports' });
        }
    }

    // ✅ FONCTION FINALE - Annuler une action (modification/création/suppression)
    async undoAction(req, res) {
        const { id } = req.params;
        const user = req.user;

        try {
            const pool = await poolPromise;

            console.log(`🔄 Tentative d'annulation (JournalID: ${id})`);

            // 🔍 1. On récupère le log correspondant
            const result = await pool.request()
                .input('JournalID', sql.Int, id)
                .query('SELECT * FROM dbo.JournalActivite WHERE JournalID = @JournalID');

            if (result.recordset.length === 0) {
                return res.status(404).json({ message: 'Entrée de journal non trouvée.' });
            }

            const log = result.recordset[0];
            const oldData = log.OldValue ? JSON.parse(log.OldValue) : null;
            const newData = log.NewValue ? JSON.parse(log.NewValue) : null;
            const tableName = log.TableName || log.TableAffectee;
            const recordId = log.RecordId || log.LigneAffectee;

            if (!oldData && !newData) {
                return res.status(400).json({ message: 'Aucune donnée à restaurer.' });
            }

            console.log(`🕓 Action: ${log.ActionType}, Table: ${tableName}, ID: ${recordId}`);

            // 🔄 2. Exécuter l'annulation selon le type d'action
            if (log.ActionType === 'MODIFICATION_CARTE') {
                await this.executeManualUpdate(pool, tableName, recordId, oldData);
            } else if (log.ActionType === 'CREATION_CARTE') {
                await pool.request()
                    .input('ID', sql.Int, recordId)
                    .query(`DELETE FROM [${tableName}] WHERE ID = @ID`);
            } else if (log.ActionType === 'SUPPRESSION_CARTE') {
                await this.executeManualInsert(pool, tableName, oldData);
            } else {
                return res.status(400).json({ message: `Type d'action non supporté: ${log.ActionType}` });
            }

            // 🧾 3. Journaliser cette restauration
            await this.logUndoAction(pool, user, req, log, newData, oldData);

            console.log('✅ Action annulée avec succès');
            return res.json({ 
                success: true, 
                message: '✅ Action annulée avec succès.' 
            });

        } catch (err) {
            console.error('❌ Erreur annulation:', err);
            return res.status(500).json({ 
                success: false,
                message: 'Erreur serveur pendant l\'annulation.',
                details: err.message 
            });
        }
    }

    // ✅ MÉTHODE CORRIGÉE POUR UPDATE - Exclut les colonnes non modifiables
    async executeManualUpdate(pool, tableName, recordId, oldData) {
        let setClauses = [];
        const request = pool.request().input('ID', sql.Int, recordId);
        
        Object.entries(oldData).forEach(([key, value], index) => {
            // ✅ EXCLURE les colonnes non modifiables
            if (key === 'ID' || key === 'HashDoublon') {
                console.log(`⚠️ Colonne exclue: ${key} (non modifiable)`);
                return; // Skip cette colonne
            }
            
            const paramName = `param${index}`;
            setClauses.push(`[${key}] = @${paramName}`);
            
            // ✅ GESTION CORRECTE DES TYPES (sans HashDoublon et ID)
            if (value === null) {
                request.input(paramName, sql.NVarChar, null);
            } else if (key === 'ImportBatchID') {
                // GUID
                request.input(paramName, sql.UniqueIdentifier, value);
            } else if (key.includes('DATE') || key === 'DateImport') {
                // Dates
                request.input(paramName, sql.DateTime, value ? new Date(value) : null);
            } else if (key === 'CONTACT' || key === 'CONTACT DE RETRAIT') {
                // Contacts (nvarchar(20))
                request.input(paramName, sql.NVarChar(20), value);
            } else if (key === 'RANGEMENT') {
                // Rangement (nvarchar(100))
                request.input(paramName, sql.NVarChar(100), value);
            } else {
                // Texte par défaut (nvarchar(255))
                request.input(paramName, sql.NVarChar(255), value);
            }
        });

        // Vérifier qu'il reste des colonnes à mettre à jour
        if (setClauses.length === 0) {
            throw new Error('Aucune colonne modifiable à mettre à jour');
        }

        const updateQuery = `UPDATE [${tableName}] SET ${setClauses.join(', ')} WHERE ID = @ID`;
        console.log('🔧 Requête UPDATE corrigée:', updateQuery);
        await request.query(updateQuery);
    }

    // ✅ MÉTHODE CORRIGÉE POUR INSERT - Exclut ID pour les nouvelles insertions
    async executeManualInsert(pool, tableName, oldData) {
        // Filtrer les colonnes - exclure ID pour l'insertion
        const filteredData = { ...oldData };
        delete filteredData.ID; // ✅ ID est auto-généré
        
        const columns = Object.keys(filteredData).map(k => `[${k}]`).join(', ');
        const params = Object.keys(filteredData).map((k, index) => `@param${index}`).join(', ');

        const request = pool.request();
        Object.entries(filteredData).forEach(([key, value], index) => {
            const paramName = `param${index}`;
            
            // ✅ GESTION CORRECTE DES TYPES
            if (value === null) {
                request.input(paramName, sql.NVarChar, null);
            } else if (key === 'HashDoublon') {
                // ✅ CORRECTION : HashDoublon est varbinary (Buffer Node.js)
                if (value && value.type === 'Buffer' && value.data) {
                    const buffer = Buffer.from(value.data);
                    request.input(paramName, sql.VarBinary, buffer);
                } else {
                    request.input(paramName, sql.VarBinary, null);
                }
            } else if (key === 'ImportBatchID') {
                request.input(paramName, sql.UniqueIdentifier, value);
            } else if (key.includes('DATE') || key === 'DateImport') {
                request.input(paramName, sql.DateTime, value ? new Date(value) : null);
            } else if (key === 'CONTACT' || key === 'CONTACT DE RETRAIT') {
                request.input(paramName, sql.NVarChar(20), value);
            } else if (key === 'RANGEMENT') {
                request.input(paramName, sql.NVarChar(100), value);
            } else {
                request.input(paramName, sql.NVarChar(255), value);
            }
        });

        const insertQuery = `INSERT INTO [${tableName}] (${columns}) VALUES (${params})`;
        console.log('🔧 Requête INSERT corrigée:', insertQuery);
        await request.query(insertQuery);
    }

    // ✅ MÉTHODE POUR JOURNALISER L'ANNULATION
    async logUndoAction(pool, user, req, log, newData, oldData) {
        const tableName = log.TableName || log.TableAffectee;
        const recordId = log.RecordId || log.LigneAffectee;

        await pool.request()
            .input('UtilisateurID', sql.Int, user.id)
            .input('NomUtilisateur', sql.NVarChar, user.NomUtilisateur)
            .input('NomComplet', sql.NVarChar, user.NomComplet || user.NomUtilisateur)
            .input('Role', sql.NVarChar, user.Role)
            .input('Agence', sql.NVarChar, user.Agence || '')
            .input('DateAction', sql.DateTime, new Date())
            .input('Action', sql.NVarChar, `Annulation de ${log.ActionType}`)
            .input('TableAffectee', sql.NVarChar, tableName)
            .input('LigneAffectee', sql.NVarChar, recordId.toString())
            .input('IPUtilisateur', sql.NVarChar, req.ip || '')
            .input('ActionType', sql.NVarChar, 'ANNULATION')
            .input('TableName', sql.NVarChar, tableName)
            .input('RecordId', sql.NVarChar, recordId.toString())
            .input('OldValue', sql.NVarChar(sql.MAX), JSON.stringify(newData))
            .input('NewValue', sql.NVarChar(sql.MAX), JSON.stringify(oldData))
            .input('AdresseIP', sql.NVarChar, req.ip || '')
            .input('UserId', sql.Int, user.id)
            .input('DetailsAction', sql.NVarChar, `Annulation de: ${log.ActionType}`)
            .query(`
                INSERT INTO dbo.JournalActivite 
                (UtilisateurID, NomUtilisateur, NomComplet, Role, Agence, DateAction, Action, 
                 TableAffectee, LigneAffectee, IPUtilisateur, ActionType, TableName, RecordId, 
                 OldValue, NewValue, AdresseIP, UserId, DetailsAction)
                VALUES (@UtilisateurID, @NomUtilisateur, @NomComplet, @Role, @Agence, @DateAction, @Action, 
                        @TableAffectee, @LigneAffectee, @IPUtilisateur, @ActionType, @TableName, @RecordId, 
                        @OldValue, @NewValue, @AdresseIP, @UserId, @DetailsAction)
            `);
    }

    // Méthode utilitaire pour journaliser les actions (à utiliser dans autres contrôleurs)
    async logAction(logData) {
        try {
            const pool = await poolPromise;
            await pool.request()
                .input('UtilisateurID', sql.Int, logData.utilisateurId || null)
                .input('NomUtilisateur', sql.NVarChar, logData.nomUtilisateur || 'System')
                .input('NomComplet', sql.NVarChar, logData.nomComplet || 'System')
                .input('Role', sql.NVarChar, logData.role || 'System')
                .input('Agence', sql.NVarChar, logData.agence || null)
                .input('DateAction', sql.DateTime, new Date())
                .input('Action', sql.NVarChar, logData.action || logData.actionType)
                .input('TableAffectee', sql.NVarChar, logData.tableName || null)
                .input('LigneAffectee', sql.NVarChar, logData.recordId || null)
                .input('IPUtilisateur', sql.NVarChar, logData.ip || null)
                .input('ActionType', sql.NVarChar, logData.actionType)
                .input('TableName', sql.NVarChar, logData.tableName || null)
                .input('RecordId', sql.NVarChar, logData.recordId || null)
                .input('OldValue', sql.NVarChar, logData.oldValue || null)
                .input('NewValue', sql.NVarChar, logData.newValue || null)
                .input('AdresseIP', sql.NVarChar, logData.ip || null)
                .input('UserId', sql.Int, logData.utilisateurId || null)
                .input('ImportBatchID', sql.UniqueIdentifier, logData.importBatchID || null)
                .input('DetailsAction', sql.NVarChar, logData.details || null)
                .query(`
                    INSERT INTO dbo.JournalActivite (
                        UtilisateurID, NomUtilisateur, NomComplet, Role, Agence,
                        DateAction, Action, TableAffectee, LigneAffectee, IPUtilisateur,
                        ActionType, TableName, RecordId, OldValue, NewValue, AdresseIP,
                        UserId, ImportBatchID, DetailsAction
                    ) VALUES (
                        @UtilisateurID, @NomUtilisateur, @NomComplet, @Role, @Agence,
                        @DateAction, @Action, @TableAffectee, @LigneAffectee, @IPUtilisateur,
                        @ActionType, @TableName, @RecordId, @OldValue, @NewValue, @AdresseIP,
                        @UserId, @ImportBatchID, @DetailsAction
                    )
                `);
        } catch (error) {
            console.error('Erreur journalisation:', error);
        }
    }

    // Statistiques d'activité
    async getStats(req, res) {
        try {
            const pool = await poolPromise;
            const result = await pool.request().query(`
                SELECT 
                    ActionType,
                    COUNT(*) as count,
                    MAX(DateAction) as derniereAction
                FROM dbo.JournalActivite 
                WHERE DateAction >= DATEADD(day, -30, GETDATE())
                GROUP BY ActionType
                ORDER BY count DESC
            `);
            res.json(result.recordset);
        } catch (error) {
            console.error('Erreur stats:', error);
            res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
        }
    }
}

module.exports = new JournalController();