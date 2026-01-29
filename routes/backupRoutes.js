const express = require('express');
const router = express.Router();
const PostgreSQLBackup = require('../backup-postgres');
const PostgreSQLRestorer = require('../restore-postgres');

// ⭐⭐⭐ UTILISEZ VOS VRAIS MIDDLEWARE ⭐⭐⭐
const { verifyToken } = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

// Rate limiting pour les routes publiques
const rateLimit = require('express-rate-limit');

const backupService = new PostgreSQLBackup();
const restoreService = new PostgreSQLRestorer();

// Variables pour suivre l'état (gardez-les)
let lastBackupTime = null;
let backupInProgress = false;

// ==================== RATE LIMITING ====================

// Rate limiting pour les routes publiques
const publicRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 requêtes max
  message: {
    success: false,
    message: 'Trop de requêtes. Veuillez réessayer dans 15 minutes.'
  }
});

// Rate limiting plus strict pour les routes sensibles
const strictRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 heure
  max: 5, // 5 requêtes max
  message: {
    success: false,
    message: 'Limite de sécurité atteinte. Veuillez réessayer dans 1 heure.'
  }
});

// ==================== ROUTES PUBLIQUES (LIMITÉES) ====================

// 1. Vérifier l'état du backup (PUBLIQUE MAIS LIMITÉE)
router.get('/status', publicRateLimiter, async (req, res) => {
  try {
    const hasBackups = await backupService.hasBackups();
    
    // Informations basiques seulement
    res.json({
      success: true,
      status: hasBackups ? 'backups_available' : 'no_backups',
      message: hasBackups ? '✅ Sauvegardes disponibles' : '📭 Aucune sauvegarde',
      requires_auth_for_details: true,
      admin_required_for_actions: true
    });
    
  } catch (error) {
    res.json({
      success: false,
      status: 'error',
      message: 'Erreur de vérification'
    });
  }
});

// 2. Test Google Drive (PUBLIQUE MAIS LIMITÉE)
router.get('/test', strictRateLimiter, async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(400).json({
        success: false,
        message: 'Google Drive non configuré',
        requires_admin: true
      });
    }
    
    await backupService.authenticate();
    const folderId = await backupService.getOrCreateBackupFolder();
    
    res.json({
      success: true,
      message: '✅ Google Drive fonctionnel',
      requires_auth_for_actions: true
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Google Drive non fonctionnel'
    });
  }
});

// 3. Informations système (PUBLIQUE MAIS LIMITÉE)
router.get('/info', publicRateLimiter, async (req, res) => {
  try {
    const googleDriveConfigured = !!process.env.GOOGLE_CLIENT_ID;
    
    res.json({
      success: true,
      system: 'GesCard Backup System',
      status: googleDriveConfigured ? 'configured' : 'not_configured',
      security: {
        authentication_required: true,
        admin_role_required: true,
        encrypted_backups: false // À implémenter
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur système'
    });
  }
});

// ==================== ROUTES AUTHENTIFIÉES (TOUS UTILISATEURS) ====================

// 4. Lister les backups (AUTH REQUISE)
router.get('/list', verifyToken, async (req, res) => {
  try {
    console.log('📋 Liste backups demandée par:', req.user.NomUtilisateur);
    
    const backups = await backupService.listBackups();
    backups.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
    
    const isAdmin = req.user.Role === 'Administrateur';
    
    res.json({
      success: true,
      count: backups.length,
      backups: backups.map(backup => ({
        id: backup.id,
        name: backup.name,
        created: new Date(backup.createdTime).toLocaleString('fr-FR'),
        size: backup.size ? `${Math.round(backup.size / 1024 / 1024)} MB` : 'N/A',
        type: backup.name.endsWith('.sql') ? 'SQL' : 'JSON',
        // ⚠️ NE PAS ENVOYER LES LIENS AUX NON-ADMINS
        ...(isAdmin ? {
          viewLink: `https://drive.google.com/file/d/${backup.id}/view`
        } : {})
      })),
      security: {
        authenticatedUser: req.user.NomUtilisateur,
        userRole: req.user.Role,
        canDownload: isAdmin,
        canRestore: isAdmin
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur récupération backups',
      error: error.message
    });
  }
});

// ==================== ROUTES ADMIN SEULEMENT ====================

// 5. Créer un backup manuel (ADMIN SEULEMENT)
router.post('/create', verifyToken, adminOnly, strictRateLimiter, async (req, res) => {
  try {
    console.log('📤 Backup manuel par admin:', req.user.NomUtilisateur);
    
    if (backupInProgress) {
      return res.status(429).json({
        success: false,
        message: 'Backup déjà en cours'
      });
    }
    
    if (lastBackupTime && (Date.now() - lastBackupTime) < 60 * 60 * 1000) {
      return res.status(429).json({
        success: false,
        message: 'Attendez 1 heure entre les backups'
      });
    }
    
    backupInProgress = true;
    
    const backupResult = await backupService.executeBackup();
    
    lastBackupTime = Date.now();
    backupInProgress = false;
    
    res.json({
      success: true,
      message: 'Backup créé avec succès',
      backup: {
        name: backupResult.name,
        timestamp: new Date().toISOString()
      },
      security: {
        performedBy: req.user.NomUtilisateur,
        userRole: req.user.Role,
        ip: req.ip
      }
    });
    
  } catch (error) {
    backupInProgress = false;
    res.status(500).json({
      success: false,
      message: 'Erreur création backup',
      error: error.message
    });
  }
});

// 6. Restaurer la base (ADMIN SEULEMENT - OPÉRATION DANGEREUSE)
router.post('/restore', verifyToken, adminOnly, strictRateLimiter, async (req, res) => {
  try {
    console.log('🔄 Restauration demandée par admin:', req.user.NomUtilisateur);
    
    // Confirmation supplémentaire requise
    if (req.body.confirm !== 'YES_I_CONFIRM_RESTORE') {
      return res.status(400).json({
        success: false,
        message: 'Confirmation requise',
        error: 'Ajoutez { "confirm": "YES_I_CONFIRM_RESTORE" } pour confirmer cette opération DANGEREUSE'
      });
    }
    
    // Backup pré-restauration si données existent
    const client = new (require('pg')).Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await client.connect();
    const countResult = await client.query("SELECT COUNT(*) as total FROM cartes");
    const totalCartes = parseInt(countResult.rows[0].total);
    await client.end();
    
    let preRestoreBackup = null;
    if (totalCartes > 0) {
      console.log(`💾 Backup pré-restauration (${totalCartes} cartes)`);
      try {
        preRestoreBackup = await backupService.executeBackup();
      } catch (backupError) {
        console.warn('⚠️ Backup pré-restauration échoué');
      }
    }
    
    // Exécuter la restauration
    await restoreService.executeRestoration();
    
    res.json({
      success: true,
      message: 'Base restaurée avec succès',
      warning: 'TOUTES LES DONNÉES ONT ÉTÉ REMPLACÉES',
      pre_restore_backup: preRestoreBackup ? 'Créé avec succès' : 'Non nécessaire',
      security: {
        performedBy: req.user.NomUtilisateur,
        userRole: req.user.Role,
        ip: req.ip,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur restauration',
      error: error.message
    });
  }
});

// 7. Télécharger un backup (ADMIN SEULEMENT)
router.post('/download', verifyToken, adminOnly, async (req, res) => {
  try {
    const { backupId } = req.body;
    
    if (!backupId) {
      return res.status(400).json({
        success: false,
        message: 'ID du backup requis'
      });
    }
    
    // Vérifier que le backup existe
    const backups = await backupService.listBackups();
    const backupExists = backups.some(b => b.id === backupId);
    
    if (!backupExists) {
      return res.status(404).json({
        success: false,
        message: 'Backup non trouvé'
      });
    }
    
    console.log('📥 Téléchargement backup par admin:', {
      backupId: backupId,
      user: req.user.NomUtilisateur,
      ip: req.ip
    });
    
    res.json({
      success: true,
      message: 'Lien généré',
      links: {
        download: `https://drive.google.com/uc?export=download&id=${backupId}`,
        view: `https://drive.google.com/file/d/${backupId}/view`
      },
      security: {
        downloadedBy: req.user.NomUtilisateur,
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur génération lien',
      error: error.message
    });
  }
});

// 8. Téléchargement direct (ADMIN SEULEMENT)
router.get('/download/:backupId', verifyToken, adminOnly, async (req, res) => {
  try {
    const { backupId } = req.params;
    
    // Journal de sécurité
    console.log('🔐 Téléchargement direct backup:', {
      backupId: backupId,
      user: req.user.NomUtilisateur,
      role: req.user.Role,
      ip: req.ip
    });
    
    // Vérifier l'existence
    const backups = await backupService.listBackups();
    const backupExists = backups.some(b => b.id === backupId);
    
    if (!backupExists) {
      return res.status(404).json({
        success: false,
        message: 'Backup non trouvé'
      });
    }
    
    res.redirect(`https://drive.google.com/uc?export=download&id=${backupId}`);
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur téléchargement',
      error: error.message
    });
  }
});

// 9. Statistiques (ADMIN SEULEMENT)
router.get('/stats', verifyToken, adminOnly, async (req, res) => {
  try {
    const backups = await backupService.listBackups();
    
    const stats = {
      total_backups: backups.length,
      last_backup: backups.length > 0 ? new Date(backups[0].createdTime).toLocaleString('fr-FR') : 'jamais',
      sql_backups: backups.filter(b => b.name.endsWith('.sql')).length,
      json_backups: backups.filter(b => b.name.endsWith('.json')).length
    };
    
    res.json({
      success: true,
      stats: stats,
      requestedBy: req.user.NomUtilisateur
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur statistiques',
      error: error.message
    });
  }
});

// 10. Synchronisation (ADMIN SEULEMENT)
router.post('/sync/local-export', verifyToken, adminOnly, async (req, res) => {
  try {
    console.log('📨 Sync desktop par admin:', req.user.NomUtilisateur);
    
    await backupService.executeBackup();
    
    res.json({
      success: true,
      message: 'Sync et backup réussis',
      performedBy: req.user.NomUtilisateur
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 11. Récupération données (ADMIN SEULEMENT)
router.get('/sync/get-data', verifyToken, adminOnly, async (req, res) => {
  try {
    const client = new (require('pg')).Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await client.connect();
    
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
      exportedBy: req.user.NomUtilisateur,
      warning: 'Données sensibles - À protéger'
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== FONCTIONS UTILITAIRES ====================

// Fonction pour le temps relatif (gardez-la)
function getRelativeTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);
  
  if (diffMins < 60) return `il y a ${diffMins} minute${diffMins !== 1 ? 's' : ''}`;
  else if (diffHours < 24) return `il y a ${diffHours} heure${diffHours !== 1 ? 's' : ''}`;
  else if (diffDays < 7) return `il y a ${diffDays} jour${diffDays !== 1 ? 's' : ''}`;
  else {
    const weeks = Math.floor(diffDays / 7);
    return `il y a ${weeks} semaine${weeks !== 1 ? 's' : ''}`;
  }
}

module.exports = router;