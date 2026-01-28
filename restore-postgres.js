const { google } = require('googleapis');
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class PostgreSQLRestorer {
  constructor() {
    this.drive = null;
    this.auth = null;
  }

  // 1. Initialisation
  async initialize() {
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
  }

  // 2. Trouver le dernier backup
  async findLatestBackup() {
    console.log('🔍 Recherche dernier backup...');
    
    // Trouver le dossier
    const folderResponse = await this.drive.files.list({
      q: "name='gescard_backups' and mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'files(id)'
    });

    if (folderResponse.data.files.length === 0) {
      throw new Error('❌ Aucun dossier de backup trouvé');
    }

    const folderId = folderResponse.data.files[0].id;

    // Chercher le dernier fichier
    const filesResponse = await this.drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      orderBy: 'createdTime desc',
      pageSize: 1,
      fields: 'files(id, name, createdTime)'
    });

    if (filesResponse.data.files.length === 0) {
      throw new Error('❌ Aucun backup trouvé');
    }

    const latestBackup = filesResponse.data.files[0];
    console.log(`✅ Dernier backup: ${latestBackup.name}`);
    
    return latestBackup;
  }

  // 3. Télécharger le backup
  async downloadBackup(fileId, fileName) {
    console.log('⬇️  Téléchargement backup...');
    
    const tempPath = path.join('/tmp', fileName);
    
    const dest = fs.createWriteStream(tempPath);
    const response = await this.drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      response.data
        .pipe(dest)
        .on('finish', () => {
          console.log(`✅ Backup téléchargé: ${tempPath}`);
          resolve(tempPath);
        })
        .on('error', reject);
    });
  }

  // 4. Restaurer fichier .sql
  async restoreSqlFile(filePath) {
    console.log('🔄 Restauration SQL...');
    
    const dbUrl = new URL(process.env.DATABASE_URL);
    
    // Commande psql pour restaurer
    const command = `psql \
      --host=${dbUrl.hostname} \
      --port=${dbUrl.port || 5432} \
      --username=${dbUrl.username} \
      --dbname=${dbUrl.pathname.slice(1)} \
      --file=${filePath}`;
    
    const env = { ...process.env, PGPASSWORD: dbUrl.password };
    
    try {
      console.log('🔄 Exécution restauration SQL...');
      const { stdout, stderr } = await execPromise(command, { env });
      
      if (stderr && !stderr.includes('WARNING:')) {
        console.warn('⚠️  Avertissements:', stderr);
      }
      
      console.log('✅ Restauration SQL terminée');
      return true;
      
    } catch (error) {
      console.error('❌ Erreur restauration SQL:', error);
      return await this.restoreJsonFile(filePath);
    }
  }

  // 5. Restaurer fichier .json
  async restoreJsonFile(filePath) {
    console.log('🔄 Restauration JSON...');
    
    const backupData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    try {
      await client.connect();
      
      // Pour chaque table dans le backup
      for (const [tableName, tableData] of Object.entries(backupData.tables)) {
        console.log(`📤 Restauration table: ${tableName}`);
        
        if (tableData.data && tableData.data.length > 0) {
          await this.restoreTable(client, tableName, tableData.data);
        }
      }
      
      console.log('✅ Restauration JSON terminée');
      return true;
      
    } catch (error) {
      console.error('❌ Erreur restauration JSON:', error);
      throw error;
    } finally {
      await client.end();
    }
  }

  // 6. Restaurer une table spécifique
  async restoreTable(client, tableName, data) {
    if (data.length === 0) return;
    
    try {
      // Vider la table (DELETE au lieu de DROP pour préserver la structure)
      await client.query(`DELETE FROM "${tableName}"`);
      
      // Prendre les colonnes du premier objet
      const columns = Object.keys(data[0]);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      const columnNames = columns.map(col => `"${col}"`).join(', ');
      
      const insertSQL = `INSERT INTO "${tableName}" (${columnNames}) VALUES (${placeholders})`;
      
      // Insérer ligne par ligne
      for (const row of data) {
        const values = columns.map(col => row[col]);
        await client.query(insertSQL, values);
      }
      
      console.log(`   ✅ ${data.length} lignes restaurées dans ${tableName}`);
      
    } catch (error) {
      console.error(`   ❌ Erreur table ${tableName}:`, error.message);
      // Continuer avec les autres tables
    }
  }

  // 7. Exécuter la restauration complète
  async executeRestoration() {
    console.log('🚀 Démarrage restauration...');
    
    try {
      await this.initialize();
      const latestBackup = await this.findLatestBackup();
      const filePath = await this.downloadBackup(latestBackup.id, latestBackup.name);
      
      // Restaurer selon le type de fichier
      if (latestBackup.name.endsWith('.sql')) {
        await this.restoreSqlFile(filePath);
      } else if (latestBackup.name.endsWith('.json')) {
        await this.restoreJsonFile(filePath);
      }
      
      // Nettoyage
      fs.unlinkSync(filePath);
      
      console.log(`🎉 RESTAURATION RÉUSSIE depuis: ${latestBackup.name}`);
      return true;
      
    } catch (error) {
      console.error('💥 RESTAURATION ÉCHOUÉE:', error);
      throw error;
    }
  }
}

module.exports = PostgreSQLRestorer;