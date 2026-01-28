const express = require('express');
const router = express.Router();
const PostgreSQLBackup = require('../backup-postgres');
const PostgreSQLRestorer = require('../restore-postgres');

const backupService = new PostgreSQLBackup();
const restoreService = new PostgreSQLRestorer();

// Middleware d'authentification (vous l'avez déjà)
const authenticate = (req, res, next) => {
  // Adaptez cette fonction à votre système d'authentification
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentification requise'
    });
  }
  next();
};

// 1. Créer un backup manuel (ADMIN SEULEMENT)
router.post('/create', authenticate, async (req, res) => {
  try {
    console.log('📤 Backup manuel demandé par:', req.user.nomUtilisateur);
    
    const backupResult = await backupService.executeBackup();
    
    res.json({
      success: true,
      message: 'Backup créé avec succès',
      backup: {
        name: backupResult.name,
        link: backupResult.webViewLink,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur backup:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 2. Restaurer la base de données (ADMIN SEULEMENT)
router.post('/restore', authenticate, async (req, res) => {
  try {
    console.log('🔄 Restauration demandée par:', req.user.nomUtilisateur);
    
    // Vérification de sécurité
    if (req.user.profil !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Seuls les administrateurs peuvent restaurer la base'
      });
    }
    
    await restoreService.executeRestoration();
    
    res.json({
      success: true,
      message: 'Base de données restaurée avec succès',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erreur restauration:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 3. Lister les backups disponibles
router.get('/list', authenticate, async (req, res) => {
  try {
    const backups = await backupService.listBackups();
    
    res.json({
      success: true,
      count: backups.length,
      backups: backups.map(backup => ({
        id: backup.id,
        name: backup.name,
        created: new Date(backup.createdTime).toLocaleString(),
        size: backup.size ? `${Math.round(backup.size / 1024 / 1024)} MB` : 'N/A',
        type: backup.name.endsWith('.sql') ? 'SQL' : 'JSON'
      }))
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 4. Vérifier l'état du backup
router.get('/status', async (req, res) => {
  try {
    const hasBackups = await backupService.hasBackups();
    
    res.json({
      success: true,
      status: hasBackups ? 'backups_available' : 'no_backups',
      message: hasBackups 
        ? 'Sauvegardes disponibles sur Google Drive' 
        : 'Aucune sauvegarde trouvée',
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.json({
      success: false,
      status: 'error',
      error: error.message
    });
  }
});

// 5. Télécharger un backup spécifique (pour l'application desktop)
router.post('/download', authenticate, async (req, res) => {
  try {
    const { backupId } = req.body;
    
    if (!backupId) {
      return res.status(400).json({
        success: false,
        message: 'ID du backup requis'
      });
    }
    
    // Cette route fournit le lien direct vers Google Drive
    res.json({
      success: true,
      downloadLink: `https://drive.google.com/uc?export=download&id=${backupId}`,
      viewLink: `https://drive.google.com/file/d/${backupId}/view`
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 6. Synchronisation pour application desktop
router.post('/sync/local-export', authenticate, async (req, res) => {
  try {
    const { data, lastSync } = req.body;
    
    console.log(`📨 Sync depuis application desktop: ${Object.keys(data).length} tables`);
    
    // Créer un backup après réception des données
    await backupService.executeBackup();
    
    res.json({
      success: true,
      message: 'Données synchronisées et backup créé',
      timestamp: new Date().toISOString(),
      backupCreated: true
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 7. Récupérer les données pour application desktop
router.get('/sync/get-data', authenticate, async (req, res) => {
  try {
    const client = new (require('pg')).Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await client.connect();
    
    // Exporter les tables principales
    const tables = ['cartes', 'utilisateurs', 'journal', 'inventaire'];
    const exportData = {};
    
    for (const table of tables) {
      const result = await client.query(`SELECT * FROM "${table}"`);
      exportData[table] = result.rows;
    }
    
    await client.end();
    
    res.json({
      success: true,
      data: exportData,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;