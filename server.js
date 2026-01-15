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

const app = express();
const PORT = process.env.PORT || 3000;

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

// ========== MIDDLEWARES DE SÉCURITÉ ET PERFORMANCE ==========

// Helmet pour la sécurité (configuré pour éviter les conflits CORS)
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
    // Ne pas compresser les exports Excel (déjà compressés)
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
      max: 200, // Augmenté à 200 pour plus de flexibilité
      message: {
        success: false,
        error: 'Limite de requêtes atteinte',
        message: 'Trop de requêtes effectuées. Veuillez réessayer dans 15 minutes.',
        limits: {
          window: '15 minutes',
          max: '200 requêtes',
          advice: 'Pour les imports/exports massifs, utilisez les endpoints asynchrones'
        }
      },
      standardHeaders: true,
      legacyHeaders: false,
      skipFailedRequests: false,
      skipSuccessfulRequests: false,
      keyGenerator: (req) => {
        return `${req.ip}-${req.user?.id || 'anonymous'}`;
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
  '/api/external/health'
];

// Middleware de rate limiting intelligent
app.use((req, res, next) => {
  // Vérifier si la route est exemptée
  const isExempt = noLimitRoutes.some(route => req.path.startsWith(route));
  
  if (isExempt) {
    return next();
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
    'x-request-type', // CORRECTION : AJOUT DE CET EN-TÊTE
    'X-Request-Type'  // CORRECTION : VERSION MAJUSCULES AUSSI
  ],
  exposedHeaders: [
    'Content-Range',
    'X-Content-Range',
    'Content-Disposition',
    'X-Request-ID',
    'X-Import-Progress',
    'X-Import-Batch-ID',
    'X-Environment'
  ],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ========== TIMEOUTS ADAPTATIFS POUR IMPORTS/EXPORTS ==========

app.use((req, res, next) => {
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
  
  if (isLongTimeoutRoute) {
    // Timeouts adaptés à l'environnement
    const timeoutMs = isRenderFreeTier ? 240000 : 300000; // 4 min sur Render, 5 min sinon
    
    req.setTimeout(timeoutMs);
    res.setTimeout(timeoutMs);
    
    // Ajouter des headers d'information
    res.setHeader('X-Timeout-MS', timeoutMs.toString());
    res.setHeader('X-Environment', isRenderFreeTier ? 'render-free' : 'production');
    
    // Surveiller les timeouts
    req.on('timeout', () => {
      console.error(`⏰ Timeout détecté pour ${req.method} ${req.url}`);
    });
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

// Middleware de logging personnalisé
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  
  // Log de fin de requête
  res.on('finish', () => {
    const duration = Date.now() - start;
    
    // Log seulement les requêtes importantes ou lentes
    const shouldLog = 
      duration > 1000 || 
      res.statusCode >= 400 ||
      req.url.includes('/import-export') ||
      req.url.includes('/bulk-import') ||
      process.env.NODE_ENV === 'development';
    
    if (shouldLog) {
      const memory = process.memoryUsage();
      const memoryMB = Math.round(memory.heapUsed / 1024 / 1024);
      
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
    
    const memory = process.memoryUsage();
    const memoryUsage = {
      rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB'
    };
    
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        name: dbResult.rows[0].db,
        server_time: dbResult.rows[0].time
      },
      memory: memoryUsage,
      environment: process.env.NODE_ENV || 'development',
      render_tier: isRenderFreeTier ? 'free' : 'paid',
      uptime: Math.round(process.uptime()) + 's',
      features: {
        import: 'available',
        export: 'available',
        bulk_import: 'available',
        streaming: 'available'
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

// Route de diagnostic complet
app.get("/api/debug/external", async (req, res) => {
  try {
    const memory = process.memoryUsage();
    const stats = await query(`
      SELECT 
        (SELECT COUNT(*) FROM cartes) as total_cartes,
        (SELECT COUNT(*) FROM utilisateurs) as total_utilisateurs,
        (SELECT MAX(created_at) FROM cartes) as last_import
    `);
    
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
        total_cartes: parseInt(stats.rows[0].total_cartes),
        total_utilisateurs: parseInt(stats.rows[0].total_utilisateurs),
        last_import: stats.rows[0].last_import
      },
      features: {
        bulk_import: true,
        export_streaming: true,
        smart_sync: true,
        memory_optimized: isRenderFreeTier
      },
      limits: isRenderFreeTier ? {
        max_upload_size: '10MB',
        max_request_size: '10MB',
        rate_limit: '200 req/15min',
        import_timeout: '4min',
        export_timeout: '4min',
        advice: [
          'Utilisez /bulk-import pour les fichiers > 1000 lignes',
          'Utilisez /export/stream pour les gros exports',
          'Divisez les gros fichiers en plusieurs parties'
        ]
      } : {
        max_upload_size: '100MB',
        max_request_size: '100MB',
        rate_limit: '1000 req/15min',
        import_timeout: '5min',
        export_timeout: '5min'
      }
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
    cors_enabled: true
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

// ========== ROUTE RACINE ==========
app.get("/", (req, res) => {
  res.json({
    message: "API CartesProject PostgreSQL",
    version: "2.0.0",
    environment: process.env.NODE_ENV || 'development',
    render_tier: isRenderFreeTier ? 'free' : 'paid',
    documentation: `${req.protocol}://${req.get('host')}/api`,
    health_check: `${req.protocol}://${req.get('host')}/api/health`,
    features: {
      bulk_import: "Optimisé pour Render gratuit",
      export_streaming: "Disponible",
      import_smart_sync: "Activé",
      memory_management: isRenderFreeTier ? "Optimisé" : "Standard"
    }
  });
});

// ========== GESTION DES ERREURS OPTIMISÉE ==========

// 404 - Route non trouvée
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
    requested: `${req.method} ${req.url}`,
    request_id: req.requestId,
    help: "Check /api for available routes"
  });
});

// Gestion globale des erreurs
app.use((err, req, res, next) => {
  console.error('❌ Error:', {
    message: err.message,
    url: req.url,
    method: req.method,
    request_id: req.requestId,
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
      retry_after: "15 minutes"
    });
  }
  
  // Timeout
  if (err.code === 'ETIMEDOUT' || err.message.includes('timeout')) {
    return res.status(504).json({
      success: false,
      message: "Request timeout",
      error: "The operation took too long to complete",
      advice: isRenderFreeTier ? [
        "Try splitting your file into smaller parts",
        "Use /bulk-import for large files",
        "Use /export/stream for large exports"
      ] : [
        "Contact system administrator"
      ],
      request_id: req.requestId
    });
  }
  
  // Erreur mémoire
  if (err.message && (err.message.includes('heap') || err.message.includes('memory'))) {
    const memory = process.memoryUsage();
    return res.status(500).json({
      success: false,
      message: "Memory error",
      error: "Insufficient memory to complete operation",
      memory_usage: `${Math.round(memory.heapUsed / 1024 / 1024)}MB / ${Math.round(memory.heapTotal / 1024 / 1024)}MB`,
      advice: [
        "Try exporting with filters",
        "Use /export/stream for large exports",
        "Split large imports into multiple files",
        "Contact administrator if problem persists"
      ],
      request_id: req.requestId
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
    
    if (usedMB > 400) {
      console.warn(`⚠️ High memory usage: ${usedMB}/${totalMB}MB`);
      
      // Forcer GC si mémoire critique
      if (usedMB > 450 && global.gc) {
        console.log('🧹 Forcing garbage collection due to high memory usage');
        try {
          global.gc();
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
const server = app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Render tier: ${isRenderFreeTier ? 'FREE (512MB)' : 'PAID'}`);
  console.log(`⚡ PID: ${process.pid}`);
  console.log(`⏰ Started at: ${new Date().toLocaleString()}`);
  
  if (isRenderFreeTier) {
    console.log('\n📋 IMPORTANT FOR RENDER FREE TIER:');
    console.log('• Memory limit: 512MB');
    console.log('• Upload limit: 10MB per request');
    console.log('• Timeout: 30 seconds (idle), 4 minutes for imports/exports');
    console.log('• Rate limit: 200 requests per 15 minutes');
    console.log('• Auto-sleep: 15 minutes of inactivity');
    console.log('\n✅ OPTIMIZATIONS ENABLED:');
    console.log('• Memory monitoring and automatic garbage collection');
    console.log('• Timeout management for long operations');
    console.log('• Compression optimized for small responses');
    console.log('• Streaming exports to avoid memory issues');
    console.log('• Background processing for large imports');
    console.log('\n💡 RECOMMENDATIONS:');
    console.log('• Use /bulk-import for files > 1000 rows');
    console.log('• Use /export/stream for large exports');
    console.log('• Split large Excel files into multiple parts');
    console.log('• Use filters to reduce data size');
    console.log('• Monitor memory usage in /api/debug/external');
  }
});

// Configuration des timeouts du serveur
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Gestion du shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  
  server.close(() => {
    console.log('✅ Server closed gracefully');
    
    // Nettoyer les fichiers temporaires
    const fs = require('fs');
    const uploadDir = 'uploads/';
    
    if (fs.existsSync(uploadDir)) {
      try {
        const files = fs.readdirSync(uploadDir);
        files.forEach(file => {
          try {
            fs.unlinkSync(`${uploadDir}/${file}`);
            console.log(`🗑️ Cleaned up file: ${file}`);
          } catch (error) {
            // Ignorer les erreurs de suppression
          }
        });
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