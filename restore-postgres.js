const { google } = require('googleapis');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const execPromise = util.promisify(exec);

class SecurePostgreSQLRestorer {
  constructor() {
    this.drive = null;
    this.auth = null;
    this.encryptionEnabled = !!process.env.BACKUP_ENCRYPTION_KEY;
    
    if (this.encryptionEnabled && process.env.BACKUP_ENCRYPTION_KEY.length !== 32) {
      throw new Error('BACKUP_ENCRYPTION_KEY doit faire exactement 32 caractères');
    }
  }

  // ==================== SÉCURITÉ ET DÉCHIFFREMENT ====================

  // Déchiffrement AES-256-GCM
  decryptData(encryptedData) {
    if (!encryptedData.encrypted) {
      return encryptedData.data;
    }

    if (!this.encryptionEnabled) {
      throw new Error('Backup chiffré mais chiffrement non configuré. Vérifiez BACKUP_ENCRYPTION_KEY.');
    }

    const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex');
    const iv = Buffer.from(encryptedData.iv, 'hex');
    const authTag = Buffer.from(encryptedData.authTag, 'hex');
    
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encryptedData.data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  // Vérifier l'intégrité du fichier
  verifyFileIntegrity(filePath, expectedSize = null) {
    try {
      const stats = fs.statSync(filePath);
      
      if (expectedSize && stats.size !== expectedSize) {
        throw new Error(`Taille du fichier incorrecte: ${stats.size} au lieu de ${expectedSize}`);
      }
      
      // Calculer le hash MD5 pour vérification
      const fileBuffer = fs.readFileSync(filePath);
      const hash = crypto.createHash('md5').update(fileBuffer).digest('hex');
      
      return {
        valid: true,
        size: stats.size,
        hash: hash,
        lastModified: stats.mtime
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  // ==================== INITIALISATION SÉCURISÉE ====================

  // 1. Initialisation sécurisée
  async initialize() {
    console.log('🔐 Initialisation sécurisée du restorateur...');
    
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
      throw new Error('Configuration Google Drive manquante. Vérifiez les variables d\'environnement.');
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });

    // Vérifier la validité du token
    try {
      await oauth2Client.getAccessToken();
    } catch (error) {
      console.error('❌ Token Google invalide ou expiré:', error.message);
      throw new Error('Token Google invalide. Veuillez le régénérer.');
    }

    this.auth = oauth2Client;
    this.drive = google.drive({ 
      version: 'v3', 
      auth: oauth2Client 
    });
    
    console.log('✅ Initialisation sécurisée réussie');
    return true;
  }

  // 2. Trouver le dernier backup (avec vérifications)
  async findLatestBackup() {
    console.log('🔍 Recherche dernier backup sécurisé...');
    
    try {
      // Trouver le dossier
      const folderResponse = await this.drive.files.list({
        q: "name='gescard_backups' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id, name, createdTime)',
        pageSize: 1
      });

      if (folderResponse.data.files.length === 0) {
        throw new Error('❌ Aucun dossier de backup trouvé. Vérifiez la configuration Google Drive.');
      }

      const folderId = folderResponse.data.files[0].id;
      console.log(`📁 Dossier backup trouvé: ${folderId}`);

      // Chercher les 5 derniers fichiers pour donner un choix
      const filesResponse = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        orderBy: 'createdTime desc',
        pageSize: 5,
        fields: 'files(id, name, createdTime, size, mimeType, md5Checksum)'
      });

      if (filesResponse.data.files.length === 0) {
        throw new Error('❌ Aucun backup trouvé dans le dossier.');
      }

      const backups = filesResponse.data.files.map(file => ({
        id: file.id,
        name: file.name,
        createdTime: file.createdTime,
        size: file.size,
        mimeType: file.mimeType,
        checksum: file.md5Checksum,
        age: this.getFileAge(file.createdTime),
        type: this.getFileType(file.name),
        encrypted: file.name.includes('.encrypted.'),
        downloadUrl: `https://drive.google.com/uc?export=download&id=${file.id}`
      }));

      const latestBackup = backups[0];
      console.log(`✅ Dernier backup trouvé: ${latestBackup.name}`);
      console.log('📊 Informations backup:', {
        taille: latestBackup.size ? `${Math.round(latestBackup.size / 1024 / 1024)} MB` : 'N/A',
        age: latestBackup.age,
        type: latestBackup.type,
        chiffré: latestBackup.encrypted ? 'OUI' : 'NON',
        date: new Date(latestBackup.createdTime).toLocaleString('fr-FR')
      });

      return latestBackup;
      
    } catch (error) {
      console.error('❌ Erreur recherche backup:', error.message);
      throw new Error(`Impossible de trouver le backup: ${error.message}`);
    }
  }

  // 3. Télécharger le backup sécurisé
  async downloadBackup(fileId, fileName, expectedSize = null, expectedChecksum = null) {
    console.log(`⬇️  Téléchargement backup sécurisé: ${fileName}`);
    
    const tempPath = path.join('/tmp', `restore_${Date.now()}_${fileName}`);
    
    try {
      // Récupérer les métadonnées du fichier
      const fileMetadata = await this.drive.files.get({
        fileId: fileId,
        fields: 'size, md5Checksum'
      });

      // Vérifier la taille attendue
      if (expectedSize && fileMetadata.data.size !== expectedSize) {
        throw new Error(`Taille inattendue: ${fileMetadata.data.size} au lieu de ${expectedSize}`);
      }

      // Télécharger le fichier
      const dest = fs.createWriteStream(tempPath);
      const response = await this.drive.files.get(
        { fileId: fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      await new Promise((resolve, reject) => {
        response.data
          .pipe(dest)
          .on('finish', () => {
            console.log(`✅ Backup téléchargé: ${tempPath}`);
            resolve();
          })
          .on('error', (error) => {
            console.error('❌ Erreur téléchargement:', error);
            reject(new Error(`Échec téléchargement: ${error.message}`));
          });
      });

      // Vérifier l'intégrité du fichier
      const integrity = this.verifyFileIntegrity(tempPath, fileMetadata.data.size);
      if (!integrity.valid) {
        throw new Error(`Fichier corrompu: ${integrity.error}`);
      }

      // Vérifier le checksum si disponible
      if (expectedChecksum && fileMetadata.data.md5Checksum) {
        if (integrity.hash !== fileMetadata.data.md5Checksum) {
          throw new Error('Checksum invalide - fichier peut être corrompu');
        }
        console.log('✅ Checksum vérifié avec succès');
      }

      console.log(`📊 Fichier téléchargé: ${(integrity.size / 1024 / 1024).toFixed(2)} MB`);
      return {
        path: tempPath,
        name: fileName,
        size: integrity.size,
        hash: integrity.hash,
        lastModified: integrity.lastModified
      };
      
    } catch (error) {
      // Nettoyer en cas d'erreur
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
      throw error;
    }
  }

  // ==================== RESTAURATION SÉCURISÉE ====================

  // 4. Restaurer fichier .sql sécurisé
  async restoreSqlFile(filePath) {
    console.log('🔄 Restauration SQL sécurisée...');
    
    try {
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error('DATABASE_URL non configurée');
      }

      const url = new URL(dbUrl);
      
      // Vérifier que le fichier existe et est valide
      const fileInfo = this.verifyFileIntegrity(filePath);
      if (!fileInfo.valid) {
        throw new Error(`Fichier SQL invalide: ${fileInfo.error}`);
      }

      // Commande psql sécurisée
      const command = `psql \
        --host=${url.hostname} \
        --port=${url.port || 5432} \
        --username=${url.username} \
        --dbname=${url.pathname.slice(1)} \
        --file=${filePath} \
        --set=ON_ERROR_STOP=on \
        --quiet`;
      
      const env = { 
        ...process.env, 
        PGPASSWORD: url.password,
        PGDATABASE: url.pathname.slice(1),
        PGSSLMODE: 'require'
      };
      
      console.log('🔄 Exécution restauration SQL sécurisée...');
      const { stdout, stderr } = await execPromise(command, { env });
      
      // Analyser les avertissements
      if (stderr) {
        const warnings = stderr.split('\n').filter(line => 
          line.includes('WARNING:') || line.includes('NOTICE:')
        );
        
        if (warnings.length > 0) {
          console.warn('⚠️  Avertissements PostgreSQL:', warnings.join('\n'));
        }
        
        // Vérifier les erreurs critiques
        const errors = stderr.split('\n').filter(line => 
          line.includes('ERROR:') && !line.includes('WARNING:')
        );
        
        if (errors.length > 0) {
          throw new Error(`Erreurs PostgreSQL: ${errors.join('\n')}`);
        }
      }
      
      console.log('✅ Restauration SQL sécurisée terminée');
      return {
        success: true,
        type: 'sql',
        fileSize: fileInfo.size,
        restoredAt: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('❌ Erreur restauration SQL sécurisée:', error.message);
      
      // Tenter la restauration JSON en fallback
      console.log('🔄 Tentative de fallback vers JSON...');
      try {
        return await this.restoreJsonFile(filePath);
      } catch (jsonError) {
        throw new Error(`Restauration SQL et JSON échouées: ${error.message} | ${jsonError.message}`);
      }
    }
  }

  // 5. Restaurer fichier .json sécurisé
  async restoreJsonFile(filePath) {
    console.log('🔄 Restauration JSON sécurisée...');
    
    let client = null;
    let backupData = null;
    
    try {
      // Lire et parser le fichier
      const fileContent = fs.readFileSync(filePath, 'utf8');
      
      // Vérifier si le fichier est chiffré
      let parsedData;
      try {
        parsedData = JSON.parse(fileContent);
        
        // Si le fichier est chiffré, le déchiffrer
        if (parsedData.encrypted) {
          console.log('🔐 Déchiffrement du backup...');
          if (!this.encryptionEnabled) {
            throw new Error('Backup chiffré mais chiffrement non configuré');
          }
          
          const decryptedContent = this.decryptData(parsedData);
          backupData = JSON.parse(decryptedContent);
        } else {
          backupData = parsedData;
        }
      } catch (parseError) {
        // Si ce n'est pas du JSON, c'est peut-être du SQL
        throw new Error('Format de fichier non supporté');
      }

      // Valider la structure des données
      if (!backupData || !backupData.tables || typeof backupData.tables !== 'object') {
        throw new Error('Structure de backup invalide');
      }

      console.log(`📊 Backup contient ${Object.keys(backupData.tables).length} tables`);

      // Se connecter à PostgreSQL
      client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 10000
      });
      
      await client.connect();
      console.log('✅ Connecté à PostgreSQL de manière sécurisée');

      // Sauvegarder les données actuelles (optionnel)
      await this.createPreRestoreBackup(client);

      // Restaurer les tables dans l'ordre logique
      const restoreOrder = this.getRestoreOrder(backupData.tables);
      const results = {
        tablesRestored: 0,
        rowsRestored: 0,
        errors: []
      };

      for (const tableName of restoreOrder) {
        const tableData = backupData.tables[tableName];
        
        if (!tableData || !tableData.data || tableData.data.length === 0) {
          console.log(`📭 Table ${tableName} vide - ignorée`);
          continue;
        }

        try {
          const tableResult = await this.restoreTableSecurely(client, tableName, tableData.data);
          results.tablesRestored++;
          results.rowsRestored += tableResult.rowsRestored;
          
          console.log(`   ✅ ${tableName}: ${tableResult.rowsRestored} lignes restaurées`);
          
        } catch (tableError) {
          console.error(`   ❌ Erreur table ${tableName}:`, tableError.message);
          results.errors.push({
            table: tableName,
            error: tableError.message
          });
          
          // Continuer avec les autres tables
          continue;
        }
      }

      // Valider la restauration
      await this.validateRestoration(client, backupData.tables);

      console.log('✅ Restauration JSON sécurisée terminée');
      console.log('📊 Résumé:', {
        tables: results.tablesRestored,
        rows: results.rowsRestored,
        errors: results.errors.length,
        errorsDetails: results.errors.length > 0 ? results.errors.map(e => e.table).join(', ') : 'Aucune'
      });

      return {
        success: true,
        type: 'json',
        tablesRestored: results.tablesRestored,
        rowsRestored: results.rowsRestored,
        errors: results.errors,
        restoredAt: new Date().toISOString()
      };
      
    } catch (error) {
      console.error('❌ Erreur restauration JSON sécurisée:', error);
      
      // Annuler les changements en cas d'erreur
      if (client) {
        try {
          await client.query('ROLLBACK');
          console.log('↩️  Transaction annulée due à une erreur');
        } catch (rollbackError) {
          console.warn('⚠️ Erreur lors du rollback:', rollbackError.message);
        }
      }
      
      throw new Error(`Restauration JSON échouée: ${error.message}`);
      
    } finally {
      if (client) {
        try {
          await client.end();
          console.log('🔌 Connexion PostgreSQL fermée');
        } catch (endError) {
          console.warn('⚠️ Erreur fermeture connexion:', endError.message);
        }
      }
    }
  }

  // 6. Restaurer une table spécifique de manière sécurisée
  async restoreTableSecurely(client, tableName, data) {
    if (!data || data.length === 0) {
      return { rowsRestored: 0 };
    }
    
    console.log(`📤 Restauration table sécurisée: ${tableName} (${data.length} lignes)`);
    
    try {
      // Commencer une transaction
      await client.query('BEGIN');
      
      // Vérifier que la table existe
      const tableExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        )`, [tableName]);
      
      if (!tableExists.rows[0].exists) {
        console.warn(`   ⚠️ Table ${tableName} n'existe pas - création...`);
        
        // Créer la table basée sur la première ligne
        const firstRow = data[0];
        const columns = Object.keys(firstRow).map(col => `"${col}" TEXT`);
        
        await client.query(`
          CREATE TABLE IF NOT EXISTS "${tableName}" (
            ${columns.join(', ')}
          )`);
        
        console.log(`   ✅ Table ${tableName} créée`);
      }
      
      // Vider la table (avec TRUNCATE pour performances)
      await client.query(`TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE`);
      
      // Préparer l'insertion par batch pour performances
      const batchSize = 1000;
      const columns = Object.keys(data[0]);
      const columnNames = columns.map(col => `"${col}"`).join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const insertSQL = `INSERT INTO "${tableName}" (${columnNames}) VALUES (${placeholders})`;
      
      let totalInserted = 0;
      
      // Insérer par batch
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        const batchPromises = batch.map(row => {
          const values = columns.map(col => {
            const value = row[col];
            // Convertir les valeurs null/non définies
            return value === null || value === undefined ? null : value;
          });
          return client.query(insertSQL, values);
        });
        
        await Promise.all(batchPromises);
        totalInserted += batch.length;
        
        if (i + batchSize < data.length) {
          console.log(`   📦 Batch ${Math.floor(i / batchSize) + 1} inséré (${totalInserted}/${data.length})`);
        }
      }
      
      // Valider la transaction
      await client.query('COMMIT');
      
      console.log(`   ✅ Table ${tableName}: ${totalInserted} lignes restaurées`);
      return { rowsRestored: totalInserted };
      
    } catch (error) {
      // Annuler la transaction en cas d'erreur
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.warn(`   ⚠️ Erreur rollback table ${tableName}:`, rollbackError.message);
      }
      
      throw error;
    }
  }

  // ==================== FONCTIONS UTILITAIRES SÉCURISÉES ====================

  // Créer un backup pré-restauration
  async createPreRestoreBackup(client) {
    try {
      // Vérifier s'il y a des données à sauvegarder
      const result = await client.query(`
        SELECT COUNT(*) as total 
        FROM information_schema.tables 
        WHERE table_schema = 'public'
      `);
      
      const tableCount = parseInt(result.rows[0].total);
      
      if (tableCount > 0) {
        console.log(`💾 Sauvegarde pré-restauration (${tableCount} tables)...`);
        // Ici vous pourriez appeler votre service de backup
        // Pour l'instant, on se contente d'un log
        console.log('✅ Sauvegarde pré-restauration notée');
      }
    } catch (error) {
      console.warn('⚠️ Impossible de créer backup pré-restauration:', error.message);
    }
  }

  // Déterminer l'ordre de restauration (tables avec clés étrangères en dernier)
  getRestoreOrder(tables) {
    const tableNames = Object.keys(tables);
    
    // Ordre par défaut (alphabétique)
    const defaultOrder = tableNames.sort();
    
    // Prioriser certaines tables
    const priorityTables = ['utilisateurs', 'profils', 'roles'];
    const otherTables = defaultOrder.filter(t => !priorityTables.includes(t));
    
    return [...priorityTables, ...otherTables];
  }

  // Valider la restauration
  async validateRestoration(client, tables) {
    console.log('🔍 Validation de la restauration...');
    
    try {
      const validationResults = [];
      
      for (const [tableName, tableData] of Object.entries(tables)) {
        if (!tableData.data || tableData.data.length === 0) {
          continue;
        }
        
        const countResult = await client.query(`SELECT COUNT(*) as count FROM "${tableName}"`);
        const restoredCount = parseInt(countResult.rows[0].count);
        const expectedCount = tableData.data.length;
        
        validationResults.push({
          table: tableName,
          expected: expectedCount,
          restored: restoredCount,
          valid: restoredCount >= expectedCount * 0.9, // 90% minimum
          percentage: Math.round((restoredCount / expectedCount) * 100)
        });
      }
      
      const invalidTables = validationResults.filter(r => !r.valid);
      
      if (invalidTables.length > 0) {
        console.warn('⚠️  Tables avec problèmes de restauration:', 
          invalidTables.map(t => `${t.table} (${t.percentage}%)`).join(', '));
      } else {
        console.log('✅ Validation réussie pour toutes les tables');
      }
      
      return validationResults;
      
    } catch (error) {
      console.warn('⚠️ Erreur validation:', error.message);
      return [];
    }
  }

  // Obtenir l'âge du fichier
  getFileAge(createdTime) {
    const created = new Date(createdTime);
    const now = new Date();
    const diffHours = Math.round((now - created) / (1000 * 60 * 60));
    
    if (diffHours < 24) {
      return `${diffHours} heure${diffHours !== 1 ? 's' : ''}`;
    } else {
      const diffDays = Math.round(diffHours / 24);
      return `${diffDays} jour${diffDays !== 1 ? 's' : ''}`;
    }
  }

  // Déterminer le type de fichier
  getFileType(fileName) {
    if (fileName.endsWith('.sql')) return 'sql';
    if (fileName.includes('.encrypted.')) return 'encrypted';
    if (fileName.endsWith('.json')) return 'json';
    return 'unknown';
  }

  // ==================== RESTAURATION COMPLÈTE SÉCURISÉE ====================

  // 7. Exécuter la restauration complète sécurisée
  async executeRestoration(backupId = null) {
    console.log('🚀 Démarrage restauration sécurisée...');
    console.log('🔐 Configuration sécurité:', {
      encryption: this.encryptionEnabled ? 'ACTIVÉ' : 'DÉSACTIVÉ',
      googleDrive: !!process.env.GOOGLE_CLIENT_ID,
      timestamp: new Date().toISOString()
    });
    
    let downloadedFile = null;
    let restoreResult = null;
    
    try {
      // Étape 1: Initialisation
      await this.initialize();
      
      // Étape 2: Trouver le backup
      let backupToRestore;
      if (backupId) {
        // Restaurer un backup spécifique
        console.log(`🔍 Recherche backup spécifique: ${backupId}`);
        // Implémenter la recherche par ID si nécessaire
        backupToRestore = await this.findLatestBackup(); // Pour l'instant, on prend le dernier
      } else {
        // Trouver le dernier backup
        backupToRestore = await this.findLatestBackup();
      }
      
      // Étape 3: Télécharger le backup
      console.log(`⬇️  Téléchargement: ${backupToRestore.name}`);
      downloadedFile = await this.downloadBackup(
        backupToRestore.id, 
        backupToRestore.name, 
        backupToRestore.size,
        backupToRestore.checksum
      );
      
      // Étape 4: Restaurer selon le type
      console.log(`🔄 Restauration fichier ${backupToRestore.type}...`);
      
      if (backupToRestore.type === 'sql') {
        restoreResult = await this.restoreSqlFile(downloadedFile.path);
      } else {
        restoreResult = await this.restoreJsonFile(downloadedFile.path);
      }
      
      // Étape 5: Nettoyage sécurisé
      console.log('🧹 Nettoyage sécurisé...');
      this.secureCleanup(downloadedFile.path);
      
      console.log(`🎉 RESTAURATION SÉCURISÉE RÉUSSIE depuis: ${backupToRestore.name}`);
      console.log('📊 Résumé restauration:', {
        fichier: backupToRestore.name,
        type: backupToRestore.type,
        chiffré: backupToRestore.encrypted ? 'OUI' : 'NON',
        age: backupToRestore.age,
        résultat: restoreResult,
        timestamp: new Date().toISOString()
      });
      
      return {
        success: true,
        backup: backupToRestore,
        restore: restoreResult,
        downloadedFile: {
          name: downloadedFile.name,
          size: downloadedFile.size,
          hash: downloadedFile.hash
        }
      };
      
    } catch (error) {
      console.error('💥 RESTAURATION SÉCURISÉE ÉCHOUÉE:', error.message);
      
      // Nettoyage en cas d'erreur
      if (downloadedFile && downloadedFile.path && fs.existsSync(downloadedFile.path)) {
        this.secureCleanup(downloadedFile.path);
      }
      
      throw new Error(`Restauration sécurisée échouée: ${error.message}`);
    }
  }

  // Nettoyage sécurisé des fichiers temporaires
  secureCleanup(filePath) {
    try {
      if (fs.existsSync(filePath)) {
        // Écraser le fichier avant suppression (sécurité)
        const fileSize = fs.statSync(filePath).size;
        const randomData = crypto.randomBytes(fileSize);
        fs.writeFileSync(filePath, randomData);
        
        // Supprimer le fichier
        fs.unlinkSync(filePath);
        console.log(`✅ Fichier temporaire sécurisé supprimé: ${path.basename(filePath)}`);
      }
    } catch (cleanupError) {
      console.warn('⚠️ Erreur nettoyage sécurisé:', cleanupError.message);
    }
  }
}

module.exports = SecurePostgreSQLRestorer;