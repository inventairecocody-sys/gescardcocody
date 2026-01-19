const express = require('express');
const router = express.Router();
const importExportController = require('../Controllers/importExportController');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const { importExportAccess, importExportRateLimit } = require('../middleware/importExportAccess');

// ==================== CONFIGURATION MULTER ====================
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const fs = require('fs');
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const safeFileName = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `import-${uniqueSuffix}-${safeFileName}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.xlsx', '.xls', '.csv'];
  const ext = file.originalname.toLowerCase().slice(-4);
  
  if (allowedExtensions.some(allowed => ext.endsWith(allowed))) {
    cb(null, true);
  } else {
    cb(new Error('Seuls les fichiers Excel (.xlsx, .xls) et CSV (.csv) sont autorisés'), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter, 
  limits: { 
    fileSize: 20 * 1024 * 1024, // 20MB (réduit pour Render gratuit)
    files: 1
  }
});

// ==================== MIDDLEWARE ====================
router.use(verifyToken);
router.use(importExportAccess);

// ==================== ROUTES PRINCIPALES ====================

// 📥 IMPORT CSV STANDARD
router.post('/import/csv', importExportRateLimit, upload.single('file'), importExportController.importCSV);

// 📤 EXPORT EXCEL (OPTIMISÉ)
router.get('/export', importExportRateLimit, importExportController.exportExcel);

// 📤 EXPORT CSV (OPTIMISÉ)
router.get('/export/csv', importExportRateLimit, importExportController.exportCSV);

// 🔍 EXPORT CSV PAR SITE
router.get('/export/csv/site', importExportRateLimit, importExportController.exportCSVBySite);

// 📋 TEMPLATE
router.get('/template', importExportController.downloadTemplate);

// 🏢 LISTE SITES
router.get('/sites', importExportController.getSitesList);

// 🩺 DIAGNOSTIC
router.get('/diagnostic', importExportController.diagnostic);

// ==================== ROUTES DE COMPATIBILITÉ ====================

// 📥 IMPORT EXCEL (redirection)
router.post('/import', importExportRateLimit, upload.single('file'), importExportController.importExcel);

// 🔄 IMPORT INTELLIGENT (redirection)
router.post('/import/smart-sync', importExportRateLimit, upload.single('file'), importExportController.importSmartSync);

// 📤 EXPORT STREAMING (redirection)
router.get('/export/stream', importExportRateLimit, importExportController.exportStream);

// 🎛️ EXPORT FILTRÉ (redirection)
router.post('/export/filtered', importExportRateLimit, importExportController.exportFiltered);

// 🔍 EXPORT RÉSULTATS (redirection)
router.get('/export-resultats', importExportRateLimit, importExportController.exportResultats);

// 📤 EXPORT OPTIMISÉ (redirection)
router.get('/export/optimized', importExportRateLimit, importExportController.exportOptimized);

// ==================== ROUTES DE SANTÉ ====================

// 🩺 SANTÉ
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'import-export-optimized',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      importCSV: 'POST /import/csv',
      exportExcel: 'GET /export',
      exportCSV: 'GET /export/csv',
      exportBySite: 'GET /export/csv/site',
      template: 'GET /template',
      sites: 'GET /sites',
      diagnostic: 'GET /diagnostic'
    },
    recommendations: [
      '✅ Utilisez /export/csv pour les exports optimisés',
      '⚠️ /export (Excel) est plus lent sur les gros fichiers',
      '💡 Exportez par site pour de meilleures performances'
    ]
  });
});

// 🧪 TEST SIMPLE
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Import/Export API fonctionnelle',
    timestamp: new Date().toISOString(),
    version: '2.0.0-optimized',
    features: [
      'Export CSV optimisé (streaming)',
      'Export Excel avec limites',
      'Import CSV par lots',
      'Export par site',
      'Diagnostic intégré'
    ]
  });
});

module.exports = router;