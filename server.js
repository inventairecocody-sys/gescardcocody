const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
dotenv.config();

const { query, isRenderFreeTier } = require("./db/db");

// Import des routes
const authRoutes = require("./routes/authRoutes");
const cartesRoutes = require("./routes/Cartes");
const importExportRoutes = require("./routes/ImportExport");
const journalRoutes = require("./routes/journal");
const logRoutes = require("./routes/log");
const utilisateursRoutes = require("./routes/utilisateurs");
const profilRoutes = require("./routes/profils");
const inventaireRoutes = require("./routes/Inventaire");
const statistiquesRoutes = require("./routes/statistiques");
const externalApiRoutes = require("./routes/externalApi");

// 🆕 NOUVEAU IMPORT POUR BACKUP
const backupRoutes = require("./routes/backupRoutes");
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CONFIGURATION BACKUP AUTOMATIQUE ==========
async function setupBackupSystem() {
  console.log('🔧 Configuration du système de backup...');
  
  // Vérifier si les clés Google sont configurées
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_REFRESH_TOKEN) {
    console.log('⚠️  Système de backup désactivé (tokens Google manquants)');
    console.log('ℹ️  Pour activer, ajoutez sur Render :');
    console.log('   - GOOGLE_CLIENT_ID');
    console.log('   - GOOGLE_CLIENT_SECRET');
    console.log('   - GOOGLE_REFRESH_TOKEN');
    console.log('   - GOOGLE_REDIRECT_URI');
    console.log('   - AUTO_RESTORE=true');
    return;
  }
  
  try {
    const PostgreSQLBackup = require('./backup-postgres');
    const PostgreSQLRestorer = require('./restore-postgres');
    
    const backupService = new PostgreSQLBackup();
    const restoreService = new PostgreSQLRestorer();
    
    // Vérifier si la base est vide (nouveau mois sur Render)
    const { Client } = require('pg');
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await client.connect();
    const result = await client.query("SELECT COUNT(*) as count FROM cartes");
    const carteCount = parseInt(result.rows[0].count);
    await client.end();
    
    console.log(`📊 Base de données: ${carteCount} cartes trouvées`);
    
    // Si moins de 10 cartes, restaurer automatiquement
    if (carteCount < 10 && process.env.AUTO_RESTORE === 'true') {
      console.log('🔄 Base semble vide, tentative de restauration automatique...');
      try {
        await restoreService.executeRestoration();
        console.log('✅ Base restaurée automatiquement depuis Google Drive');
      } catch (restoreError) {
        console.error('❌ Restauration auto échouée:', restoreError.message);
        console.log('ℹ️  La base démarrera vide, un backup sera créé automatiquement');
      }
    }
    
    // Backup automatique tous les jours à 2h du matin
    cron.schedule('0 2 * * *', async () => {
      console.log('⏰ Backup automatique programmé...');
      try {
        await backupService.executeBackup();
        console.log('✅ Backup automatique réussi');
      } catch (error) {
        console.error('❌ Backup automatique échoué:', error.message);
      }
    });
    
    console.log('✅ Système de backup configuré (tous les jours à 2h)');
    console.log('📁 Backups sauvegardés sur Google Drive -> dossier "gescard_backups"');
    
  } catch (error) {
    console.error('⚠️ Erreur configuration backup:', error.message);
  }
}

// ========== OPTIMISATIONS POUR RENDER GRATUIT ==========
console.log(`⚙️ Environnement: ${process.env.NODE_ENV || 'development'}`);
console.log(`💾 Plan Render: ${isRenderFreeTier ? 'GRATUIT (512MB)' : 'PAYANT'}`);

// Optimiser la mémoire Node.js pour Render gratuit
if (isRenderFreeTier) {
  console.log('🧠 Configuration optimisée pour Render gratuit');
  
  // Configurer la mémoire Node.js
  const v8 = require('v8');
  const heapStatistics = v8.getHeapStatistics();
  console.log(`📊 Heap total: ${Math.round(heapStatistics.total_heap_size / 1024 / 1024)}MB`);
  
  // Optimiser le garbage collection
  if (global.gc) {
    console.log('🧹 Garbage collection forcé disponible');
    // Forcer un premier GC au démarrage
    try {
      global.gc();
      console.log('🧹 Premier GC forcé effectué');
    } catch (error) {
      console.warn('⚠️ Impossible de forcer le GC:', error.message);
    }
  }
}

// ========== CONFIGURATION POUR EXPORTS COMPLETS ==========

// Activer trust proxy pour éviter les problèmes de rate limiting
app.set('trust proxy', 1); // Faire confiance au premier proxy

// Augmenter les timeouts pour les gros exports
const configureExportTimeouts = (req, res, next) => {
  // Routes d'export COMPLET (toutes les données)
  const exportCompleteRoutes = [
    '/api/import-export/export/complete',
    '/api/import-export/export/complete/csv',
    '/api/import-export/export/all'
  ];
  
  const isExportComplete = exportCompleteRoutes.some(route => req.path.includes(route));
  
  if (isExportComplete) {
    // Timeouts très longs pour les exports complets
    const timeoutMs = isRenderFreeTier ? 300000 : 600000; // 5-10 minutes
    
    req.setTimeout(timeoutMs);
    res.setTimeout(timeoutMs);
    
    // Ajouter des headers d'information
    res.setHeader('X-Export-Complete', 'true');
    res.setHeader('X-Timeout-MS', timeoutMs.toString());
    res.setHeader('X-Environment', isRenderFreeTier ? 'render-free' : 'production');
    
    console.log(`⏱️ Timeout configuré à ${timeoutMs/1000}s pour l'export complet: ${req.url}`);
  }
  
  // Routes nécessitant des timeouts plus longs
  const longTimeoutRoutes = [
    '/api/import-export/import',
    '/api/import-export/import/smart-sync',
    '/api/import-export/bulk-import',
    '/api/import-export/export/stream',
    '/api/import-export/export/optimized',
    '/api/statistiques/refresh'
  ];
  
  const isLongTimeoutRoute = longTimeoutRoutes.some(route => req.path.includes(route));
  
  if (isLongTimeoutRoute && !isExportComplete) {
    // Timeouts adaptés à l'environnement
    const timeoutMs = isRenderFreeTier ? 240000 : 300000; // 4 min sur Render, 5 min sinon
    
    req.setTimeout(timeoutMs);
    res.setTimeout(timeoutMs);
    
    // Ajouter des headers d'information
    res.setHeader('X-Timeout-MS', timeoutMs.toString());
    res.setHeader('X-Environment', isRenderFreeTier ? 'render-free' : 'production');
  }
  
  next();
};

// ========== MIDDLEWARES DE SÉCURITÉ ET PERFORMANCE ==========

// Helmet pour la sécurité
app.use(helmet({
  contentSecurityPolicy: false, // Désactivé pour compatibilité CORS
  crossOriginResourcePolicy: { policy: "cross-origin" },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
  xssFilter: true,
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));

// Compression GZIP optimisée pour Render
app.use(compression({
  level: 6,
  threshold: isRenderFreeTier ? 1024 : 100 * 1024, // Seulement > 1KB sur Render gratuit
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    // Ne pas compresser les exports (déjà compressés ou binaires)
    if (req.url.includes('/export') && req.method === 'GET') return false;
    // Ne pas compresser les grandes réponses JSON streaming
    if (res.getHeader('Content-Type') === 'application/json' && 
        req.url.includes('/import-export')) return false;
    return compression.filter(req, res);
  }
}));

// Rate Limiting adaptatif pour Render gratuit
const getRateLimitConfig = () => {
  if (isRenderFreeTier) {
    return {
      windowMs: 15 * 60 * 1000,
      max: 300, // Augmenté à 300 pour plus de flexibilité
      message: {
        success: false,
        error: 'Limite de requêtes atteinte',
        message: 'Trop de requêtes effectuées. Veuillez réessayer dans 15 minutes.',
        limits: {
          window: '15 minutes',
          max: '300 requêtes',
          advice: 'Pour les exports complets, patientez entre chaque export'
        }
      },
      standardHeaders: true,
      legacyHeaders: false,
      skipFailedRequests: false,
      skipSuccessfulRequests: false,
      keyGenerator: (req) => {
        // Utiliser l'IP et l'ID utilisateur pour un rate limiting plus précis
        const userId = req.user?.id || req.user?.Id || 'anonymous';
        return `${req.ip}-${userId}`;
      },
      handler: (req, res, next, options) => {
        console.warn(`🚫 Rate limit dépassé pour ${req.ip} - ${req.url}`);
        res.status(429).json(options.message);
      }
    };
  } else {
    return {
      windowMs: 15 * 60 * 1000,
      max: 1000,
      message: { error: 'Trop de requêtes' },
      standardHeaders: true
    };
  }
};

const limiter = rateLimit(getRateLimitConfig());

// Routes exemptées du rate limiting
const noLimitRoutes = [
  '/api/health',
  '/api/test-db',
  '/api/debug/external',
  '/api/cors-test',
  '/api/import-export/diagnostic',
  '/api/external/health',
  '/api/import-export/health',
  '/api/backup/status',
  '/api/backup/health'
];

// Middleware de rate limiting intelligent
app.use((req, res, next) => {
  // Vérifier si la route est exemptée
  const isExempt = noLimitRoutes.some(route => req.path.startsWith(route));
  
  if (isExempt) {
    return next();
  }
  
  // Appliquer des limites différentes pour les exports complets
  if (req.path.includes('/import-export/export/complete') || 
      req.path.includes('/import-export/export/all')) {
    
    const exportCompleteLimiter = rateLimit({
      windowMs: 60 * 60 * 1000, // 1 heure
      max: isRenderFreeTier ? 3 : 10, // 3 exports complets/heure sur Render gratuit
      message: {
        success: false,
        error: 'Limite d\'export complet atteinte',
        message: 'Trop d\'exports complets effectués. Veuillez patienter 1 heure.',
        advice: 'Les exports complets sont très gourmands. Limitez-les à quelques fois par heure.'
      },
      keyGenerator: (req) => {
        const userId = req.user?.id || req.user?.Id || 'anonymous';
        return `${req.ip}-${userId}-export-complet`;
      }
    });
    
    return exportCompleteLimiter(req, res, next);
  }
  
  // Vérifier si c'est une requête d'import/export massif
  if (req.path.includes('/import-export/bulk-import') || 
      req.path.includes('/import-export/export/stream')) {
    // Appliquer un rate limiting plus souple pour ces routes
    const importLimiter = rateLimit({
      windowMs: 60 * 60 * 1000, // 1 heure
      max: isRenderFreeTier ? 5 : 50, // 5 imports/heure max sur Render gratuit
      message: {
        success: false,
        error: 'Limite d\'import/export atteinte',
        message: 'Trop d\'imports/exports effectués. Veuillez patienter 1 heure.',
        advice: 'Pour les traitements fréquents, contactez l\'administrateur'
      }
    });
    
    return importLimiter(req, res, next);
  }
  
  // Appliquer le rate limiting normal
  return limiter(req, res, next);
});

// Appliquer les timeouts pour les exports
app.use(configureExportTimeouts);

// ========== CONFIGURATION CORS OPTIMISÉE ==========
const allowedOrigins = [
  'https://gescardcocody.netlify.app',
  'https://gescardcocodybackend.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  undefined
];

const corsOptions = {
  origin: function (origin, callback) {
    // Mode développement: tout autoriser
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    
    // Autoriser les requêtes sans origine
    if (!origin) {
      return callback(null, true);
    }
    
    // Vérifier l'origine
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`🚫 Origine CORS bloquée: ${origin}`);
      callback(new Error(`Origine "${origin}" non autorisée par CORS`));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Access-Control-Request-Method',
    'Access-Control-Request-Headers',
    'X-API-Token',
    'X-No-Compression',
    'X-Request-ID',
    'X-File-Size',
    'X-Import-Batch-ID',
    'x-environment',
    'X-Environment',
    'x-request-type',
    'X-Request-Type',
    'x-file-type',
    'X-File-Type',
    'X-Export-Complete', // Pour les exports complets
    'X-Timeout-MS'       // Pour les timeouts
  ],
  exposedHeaders: [
    'Content-Range',
    'X-Content-Range',
    'Content-Disposition',  // IMPORTANT pour les téléchargements
    'X-Request-ID',
    'X-Import-Progress',
    'X-Import-Batch-ID',
    'X-Environment',
    'Content-Type',
    'Content-Length',
    'Filename',
    'X-Export-Complete',    // Exposé pour le frontend
    'X-Total-Rows',         // Nombre total de lignes exportées
    'X-Export-Type',        // Type d'export (complet/limité)
    'X-Timeout-MS'          // Timeout configuré
  ],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Middleware pour forcer le téléchargement des exports
app.use((req, res, next) => {
  // Si c'est une route d'export, ajouter des headers pour forcer le téléchargement
  if (req.path.includes('/api/import-export/export')) {
    // Intercepter la réponse pour ajouter les headers nécessaires
    const originalSend = res.send;
    const originalJson = res.json;
    
    res.send = function(body) {
      // Pour les exports Excel
      if (req.path.includes('/export') && !req.path.includes('/export/csv')) {
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        
        // Nom de fichier personnalisé selon le type d'export
        let filename = 'export-cartes.xlsx';
        if (req.path.includes('/complete')) {
          filename = 'export-complet-cartes.xlsx';
        } else if (req.path.includes('/all')) {
          filename = 'export-toutes-cartes.xlsx';
        }
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      }
      // Pour les exports CSV
      else if (req.path.includes('/export/csv')) {
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        
        // Nom de fichier personnalisé selon le type d'export
        let filename = 'export-cartes.csv';
        if (req.path.includes('/complete')) {
          filename = 'export-complet-cartes.csv';
        } else if (req.path.includes('/all')) {
          filename = 'export-toutes-cartes.csv';
        }
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      }
      
      return originalSend.call(this, body);
    };
    
    res.json = function(body) {
      // Si c'est un export, on ne devrait pas utiliser res.json mais res.send
      // Cette partie est pour sécurité
      if (req.path.includes('/export')) {
        console.warn(`⚠️ Export route using res.json instead of res.send: ${req.path}`);
      }
      return originalJson.call(this, body);
    };
  }
  
  next();
});

// ========== CONFIGURATION BODY PARSER OPTIMISÉE ==========

const requestSizeLimit = isRenderFreeTier ? '10mb' : '100mb';
const jsonParser = express.json({
  limit: requestSizeLimit,
  inflate: true,
  strict: true,
  type: ['application/json', 'application/json-patch+json', 'application/merge-patch+json']
});

const urlencodedParser = express.urlencoded({
  extended: true,
  limit: requestSizeLimit,
  parameterLimit: isRenderFreeTier ? 100 : 1000,
  inflate: true,
  type: 'application/x-www-form-urlencoded'
});

// Middleware de parsing intelligent
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || '';
  
  if (contentType.includes('application/json')) {
    return jsonParser(req, res, next);
  } else if (contentType.includes('application/x-www-form-urlencoded')) {
    return urlencodedParser(req, res, next);
  }
  
  next();
});

// ========== LOGGING OPTIMISÉ ==========

// Configuration Morgan pour Render gratuit
const morganFormat = isRenderFreeTier ? 'short' : 'combined';
const morganSkip = (req, res) => {
  // Ne pas logger les requêtes de santé en production
  if (process.env.NODE_ENV === 'production' && req.url.includes('/health')) {
    return true;
  }
  
  // Ne pas logger les requêtes OPTIONS CORS
  if (req.method === 'OPTIONS') {
    return true;
  }
  
  return false;
};

app.use(morgan(morganFormat, { skip: morganSkip }));

// Middleware de logging personnalisé pour les exports
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  
  // Log de début pour les exports complets
  if (req.path.includes('/import-export/export/complete') || 
      req.path.includes('/import-export/export/all')) {
    console.log(`🚀 Début export complet: ${req.method} ${req.url} - User: ${req.user?.nomUtilisateur || 'unknown'}`);
  }
  
  // Log de fin de requête
  res.on('finish', () => {
    const duration = Date.now() - start;
    const memory = process.memoryUsage();
    const memoryMB = Math.round(memory.heapUsed / 1024 / 1024);
    
    // Log pour les exports complets (toujours)
    if (req.path.includes('/import-export/export/complete') || 
        req.path.includes('/import-export/export/all')) {
      
      const totalRows = res.getHeader('X-Total-Rows') || 'unknown';
      const exportType = res.getHeader('X-Export-Type') || 'unknown';
      
      console.log(`📊 EXPORT ${exportType}: ${req.url} - ${duration}ms - ${res.statusCode} - Lignes: ${totalRows} - Mem: ${memoryMB}MB`);
    }
    // Log pour les autres requêtes importantes ou lentes
    else if (duration > 1000 || res.statusCode >= 400 || process.env.NODE_ENV === 'development') {
      console.log(`📊 ${req.method} ${req.url} - ${duration}ms - ${res.statusCode} - Mem: ${memoryMB}MB - ID: ${requestId}`);
    }
  });
  
  next();
});

// ========== ROUTES DE DIAGNOSTIC OPTIMISÉES ==========

// Route de santé légère (utilisée par Render pour les health checks)
app.get("/api/health", async (req, res) => {
  try {
    // Requête ultra-légère pour vérifier la DB
    const dbResult = await query("SELECT 1 as ok, current_database() as db, NOW() as time");
    
    // Compter les cartes pour information
    const countResult = await query("SELECT COUNT(*) as total FROM cartes");
    const totalCartes = parseInt(countResult.rows[0].total);
    
    const memory = process.memoryUsage();
    const memoryUsage = {
      rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
    };
    
    // 🆕 Vérifier l'état du système de backup
    let backupStatus = 'not_configured';
    let googleDriveStatus = 'not_connected';
    
    if (process.env.GOOGLE_CLIENT_ID) {
      backupStatus = 'configured';
      try {
        const PostgreSQLBackup = require('./backup-postgres');
        const backupService = new PostgreSQLBackup();
        const hasBackups = await backupService.hasBackups().catch(() => false);
        googleDriveStatus = hasBackups ? 'connected_with_backups' : 'connected_no_backups';
      } catch (error) {
        googleDriveStatus = 'connection_error';
      }
    }
    
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        name: dbResult.rows[0].db,
        server_time: dbResult.rows[0].time
      },
      data: {
        total_cartes: totalCartes,
        export_complet_disponible: totalCartes > 0
      },
      memory: memoryUsage,
      
      // 🆕 SECTION BACKUP AJOUTÉE
      backup_system: {
        status: backupStatus,
        google_drive: googleDriveStatus,
        auto_backup: 'daily_at_2am',
        auto_restore: process.env.AUTO_RESTORE === 'true' ? 'enabled' : 'disabled',
        endpoints: {
          create_backup: '/api/backup/create',
          restore_backup: '/api/backup/restore',
          list_backups: '/api/backup/list',
          status: '/api/backup/status'
        }
      },
      
      environment: process.env.NODE_ENV || 'development',
      render_tier: isRenderFreeTier ? 'free' : 'paid',
      uptime: Math.round(process.uptime()) + 's',
      features: {
        import: 'available',
        export: 'available',
        export_complet: 'available (nouveau!)',
        bulk_import: 'available',
        streaming: 'available',
        backup_system: backupStatus === 'configured' ? 'enabled' : 'disabled'
      },
      endpoints: {
        export_complet: '/api/import-export/export/complete',
        export_tout_en_un: '/api/import-export/export/all',
        export_limite: '/api/import-export/export',
        backup_system: '/api/backup'
      }
    });
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    res.status(503).json({
      status: "unhealthy",
      error: "Database connection failed",
      timestamp: new Date().toISOString()
    });
  }
});

// Route de test de connexion DB
app.get("/api/test-db", async (req, res) => {
  try {
    const result = await query("SELECT version() as pg_version, NOW() as server_time");
    res.json({
      success: true,
      database: "PostgreSQL",
      version: result.rows[0].pg_version.split(',')[0],
      server_time: result.rows[0].server_time,
      request_id: req.requestId
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      request_id: req.requestId
    });
  }
});

// Route de diagnostic complet avec info sur les exports
app.get("/api/debug/external", async (req, res) => {
  try {
    const memory = process.memoryUsage();
    const stats = await query(`
      SELECT 
        (SELECT COUNT(*) FROM cartes) as total_cartes,
        (SELECT COUNT(*) FROM utilisateurs) as total_utilisateurs,
        (SELECT MAX(created_at) FROM cartes) as last_import,
        (SELECT COUNT(DISTINCT importbatchid) FROM cartes WHERE importbatchid IS NOT NULL) as total_imports
    `);
    
    const totalCartes = parseInt(stats.rows[0].total_cartes);
    
    // 🆕 Info backup
    let backupInfo = {
      configured: process.env.GOOGLE_CLIENT_ID ? true : false,
      auto_restore: process.env.AUTO_RESTORE === 'true',
      next_backup: '02:00 UTC daily'
    };
    
    if (process.env.GOOGLE_CLIENT_ID) {
      try {
        const PostgreSQLBackup = require('./backup-postgres');
        const backupService = new PostgreSQLBackup();
        const backups = await backupService.listBackups().catch(() => []);
        backupInfo.backup_count = backups.length;
        backupInfo.last_backup = backups.length > 0 ? backups[0].createdTime : 'none';
      } catch (error) {
        backupInfo.error = error.message;
      }
    }
    
    res.json({
      status: "operational",
      environment: process.env.NODE_ENV || 'development',
      render_tier: isRenderFreeTier ? 'free' : 'paid',
      memory: {
        used: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
        rss: Math.round(memory.rss / 1024 / 1024) + 'MB'
      },
      database: {
        total_cartes: totalCartes,
        total_utilisateurs: parseInt(stats.rows[0].total_utilisateurs),
        last_import: stats.rows[0].last_import,
        total_imports: parseInt(stats.rows[0].total_imports || 0)
      },
      
      // 🆕 SECTION BACKUP
      backup_system: backupInfo,
      
      export_capabilities: {
        complet_available: true,
        formats: ['Excel', 'CSV'],
        max_rows: isRenderFreeTier ? '50,000 (recommandé)' : 'illimité',
        estimated_time: totalCartes > 50000 ? '5-10 minutes' : '2-5 minutes'
      },
      features: {
        bulk_import: true,
        export_streaming: true,
        export_complet: true,
        smart_sync: true,
        memory_optimized: isRenderFreeTier,
        backup_system: backupInfo.configured
      },
      limits: isRenderFreeTier ? {
        max_upload_size: '10MB',
        max_request_size: '10MB',
        rate_limit: '300 req/15min',
        export_complet_limit: '3/heure',
        import_timeout: '4min',
        export_timeout: '5-10min pour complet',
        backup_auto: 'daily',
        advice: [
          `Vous avez ${totalCartes.toLocaleString()} cartes`,
          'Utilisez /export/all pour le format optimal',
          'CSV recommandé pour > 20,000 lignes',
          'Limitez les exports complets à 3/heure',
          backupInfo.configured ? '✅ Backup automatique activé' : '⚠️  Backup non configuré'
        ]
      } : {
        max_upload_size: '100MB',
        max_request_size: '100MB',
        rate_limit: '1000 req/15min',
        export_complet_limit: '10/heure',
        import_timeout: '5min',
        export_timeout: '10min pour complet',
        backup_auto: 'daily',
        advice: [
          `Vous avez ${totalCartes.toLocaleString()} cartes`,
          'Utilisez /export/all pour le format optimal',
          'Tous les formats disponibles',
          backupInfo.configured ? '✅ Backup automatique activé' : '⚠️  Backup non configuré'
        ]
      },
      endpoints_recommendation: [
        ...(totalCartes > 5000 ? [
          '🚀 Utilisez /api/import-export/export/all pour tout exporter',
          '📊 /api/import-export/export/complete pour Excel complet',
          '⚡ /api/import-export/export/complete/csv pour CSV complet'
        ] : [
          '✅ Toutes les routes fonctionnent',
          '📤 /api/import-export/export pour Excel (limitée)',
          '📄 /api/import-export/export/csv pour CSV (limitée)',
          '🚀 /api/import-export/export/all pour le format optimal'
        ]),
        ...(backupInfo.configured ? [
          '🔐 /api/backup/create pour créer un backup manuel',
          '📋 /api/backup/list pour voir les sauvegardes',
          '🔄 /api/backup/restore pour restaurer (admin seulement)'
        ] : [
          '⚠️  Configurez le backup pour protéger vos données'
        ])
      ]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test CORS
app.get("/api/cors-test", (req, res) => {
  res.json({
    message: "CORS test successful",
    your_origin: req.headers.origin || 'not specified',
    allowed_origins: allowedOrigins.filter(o => o !== undefined),
    cors_enabled: true,
    export_headers_supported: [
      'Content-Disposition',
      'X-Export-Complete',
      'X-Total-Rows',
      'X-Export-Type',
      'X-Timeout-MS'
    ],
    backup_endpoints: [
      '/api/backup/create',
      '/api/backup/restore',
      '/api/backup/list',
      '/api/backup/status'
    ]
  });
});

// ========== MONTAGE DES ROUTES PRINCIPALES ==========
app.use("/api/auth", authRoutes);
app.use("/api/utilisateurs", utilisateursRoutes);
app.use("/api/cartes", cartesRoutes);
app.use("/api/inventaire", inventaireRoutes);
app.use("/api/import-export", importExportRoutes);
app.use("/api/journal", journalRoutes);
app.use("/api/log", logRoutes);
app.use("/api/profil", profilRoutes);
app.use("/api/statistiques", statistiquesRoutes);
app.use("/api/external", externalApiRoutes);

// 🆕 ROUTE DE BACKUP
app.use("/api/backup", backupRoutes);

// ========== ROUTE RACINE AMÉLIORÉE ==========
app.get("/", (req, res) => {
  const hasBackup = !!process.env.GOOGLE_CLIENT_ID;
  
  res.json({
    message: "API CartesProject PostgreSQL - EXPORT COMPLET DISPONIBLE",
    version: "3.0.0-complet",
    environment: process.env.NODE_ENV || 'development',
    render_tier: isRenderFreeTier ? 'free' : 'paid',
    documentation: `${req.protocol}://${req.get('host')}/api`,
    health_check: `${req.protocol}://${req.get('host')}/api/health`,
    debug_info: `${req.protocol}://${req.get('host')}/api/debug/external`,
    features: {
      bulk_import: "Optimisé pour Render gratuit",
      export_streaming: "Disponible",
      export_complet: "NOUVEAU - Toutes les données",
      import_smart_sync: "Activé",
      memory_management: isRenderFreeTier ? "Optimisé" : "Standard",
      backup_system: hasBackup ? "✅ Activé (Google Drive)" : "❌ Désactivé"
    },
    quick_start: {
      export_toutes_les_donnees: "GET /api/import-export/export/all",
      export_excel_complet: "GET /api/import-export/export/complete",
      export_csv_complet: "GET /api/import-export/export/complete/csv",
      export_limite: "GET /api/import-export/export (max 5000 lignes)",
      import_csv: "POST /api/import-export/import/csv",
      ...(hasBackup ? {
        create_backup: "POST /api/backup/create",
        list_backups: "GET /api/backup/list",
        backup_status: "GET /api/backup/status"
      } : {})
    },
    note_importante: [
      "Les exports complets peuvent prendre plusieurs minutes pour les gros volumes de données",
      ...(hasBackup ? [
        "✅ Backup automatique activé (tous les jours à 2h)",
        "✅ Restauration automatique si base vide",
        "📁 Sauvegardes stockées sur Google Drive"
      ] : [
        "⚠️  Système de backup non configuré - Vos données sont à risque!",
        "ℹ️  Configurez GOOGLE_CLIENT_ID et GOOGLE_REFRESH_TOKEN sur Render"
      ])
    ]
  });
});

// ========== GESTION DES ERREURS OPTIMISÉE POUR EXPORTS ==========

// 404 - Route non trouvée
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    requested: `${req.method} ${req.url}`,
    request_id: req.requestId,
    help: "Check /api for available routes",
    export_routes: [
      '/api/import-export/export/all (toutes les données)',
      '/api/import-export/export/complete (Excel complet)',
      '/api/import-export/export/complete/csv (CSV complet)',
      '/api/import-export/export (Excel limité)',
      '/api/import-export/export/csv (CSV limité)'
    ],
    backup_routes: [
      '/api/backup/create (créer backup)',
      '/api/backup/restore (restaurer)',
      '/api/backup/list (lister backups)',
      '/api/backup/status (statut)'
    ]
  });
});

// Gestion globale des erreurs
app.use((err, req, res, next) => {
  console.error('❌ Error:', {
    message: err.message,
    url: req.url,
    method: req.method,
    request_id: req.requestId,
    user: req.user?.nomUtilisateur || 'unknown',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
  
  // Erreur CORS
  if (err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: "CORS error",
      error: "Origin not allowed",
      your_origin: req.headers.origin || 'not specified',
      allowed_origins: allowedOrigins.filter(o => o !== undefined),
      request_id: req.requestId
    });
  }
  
  // Rate limit
  if (err.statusCode === 429) {
    return res.status(429).json({
      success: false,
      message: "Rate limit exceeded",
      request_id: req.requestId,
      retry_after: err.message.includes('export complet') ? "1 hour" : "15 minutes",
      advice: err.message.includes('export complet') ? 
        "Les exports complets sont limités à 3 par heure sur Render gratuit" :
        "Veuillez réessayer dans 15 minutes"
    });
  }
  
  // Timeout (spécial pour exports complets)
  if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
    const isExportComplete = req.url.includes('/export/complete') || req.url.includes('/export/all');
    const isBackupOperation = req.url.includes('/api/backup');
    
    return res.status(504).json({
      success: false,
      message: "Request timeout",
      error: "The operation took too long to complete",
      request_type: isExportComplete ? "Export complet" : isBackupOperation ? "Backup" : "Normal",
      request_id: req.requestId,
      advice: isExportComplete ? [
        "L'export complet de toutes les données prend du temps",
        "Essayez d'exporter en CSV qui est plus rapide",
        "Sur Render gratuit, les exports > 50,000 lignes peuvent être lents",
        "Contactez l'administrateur si le problème persiste"
      ] : isBackupOperation ? [
        "Les backups peuvent prendre du temps pour les grosses bases",
        "Le backup continue en arrière-plan",
        "Vérifiez les logs pour la progression",
        "Les backups sont automatiques, vous pouvez réessayer plus tard"
      ] : isRenderFreeTier ? [
        "Try splitting your file into smaller parts",
        "Use /bulk-import for large files",
        "Use /export/stream for large exports"
      ] : [
        "Contact system administrator"
      ]
    });
  }
  
  // Erreur mémoire (spécial pour exports complets)
  if (err.message && (err.message.includes('heap') || err.message.includes('memory'))) {
    const memory = process.memoryUsage();
    const isExportComplete = req.url.includes('/export/complete') || req.url.includes('/export/all');
    const isBackupOperation = req.url.includes('/api/backup');
    
    return res.status(500).json({
      success: false,
      message: "Memory error",
      error: "Insufficient memory to complete operation",
      request_type: isExportComplete ? "Export complet" : isBackupOperation ? "Backup" : "Normal",
      memory_usage: `${Math.round(memory.heapUsed / 1024 / 1024)}MB / ${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
      request_id: req.requestId,
      advice: isExportComplete ? [
        "L'export complet nécessite beaucoup de mémoire",
        "Essayez d'exporter en CSV qui utilise moins de mémoire",
        "Divisez l'export par site si possible",
        "Contactez l'administrateur pour optimiser"
      ] : isBackupOperation ? [
        "Le backup utilise beaucoup de mémoire",
        "Essayez un backup manuel plus tard",
        "Les backups automatiques continueront la nuit",
        "Le système retentera automatiquement"
      ] : [
        "Try exporting with filters",
        "Use /export/stream for large exports",
        "Split large imports into multiple files",
        "Contact administrator if problem persists"
      ]
    });
  }
  
  // Erreur de base de données
  if (err.code && err.code.startsWith('23')) {
    return res.status(400).json({
      success: false,
      message: "Database error",
      error: "Data constraint violation",
      details: err.message,
      request_id: req.requestId
    });
  }
  
  // Erreur de fichier trop volumineux
  if (err.message && err.message.includes('too large')) {
    return res.status(413).json({
      success: false,
      message: "File too large",
      error: "The file exceeds the maximum allowed size",
      max_size: isRenderFreeTier ? "10MB" : "100MB",
      request_id: req.requestId,
      advice: [
        "Compress your file before uploading",
        "Split large files into smaller parts",
        "Use CSV format instead of Excel for smaller file sizes"
      ]
    });
  }
  
  // Erreur Google Drive (spécial pour backups)
  if (err.message && (err.message.includes('Google') || err.message.includes('Drive') || err.message.includes('OAuth'))) {
    return res.status(500).json({
      success: false,
      message: "Google Drive error",
      error: "Backup system error",
      request_id: req.requestId,
      advice: [
        "Vérifiez les tokens Google sur Render",
        "Les tokens expirent après un certain temps",
        "Utilisez /api/backup/status pour vérifier la connexion",
        "Contactez l'administrateur si le problème persiste"
      ]
    });
  }
  
  // Erreur générique
  const errorResponse = {
    success: false,
    message: "Internal server error",
    request_id: req.requestId,
    timestamp: new Date().toISOString()
  };
  
  if (process.env.NODE_ENV === 'development') {
    errorResponse.error = err.message;
    errorResponse.stack = err.stack;
  }
  
  res.status(err.status || 500).json(errorResponse);
});

// ========== GESTION MÉMOIRE POUR RENDER GRATUIT ==========

if (isRenderFreeTier) {
  // Monitorer la mémoire toutes les 30 secondes
  setInterval(() => {
    const memory = process.memoryUsage();
    const usedMB = Math.round(memory.heapUsed / 1024 / 1024);
    const totalMB = Math.round(memory.heapTotal / 1024 / 1024);
    
    if (usedMB > 350) {
      console.warn(`⚠️ High memory usage: ${usedMB}/${totalMB}MB`);
      
      // Forcer GC si mémoire critique
      if (usedMB > 400 && global.gc) {
        console.log('🧹 Forcing garbage collection due to high memory usage');
        try {
          global.gc();
          const afterGC = process.memoryUsage();
          const freedMB = usedMB - Math.round(afterGC.heapUsed / 1024 / 1024);
          if (freedMB > 0) {
            console.log(`🧹 GC freed ${freedMB}MB`);
          }
        } catch (error) {
          console.warn('⚠️ Failed to force GC:', error.message);
        }
      }
    }
  }, 30000);
  
  // Nettoyage périodique toutes les 5 minutes
  setInterval(() => {
    if (global.gc) {
      try {
        global.gc();
        const memory = process.memoryUsage();
        console.log(`🧹 Periodic GC - Memory: ${Math.round(memory.heapUsed / 1024 / 1024)}MB`);
      } catch (error) {
        // Ignorer les erreurs de GC
      }
    }
  }, 5 * 60 * 1000);
}

// ========== LANCEMENT DU SERVEUR ==========
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Render tier: ${isRenderFreeTier ? 'FREE (512MB)' : 'PAID'}`);
  
  // 🆕 DÉMARRER LE SYSTÈME DE BACKUP
  setupBackupSystem();
  
  console.log(`⚡ PID: ${process.pid}`);
  console.log(`⏰ Started at: ${new Date().toLocaleString()}`);
  console.log(`🔧 Trust proxy: ${app.get('trust proxy')}`);
  
  console.log('\n🚀 NOUVELLES FONCTIONNALITÉS D\'EXPORT:');
  console.log('• ✅ Export COMPLET disponible (toutes les données)');
  console.log('• 📊 /api/import-export/export/all - Choix intelligent Excel/CSV');
  console.log('• 📈 /api/import-export/export/complete - Excel complet');
  console.log('• ⚡ /api/import-export/export/complete/csv - CSV complet');
  console.log('• 🎯 Timeouts adaptatifs: 5-10min pour les exports complets');
  
  console.log('\n🔐 NOUVELLES FONCTIONNALITÉS DE BACKUP:');
  console.log('• ✅ Backup automatique quotidien (2h du matin)');
  console.log('• 🔄 Restauration automatique si base vide');
  console.log('• 📁 Stockage sur Google Drive (dossier "gescard_backups")');
  console.log('• 🔧 Routes: /api/backup/create, /api/backup/list, /api/backup/restore');
  
  if (isRenderFreeTier) {
    console.log('\n📋 IMPORTANT FOR RENDER FREE TIER:');
    console.log('• Memory limit: 512MB');
    console.log('• Upload limit: 10MB per request');
    console.log('• Timeout idle: 30 seconds');
    console.log('• Timeout exports complets: 5 minutes');
    console.log('• Rate limit: 300 req/15min normal, 3 exports complets/heure');
    console.log('• Auto-sleep: 15 minutes of inactivity');
    console.log('\n✅ OPTIMIZATIONS ENABLED:');
    console.log('• Memory monitoring and automatic garbage collection');
    console.log('• Timeout management for complete exports (5-10min)');
    console.log('• Streaming exports to avoid memory issues');
    console.log('• Smart format selection (Excel/CSV) based on data size');
    console.log('• Enhanced error handling for large exports');
    console.log('• Automatic backup system with Google Drive');
    console.log('\n💡 RECOMMENDATIONS FOR COMPLETE EXPORTS:');
    console.log('• Use /export/all for automatic best format selection');
    console.log('• CSV is faster and uses less memory for > 20,000 rows');
    console.log('• Complete exports may take several minutes for large datasets');
    console.log('• Monitor progress via logs and response headers');
    console.log('• Check /api/debug/external for system status');
    console.log('• Limit complete exports to 3 per hour');
    console.log('\n💾 BACKUP SYSTEM INFO:');
    console.log('• Backups are stored in Google Drive folder "gescard_backups"');
    console.log('• Automatic backup every day at 2:00 AM');
    console.log('• Auto-restore if database is empty (Render monthly reset)');
    console.log('• Check /api/backup/status for backup system health');
    console.log('• Use /api/backup/create for manual backup');
  }
});

// Configuration des timeouts du serveur
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 121000; // Juste au-dessus de keepAliveTimeout

// Gestion du shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  
  // 🆕 Créer un backup final avant shutdown
  if (process.env.GOOGLE_CLIENT_ID) {
    console.log('💾 Creating final backup before shutdown...');
    try {
      const PostgreSQLBackup = require('./backup-postgres');
      const backupService = new PostgreSQLBackup();
      // Exécuter en arrière-plan, ne pas attendre
      backupService.executeBackup().catch(() => {});
    } catch (error) {
      console.log('⚠️ Could not create final backup:', error.message);
    }
  }
  
  server.close(() => {
    console.log('✅ Server closed gracefully');
    
    // Nettoyer les fichiers temporaires
    const fs = require('fs');
    const uploadDir = 'uploads/';
    
    if (fs.existsSync(uploadDir)) {
      try {
        const files = fs.readdirSync(uploadDir);
        console.log(`🗑️ Cleaning up ${files.length} temporary files...`);
        files.forEach(file => {
          try {
            fs.unlinkSync(`${uploadDir}/${file}`);
          } catch (error) {
            // Ignorer les erreurs de suppression
          }
        });
        console.log('✅ Temporary files cleaned up');
      } catch (error) {
        console.warn('⚠️ Error cleaning uploads directory:', error.message);
      }
    }
    
    process.exit(0);
  });
  
  // Timeout de sécurité
  setTimeout(() => {
    console.error('⏰ Shutdown timeout, forcing exit');
    process.exit(1);
  }, 10000);
});

// Gestion des erreurs non capturées
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', {
    reason: reason.message || reason,
    promise: promise
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', {
    message: error.message,
    stack: error.stack
  });
  
  // Redémarrer proprement sur Render
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

module.exports = app;