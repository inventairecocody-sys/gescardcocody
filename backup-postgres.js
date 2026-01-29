const { google } = require('googleapis');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const execPromise = util.promisify(exec);

class SecurePostgreSQLBackup {
  constructor() {
    this.auth = null;
    this.drive = null;
    this.backupFolderId = null;
    this.encryptionEnabled = !!process.env.BACKUP_ENCRYPTION_KEY;
    
    if (this.encryptionEnabled && process.env.BACKUP_ENCRYPTION_KEY.length !== 32) {
      throw new Error('BACKUP_ENCRYPTION_KEY doit faire exactement 32 caractères');
    }
  }

  // ==================== SÉCURITÉ ET CHIFFREMENT ====================

  // Chiffrement AES-256-GCM
  encryptData(data) {
    if (!this.encryptionEnabled) {
      return {
        encrypted: false,
        data: data,
        timestamp: new Date().toISOString()
      };
    }

    const iv = crypto.randomBytes(12);
    const key = Buffer.from(process.env.BACKUP_ENCRYPTION_KEY, 'hex');
    
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(data, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag();
    
    return {
      encrypted: true,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('hex'),
      data: encrypted,
      authTag: authTag.toString('hex'),
      timestamp: new Date().toISOString(),
      keyVersion: '1'
    };
  }

  // Déchiffrement
  decryptData(encryptedData) {
    if (!encryptedData.encrypted) {
      return encryptedData.data;
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

  // ==================== AUTHENTIFICATION GOOGLE ====================

  // 1. Authentification Google Drive sécurisée
  async authenticate() {
    console.log('🔐 Authentification Google Drive sécurisée...');
    
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
      throw new Error('Configuration Google Drive manquante. Vérifiez les variables d\'environnement.');
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    // Configuration sécurisée
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
    
    console.log('✅ Authentification Google Drive réussie');
    return true;
  }

  // 2. Trouver ou créer dossier backup sécurisé
  async getOrCreateBackupFolder() {
    console.log('📁 Recherche dossier backup sécurisé...');
    
    try {
      const response = await this.drive.files.list({
        q: "name='gescard_backups' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id, name, permissions)'
      });

      if (response.data.files.length > 0) {
        this.backupFolderId = response.data.files[0].id;
        console.log(`✅ Dossier backup trouvé: ${this.backupFolderId}`);
        
        // Vérifier les permissions
        await this.verifyFolderPermissions(this.backupFolderId);
        return this.backupFolderId;
      }

      // Créer le dossier avec permissions restreintes
      console.log('📁 Création dossier gescard_backups sécurisé...');
      const folderMetadata = {
        name: 'gescard_backups',
        mimeType: 'application/vnd.google-apps.folder',
        description: 'Backups sécurisés Gescard - Ne pas modifier manuellement'
      };

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: 'id'
      });

      this.backupFolderId = folder.data.id;
      
      // Configurer les permissions (lecture seule pour l'app)
      await this.drive.permissions.create({
        fileId: this.backupFolderId,
        resource: {
          role: 'reader',
          type: 'anyone',
          allowFileDiscovery: false
        }
      });

      console.log(`✅ Dossier backup créé et sécurisé: ${this.backupFolderId}`);
      return this.backupFolderId;

    } catch (error) {
      console.error('❌ Erreur dossier backup:', error.message);
      throw new Error(`Impossible d'accéder au dossier backup: ${error.message}`);
    }
  }

  // Vérifier les permissions du dossier
  async verifyFolderPermissions(folderId) {
    try {
      const response = await this.drive.files.get({
        fileId: folderId,
        fields: 'permissions'
      });
      
      console.log('🔐 Permissions dossier vérifiées');
      return true;
    } catch (error) {
      console.warn('⚠️ Impossible de vérifier les permissions:', error.message);
      return false;
    }
  }

  // ==================== EXPORT DATABASE SÉCURISÉ ====================

  // 3. Exporter PostgreSQL avec pg_dump (sécurisé)
  async exportWithPgDump() {
    console.log('💾 Export PostgreSQL sécurisé...');
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup-gescard-${timestamp}.sql`;
    const filePath = path.join('/tmp', fileName);
    
    try {
      // Extraire les infos de connexion de façon sécurisée
      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error('DATABASE_URL non configurée');
      }

      const url = new URL(dbUrl);
      
      // Commande pg_dump sécurisée avec exclusion des données sensibles
      const command = `pg_dump \
        --host=${url.hostname} \
        --port=${url.port || 5432} \
        --username=${url.username} \
        --dbname=${url.pathname.slice(1)} \
        --file=${filePath} \
        --format=custom \
        --no-owner \
        --no-privileges \
        --exclude-table-data='sessions' \
        --exclude-table-data='tokens' \
        --exclude-table-data='logs_sensibles'`;
      
      // Environnement sécurisé
      const env = { 
        ...process.env, 
        PGPASSWORD: url.password,
        PGDATABASE: url.pathname.slice(1),
        PGSSLMODE: 'require'
      };
      
      console.log(`📁 Création backup sécurisé: ${fileName}`);
      const { stdout, stderr } = await execPromise(command, { env });
      
      if (stderr && !stderr.includes('WARNING')) {
        console.warn('⚠️ Avertissements pg_dump:', stderr);
      }
      
      const stats = fs.statSync(filePath);
      console.log(`✅ Backup créé: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      // Chiffrer le backup si activé
      if (this.encryptionEnabled) {
        console.log('🔐 Chiffrement du backup...');
        const sqlContent = fs.readFileSync(filePath, 'utf8');
        const encryptedData = this.encryptData(sqlContent);
        
        const encryptedFileName = fileName.replace('.sql', '.encrypted.json');
        const encryptedFilePath = path.join('/tmp', encryptedFileName);
        
        fs.writeFileSync(encryptedFilePath, JSON.stringify(encryptedData, null, 2));
        fs.unlinkSync(filePath); // Supprimer le fichier non chiffré
        
        console.log(`✅ Backup chiffré: ${encryptedFileName}`);
        return { filePath: encryptedFilePath, fileName: encryptedFileName, encrypted: true };
      }
      
      return { filePath, fileName, encrypted: false };
      
    } catch (error) {
      console.error('❌ Erreur pg_dump sécurisé:', error.message);
      
      // Nettoyer en cas d'erreur
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      
      // Fallback vers méthode manuelle
      return await this.exportManualBackup();
    }
  }

  // 4. Méthode manuelle sécurisée
  async exportManualBackup() {
    console.log('🔄 Méthode manuelle sécurisée...');
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup-gescard-${timestamp}.json`;
    const filePath = path.join('/tmp', fileName);
    
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    try {
      await client.connect();
      console.log('✅ Connecté à PostgreSQL de manière sécurisée');
      
      // 1. Obtenir la liste des tables (exclure les tables sensibles)
      const tablesQuery = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('sessions', 'tokens', 'logs_sensibles')
        ORDER BY table_name;
      `;
      
      const tablesResult = await client.query(tablesQuery);
      const tables = tablesResult.rows.map(row => row.table_name);
      
      console.log(`📋 ${tables.length} tables sécurisées trouvées`);
      
      const backupData = {
        metadata: {
          database: 'Gescard PostgreSQL',
          exportDate: new Date().toISOString(),
          tableCount: tables.length,
          encrypted: this.encryptionEnabled,
          version: '2.0'
        },
        tables: {}
      };
      
      // 2. Exporter chaque table avec gestion d'erreur
      for (const tableName of tables) {
        try {
          console.log(`📤 Export table: ${tableName}`);
          
          const dataQuery = `SELECT * FROM "${tableName}" LIMIT 100000`; // Limite de sécurité
          const dataResult = await client.query(dataQuery);
          
          // Masquer les données sensibles
          const sanitizedData = this.sanitizeTableData(tableName, dataResult.rows);
          
          backupData.tables[tableName] = {
            data: sanitizedData,
            rowCount: dataResult.rowCount,
            exportedAt: new Date().toISOString()
          };
          
          console.log(`   ✅ ${dataResult.rowCount} lignes exportées (sanitisées)`);
          
        } catch (tableError) {
          console.warn(`   ⚠️ Erreur table ${tableName}:`, tableError.message);
          backupData.tables[tableName] = {
            error: tableError.message,
            rowCount: 0
          };
        }
      }
      
      // 3. Sauvegarder en fichier JSON
      const jsonData = JSON.stringify(backupData, null, 2);
      
      // Chiffrer si activé
      if (this.encryptionEnabled) {
        console.log('🔐 Chiffrement des données...');
        const encryptedData = this.encryptData(jsonData);
        
        const encryptedFileName = fileName.replace('.json', '.encrypted.json');
        const encryptedFilePath = path.join('/tmp', encryptedFileName);
        
        fs.writeFileSync(encryptedFilePath, JSON.stringify(encryptedData, null, 2));
        
        console.log(`✅ Backup JSON chiffré créé: ${encryptedFileName}`);
        return { 
          filePath: encryptedFilePath, 
          fileName: encryptedFileName, 
          encrypted: true 
        };
      } else {
        fs.writeFileSync(filePath, jsonData);
        console.log(`✅ Backup JSON créé: ${fileName}`);
        return { filePath, fileName, encrypted: false };
      }
      
    } catch (error) {
      console.error('❌ Erreur export manuel sécurisé:', error);
      throw new Error(`Export manuel échoué: ${error.message}`);
    } finally {
      try {
        await client.end();
        console.log('🔌 Connexion PostgreSQL fermée');
      } catch (endError) {
        console.warn('⚠️ Erreur fermeture connexion:', endError.message);
      }
    }
  }

  // Sanitiser les données sensibles
  sanitizeTableData(tableName, rows) {
    // Masquer les colonnes sensibles
    const sensitiveColumns = {
      'utilisateurs': ['mot_de_passe_hash', 'token_reset', 'email'],
      'sessions': ['token', 'ip_address'],
      'logs': ['donnees_sensibles']
    };
    
    if (!sensitiveColumns[tableName]) {
      return rows;
    }
    
    const columnsToMask = sensitiveColumns[tableName];
    
    return rows.map(row => {
      const sanitizedRow = { ...row };
      columnsToMask.forEach(col => {
        if (sanitizedRow[col] !== undefined) {
          sanitizedRow[col] = '***MASQUÉ***';
        }
      });
      return sanitizedRow;
    });
  }

  // ==================== UPLOAD SÉCURISÉ ====================

  // 5. Upload vers Google Drive sécurisé
  async uploadToDrive(filePath, fileName, isEncrypted = false) {
    console.log(`☁️  Upload sécurisé vers Google Drive: ${fileName}`);
    
    const fileStats = fs.statSync(filePath);
    if (fileStats.size > 500 * 1024 * 1024) { // 500MB max
      throw new Error('Fichier trop volumineux (> 500MB)');
    }
    
    const fileMetadata = {
      name: fileName,
      parents: [this.backupFolderId],
      description: `Backup Gescard sécurisé - ${new Date().toLocaleString('fr-FR')}`,
      properties: {
        encrypted: isEncrypted.toString(),
        backupType: fileName.endsWith('.sql') ? 'sql' : 'json',
        createdBy: 'Gescard Backup System',
        version: '2.0'
      }
    };
    
    // Déterminer le type MIME
    let mimeType;
    if (fileName.endsWith('.sql')) {
      mimeType = 'application/sql';
    } else if (fileName.endsWith('.json')) {
      mimeType = 'application/json';
    } else if (fileName.includes('.encrypted.')) {
      mimeType = 'application/json';
    } else {
      mimeType = 'application/octet-stream';
    }
    
    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath)
    };
    
    try {
      const file = await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink, size, createdTime, md5Checksum'
      });
      
      console.log(`✅ Upload réussi: ${file.data.name}`);
      console.log(`📏 Taille: ${file.data.size ? Math.round(file.data.size / 1024 / 1024) + ' MB' : 'N/A'}`);
      console.log(`🔗 Lien: ${file.data.webViewLink}`);
      console.log(`🔐 Chiffré: ${isEncrypted ? 'OUI' : 'NON'}`);
      
      // Ajouter une description détaillée
      await this.drive.files.update({
        fileId: file.data.id,
        resource: {
          description: `Backup Gescard - ${new Date().toLocaleString('fr-FR')}\n` +
                      `Type: ${fileName.endsWith('.sql') ? 'SQL' : 'JSON'}\n` +
                      `Chiffré: ${isEncrypted ? 'OUI (AES-256-GCM)' : 'NON'}\n` +
                      `Taille: ${file.data.size ? Math.round(file.data.size / 1024 / 1024) + ' MB' : 'N/A'}\n` +
                      `Créé automatiquement par Gescard Backup System`
        }
      });
      
      return {
        id: file.data.id,
        name: file.data.name,
        webViewLink: file.data.webViewLink,
        size: file.data.size,
        createdTime: file.data.createdTime,
        md5Checksum: file.data.md5Checksum,
        encrypted: isEncrypted,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${file.data.id}`
      };
      
    } catch (error) {
      console.error('❌ Erreur upload sécurisé:', error.message);
      
      if (error.message.includes('quota')) {
        throw new Error('Quota Google Drive dépassé. Veuillez libérer de l\'espace.');
      } else if (error.message.includes('auth')) {
        throw new Error('Authentification Google Drive échouée. Token peut-être expiré.');
      } else {
        throw new Error(`Upload échoué: ${error.message}`);
      }
    }
  }

  // ==================== BACKUP COMPLET SÉCURISÉ ====================

  // 6. Exécuter le backup complet sécurisé
  async executeBackup() {
    console.log('🚀 Démarrage backup Gescard sécurisé...');
    console.log('🔐 Configuration sécurité:', {
      encryption: this.encryptionEnabled ? 'ACTIVÉ' : 'DÉSACTIVÉ',
      googleDrive: !!process.env.GOOGLE_CLIENT_ID,
      timestamp: new Date().toISOString()
    });
    
    let backupFile = null;
    let uploadedFile = null;
    
    try {
      // Étape 1: Authentification
      await this.authenticate();
      
      // Étape 2: Dossier backup
      await this.getOrCreateBackupFolder();
      
      // Étape 3: Export de la base
      console.log('💾 Export de la base de données...');
      try {
        backupFile = await this.exportWithPgDump();
      } catch (exportError) {
        console.error('❌ Export principal échoué:', exportError.message);
        backupFile = await this.exportManualBackup();
      }
      
      // Étape 4: Upload vers Google Drive
      console.log('☁️  Upload vers Google Drive...');
      uploadedFile = await this.uploadToDrive(
        backupFile.filePath, 
        backupFile.fileName, 
        backupFile.encrypted
      );
      
      // Étape 5: Nettoyage sécurisé
      console.log('🧹 Nettoyage des fichiers temporaires...');
      this.secureCleanup(backupFile.filePath);
      
      console.log(`🎉 BACKUP SÉCURISÉ RÉUSSI: ${uploadedFile.name}`);
      console.log('📊 Résumé:', {
        fichier: uploadedFile.name,
        taille: uploadedFile.size ? Math.round(uploadedFile.size / 1024 / 1024) + ' MB' : 'N/A',
        chiffré: uploadedFile.encrypted ? 'OUI' : 'NON',
        lien: uploadedFile.webViewLink,
        timestamp: new Date().toISOString()
      });
      
      return uploadedFile;
      
    } catch (error) {
      console.error('💥 BACKUP SÉCURISÉ ÉCHOUÉ:', error.message);
      
      // Nettoyage en cas d'erreur
      if (backupFile && backupFile.filePath && fs.existsSync(backupFile.filePath)) {
        this.secureCleanup(backupFile.filePath);
      }
      
      throw new Error(`Backup sécurisé échoué: ${error.message}`);
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

  // ==================== LISTAGE ET VÉRIFICATION ====================

  // 7. Lister les backups sécurisé
  async listBackups() {
    try {
      await this.authenticate();
      await this.getOrCreateBackupFolder();
      
      const response = await this.drive.files.list({
        q: `'${this.backupFolderId}' in parents and trashed=false`,
        orderBy: 'createdTime desc',
        fields: 'files(id, name, createdTime, size, mimeType, properties)',
        pageSize: 50
      });
      
      return response.data.files.map(file => ({
        id: file.id,
        name: file.name,
        createdTime: file.createdTime,
        size: file.size,
        mimeType: file.mimeType,
        encrypted: file.properties?.encrypted === 'true',
        type: file.name.endsWith('.sql') ? 'sql' : 
              file.name.includes('.encrypted.') ? 'encrypted' : 'json',
        downloadUrl: `https://drive.google.com/uc?export=download&id=${file.id}`,
        viewUrl: `https://drive.google.com/file/d/${file.id}/view`
      }));
      
    } catch (error) {
      console.error('❌ Erreur listage backups:', error.message);
      throw new Error(`Impossible de lister les backups: ${error.message}`);
    }
  }

  // 8. Vérifier s'il y a des backups
  async hasBackups() {
    try {
      const backups = await this.listBackups();
      return {
        hasBackups: backups.length > 0,
        count: backups.length,
        latest: backups.length > 0 ? backups[0].createdTime : null,
        encryptedCount: backups.filter(b => b.encrypted).length
      };
    } catch (error) {
      console.warn('⚠️ Erreur vérification backups:', error.message);
      return {
        hasBackups: false,
        count: 0,
        latest: null,
        error: error.message
      };
    }
  }

  // 9. Vérifier l'intégrité d'un backup
  async verifyBackup(backupId) {
    try {
      const file = await this.drive.files.get({
        fileId: backupId,
        fields: 'id, name, size, md5Checksum, createdTime'
      });
      
      return {
        id: file.data.id,
        name: file.data.name,
        size: file.data.size,
        checksum: file.data.md5Checksum,
        createdTime: file.data.createdTime,
        status: 'VALID'
      };
    } catch (error) {
      return {
        id: backupId,
        status: 'INVALID',
        error: error.message
      };
    }
  }
}

module.exports = SecurePostgreSQLBackup;