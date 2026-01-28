const { google } = require('googleapis');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class PostgreSQLBackup {
  constructor() {
    this.auth = null;
    this.drive = null;
    this.backupFolderId = null;
  }

  // 1. Authentification Google Drive
  async authenticate() {
    console.log('🔐 Authentification Google Drive...');
    
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN
    });

    this.auth = oauth2Client;
    this.drive = google.drive({ version: 'v3', auth: oauth2Client });
    
    console.log('✅ Authentification réussie');
  }

  // 2. Trouver ou créer dossier backup
  async getOrCreateBackupFolder() {
    console.log('📁 Recherche dossier backup...');
    
    try {
      const response = await this.drive.files.list({
        q: "name='gescard_backups' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        fields: 'files(id, name)'
      });

      if (response.data.files.length > 0) {
        this.backupFolderId = response.data.files[0].id;
        console.log(`✅ Dossier trouvé: ${this.backupFolderId}`);
        return this.backupFolderId;
      }

      // Créer le dossier
      console.log('📁 Création dossier gescard_backups...');
      const folderMetadata = {
        name: 'gescard_backups',
        mimeType: 'application/vnd.google-apps.folder'
      };

      const folder = await this.drive.files.create({
        resource: folderMetadata,
        fields: 'id'
      });

      this.backupFolderId = folder.data.id;
      console.log(`✅ Dossier créé: ${this.backupFolderId}`);
      return this.backupFolderId;

    } catch (error) {
      console.error('❌ Erreur dossier:', error);
      throw error;
    }
  }

  // 3. Exporter PostgreSQL avec pg_dump (méthode rapide)
  async exportWithPgDump() {
    console.log('💾 Export PostgreSQL avec pg_dump...');
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup-gescard-${timestamp}.sql`;
    const filePath = path.join('/tmp', fileName);
    
    // Extraire les infos de connexion de DATABASE_URL
    const dbUrl = new URL(process.env.DATABASE_URL);
    
    const command = `pg_dump \
      --host=${dbUrl.hostname} \
      --port=${dbUrl.port || 5432} \
      --username=${dbUrl.username} \
      --dbname=${dbUrl.pathname.slice(1)} \
      --file=${filePath} \
      --format=plain \
      --no-owner \
      --no-privileges \
      --inserts`;
    
    // Ajouter le mot de passe
    const env = { ...process.env, PGPASSWORD: dbUrl.password };
    
    try {
      console.log(`📁 Création backup: ${fileName}`);
      await execPromise(command, { env });
      
      const stats = fs.statSync(filePath);
      console.log(`✅ Backup créé: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      return { filePath, fileName };
      
    } catch (error) {
      console.error('❌ Erreur pg_dump:', error);
      return await this.exportManualBackup();
    }
  }

  // 4. Méthode manuelle si pg_dump échoue
  async exportManualBackup() {
    console.log('🔄 Méthode manuelle d\'export...');
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `backup-gescard-${timestamp}.json`;
    const filePath = path.join('/tmp', fileName);
    
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    try {
      await client.connect();
      console.log('✅ Connecté à PostgreSQL');
      
      // 1. Obtenir la liste des tables
      const tablesQuery = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `;
      
      const tablesResult = await client.query(tablesQuery);
      const tables = tablesResult.rows.map(row => row.table_name);
      
      console.log(`📋 ${tables.length} tables trouvées`);
      
      const backupData = {
        metadata: {
          database: 'Gescard PostgreSQL',
          exportDate: new Date().toISOString(),
          tableCount: tables.length
        },
        tables: {}
      };
      
      // 2. Exporter chaque table
      for (const tableName of tables) {
        console.log(`📤 Export table: ${tableName}`);
        
        const dataQuery = `SELECT * FROM "${tableName}"`;
        const dataResult = await client.query(dataQuery);
        
        backupData.tables[tableName] = {
          data: dataResult.rows,
          rowCount: dataResult.rowCount
        };
        
        console.log(`   ✅ ${dataResult.rowCount} lignes exportées`);
      }
      
      // 3. Sauvegarder en fichier JSON
      fs.writeFileSync(filePath, JSON.stringify(backupData, null, 2));
      
      console.log(`✅ Backup JSON créé: ${fileName}`);
      return { filePath, fileName };
      
    } catch (error) {
      console.error('❌ Erreur export manuel:', error);
      throw error;
    } finally {
      await client.end();
    }
  }

  // 5. Upload vers Google Drive
  async uploadToDrive(filePath, fileName) {
    console.log(`☁️  Upload vers Google Drive: ${fileName}`);
    
    const fileMetadata = {
      name: fileName,
      parents: [this.backupFolderId],
      description: `Backup Gescard - ${new Date().toLocaleString()}`
    };
    
    const mimeType = fileName.endsWith('.sql') 
      ? 'application/sql' 
      : 'application/json';
    
    const media = {
      mimeType: mimeType,
      body: fs.createReadStream(filePath)
    };
    
    try {
      const file = await this.drive.files.create({
        resource: fileMetadata,
        media: media,
        fields: 'id, name, webViewLink, size'
      });
      
      console.log(`✅ Upload réussi: ${file.data.name}`);
      console.log(`🔗 Lien: ${file.data.webViewLink}`);
      
      return file.data;
      
    } catch (error) {
      console.error('❌ Erreur upload:', error);
      throw error;
    }
  }

  // 6. Exécuter le backup complet
  async executeBackup() {
    console.log('🚀 Démarrage backup Gescard...');
    
    try {
      await this.authenticate();
      await this.getOrCreateBackupFolder();
      
      // Essayer pg_dump d'abord, sinon méthode manuelle
      let backupFile;
      try {
        backupFile = await this.exportWithPgDump();
      } catch (error) {
        console.log('⚠️  pg_dump échoué, méthode JSON');
        backupFile = await this.exportManualBackup();
      }
      
      // Upload
      const uploadedFile = await this.uploadToDrive(
        backupFile.filePath, 
        backupFile.fileName
      );
      
      // Nettoyage
      fs.unlinkSync(backupFile.filePath);
      
      console.log(`🎉 BACKUP RÉUSSI: ${uploadedFile.name}`);
      return uploadedFile;
      
    } catch (error) {
      console.error('💥 BACKUP ÉCHOUÉ:', error);
      throw error;
    }
  }

  // 7. Lister les backups
  async listBackups() {
    await this.authenticate();
    await this.getOrCreateBackupFolder();
    
    const response = await this.drive.files.list({
      q: `'${this.backupFolderId}' in parents and trashed=false`,
      orderBy: 'createdTime desc',
      fields: 'files(id, name, createdTime, size, mimeType)'
    });
    
    return response.data.files;
  }

  // 8. Vérifier s'il y a des backups
  async hasBackups() {
    try {
      const backups = await this.listBackups();
      return backups.length > 0;
    } catch (error) {
      return false;
    }
  }
}

module.exports = PostgreSQLBackup;