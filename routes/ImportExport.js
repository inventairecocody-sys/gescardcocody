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
    fileSize: 30 * 1024 * 1024, // 30MB
    files: 1
  }
});

// ==================== MIDDLEWARE ====================
router.use(verifyToken);
router.use(importExportAccess);

// ==================== ROUTES PRINCIPALES ====================

// 📥 IMPORT CSV STANDARD
router.post('/import/csv', importExportRateLimit, upload.single('file'), importExportController.importCSV);

// 🚀 IMPORT CSV AVANCÉ (BULK)
router.post('/import/csv/advanced', importExportRateLimit, upload.single('file'), importExportController.importCSVAdvanced);

// 📤 EXPORT EXCEL
router.get('/export', importExportRateLimit, importExportController.exportExcel);

// 📤 EXPORT CSV
router.get('/export/csv', importExportRateLimit, importExportController.exportCSV);

// 🔍 EXPORT CSV PAR SITE
router.get('/export/csv/site', importExportRateLimit, importExportController.exportCSVBySite);

// 📊 STATUT IMPORT CSV AVANCÉ
router.get('/import-status/:importId', importExportController.getImportStatus);

// 📋 LISTE IMPORTS ACTIFS
router.get('/imports/active', importExportController.listActiveImports);

// 🛑 ANNULER IMPORT
router.post('/import/cancel/:importId', importExportController.cancelImport);

// 📋 TEMPLATE
router.get('/template', importExportController.downloadTemplate);

// 🏢 LISTE SITES
router.get('/sites', importExportController.getSitesList);

// ==================== ROUTES DE COMPATIBILITÉ ====================

// 📥 IMPORT EXCEL (redirection)
router.post('/import', importExportRateLimit, upload.single('file'), importExportController.importCSV);

// 🔄 IMPORT INTELLIGENT (redirection)
router.post('/import/smart-sync', importExportRateLimit, upload.single('file'), importExportController.importCSV);

// 📤 EXPORT STREAMING (redirection)
router.get('/export/stream', importExportRateLimit, importExportController.exportExcel);

// 🎛️ EXPORT FILTRÉ (redirection)
router.post('/export/filtered', importExportRateLimit, importExportController.exportFiltered);

// 🔍 EXPORT RÉSULTATS (redirection)
router.get('/export-resultats', importExportRateLimit, importExportController.exportResultats);

// 📤 EXPORT OPTIMISÉ (redirection)
router.get('/export/optimized', importExportRateLimit, importExportController.exportCSV);

// ==================== ROUTES UTILITAIRES ====================

// 🩺 SANTÉ
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'import-export-unified',
    timestamp: new Date().toISOString(),
    endpoints: {
      importCSV: 'POST /import/csv',
      importCSVAdvanced: 'POST /import/csv/advanced',
      exportExcel: 'GET /export',
      exportCSV: 'GET /export/csv',
      exportBySite: 'GET /export/csv/site',
      importStatus: 'GET /import-status/:id',
      template: 'GET /template'
    }
  });
});

// 🔧 DIAGNOSTIC
router.get('/diagnostic', (req, res) => {
  const controller = importExportController._controller;
  const csvService = controller ? controller.csvImportService : null;
  
  res.json({
    success: true,
    controller: 'UnifiedImportExportController',
    activeImports: csvService ? csvService.listActiveImports().length : 0,
    memory: process.memoryUsage(),
    environment: process.env.NODE_ENV || 'development'
  });
});

module.exports = router;