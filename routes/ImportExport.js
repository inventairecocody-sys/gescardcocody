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

// 📤 EXPORT EXCEL (OPTIMISÉ - limité à 5000 lignes)
router.get('/export', importExportRateLimit, importExportController.exportExcel);

// 📤 EXPORT CSV (OPTIMISÉ - limité à 5000 lignes)
router.get('/export/csv', importExportRateLimit, importExportController.exportCSV);

// 🔍 EXPORT CSV PAR SITE
router.get('/export/csv/site', importExportRateLimit, importExportController.exportCSVBySite);

// 📋 TEMPLATE
router.get('/template', importExportController.downloadTemplate);

// 🏢 LISTE SITES
router.get('/sites', importExportController.getSitesList);

// 🩺 DIAGNOSTIC
router.get('/diagnostic', importExportController.diagnostic);

// ==================== ROUTES D'EXPORT COMPLET ====================

// 🚀 EXPORT EXCEL COMPLET (TOUTES les données - sans limite)
router.get('/export/complete', importExportRateLimit, importExportController.exportCompleteExcel);

// 🚀 EXPORT CSV COMPLET (TOUTES les données - sans limite)
router.get('/export/complete/csv', importExportRateLimit, importExportController.exportCompleteCSV);

// 🚀 EXPORT "TOUT EN UN" (choix automatique du meilleur format)
router.get('/export/all', importExportRateLimit, importExportController.exportAllData);

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

// ==================== ROUTES DE TEST ET DIAGNOSTIC ====================

// 🧪 TEST EXPORT SIMPLE
router.get('/test/export', importExportRateLimit, async (req, res) => {
  try {
    const client = await require('../db/db').getClient();
    const result = await client.query('SELECT COUNT(*) as total FROM cartes');
    const totalRows = parseInt(result.rows[0].total);
    
    res.json({
      success: true,
      message: 'Test d\'export disponible',
      data: {
        total_cartes: totalRows,
        endpoints: {
          export_limite_excel: '/api/import-export/export (max 5000 lignes)',
          export_limite_csv: '/api/import-export/export/csv (max 5000 lignes)',
          export_complet_excel: '/api/import-export/export/complete (TOUTES les données)',
          export_complet_csv: '/api/import-export/export/complete/csv (TOUTES les données)',
          export_tout_en_un: '/api/import-export/export/all (choix automatique)'
        },
        recommendations: [
          totalRows > 5000 ? 
            `⚠️ Vous avez ${totalRows} cartes. Utilisez les routes /complete pour tout exporter` :
            `✅ Vous avez ${totalRows} cartes. Toutes les routes fonctionnent`,
          totalRows > 20000 ? 
            '📊 Gros volume: CSV recommandé pour plus de rapidité' :
            '📊 Volume modéré: Excel ou CSV fonctionnent bien'
        ]
      }
    });
    
    client.release();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 📊 STATISTIQUES D'EXPORT
router.get('/stats', importExportRateLimit, async (req, res) => {
  try {
    const client = await require('../db/db').getClient();
    
    // Compter toutes les cartes
    const totalResult = await client.query('SELECT COUNT(*) as total FROM cartes');
    const totalRows = parseInt(totalResult.rows[0].total);
    
    // Compter par site
    const sitesResult = await client.query(`
      SELECT "SITE DE RETRAIT" as site, COUNT(*) as count 
      FROM cartes 
      WHERE "SITE DE RETRAIT" IS NOT NULL 
      GROUP BY "SITE DE RETRAIT" 
      ORDER BY count DESC
      LIMIT 10
    `);
    
    // Dernier import
    const lastImportResult = await client.query(`
      SELECT MAX(created_at) as last_import, 
             COUNT(DISTINCT importbatchid) as import_count 
      FROM cartes 
      WHERE importbatchid IS NOT NULL
    `);
    
    res.json({
      success: true,
      stats: {
        total_cartes: totalRows,
        top_sites: sitesResult.rows,
        imports: {
          dernier: lastImportResult.rows[0].last_import,
          total_batches: parseInt(lastImportResult.rows[0].import_count || 0)
        },
        export_capacite: {
          limite: '5000 lignes pour /export et /export/csv',
          complet: 'TOUTES les données pour /export/complete*',
          recommandation: totalRows > 10000 ? 
            'Utilisez /export/all pour le format optimal' :
            'Toutes les routes fonctionnent'
        }
      }
    });
    
    client.release();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== ROUTES DE SANTÉ ====================

// 🩺 SANTÉ
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'import-export-complet',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      // Import
      importCSV: 'POST /import/csv',
      
      // Export limité
      exportExcel: 'GET /export (max 5000 lignes)',
      exportCSV: 'GET /export/csv (max 5000 lignes)',
      exportBySite: 'GET /export/csv/site',
      
      // Export COMPLET (NOUVEAU)
      exportCompleteExcel: 'GET /export/complete (TOUTES les données)',
      exportCompleteCSV: 'GET /export/complete/csv (TOUTES les données)',
      exportAllData: 'GET /export/all (choix automatique)',
      
      // Utilitaires
      template: 'GET /template',
      sites: 'GET /sites',
      diagnostic: 'GET /diagnostic',
      stats: 'GET /stats',
      testExport: 'GET /test/export'
    },
    recommendations: [
      '✅ Export complet disponible !',
      '🚀 Utilisez /export/all pour exporter TOUTES vos données',
      '📊 /export/complete pour Excel, /export/complete/csv pour CSV',
      '⚡ CSV recommandé pour plus de 20,000 lignes',
      '💡 /export et /export/csv restent limités à 5000 lignes'
    ],
    version: '3.0.0-complet'
  });
});

// 🧪 TEST SIMPLE
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Import/Export API COMPLETE fonctionnelle',
    timestamp: new Date().toISOString(),
    version: '3.0.0-complet',
    features: [
      '✅ Export CSV optimisé (streaming)',
      '✅ Export Excel avec limites (5000 lignes)',
      '🚀 NOUVEAU: Export Excel COMPLET (toutes les données)',
      '🚀 NOUVEAU: Export CSV COMPLET (toutes les données)',
      '🚀 NOUVEAU: Export "Tout en un" (choix automatique)',
      '📊 Import CSV par lots',
      '📍 Export par site',
      '📈 Diagnostic intégré',
      '📊 Statistiques d\'export'
    ],
    quick_start: [
      'Pour exporter TOUT: /api/import-export/export/all',
      'Pour Excel complet: /api/import-export/export/complete',
      'Pour CSV complet: /api/import-export/export/complete/csv',
      'Pour export limité: /api/import-export/export ou /export/csv'
    ]
  });
});

// ==================== ROUTE DE GUIDAGE ====================

router.get('/', (req, res) => {
  res.json({
    title: 'API Import/Export COMPLETE',
    description: 'Exportez TOUTES vos données en une seule fois !',
    endpoints: {
      export_complet: {
        description: 'Exporter TOUTES les données (sans limite)',
        routes: {
          tout_en_un: {
            path: '/api/import-export/export/all',
            method: 'GET',
            description: 'Choix automatique du meilleur format (Excel ou CSV)',
            headers: 'Authorization: Bearer <token>'
          },
          excel_complet: {
            path: '/api/import-export/export/complete',
            method: 'GET',
            description: 'Export COMPLET en Excel (toutes les données)',
            format: '.xlsx'
          },
          csv_complet: {
            path: '/api/import-export/export/complete/csv',
            method: 'GET',
            description: 'Export COMPLET en CSV (toutes les données)',
            format: '.csv'
          }
        }
      },
      export_limite: {
        description: 'Export limité à 5000 lignes (pour compatibilité)',
        routes: {
          excel: {
            path: '/api/import-export/export',
            method: 'GET',
            description: 'Export limité en Excel (max 5000 lignes)'
          },
          csv: {
            path: '/api/import-export/export/csv',
            method: 'GET',
            description: 'Export limité en CSV (max 5000 lignes)'
          }
        }
      },
      import: {
        description: 'Importer des données',
        routes: {
          csv: {
            path: '/api/import-export/import/csv',
            method: 'POST',
            description: 'Importer un fichier CSV',
            headers: 'Content-Type: multipart/form-data'
          }
        }
      },
      utilitaires: {
        description: 'Outils complémentaires',
        routes: {
          sites: '/api/import-export/sites',
          template: '/api/import-export/template',
          diagnostic: '/api/import-export/diagnostic',
          stats: '/api/import-export/stats',
          test: '/api/import-export/test/export'
        }
      }
    },
    conseils: [
      '💡 Pour exporter TOUTES vos cartes: utilisez /export/all',
      '📊 Si vous avez > 20,000 cartes: CSV est plus rapide',
      '🎯 Si vous avez < 5,000 cartes: /export ou /export/csv suffisent',
      '⏱️ Les exports complets peuvent prendre plusieurs minutes',
      '✅ Vérifiez /diagnostic pour voir le nombre total de cartes'
    ],
    version: '3.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date().toISOString()
  });
});

module.exports = router;