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

// 1. Créer un backup manuel (PUBLIQUE POUR TEST - normalement ADMIN SEULEMENT)
router.post('/create', async (req, res) => {
  try {
    console.log('📤 Backup manuel demandé');
    
    // Simuler un utilisateur pour compatibilité
    req.user = { nomUtilisateur: 'public-backup', profil: 'admin' };
    
    const backupResult = await backupService.executeBackup();
    
    res.json({
      success: true,
      message: 'Backup créé avec succès',
      backup: {
        name: backupResult.name,
        link: backupResult.webViewLink,
        timestamp: new Date().toISOString(),
        folderId: '1EDj5fNR27ZcJ6txXcUYFOhmnn8WdzbWP'
      },
      notes: [
        'Backup stocké sur Google Drive',
        'Dossier: gescard_backups',
        'Backup automatique à 2h UTC'
      ]
    });
    
  } catch (error) {
    console.error('❌ Erreur backup:', error);
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la création du backup',
      error: error.message,
      advice: 'Vérifiez la configuration Google Drive sur Render'
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

// 3. Lister les backups disponibles (PUBLIQUE POUR TEST)
router.get('/list', async (req, res) => {
  try {
    const backups = await backupService.listBackups();
    
    res.json({
      success: true,
      count: backups.length,
      message: backups.length > 0 
        ? `${backups.length} backups disponibles sur Google Drive`
        : 'Aucun backup trouvé - Créez-en un avec /api/backup/create',
      backups: backups.map(backup => ({
        id: backup.id,
        name: backup.name,
        created: new Date(backup.createdTime).toLocaleString('fr-FR'),
        size: backup.size ? `${Math.round(backup.size / 1024 / 1024)} MB` : 'N/A',
        type: backup.name.endsWith('.sql') ? 'SQL' : 'JSON',
        viewLink: `https://drive.google.com/file/d/${backup.id}/view`,
        downloadLink: `https://drive.google.com/uc?export=download&id=${backup.id}`
      })),
      googleDriveInfo: {
        folderName: 'gescard_backups',
        folderId: '1EDj5fNR27ZcJ6txXcUYFOhmnn8WdzbWP'
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des backups',
      error: error.message,
      advice: 'Google Drive pourrait ne pas être configuré ou accessible'
    });
  }
});

// 4. Vérifier l'état du backup (PUBLIQUE)
router.get('/status', async (req, res) => {
  try {
    const hasBackups = await backupService.hasBackups();
    
    // Informations supplémentaires
    const client = new (require('pg')).Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await client.connect();
    const countResult = await client.query("SELECT COUNT(*) as total FROM cartes");
    const totalCartes = parseInt(countResult.rows[0].total);
    await client.end();
    
    res.json({
      success: true,
      status: hasBackups ? 'backups_available' : 'no_backups',
      message: hasBackups 
        ? '✅ Sauvegardes disponibles sur Google Drive' 
        : '📭 Aucune sauvegarde trouvée',
      data: {
        cartes_in_database: totalCartes,
        google_drive_configured: !!process.env.GOOGLE_CLIENT_ID,
        auto_backup_enabled: true,
        next_backup_time: '02:00 UTC (tous les jours)'
      },
      actions: {
        create_backup: 'POST /api/backup/create',
        list_backups: 'GET /api/backup/list',
        restore_backup: 'POST /api/backup/restore (authentification requise)'
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.json({
      success: false,
      status: 'error',
      message: 'Erreur lors de la vérification du statut',
      error: error.message
    });
  }
});

// 5. Télécharger un backup spécifique (PUBLIQUE POUR TEST)
router.post('/download', async (req, res) => {
  try {
    const { backupId } = req.body;
    
    if (!backupId) {
      return res.status(400).json({
        success: false,
        message: 'ID du backup requis',
        advice: 'Utilisez /api/backup/list pour obtenir les IDs disponibles'
      });
    }
    
    // Cette route fournit le lien direct vers Google Drive
    res.json({
      success: true,
      message: 'Liens de téléchargement générés',
      links: {
        download: `https://drive.google.com/uc?export=download&id=${backupId}`,
        view: `https://drive.google.com/file/d/${backupId}/view`,
        api_direct: `${req.protocol}://${req.get('host')}/api/backup/download/${backupId}`
      },
      instructions: [
        '1. Utilisez le lien "download" pour télécharger directement',
        '2. Le lien "view" ouvre le fichier dans Google Drive',
        '3. Le backup est automatique tous les jours à 2h UTC'
      ]
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la génération des liens',
      error: error.message
    });
  }
});

// 6. Télécharger un backup par ID (nouvelle route publique)
router.get('/download/:backupId', async (req, res) => {
  try {
    const { backupId } = req.params;
    
    if (!backupId) {
      return res.status(400).json({
        success: false,
        message: 'ID du backup requis'
      });
    }
    
    // Rediriger vers Google Drive
    res.redirect(`https://drive.google.com/uc?export=download&id=${backupId}`);
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur de redirection',
      error: error.message
    });
  }
});

// 7. Synchronisation pour application desktop (AUTH REQUISE)
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
      backupCreated: true,
      backupInfo: {
        location: 'Google Drive',
        folder: 'gescard_backups',
        frequency: 'Automatique à 2h UTC'
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 8. Récupérer les données pour application desktop (AUTH REQUISE)
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
      timestamp: new Date().toISOString(),
      tables_exported: tables,
      row_counts: Object.keys(exportData).reduce((acc, table) => {
        acc[table] = exportData[table].length;
        return acc;
      }, {})
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 9. Test simple de Google Drive (PUBLIQUE)
router.get('/test', async (req, res) => {
  try {
    console.log('🧪 Test Google Drive demandé');
    
    // Vérifier si les credentials sont configurés
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({
        success: false,
        message: 'Google Drive non configuré',
        advice: 'Ajoutez GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET et GOOGLE_REFRESH_TOKEN sur Render'
      });
    }
    
    // Tester l'authentification
    await backupService.authenticate();
    const folderId = await backupService.getOrCreateBackupFolder();
    
    res.json({
      success: true,
      message: '✅ Google Drive fonctionnel !',
      googleDrive: {
        authenticated: true,
        folderId: folderId,
        folderName: 'gescard_backups',
        configured: true
      },
      nextSteps: [
        'POST /api/backup/create - Créer un backup',
        'GET /api/backup/list - Voir les backups existants',
        'GET /api/backup/status - Vérifier le statut'
      ],
      environment: {
        render_tier: process.env.NODE_ENV === 'production' ? 'free' : 'development',
        backup_auto_restore: process.env.AUTO_RESTORE === 'true'
      }
    });
    
  } catch (error) {
    console.error('❌ Test Google Drive échoué:', error);
    res.status(500).json({
      success: false,
      message: '❌ Google Drive non fonctionnel',
      error: error.message,
      commonIssues: [
        'Les tokens Google peuvent être expirés',
        'Vérifiez GOOGLE_REFRESH_TOKEN sur Render',
        'Assurez-vous que l\'API Google Drive est activée'
      ]
    });
  }
});

// 10. Route d'information sur le système de backup (PUBLIQUE)
router.get('/info', async (req, res) => {
  try {
    const client = new (require('pg')).Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await client.connect();
    const countResult = await client.query("SELECT COUNT(*) as total FROM cartes");
    const totalCartes = parseInt(countResult.rows[0].total);
    await client.end();
    
    const googleDriveConfigured = !!process.env.GOOGLE_CLIENT_ID;
    
    res.json({
      success: true,
      system: 'GesCard Backup System',
      version: '1.0.0',
      status: googleDriveConfigured ? 'active' : 'inactive',
      
      database: {
        total_cartes: totalCartes,
        connection: 'PostgreSQL',
        environment: process.env.NODE_ENV || 'development'
      },
      
      backup_system: {
        google_drive: googleDriveConfigured ? 'configured' : 'not_configured',
        auto_backup: 'daily at 02:00 UTC',
        auto_restore: process.env.AUTO_RESTORE === 'true' ? 'enabled' : 'disabled',
        storage: 'Google Drive (gescard_backups folder)',
        retention: 'unlimited'
      },
      
      endpoints: {
        public: {
          create_backup: 'POST /api/backup/create',
          list_backups: 'GET /api/backup/list',
          backup_status: 'GET /api/backup/status',
          backup_info: 'GET /api/backup/info',
          test_drive: 'GET /api/backup/test',
          download_backup: 'GET /api/backup/download/:id'
        },
        protected: {
          restore_backup: 'POST /api/backup/restore (admin only)',
          sync_export: 'POST /api/backup/sync/local-export',
          sync_get_data: 'GET /api/backup/sync/get-data'
        }
      },
      
      recommendations: [
        totalCartes < 10 ? '⚠️  Base de données presque vide - envisagez une restauration' : '',
        !googleDriveConfigured ? '⚠️  Configurez Google Drive pour protéger vos données' : '',
        '✅ Backup automatique quotidien activé',
        '🔄 Restauration automatique si base vide (Render reset)'
      ].filter(Boolean),
      
      quick_start: [
        '1. GET /api/backup/test - Tester Google Drive',
        '2. GET /api/backup/list - Voir les backups existants',
        '3. POST /api/backup/create - Créer un nouveau backup',
        '4. GET /api/backup/status - Vérifier l\'état du système'
      ]
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération des informations',
      error: error.message
    });
  }
});

module.exports = router;