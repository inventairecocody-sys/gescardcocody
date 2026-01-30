const express = require('express');
const router = express.Router();
const PostgreSQLBackup = require('../backup-postgres');
const PostgreSQLRestorer = require('../restore-postgres');

// ⭐⭐⭐ UTILISEZ VOS VRAIS MIDDLEWARE ⭐⭐⭐
const { verifyToken } = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const journalAccess = require('../middleware/journalAccess'); // ✅ NOUVEAU: Middleware pour admin + superviseur

// Rate limiting pour les routes publiques
const rateLimit = require('express-rate-limit');

const backupService = new PostgreSQLBackup();
const restoreService = new PostgreSQLRestorer();

// Variables pour suivre l'état
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
    
    res.json({
      success: true,
      status: hasBackups ? 'backups_available' : 'no_backups',
      message: hasBackups ? '✅ Sauvegardes disponibles' : '📭 Aucune sauvegarde',
      requires_auth_for_details: true,
      allowed_roles: ['Administrateur', 'Superviseur'],
      backup_schedule: 'Tous les jours à 13h30 UTC (heure d\'Abidjan)'
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
      requires_auth_for_actions: true,
      allowed_roles: {
        view: ['Administrateur', 'Superviseur'],
        manage: ['Administrateur']
      }
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
        allowed_roles: ['Administrateur', 'Superviseur'],
        admin_only_actions: ['create', 'restore', 'download'],
        encrypted_backups: !!process.env.BACKUP_ENCRYPTION_KEY
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Erreur système'
    });
  }
});

// ==================== ROUTES POUR ADMIN + SUPERVISEUR ====================

// 4. Lister les backups (ADMIN + SUPERVISEUR)
router.get('/list', verifyToken, journalAccess, async (req, res) => {
  try {
    const userRole = req.user?.Role || req.user?.role;
    const isAdmin = userRole === 'Administrateur';
    const isSupervisor = userRole === 'Superviseur';
    
    console.log('📋 Liste backups demandée par:', {
      user: req.user.NomUtilisateur,
      role: userRole,
      permissions: {
        canView: true,
        canCreate: isAdmin,
        canRestore: isAdmin,
        canDownload: isAdmin
      }
    });
    
    const backups = await backupService.listBackups();
    backups.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
    
    res.json({
      success: true,
      count: backups.length,
      backups: backups.map(backup => ({
        id: backup.id,
        name: backup.name,
        created: new Date(backup.createdTime).toLocaleString('fr-FR'),
        size: backup.size ? `${Math.round(backup.size / 1024 / 1024)} MB` : 'N/A',
        type: backup.name.endsWith('.sql') ? 'SQL' : 'JSON',
        encrypted: backup.encrypted || backup.name.includes('.encrypted.'),
        // ⚠️ NE PAS ENVOYER LES LIENS AUX NON-ADMINS
        ...(isAdmin ? {
          viewLink: `https://drive.google.com/file/d/${backup.id}/view`,
          downloadUrl: `https://drive.google.com/uc?export=download&id=${backup.id}`
        } : {})
      })),
      userPermissions: {
        role: userRole,
        canView: true,
        canCreate: isAdmin,
        canRestore: isAdmin,
        canDownload: isAdmin,
        message: isSupervisor ? 'Mode consultation seulement' : 'Accès complet'
      },
      systemInfo: {
        totalBackups: backups.length,
        lastBackup: backups.length > 0 ? new Date(backups[0].createdTime).toLocaleString('fr-FR') : 'Aucun',
        nextScheduled: '13h30 UTC quotidien',
        storage: 'Google Drive (dossier gescard_backups)'
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur récupération backups:', error.message);
    res.status(500).json({
      success: false,
      message: 'Erreur récupération backups',
      error: error.message,
      advice: 'Vérifiez la connexion Google Drive'
    });
  }
});

// 5. Statistiques (ADMIN + SUPERVISEUR)
router.get('/stats', verifyToken, journalAccess, async (req, res) => {
  try {
    const userRole = req.user?.Role || req.user?.role;
    const isAdmin = userRole === 'Administrateur';
    
    console.log('📊 Statistiques backups demandées par:', {
      user: req.user.NomUtilisateur,
      role: userRole
    });
    
    const backups = await backupService.listBackups();
    
    const stats = {
      total_backups: backups.length,
      last_backup: backups.length > 0 ? new Date(backups[0].createdTime).toLocaleString('fr-FR') : 'jamais',
      sql_backups: backups.filter(b => b.name.endsWith('.sql')).length,
      json_backups: backups.filter(b => b.name.endsWith('.json')).length,
      encrypted_backups: backups.filter(b => b.encrypted || b.name.includes('.encrypted.')).length,
      total_size_mb: backups.reduce((total, b) => total + (b.size ? parseInt(b.size) : 0), 0) / 1024 / 1024
    };
    
    res.json({
      success: true,
      stats: stats,
      userInfo: {
        requestedBy: req.user.NomUtilisateur,
        role: userRole,
        permissions: {
          canManage: isAdmin,
          canRestore: isAdmin
        }
      },
      backupSchedule: {
        automatic: '13h30 UTC quotidien',
        manual: isAdmin ? 'Autorisé' : 'Non autorisé',
        retention: 'Illimité (Google Drive)'
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur statistiques:', error.message);
    res.status(500).json({
      success: false,
      message: 'Erreur statistiques',
      error: error.message
    });
  }
});

// ==================== ROUTES ADMIN SEULEMENT ====================

// 6. Créer un backup manuel (ADMIN SEULEMENT)
router.post('/create', verifyToken, adminOnly, strictRateLimiter, async (req, res) => {
  try {
    console.log('📤 Backup manuel par admin:', {
      user: req.user.NomUtilisateur,
      role: req.user.Role,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });
    
    // Vérifier si un backup est déjà en cours
    if (backupInProgress) {
      return res.status(429).json({
        success: false,
        message: 'Backup déjà en cours',
        details: 'Un backup est déjà en cours d\'exécution. Veuillez patienter.',
        advice: 'Vérifiez la progression dans les logs système'
      });
    }
    
    // Limiter la fréquence des backups manuels
    if (lastBackupTime && (Date.now() - lastBackupTime) < 30 * 60 * 1000) { // 30 minutes
      const minutesLeft = Math.ceil((30 * 60 * 1000 - (Date.now() - lastBackupTime)) / 60000);
      return res.status(429).json({
        success: false,
        message: 'Attendez entre les backups manuels',
        details: `Vous devez attendre ${minutesLeft} minutes avant de créer un nouveau backup manuel.`,
        advice: 'Utilisez le backup automatique quotidien ou patientez'
      });
    }
    
    backupInProgress = true;
    const startTime = Date.now();
    
    // Journaliser le début du backup
    try {
      const db = require('../db/db');
      await db.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, nomcomplet, role, agence,
          dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
          actiontype, tablename, recordid, adresseip, userid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        req.user.id, req.user.NomUtilisateur, req.user.NomComplet || req.user.NomUtilisateur, 
        req.user.Role, req.user.Agence || '',
        new Date(), 'Début création backup manuel', 'System', 
        'N/A', req.ip, 'BACKUP_CREATE', 'System', 'backup', req.ip, req.user.id,
        `Backup manuel initié par ${req.user.NomUtilisateur}`
      ]);
    } catch (logError) {
      console.warn('⚠️ Impossible de journaliser le backup:', logError.message);
    }
    
    const backupResult = await backupService.executeBackup();
    
    lastBackupTime = Date.now();
    backupInProgress = false;
    const duration = Date.now() - startTime;
    
    // Journaliser la fin du backup
    try {
      const db = require('../db/db');
      await db.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, nomcomplet, role, agence,
          dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
          actiontype, tablename, recordid, adresseip, userid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        req.user.id, req.user.NomUtilisateur, req.user.NomComplet || req.user.NomUtilisateur, 
        req.user.Role, req.user.Agence || '',
        new Date(), 'Backup manuel terminé avec succès', 'System', 
        backupResult.name, req.ip, 'BACKUP_CREATE', 'System', backupResult.id, req.ip, req.user.id,
        `Backup "${backupResult.name}" créé en ${duration}ms`
      ]);
    } catch (logError) {
      console.warn('⚠️ Impossible de journaliser la fin du backup:', logError.message);
    }
    
    res.json({
      success: true,
      message: 'Backup créé avec succès',
      backup: {
        name: backupResult.name,
        timestamp: new Date().toISOString(),
        size: backupResult.size ? `${Math.round(backupResult.size / 1024 / 1024)} MB` : 'N/A',
        id: backupResult.id,
        viewLink: `https://drive.google.com/file/d/${backupResult.id}/view`,
        downloadUrl: `https://drive.google.com/uc?export=download&id=${backupResult.id}`
      },
      performance: {
        duration: `${duration}ms`,
        speed: backupResult.size ? `${Math.round(backupResult.size / duration * 1000)} KB/s` : 'N/A'
      },
      security: {
        performedBy: req.user.NomUtilisateur,
        userRole: req.user.Role,
        ip: req.ip,
        timestamp: new Date().toISOString()
      },
      nextAvailable: 'Dans 30 minutes'
    });
    
  } catch (error) {
    backupInProgress = false;
    console.error('❌ Erreur création backup:', error.message);
    
    // Journaliser l'erreur
    try {
      const db = require('../db/db');
      await db.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, nomcomplet, role, agence,
          dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
          actiontype, tablename, recordid, adresseip, userid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        req.user.id, req.user.NomUtilisateur, req.user.NomComplet || req.user.NomUtilisateur, 
        req.user.Role, req.user.Agence || '',
        new Date(), 'Échec création backup manuel', 'System', 
        'N/A', req.ip, 'BACKUP_ERROR', 'System', 'error', req.ip, req.user.id,
        `Erreur création backup: ${error.message}`
      ]);
    } catch (logError) {
      console.warn('⚠️ Impossible de journaliser l\'erreur:', logError.message);
    }
    
    res.status(500).json({
      success: false,
      message: 'Erreur création backup',
      error: error.message,
      advice: [
        'Vérifiez la connexion Google Drive',
        'Assurez-vous que les tokens sont valides',
        'Vérifiez l\'espace disponible sur Google Drive'
      ]
    });
  }
});

// 7. Restaurer la base (ADMIN SEULEMENT - OPÉRATION DANGEREUSE)
router.post('/restore', verifyToken, adminOnly, strictRateLimiter, async (req, res) => {
  try {
    console.log('🔄 Restauration demandée par admin:', {
      user: req.user.NomUtilisateur,
      backupId: req.body.backupId,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });
    
    // Confirmation supplémentaire requise
    if (req.body.confirm !== 'YES_I_CONFIRM_RESTORE') {
      return res.status(400).json({
        success: false,
        message: 'Confirmation requise',
        error: 'Ajoutez { "confirm": "YES_I_CONFIRM_RESTORE" } pour confirmer cette opération DANGEREUSE',
        warning: 'Cette opération va remplacer TOUTES vos données actuelles'
      });
    }
    
    const backupId = req.body.backupId;
    
    // Si aucun backup spécifié, utiliser le dernier
    let backupToRestore = null;
    const backups = await backupService.listBackups();
    
    if (backupId) {
      backupToRestore = backups.find(b => b.id === backupId);
      if (!backupToRestore) {
        return res.status(404).json({
          success: false,
          message: 'Backup spécifié non trouvé',
          availableBackups: backups.map(b => ({ id: b.id, name: b.name, date: b.createdTime }))
        });
      }
    } else {
      // Prendre le dernier backup
      backups.sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
      backupToRestore = backups[0];
    }
    
    if (!backupToRestore) {
      return res.status(404).json({
        success: false,
        message: 'Aucun backup disponible pour la restauration'
      });
    }
    
    console.log(`📋 Backup sélectionné pour restauration: ${backupToRestore.name}`);
    
    // Journaliser le début de la restauration
    try {
      const db = require('../db/db');
      await db.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, nomcomplet, role, agence,
          dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
          actiontype, tablename, recordid, adresseip, userid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        req.user.id, req.user.NomUtilisateur, req.user.NomComplet || req.user.NomUtilisateur, 
        req.user.Role, req.user.Agence || '',
        new Date(), 'Début restauration backup', 'System', 
        backupToRestore.name, req.ip, 'BACKUP_RESTORE', 'System', backupToRestore.id, req.ip, req.user.id,
        `Restauration depuis "${backupToRestore.name}" initiée par ${req.user.NomUtilisateur}`
      ]);
    } catch (logError) {
      console.warn('⚠️ Impossible de journaliser la restauration:', logError.message);
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
        console.log(`✅ Backup pré-restauration créé: ${preRestoreBackup.name}`);
      } catch (backupError) {
        console.warn('⚠️ Backup pré-restauration échoué:', backupError.message);
      }
    }
    
    // Exécuter la restauration
    const restoreResult = await restoreService.executeRestoration(backupToRestore.id);
    
    // Journaliser la fin de la restauration
    try {
      const db = require('../db/db');
      await db.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, nomcomplet, role, agence,
          dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
          actiontype, tablename, recordid, adresseip, userid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        req.user.id, req.user.NomUtilisateur, req.user.NomComplet || req.user.NomUtilisateur, 
        req.user.Role, req.user.Agence || '',
        new Date(), 'Restauration backup terminée', 'System', 
        backupToRestore.name, req.ip, 'BACKUP_RESTORE', 'System', backupToRestore.id, req.ip, req.user.id,
        `Restauration "${backupToRestore.name}" terminée - ${restoreResult.tablesRestored || '?'} tables restaurées`
      ]);
    } catch (logError) {
      console.warn('⚠️ Impossible de journaliser la fin de restauration:', logError.message);
    }
    
    res.json({
      success: true,
      message: 'Base restaurée avec succès',
      warning: '⚠️ TOUTES LES DONNÉES ONT ÉTÉ REMPLACÉES',
      restoreDetails: {
        backupUsed: backupToRestore.name,
        backupDate: new Date(backupToRestore.createdTime).toLocaleString('fr-FR'),
        preRestoreBackup: preRestoreBackup ? {
          name: preRestoreBackup.name,
          id: preRestoreBackup.id,
          downloadUrl: `https://drive.google.com/uc?export=download&id=${preRestoreBackup.id}`
        } : 'Non nécessaire (base vide)',
        restoreStats: restoreResult
      },
      security: {
        performedBy: req.user.NomUtilisateur,
        userRole: req.user.Role,
        ip: req.ip,
        timestamp: new Date().toISOString()
      },
      advice: [
        'Vérifiez l\'intégrité des données restaurées',
        'Testez les fonctionnalités principales',
        'Si problème, utilisez le backup pré-restauration pour revenir en arrière'
      ]
    });
    
  } catch (error) {
    console.error('❌ Erreur restauration:', error.message);
    
    // Journaliser l'erreur de restauration
    try {
      const db = require('../db/db');
      await db.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, nomcomplet, role, agence,
          dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
          actiontype, tablename, recordid, adresseip, userid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        req.user.id, req.user.NomUtilisateur, req.user.NomComplet || req.user.NomUtilisateur, 
        req.user.Role, req.user.Agence || '',
        new Date(), 'Échec restauration backup', 'System', 
        'N/A', req.ip, 'BACKUP_RESTORE_ERROR', 'System', 'error', req.ip, req.user.id,
        `Erreur restauration: ${error.message}`
      ]);
    } catch (logError) {
      console.warn('⚠️ Impossible de journaliser l\'erreur:', logError.message);
    }
    
    res.status(500).json({
      success: false,
      message: 'Erreur restauration',
      error: error.message,
      advice: [
        'Vérifiez que le backup n\'est pas corrompu',
        'Assurez-vous d\'avoir assez d\'espace en base',
        'Contactez le support si le problème persiste'
      ]
    });
  }
});

// 8. Télécharger un backup (ADMIN SEULEMENT)
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
    const backup = backups.find(b => b.id === backupId);
    
    if (!backup) {
      return res.status(404).json({
        success: false,
        message: 'Backup non trouvé',
        availableBackups: backups.map(b => ({ id: b.id, name: b.name, date: b.createdTime }))
      });
    }
    
    console.log('📥 Téléchargement backup par admin:', {
      backupId: backupId,
      backupName: backup.name,
      user: req.user.NomUtilisateur,
      ip: req.ip,
      timestamp: new Date().toISOString()
    });
    
    // Journaliser le téléchargement
    try {
      const db = require('../db/db');
      await db.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, nomcomplet, role, agence,
          dateaction, action, tableaffectee, ligneaffectee, iputilisateur,
          actiontype, tablename, recordid, adresseip, userid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `, [
        req.user.id, req.user.NomUtilisateur, req.user.NomComplet || req.user.NomUtilisateur, 
        req.user.Role, req.user.Agence || '',
        new Date(), 'Téléchargement backup', 'System', 
        backup.name, req.ip, 'BACKUP_DOWNLOAD', 'System', backup.id, req.ip, req.user.id,
        `Téléchargement backup "${backup.name}" par ${req.user.NomUtilisateur}`
      ]);
    } catch (logError) {
      console.warn('⚠️ Impossible de journaliser le téléchargement:', logError.message);
    }
    
    res.json({
      success: true,
      message: 'Lien généré',
      backupInfo: {
        id: backup.id,
        name: backup.name,
        created: new Date(backup.createdTime).toLocaleString('fr-FR'),
        size: backup.size ? `${Math.round(backup.size / 1024 / 1024)} MB` : 'N/A',
        type: backup.name.endsWith('.sql') ? 'SQL' : 'JSON'
      },
      links: {
        download: `https://drive.google.com/uc?export=download&id=${backup.id}`,
        view: `https://drive.google.com/file/d/${backup.id}/view`
      },
      security: {
        downloadedBy: req.user.NomUtilisateur,
        role: req.user.Role,
        timestamp: new Date().toISOString(),
        ip: req.ip
      },
      advice: [
        'Le lien de téléchargement est valide pendant quelques heures',
        'Téléchargez et stockez le backup localement pour plus de sécurité',
        'Le fichier peut être volumineux, assurez-vous d\'avoir assez d\'espace'
      ]
    });
    
  } catch (error) {
    console.error('❌ Erreur génération lien:', error.message);
    res.status(500).json({
      success: false,
      message: 'Erreur génération lien',
      error: error.message,
      advice: 'Vérifiez la connexion Google Drive'
    });
  }
});

// 9. Téléchargement direct (ADMIN SEULEMENT - pour intégration frontend)
router.get('/download/:backupId', verifyToken, adminOnly, async (req, res) => {
  try {
    const { backupId } = req.params;
    
    // Journal de sécurité
    console.log('🔐 Téléchargement direct backup:', {
      backupId: backupId,
      user: req.user.NomUtilisateur,
      role: req.user.Role,
      ip: req.ip,
      timestamp: new Date().toISOString()
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
    
    // Rediriger vers Google Drive
    res.redirect(`https://drive.google.com/uc?export=download&id=${backupId}`);
    
  } catch (error) {
    console.error('❌ Erreur téléchargement:', error.message);
    res.status(500).json({
      success: false,
      message: 'Erreur téléchargement',
      error: error.message
    });
  }
});

// 10. Synchronisation (ADMIN SEULEMENT)
router.post('/sync/local-export', verifyToken, adminOnly, async (req, res) => {
  try {
    console.log('📨 Sync desktop par admin:', req.user.NomUtilisateur);
    
    const backupResult = await backupService.executeBackup();
    
    res.json({
      success: true,
      message: 'Sync et backup réussis',
      backup: {
        name: backupResult.name,
        id: backupResult.id,
        viewLink: `https://drive.google.com/file/d/${backupResult.id}/view`
      },
      performedBy: req.user.NomUtilisateur,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 11. Récupération données (ADMIN SEULEMENT - pour export local)
router.get('/sync/get-data', verifyToken, adminOnly, async (req, res) => {
  try {
    const client = new (require('pg')).Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await client.connect();
    
    const tables = ['cartes', 'utilisateurs', 'journalactivite', 'inventaire'];
    const exportData = {};
    
    for (const table of tables) {
      try {
        const result = await client.query(`SELECT * FROM "${table}" LIMIT 10000`); // Limite pour sécurité
        exportData[table] = result.rows;
        console.log(`✅ ${table}: ${result.rows.length} lignes exportées`);
      } catch (tableError) {
        console.warn(`⚠️ Table ${table} non exportée:`, tableError.message);
        exportData[table] = { error: tableError.message };
      }
    }
    
    await client.end();
    
    res.json({
      success: true,
      data: exportData,
      exportedBy: req.user.NomUtilisateur,
      timestamp: new Date().toISOString(),
      warning: '⚠️ Données sensibles - À protéger et stocker en sécurité',
      dataProtection: {
        encryption: 'Recommandé pour le stockage local',
        access: 'Limité aux personnes autorisées',
        retention: 'Conformément aux politiques de l\'organisation'
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== ROUTE DE SANTÉ ====================

// 12. Vérifier la santé du système de backup
router.get('/health', publicRateLimiter, async (req, res) => {
  try {
    const googleDriveConfigured = !!process.env.GOOGLE_CLIENT_ID;
    let googleDriveStatus = 'not_configured';
    let hasBackups = false;
    let backupCount = 0;
    
    if (googleDriveConfigured) {
      try {
        await backupService.authenticate();
        googleDriveStatus = 'authenticated';
        
        const backups = await backupService.listBackups();
        backupCount = backups.length;
        hasBackups = backupCount > 0;
      } catch (error) {
        googleDriveStatus = 'error';
      }
    }
    
    res.json({
      success: true,
      system: 'GesCard Backup System',
      status: 'operational',
      components: {
        google_drive: googleDriveStatus,
        database: 'connected',
        encryption: !!process.env.BACKUP_ENCRYPTION_KEY ? 'enabled' : 'disabled'
      },
      backups: {
        available: hasBackups,
        count: backupCount,
        schedule: '13h30 UTC quotidien'
      },
      permissions: {
        view: ['Administrateur', 'Superviseur'],
        manage: ['Administrateur'],
        public_access: 'limited_info_only'
      },
      endpoints: {
        list: '/api/backup/list (admin+supervisor)',
        create: '/api/backup/create (admin only)',
        restore: '/api/backup/restore (admin only)',
        download: '/api/backup/download (admin only)',
        stats: '/api/backup/stats (admin+supervisor)'
      }
    });
    
  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'degraded',
      message: 'Erreur vérification santé',
      error: error.message
    });
  }
});

// ==================== FONCTIONS UTILITAIRES ====================

// Fonction pour le temps relatif
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