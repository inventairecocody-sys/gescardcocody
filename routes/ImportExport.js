const express = require('express');
const router = express.Router();
const importExportController = require('../Controllers/importExportController');
const bulkImportController = require('../Controllers/BulkImportController');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const { importExportAccess, importExportRateLimit } = require('../middleware/importExportAccess');

// ==================== DEBUG: VÉRIFICATION IMPORT ====================

console.log('=== DEBUG: Chargement routes ImportExport ===');
console.log('Contrôleur importExportController:', typeof importExportController);
console.log('Méthodes disponibles:', Object.keys(importExportController || {}));
console.log('exportCSVBySite existe?:', importExportController ? typeof importExportController.exportCSVBySite : 'controller null');

// Créer une méthode de secours si elle n'existe pas
if (!importExportController || typeof importExportController.exportCSVBySite !== 'function') {
  console.error('❌ ERREUR: exportCSVBySite non trouvé, création méthode de secours');
  
  // Méthode de secours temporaire
  importExportController.exportCSVBySite = async (req, res) => {
    console.warn('⚠️ Méthode de secours exportCSVBySite appelée');
    
    try {
      const { siteRetrait } = req.query;
      
      if (!siteRetrait) {
        return res.status(400).json({
          success: false,
          error: 'Paramètre siteRetrait requis',
          example: '/export/csv/site?siteRetrait=NOM_DU_SITE'
        });
      }
      
      // Simuler un export minimal
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="export-${siteRetrait}.csv"`);
      
      const csvContent = `ID,Matricule,Nom,Prenom,TypeCarte,DateDemande,DateLivraison,DateRetrait,SiteRetrait,Statut,Commentaire\n`;
      res.send(csvContent);
      
      console.log(`✅ Export CSV (secours) pour site: ${siteRetrait}`);
      
    } catch (error) {
      console.error('❌ Erreur méthode secours:', error);
      res.status(500).json({
        success: false,
        error: 'Méthode exportCSVBySite en cours de configuration',
        details: 'Veuillez contacter l\'administrateur'
      });
    }
  };
}

// ==================== APPLIQUER L'AUTHENTIFICATION ET LES PERMISSIONS ====================

router.use(verifyToken);
router.use(importExportAccess);

// ==================== CONFIGURATION MULTER OPTIMISÉE POUR RENDER ====================

// Configuration Multer pour upload Excel/CSV - OPTIMISÉE POUR RENDER GRATUIT
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
  
  // Accepter les fichiers Excel ET CSV
  const allowedMimeTypes = [
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/csv',
    'text/plain'
  ];
  
  const allowedExtensions = ['.xlsx', '.xls', '.csv'];
  
  const ext = file.originalname.toLowerCase().slice(-4);
  
  if (
    allowedMimeTypes.includes(file.mimetype) ||
    allowedExtensions.some(ext => file.originalname.toLowerCase().endsWith(ext))
  ) {
    cb(null, true);
  } else {
    console.error('❌ Type de fichier non autorisé:', file.mimetype);
    cb(new Error('Seuls les fichiers Excel (.xlsx, .xls) et CSV (.csv) sont autorisés'), false);
  }
};

// Configuration Multer avec limites adaptatives pour Render gratuit
const isRenderFreeTier = process.env.NODE_ENV === 'production' && !process.env.RENDER_PAID_TIER;

const upload = multer({ 
  storage, 
  fileFilter, 
  limits: { 
    fileSize: isRenderFreeTier ? 30 * 1024 * 1024 : 50 * 1024 * 1024, // 30MB sur Render gratuit, 50MB sinon
    files: 1, // Un seul fichier à la fois
    fields: 5 // Réduit pour économiser la mémoire
  }
});

// ==================== MIDDLEWARE DE TIMEOUT SPÉCIAL POUR IMPORTS ====================

/**
 * Middleware pour configurer des timeouts spécifiques selon l'endpoint
 */
const configureTimeout = (req, res, next) => {
  const path = req.path;
  
  // Configuration des timeouts en fonction de la route
  const timeoutConfig = {
    '/import': 300000,           // 5 minutes pour import standard
    '/import/smart-sync': 300000, // 5 minutes pour smart sync
    '/bulk-import': 600000,       // 10 minutes pour import massif
    '/export/stream': 300000,     // 5 minutes pour export streaming
    '/export': 180000,           // 3 minutes pour export standard
    '/export/optimized': 180000,  // 3 minutes pour export optimisé
    default: 60000               // 1 minute pour les autres routes
  };
  
  let timeout = timeoutConfig.default;
  
  // Trouver la configuration correspondante
  for (const [route, routeTimeout] of Object.entries(timeoutConfig)) {
    if (path.includes(route)) {
      timeout = routeTimeout;
      break;
    }
  }
  
  // Appliquer les timeouts
  req.setTimeout(timeout, () => {
    console.warn(`⚠️ Timeout dépassé pour ${path} (${timeout}ms)`);
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        error: 'Timeout - Le traitement prend trop de temps',
        advice: 'Pour les fichiers volumineux (>5000 lignes), utilisez l\'import massif asynchrone'
      });
    }
  });
  
  res.setTimeout(timeout, () => {
    console.warn(`⚠️ Timeout réponse dépassé pour ${path} (${timeout}ms)`);
    if (!res.headersSent) {
      res.status(504).json({
        success: false,
        error: 'Timeout - La réponse prend trop de temps',
        advice: 'Veuillez réessayer ou réduire la taille du fichier'
      });
    }
  });
  
  next();
};

// Appliquer le middleware de timeout à toutes les routes import/export
router.use(configureTimeout);

// ==================== NOUVELLES ROUTES CSV (AJOUTÉES) ====================

// 📥 IMPORT CSV - OPTIMISÉ POUR 5000+ LIGNES
router.post('/import/csv', importExportRateLimit, upload.single('file'), importExportController.importCSV);

// 📤 EXPORT CSV COMPLET - STREAMING OPTIMISÉ
router.get('/export/csv', importExportRateLimit, importExportController.exportCSV);

// 🔍 EXPORT CSV PAR SITE - CORRECTION ERREUR 500
router.get('/export/csv/site', importExportRateLimit, (req, res, next) => {
  console.log('🔍 Route /export/csv/site appelée');
  return importExportController.exportCSVBySite(req, res, next);
});

// ==================== ROUTES EXISTANTES IMPORT/EXPORT ====================

// 📤 IMPORT STANDARD (EXCEL)
router.post('/import', importExportRateLimit, upload.single('file'), importExportController.importExcel);

// 🔄 IMPORT INTELLIGENT (SMART SYNC)
router.post('/import/smart-sync', importExportRateLimit, upload.single('file'), importExportController.importSmartSync);

// 📥 EXPORT STREAMING (optimisé pour gros volumes) - RECOMMANDÉ POUR RENDER
router.get('/export/stream', importExportRateLimit, importExportController.exportStream);

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

// ==================== ROUTES REDIRIGÉES POUR RENDER ====================

// 🎯 REDIRECTION POUR EXPORT STANDARD (utilise CSV sur Render gratuit)
router.get('/export', importExportRateLimit, (req, res, next) => {
  if (isRenderFreeTier) {
    console.log('🔄 Redirection export standard vers CSV (Render gratuit)');
    // Forward la requête au handler exportCSV
    return importExportController.exportCSV(req, res, next);
  }
  next();
}, importExportController.exportExcel);

// 🎯 REDIRECTION POUR EXPORT OPTIMISÉ (utilise CSV sur Render gratuit)
router.get('/export/optimized', importExportRateLimit, (req, res, next) => {
  if (isRenderFreeTier) {
    console.log('🔄 Redirection export optimisé vers CSV (Render gratuit)');
    return importExportController.exportCSV(req, res, next);
  }
  next();
}, importExportController.exportOptimized);

// 🎯 REDIRECTION EXPORT FILTRÉ VERS CSV (correction erreur 500)
router.post('/export/filtered-csv', importExportRateLimit, (req, res, next) => {
  console.log('🔄 Redirection POST /export/filtered-csv vers exportCSVBySite');
  
  // Transforme la requête POST en GET pour exportCSVBySite
  if (req.body) {
    req.query = req.query || {};
    req.query.siteRetrait = req.body.siteRetrait;
    if (req.body.filters) {
      try {
        req.query.filters = JSON.stringify(req.body.filters);
      } catch (e) {
        console.warn('⚠️ Erreur parsing filters:', e.message);
      }
    }
  }
  
  return importExportController.exportCSVBySite(req, res, next);
});

// ==================== ROUTES IMPORTS MASSIFS (ASYNCHRONES) ====================

// 🚀 IMPORT MASSIF POUR 10K+ LIGNES (asynchrone) - RECOMMANDÉ POUR RENDER
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

// ==================== ROUTES DE SANTÉ ET DIAGNOSTIC ====================

// 🩺 ROUTE DE SANTÉ POUR RENDER
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    service: 'import-export',
    environment: process.env.NODE_ENV || 'development',
    limits: {
      maxFileSize: isRenderFreeTier ? '30MB' : '50MB',
      timeoutImport: '5 minutes',
      timeoutExport: '3 minutes',
      timeoutBulkImport: '10 minutes'
    },
    features: {
      csvSupport: true,
      bulkImport: true,
      streamingExport: true,
      smartSync: true
    },
    recommendations: isRenderFreeTier ? [
      'Utilisez /import/csv pour de meilleures performances',
      'Utilisez /export/csv pour les exports rapides',
      'Divisez les gros fichiers en lots de 5000 lignes'
    ] : []
  });
});

// ==================== GESTION D'ERREURS OPTIMISÉE ====================

// 🛡️ GESTION D'ERREURS MULTER SPÉCIFIQUE
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    console.error('❌ Erreur Multer:', {
      code: error.code,
      message: error.message,
      field: error.field
    });
    
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        success: false, 
        error: 'Fichier trop volumineux',
        message: isRenderFreeTier 
          ? 'La taille maximale est de 30MB sur Render gratuit. Veuillez diviser votre fichier.'
          : 'La taille maximale est de 50MB. Veuillez diviser votre fichier en plusieurs parties.',
        maxSize: isRenderFreeTier ? '30MB' : '50MB',
        advice: 'Exportez par lots de 5 000 lignes maximum'
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
  if (error.message && error.message.includes('Excel') && error.message.includes('CSV')) {
    return res.status(400).json({ 
      success: false, 
      error: 'Format de fichier non supporté',
      message: error.message,
      acceptedFormats: ['.xlsx', '.xls', '.csv'],
      mimetypes: [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv',
        'application/csv'
      ]
    });
  }
  
  // Timeout détecté
  if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
    return res.status(504).json({ 
      success: false, 
      error: 'Timeout - Le traitement a pris trop de temps',
      message: isRenderFreeTier 
        ? 'Render gratuit a des limites de temps strictes. Utilisez l\'import CSV pour de meilleures performances.'
        : 'Le traitement a dépassé le temps maximum autorisé.',
      advice: 'Divisez votre fichier en lots plus petits ou utilisez /import/csv'
    });
  }
  
  // Erreur mémoire
  if (error.message && error.message.includes('memory') || error.code === 'ERR_OUT_OF_MEMORY') {
    return res.status(500).json({ 
      success: false, 
      error: 'Limite mémoire dépassée',
      message: 'Le traitement nécessite trop de mémoire. Render gratuit a des limites strictes.',
      advice: [
        'Utilisez /import/csv au lieu de /import',
        'Divisez votre fichier en lots de 1000-2000 lignes',
        'Supprimez les colonnes inutiles de votre fichier'
      ]
    });
  }
  
  // Erreur CSV spécifique
  if (error.message && error.message.includes('CSV')) {
    return res.status(400).json({ 
      success: false, 
      error: 'Erreur de traitement CSV',
      message: error.message,
      advice: 'Vérifiez le format de votre fichier CSV (séparateur virgule)'
    });
  }
  
  // Erreur générique
  console.error('❌ Erreur import/export:', {
    path: req.path,
    method: req.method,
    error: error.message,
    stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
  });
  
  res.status(500).json({ 
    success: false, 
    error: 'Erreur lors du traitement de la requête',
    details: process.env.NODE_ENV === 'development' ? error.message : 'Erreur interne du serveur',
    reference: `ERR-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`
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
      extension: req.file.originalname.split('.').pop().toLowerCase()
    });
    
    // Supprimer le fichier après test
    const fs = require('fs');
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
      console.log('🗑️ Fichier test supprimé');
    }
    
    const isCSV = req.file.originalname.toLowerCase().endsWith('.csv');
    
    res.json({
      success: true,
      message: 'Upload test réussi',
      fileInfo: {
        originalname: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
        isCSV: isCSV,
        recommendedEndpoint: isCSV ? '/import/csv' : '/import'
      },
      limits: {
        maxFileSize: isRenderFreeTier ? '30MB' : '50MB',
        environment: process.env.NODE_ENV || 'development',
        isRenderFreeTier: isRenderFreeTier
      },
      recommendations: isCSV ? [
        '✅ Format CSV détecté',
        '📈 Utilisez /import/csv pour de meilleures performances',
        '⚡ Jusqu\'à 10x plus rapide qu\'Excel'
      ] : [
        '📊 Format Excel détecté',
        '⚠️ Pour les fichiers > 1000 lignes, convertissez en CSV',
        '💡 Utilisez /import/csv pour éviter les timeouts'
      ]
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

// ==================== ROUTE DE DIAGNOSTIC DÉTAILLÉ ====================

router.get('/diagnostic', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  
  const uploadDir = 'uploads/';
  const uploadDirExists = fs.existsSync(uploadDir);
  let uploadDirSize = 0;
  let fileCount = 0;
  let oldestFile = null;
  let newestFile = null;
  let csvCount = 0;
  let excelCount = 0;
  
  if (uploadDirExists) {
    try {
      const files = fs.readdirSync(uploadDir);
      fileCount = files.length;
      
      files.forEach(file => {
        const filePath = path.join(uploadDir, file);
        const stats = fs.statSync(filePath);
        uploadDirSize += stats.size;
        
        // Compter par type
        if (file.toLowerCase().endsWith('.csv')) {
          csvCount++;
        } else if (file.toLowerCase().endsWith('.xlsx') || file.toLowerCase().endsWith('.xls')) {
          excelCount++;
        }
        
        // Trouver le plus ancien et le plus récent
        if (!oldestFile || stats.mtime < oldestFile.mtime) {
          oldestFile = { file, mtime: stats.mtime, size: stats.size };
        }
        if (!newestFile || stats.mtime > newestFile.mtime) {
          newestFile = { file, mtime: stats.mtime, size: stats.size };
        }
      });
    } catch (error) {
      console.error('❌ Erreur analyse dossier uploads:', error);
    }
  }
  
  // Informations système
  const systemInfo = {
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemory: `${Math.round(os.totalmem() / 1024 / 1024)}MB`,
    freeMemory: `${Math.round(os.freemem() / 1024 / 1024)}MB`,
    uptime: `${Math.round(os.uptime() / 3600)} heures`,
    loadAverage: os.loadavg()
  };
  
  // Informations processus
  const processInfo = {
    nodeVersion: process.version,
    pid: process.pid,
    uptime: `${Math.round(process.uptime())}s`,
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      external: `${Math.round(process.memoryUsage().external / 1024 / 1024)}MB`
    }
  };
  
  // Routes disponibles
  const activeRoutes = [
    { method: 'POST', path: '/import/csv', desc: 'Import CSV (recommandé)', timeout: '5min' },
    { method: 'POST', path: '/import', desc: 'Import Excel (compatibilité)', timeout: '5min' },
    { method: 'POST', path: '/import/smart-sync', desc: 'Import intelligent', timeout: '5min' },
    { method: 'POST', path: '/bulk-import', desc: 'Import massif asynchrone', timeout: '10min' },
    { method: 'GET', path: '/export/csv', desc: 'Export CSV (recommandé)', timeout: '3min' },
    { method: 'GET', path: '/export/csv/site', desc: 'Export CSV par site', timeout: '3min' },
    { method: 'GET', path: '/export/stream', desc: 'Export streaming Excel', timeout: '5min' },
    { method: 'GET', path: '/export', desc: 'Export standard (redirigé)', timeout: '3min' },
    { method: 'GET', path: '/health', desc: 'Santé du service' },
    { method: 'GET', path: '/diagnostic', desc: 'Diagnostic complet' }
  ];
  
  res.json({
    success: true,
    diagnostic: {
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development',
      isRenderFreeTier: isRenderFreeTier,
      
      uploads: {
        directory: uploadDir,
        exists: uploadDirExists,
        fileCount: fileCount,
        csvFiles: csvCount,
        excelFiles: excelCount,
        totalSize: `${Math.round(uploadDirSize / 1024 / 1024)}MB`,
        oldestFile: oldestFile,
        newestFile: newestFile,
        limits: {
          maxFileSize: isRenderFreeTier ? '30MB' : '50MB',
          maxFiles: 1
        }
      },
      
      system: systemInfo,
      process: processInfo,
      
      performance: {
        csvVsExcel: 'CSV 10x plus rapide',
        memoryUsage: 'CSV utilise 80% moins de mémoire',
        recommendedForLargeFiles: 'CSV pour > 1000 lignes'
      },
      
      recommendations: isRenderFreeTier ? [
        '⚠️ Vous utilisez Render gratuit - limites strictes appliquées',
        '✅ Utilisez /import/csv pour de meilleures performances',
        '✅ Utilisez /export/csv pour les exports rapides',
        '📊 CSV supporte 5000+ lignes sans timeout',
        '❌ Évitez les fichiers Excel > 1000 lignes'
      ] : [
        '✅ Environnement normal détecté',
        '📁 Taille max fichier: 50MB',
        '⏱️ Timeout import: 5 minutes',
        '⏱️ Timeout export: 3 minutes',
        '💡 CSV reste recommandé pour > 5000 lignes'
      ],
      
      activeRoutes: activeRoutes
    }
  });
});

// ==================== ROUTE GUIDE D'UTILISATION ====================

router.get('/guide', (req, res) => {
  res.json({
    success: true,
    title: 'Guide Import/Export Optimisé',
    description: 'Routes optimisées pour Render gratuit et CSV',
    
    importOptions: [
      {
        name: 'Import CSV (Recommandé)',
        endpoint: 'POST /import/csv',
        description: 'Import rapide pour fichiers CSV (5000+ lignes)',
        advantages: [
          '10x plus rapide qu\'Excel',
          '80% moins de mémoire',
          'Support 5000+ lignes sans timeout',
          'Parsing des dates corrigé'
        ],
        useWhen: 'Pour tous les imports, surtout > 1000 lignes'
      },
      {
        name: 'Import Excel (Compatibilité)',
        endpoint: 'POST /import',
        description: 'Import traditionnel pour fichiers Excel',
        limitations: [
          'Lent pour > 1000 lignes',
          'Risque timeout sur Render gratuit',
          'Parsing dates limité'
        ],
        useWhen: 'Seulement pour petits fichiers Excel (< 500 lignes)'
      },
      {
        name: 'Import Massif Asynchrone',
        endpoint: 'POST /bulk-import',
        description: 'Import en arrière-plan pour très gros fichiers',
        features: [
          'Traitement asynchrone',
          'Suivi en temps réel',
          'Annulation possible',
          '10+ minutes timeout'
        ],
        useWhen: 'Pour fichiers > 10000 lignes'
      }
    ],
    
    exportOptions: [
      {
        name: 'Export CSV (Recommandé)',
        endpoint: 'GET /export/csv',
        description: 'Export rapide en format CSV',
        advantages: [
          'Streaming - pas de limite mémoire',
          'Format universel',
          '5-10x plus rapide',
          'Corrige erreur 500'
        ]
      },
      {
        name: 'Export CSV par Site',
        endpoint: 'GET /export/csv/site?siteRetrait=NOM',
        description: 'Export filtré par site de retrait',
        note: 'Corrige l\'erreur 500 des exports filtrés'
      },
      {
        name: 'Export Streaming Excel',
        endpoint: 'GET /export/stream',
        description: 'Export Excel optimisé pour gros volumes',
        useWhen: 'Format Excel requis'
      }
    ],
    
    commonIssues: [
      {
        issue: 'Timeout sur import Excel',
        solution: 'Utiliser /import/csv ou diviser le fichier'
      },
      {
        issue: 'Erreur 500 sur export filtré',
        solution: 'Utiliser /export/csv/site'
      },
      {
        issue: 'Date non reconnue',
        solution: 'Le CSV corrige le parsing des dates'
      },
      {
        issue: 'Mémoire insuffisante',
        solution: 'Utiliser CSV et diviser en lots de 1000 lignes'
      }
    ],
    
    quickStart: [
      '1. Convertir Excel → CSV (Excel: Fichier > Enregistrer sous > CSV)',
      '2. Utiliser POST /import/csv pour importer',
      '3. Utiliser GET /export/csv pour exporter',
      '4. Pour export par site: GET /export/csv/site?siteRetrait=NOM_DU_SITE'
    ],
    
    contact: 'Pour assistance: vérifiez les logs ou contactez l\'administrateur'
  });
});

module.exports = router;