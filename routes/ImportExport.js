const express = require('express');
const router = express.Router();
const importExportController = require('../Controllers/importExportController');
const bulkImportController = require('../Controllers/BulkImportController');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const { importExportAccess, importExportRateLimit } = require('../middleware/importExportAccess');

// ✅ APPLIQUER L'AUTHENTIFICATION ET LES PERMISSIONS IMPORT/EXPORT
router.use(verifyToken);
router.use(importExportAccess);

// ==================== CONFIGURATION MULTER OPTIMISÉE ====================

// Configuration Multer pour upload Excel - OPTIMISÉE POUR 50MB
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const fs = require('fs');
    const uploadDir = 'uploads/';
    
    // Créer le dossier s'il n'existe pas
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
      console.log(`📁 Dossier uploads créé: ${uploadDir}`);
    }
    
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const safeFileName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `import-${uniqueSuffix}-${safeFileName}`);
  }
});

const fileFilter = (req, file, cb) => {
  console.log('📁 Vérification fichier:', {
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size
  });
  
  // Accepter les fichiers Excel
  if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.mimetype === 'application/vnd.ms-excel' ||
    file.originalname.match(/\.(xlsx|xls)$/i)
  ) {
    cb(null, true);
  } else {
    console.error('❌ Type de fichier non autorisé:', file.mimetype);
    cb(new Error('Seuls les fichiers Excel (.xlsx, .xls) sont autorisés'), false);
  }
};

// Configuration Multer avec limites adaptatives
const upload = multer({ 
  storage, 
  fileFilter, 
  limits: { 
    fileSize: 50 * 1024 * 1024, // 50MB max (augmenté pour imports massifs)
    files: 1, // Un seul fichier à la fois
    fields: 10 // Nombre maximal de champs de formulaire
  }
});

// ==================== ROUTES EXISTANTES IMPORT/EXPORT ====================

// 📤 IMPORT STANDARD
router.post('/import', importExportRateLimit, upload.single('file'), importExportController.importExcel);

// 🔄 IMPORT INTELLIGENT (SMART SYNC)
router.post('/import/smart-sync', importExportRateLimit, upload.single('file'), importExportController.importSmartSync);

// 🎯 IMPORT FILTRÉ
router.post('/import/filtered', importExportRateLimit, upload.single('file'), importExportController.importFiltered);

// 📥 EXPORT STANDARD
router.get('/export', importExportRateLimit, importExportController.exportExcel);

// 🌊 EXPORT STREAMING (optimisé pour gros volumes)
router.get('/export/stream', importExportRateLimit, importExportController.exportStream);

// 🚀 EXPORT OPTIMISÉ (avec pagination)
router.get('/export/optimized', importExportRateLimit, importExportController.exportOptimized);

// 🎛️ EXPORT AVEC FILTRES
router.post('/export/filtered', importExportRateLimit, importExportController.exportFiltered);

// 🔍 EXPORT RÉSULTATS DE RECHERCHE
router.get('/export-resultats', importExportRateLimit, importExportController.exportResultats);

// 📋 TÉLÉCHARGEMENT TEMPLATE
router.get('/template', importExportController.downloadTemplate);

// 📊 STATISTIQUES IMPORT
router.get('/stats', importExportController.getImportStats);

// 🏢 LISTE DES SITES
router.get('/sites', importExportController.getSitesList);

// 📈 SUIVI EXPORT
router.get('/export-status/:batchId', importExportController.getExportStatus);

// 🚫 EXPORT PDF (non implémenté)
router.get('/export-pdf', importExportController.exportPDF);

// ==================== NOUVELLES ROUTES IMPORTS MASSIFS ====================

// 🚀 IMPORT MASSIF POUR 10K+ LIGNES (asynchrone)
router.post('/bulk-import', importExportRateLimit, upload.single('file'), bulkImportController.startBulkImport);

// 📊 SUIVI D'UN IMPORT MASSIF
router.get('/bulk-import/status/:importId', bulkImportController.getImportStatus);

// 🛑 ANNULATION D'UN IMPORT MASSIF
router.post('/bulk-import/cancel/:importId', bulkImportController.cancelImport);

// 📋 LISTE DES IMPORTS ACTIFS/RÉCENTS
router.get('/bulk-import/active', bulkImportController.listActiveImports);

// 📈 STATISTIQUES DES IMPORTS MASSIFS
router.get('/bulk-import/stats', bulkImportController.getImportStats);

// ==================== ROUTES ADMINISTRATION ====================

// 🎯 ROUTES ADMIN POUR LA JOURNALISATION (admin seulement)
const adminOnly = require('../middleware/adminOnly');

// ✅ Récupérer les imports groupés (admin seulement)
router.get('/imports-batch', adminOnly, async (req, res) => {
  try {
    const journalController = require('../Controllers/journalController');
    await journalController.getImports(req, res);
  } catch (error) {
    console.error('❌ Erreur récupération imports batch:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des imports',
      details: error.message
    });
  }
});

// ✅ Annuler une importation (admin seulement)
router.post('/annuler-import', adminOnly, async (req, res) => {
  try {
    const journalController = require('../Controllers/journalController');
    await journalController.annulerImportation(req, res);
  } catch (error) {
    console.error('❌ Erreur annulation import:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de l\'annulation de l\'importation',
      details: error.message
    });
  }
});

// ==================== GESTION D'ERREURS ====================

// 🛡️ GESTION D'ERREURS MULTER SPÉCIFIQUE
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    console.error('❌ Erreur Multer:', {
      code: error.code,
      message: error.message,
      field: error.field,
      file: req.file
    });
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        success: false, 
        error: 'Fichier trop volumineux',
        message: 'La taille maximale est de 50MB. Veuillez diviser votre fichier en plusieurs parties.',
        maxSize: '50MB',
        advice: 'Exportez par lots de 10 000 lignes maximum'
      });
    }
    
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ 
        success: false, 
        error: 'Trop de fichiers',
        message: 'Un seul fichier à la fois est autorisé'
      });
    }
    
    return res.status(400).json({ 
      success: false, 
      error: `Erreur d'upload: ${error.message}`,
      code: error.code
    });
  }
  
  // Erreur de validation de type de fichier
  if (error.message && error.message.includes('Excel')) {
    return res.status(400).json({ 
      success: false, 
      error: 'Format de fichier non supporté',
      message: error.message,
      acceptedFormats: ['.xlsx', '.xls'],
      mimetypes: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel'
      ]
    });
  }
  
  // Erreur générique d'upload
  console.error('❌ Erreur upload générique:', error);
  res.status(500).json({ 
    success: false, 
    error: 'Erreur lors du traitement du fichier',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
});

// ==================== ROUTE DE TEST UPLOAD ====================

router.post('/test-upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier reçu'
      });
    }
    
    console.log('✅ Fichier reçu avec succès:', {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      path: req.file.path
    });
    
    // Supprimer le fichier après test
    const fs = require('fs');
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
      console.log('🗑️ Fichier test supprimé');
    }
    
    res.json({
      success: true,
      message: 'Upload test réussi',
      fileInfo: {
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        encoding: req.file.encoding
      },
      uploadConfig: {
        maxSize: '50MB',
        acceptedFormats: ['.xlsx', '.xls'],
        destination: 'uploads/'
      }
    });
    
  } catch (error) {
    console.error('❌ Erreur test upload:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors du test d\'upload',
      details: error.message
    });
  }
});

// ==================== ROUTE DE DIAGNOSTIC ====================

router.get('/diagnostic', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  
  const uploadDir = 'uploads/';
  const uploadDirExists = fs.existsSync(uploadDir);
  let uploadDirSize = 0;
  let fileCount = 0;
  
  if (uploadDirExists) {
    try {
      const files = fs.readdirSync(uploadDir);
      fileCount = files.length;
      
      files.forEach(file => {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        uploadDirSize += stats.size;
      });
    } catch (error) {
      console.error('❌ Erreur analyse dossier uploads:', error);
    }
  }
  
  res.json({
    success: true,
    diagnostic: {
      timestamp: new Date().toISOString(),
      uploads: {
        directory: uploadDir,
        exists: uploadDirExists,
        fileCount: fileCount,
        totalSize: `${Math.round(uploadDirSize / 1024 / 1024)}MB`,
        maxFileSize: '50MB',
        acceptedFormats: ['Excel (.xlsx, .xls)']
      },
      routes: {
        import: [
          'POST /import',
          'POST /import/smart-sync',
          'POST /import/filtered',
          'POST /bulk-import (NOUVEAU)'
        ],
        export: [
          'GET /export',
          'GET /export/stream',
          'GET /export/optimized (NOUVEAU)',
          'POST /export/filtered',
          'GET /export-resultats'
        ],
        management: [
          'GET /bulk-import/status/:id',
          'POST /bulk-import/cancel/:id',
          'GET /bulk-import/active',
          'GET /bulk-import/stats'
        ],
        utilities: [
          'GET /template',
          'GET /sites',
          'GET /stats',
          'POST /test-upload'
        ]
      },
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        memory: {
          rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
        },
        environment: process.env.NODE_ENV || 'development'
      }
    }
  });
});

module.exports = router;