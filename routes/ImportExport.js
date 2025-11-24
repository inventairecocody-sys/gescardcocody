const express = require('express');
const router = express.Router();
const importExportController = require('../Controllers/importExportController');
const multer = require('multer');
const { verifyToken } = require('../middleware/auth');
const importExportAccess = require('../middleware/importExportAccess'); // ✅ NOUVEAU MIDDLEWARE

// ✅ APPLIQUER L'AUTHENTIFICATION ET LES PERMISSIONS IMPORT/EXPORT
router.use(verifyToken);
router.use(importExportAccess); // ✅ RESTREINT L'ACCÈS

// Configuration Multer pour upload Excel
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const fs = require('fs');
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, `import-${uniqueSuffix}-${file.originalname}`);
  }
});

const fileFilter = (req, file, cb) => {
  if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.mimetype === 'application/vnd.ms-excel' ||
    file.originalname.match(/\.(xlsx|xls)$/)
  ) {
    cb(null, true);
  } else {
    cb(new Error('Seuls les fichiers Excel (.xlsx, .xls) sont autorisés'), false);
  }
};

const upload = multer({ 
  storage, 
  fileFilter, 
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Routes principales - PROTÉGÉES PAR importExportAccess
router.post('/import', upload.single('file'), importExportController.importExcel);
router.get('/export', importExportController.exportExcel);
router.get('/export-resultats', importExportController.exportResultats);
router.get('/template', importExportController.downloadTemplate);
router.get('/export-pdf', importExportController.exportPDF);

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
      error: 'Erreur lors de la récupération des imports'
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
      error: 'Erreur lors de l\'annulation de l\'importation'
    });
  }
});

// Gestion d'erreurs multer
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        success: false, 
        error: 'Fichier trop volumineux (max 10MB)' 
      });
    }
    return res.status(400).json({ 
      success: false, 
      error: `Erreur upload: ${error.message}` 
    });
  }
  
  if (error.message.includes('Excel')) {
    return res.status(400).json({ 
      success: false, 
      error: error.message 
    });
  }
  
  console.error('❌ Erreur upload:', error);
  res.status(500).json({ 
    success: false, 
    error: 'Erreur lors du traitement du fichier' 
  });
});

module.exports = router;