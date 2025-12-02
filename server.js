const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
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
  
  // Réduire l'empreinte mémoire
  require('v8').setFlagsFromString('--max-old-space-size=512');
  
  // Désactiver certaines fonctionnalités gourmandes en mémoire
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS || '';
  process.env.NODE_OPTIONS += ' --max-http-header-size=8192';
}

// ========== MIDDLEWARES DE SÉCURITÉ ET PERFORMANCE ==========

// Helmet pour la sécurité
app.use(helmet({
  contentSecurityPolicy: false, // Désactivé pour permettre les requêtes cross-origin
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Compression GZIP (économise la bande passante)
app.use(compression({
  level: 6,
  threshold: 100 * 1024, // Compresser seulement les réponses > 100KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// Rate Limiting adaptatif selon l'environnement
const getRateLimitConfig = () => {
  if (isRenderFreeTier) {
    // Limites strictes pour Render gratuit
    return {
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // 100 requêtes max par fenêtre
      message: {
        success: false,
        error: 'Trop de requêtes. Limite atteinte sur le plan gratuit.',
        advice: 'Réessayez dans 15 minutes ou contactez l\'administrateur.'
      },
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: false,
      keyGenerator: (req) => {
        // Utiliser l'IP + userId si disponible
        return req.ip + (req.user?.id || '');
      }
    };
  } else {
    // Limites plus souples pour production payante
    return {
      windowMs: 15 * 60 * 1000,
      max: 1000,
      message: { error: 'Trop de requêtes' },
      standardHeaders: true
    };
  }
};

const limiter = rateLimit(getRateLimitConfig());

// Appliquer le rate limiting aux routes API
app.use('/api/', limiter);

// Exceptions pour certaines routes
const noLimitRoutes = ['/api/health', '/api/cors-test', '/api/test-db'];
app.use((req, res, next) => {
  if (noLimitRoutes.includes(req.path)) {
    return next(); // Pas de rate limiting
  }
  return limiter(req, res, next);
});

// ========== CONFIGURATION CORS COMPLÈTE ==========
const allowedOrigins = [
  'https://gescardcocody.netlify.app',            // Production frontend
  'https://gescardcocodybackend.onrender.com',    // Backend lui-même
  'http://localhost:5173',                        // Dev Vite
  'http://localhost:3000',                        // Dev backend
  'http://localhost:5174',                        // Dev alternative port
  'http://127.0.0.1:5173',                       // Dev localhost
  'http://127.0.0.1:3000',                       // Dev backend local
  undefined                                       // Pour les requêtes sans origine
];

const corsOptions = {
  origin: function (origin, callback) {
    console.log(`🌐 [CORS] Requête reçue depuis: ${origin || 'undefined/origin'}`);
    
    // Mode développement: tout autoriser
    if (process.env.NODE_ENV !== 'production') {
      console.log('🔧 [CORS] Mode développement - Toutes origines autorisées');
      return callback(null, true);
    }
    
    // Accepter les requêtes sans origine (pour les tests, curl, etc.)
    if (!origin) {
      console.log('📡 [CORS] Requête sans origine - Autorisée');
      return callback(null, true);
    }
    
    // Vérifier l'origine
    if (allowedOrigins.includes(origin)) {
      console.log(`✅ [CORS] Origine autorisée: ${origin}`);
      callback(null, true);
    } else {
      console.warn(`🚫 [CORS] Origine BLOQUÉE: ${origin}`);
      callback(new Error(`Accès interdit par CORS. Origine "${origin}" non autorisée.`));
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
    'X-API-Token', // Important pour l'API externe
    'X-No-Compression' // Pour désactiver la compression si besoin
  ],
  exposedHeaders: ['Content-Range', 'X-Content-Range', 'Content-Disposition'],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 200
};

// Appliquer CORS globalement
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ========== MIDDLEWARE DE LOGGING INTELLIGENT ==========
app.use((req, res, next) => {
  const start = Date.now();
  const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2);
  
  // Log seulement les requêtes importantes ou lentes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const isImportant = req.url.includes('/api/import-export') || 
                       req.url.includes('/api/external') ||
                       duration > 1000 ||
                       res.statusCode >= 400;
    
    if (isImportant || process.env.NODE_ENV === 'development') {
      console.log(`📨 ${req.method} ${req.url} - ${duration}ms - ${res.statusCode} - ID: ${requestId}`);
    }
  });
  
  // Timeout adaptatif pour Render gratuit
  if (isRenderFreeTier) {
    req.setTimeout(30000); // 30s max (au lieu de défaut Node.js)
    res.setTimeout(30000);
  }
  
  // Ajouter l'ID à la requête pour tracking
  req.requestId = requestId;
  
  next();
});

// Limiter la taille des requêtes pour économiser la mémoire
const requestSizeLimit = isRenderFreeTier ? '5mb' : '50mb';
app.use(express.json({ 
  limit: requestSizeLimit
}));

app.use(express.urlencoded({ 
  extended: true, 
  limit: requestSizeLimit,
  parameterLimit: isRenderFreeTier ? 50 : 1000 // Moins de paramètres sur gratuit
}));

// ========== ROUTES DE TEST ET DIAGNOSTIC OPTIMISÉES ==========

// Test de connexion PostgreSQL (léger)
app.get("/api/test-db", async (req, res) => {
  try {
    const result = await query("SELECT 1 as test, NOW() as server_time");
    res.json({ 
      success: true,
      database: "PostgreSQL",
      status: "connecté",
      server_time: result.rows[0].server_time,
      request_id: req.requestId
    });
  } catch (err) {
    console.error('❌ Erreur PostgreSQL:', err.message);
    res.status(500).json({ 
      success: false,
      error: "Erreur de connexion à la base de données",
      request_id: req.requestId
    });
  }
});

// Route de diagnostic optimisée
app.get("/api/debug/external", async (req, res) => {
  try {
    const result = await query("SELECT NOW() as time, version() as pg_version");
    
    const memory = process.memoryUsage();
    const memoryUsage = {
      rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
      external: Math.round(memory.external / 1024 / 1024) + 'MB'
    };
    
    res.json({
      status: "API fonctionnelle",
      environment: process.env.NODE_ENV || 'development',
      render_tier: isRenderFreeTier ? 'gratuit' : 'payant',
      memory: memoryUsage,
      database: {
        time: result.rows[0].time,
        version: result.rows[0].pg_version.split(',')[0]
      },
      cors: {
        origin: req.headers.origin || 'undefined',
        allowed: allowedOrigins.includes(req.headers.origin) || !req.headers.origin
      },
      request_id: req.requestId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      status: "API en erreur",
      request_id: req.requestId
    });
  }
});

// Route de santé optimisée (rapide)
app.get("/api/health", async (req, res) => {
  try {
    const dbResult = await query("SELECT NOW() as server_time, current_database() as database_name");
    
    const memory = process.memoryUsage();
    const memoryUsage = {
      rss: Math.round(memory.rss / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024) + 'MB',
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024) + 'MB',
      external: Math.round(memory.external / 1024 / 1024) + 'MB'
    };
    
    // Récupérer les stats de base (sans requêtes lourdes)
    const statsResult = await query(`
      SELECT 
        (SELECT COUNT(*) FROM cartes) as total_cartes,
        (SELECT COUNT(*) FROM utilisateurs) as total_utilisateurs
    `);

    res.json({
      status: "healthy",
      database: {
        status: "connected",
        server_time: dbResult.rows[0].server_time,
        database_name: dbResult.rows[0].database_name
      },
      system: {
        node_version: process.version,
        platform: process.platform,
        memory_usage: memoryUsage,
        uptime: Math.round(process.uptime()) + 's',
        environment: process.env.NODE_ENV || 'development',
        render_tier: isRenderFreeTier ? 'gratuit (512MB)' : 'payant'
      },
      application: {
        total_cartes: parseInt(statsResult.rows[0].total_cartes),
        total_utilisateurs: parseInt(statsResult.rows[0].total_utilisateurs),
        cors_enabled: true,
        compression_enabled: true,
        rate_limiting: true
      },
      limits: isRenderFreeTier ? {
        max_request_size: '5MB',
        rate_limit: '100 req/15min',
        timeout: '30s',
        advice: 'Exportez par lots de 1000 lignes maximum'
      } : {
        max_request_size: '50MB',
        rate_limit: '1000 req/15min',
        timeout: '120s'
      },
      request_id: req.requestId,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Health check failed:', error.message);
    res.status(500).json({
      status: "unhealthy",
      error: error.message,
      request_id: req.requestId,
      timestamp: new Date().toISOString()
    });
  }
});

// Route test CORS spécifique
app.get("/api/cors-test", (req, res) => {
  res.json({
    message: "✅ Test CORS réussi",
    your_origin: req.headers.origin || 'Non spécifié',
    cors_status: "Actif",
    allowed_origins: allowedOrigins.filter(o => o !== undefined),
    request_id: req.requestId,
    timestamp: new Date().toISOString()
  });
});

// Racine API - Documentations des routes
app.get("/api", (req, res) => {
  res.json({
    message: "🚀 API CartesProject PostgreSQL - Version Optimisée",
    database: "PostgreSQL",
    version: "1.2.0",
    environment: process.env.NODE_ENV || 'development',
    deployment: "Render",
    optimization: isRenderFreeTier ? "Optimisé pour plan gratuit (512MB)" : "Optimisé pour production",
    cors: {
      allowed_origins: allowedOrigins.filter(o => o !== undefined),
      status: "configured",
      request_origin: req.headers.origin || 'none'
    },
    features: {
      import: ["standard", "smart-sync", "filtered"],
      export: ["standard", "streaming", "filtered", "results"],
      optimization: ["compression", "rate-limiting", "memory-management", "streaming"],
      security: ["cors", "helmet", "authentication", "authorization"]
    },
    routes: {
      public: [
        "GET /api/test-db", 
        "POST /api/auth/login",
        "GET /api",
        "GET /api/health",
        "GET /api/cors-test",
        "GET /api/debug/external"
      ],
      import_export: [
        "POST /api/import-export/import",
        "POST /api/import-export/import/smart-sync (NOUVEAU)",
        "POST /api/import-export/import/filtered (NOUVEAU)",
        "GET /api/import-export/export",
        "GET /api/import-export/export/stream (NOUVEAU - optimisé)",
        "POST /api/import-export/export/filtered (NOUVEAU)",
        "GET /api/import-export/export-resultats",
        "GET /api/import-export/template",
        "GET /api/import-export/sites (NOUVEAU)",
        "GET /api/import-export/stats (NOUVEAU)"
      ],
      protected: [
        "GET /api/cartes",
        "GET /api/inventaire/recherche", 
        "GET /api/utilisateurs",
        "GET /api/journal",
        "GET /api/log",
        "GET /api/statistiques/globales",
        "GET /api/statistiques/sites",
        "GET /api/statistiques/detail",
        "POST /api/statistiques/refresh"
      ],
      external_api: {
        public: [
          "GET /api/external/health",
          "GET /api/external/changes",
          "GET /api/external/sites",
          "GET /api/external/cors-test"
        ],
        protected: [
          "GET /api/external/cartes",
          "POST /api/external/sync", 
          "GET /api/external/stats",
          "GET /api/external/modifications"
        ],
        authentication: "X-API-Token header or api_token query param"
      },
      administration: [
        "POST /api/utilisateurs",
        "PUT /api/utilisateurs/:id",
        "DELETE /api/utilisateurs/:id",
        "GET /api/journal/imports",
        "POST /api/journal/annuler-import"
      ]
    },
    status: {
      database: "PostgreSQL",
      api: "En ligne",
      cors: "Actif",
      external_api: "Actif avec fusion intelligente",
      optimization: isRenderFreeTier ? "Actif (mode gratuit)" : "Actif (mode production)",
      timestamp: new Date().toISOString(),
      request_id: req.requestId
    }
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

// ========== ROUTE RACINE OPTIMISÉE ==========
app.get("/", (req, res) => {
  res.json({
    message: "🚀 API CartesProject PostgreSQL - Version Optimisée",
    documentation: `http://localhost:${PORT}/api`,
    health_check: `http://localhost:${PORT}/api/health`,
    database: "PostgreSQL",
    version: "1.2.0",
    optimized_for: isRenderFreeTier ? "Render Free Tier (512MB)" : "Production",
    features: [
      "Import/Export intelligent avec synchronisation",
      "API externe sécurisée",
      "Streaming optimisé pour gros volumes",
      "Gestion de conflits automatique",
      "Compression GZIP activée",
      "Rate limiting intelligent"
    ],
    tips: isRenderFreeTier ? [
      "Utilisez /export/stream pour les exports > 5000 lignes",
      "Limite: 5MB par requête, 100 req/15min",
      "Exportez par filtres pour réduire la taille"
    ] : [
      "Toutes les fonctionnalités disponibles",
      "Limite: 50MB par requête, 1000 req/15min"
    ],
    request_id: req.requestId,
    timestamp: new Date().toISOString()
  });
});

// ========== GESTION DES ERREURS OPTIMISÉE ==========

// 404 - Route non trouvée
app.use((req, res) => {
  console.warn(`🔍 Route non trouvée: ${req.method} ${req.url} - ID: ${req.requestId}`);
  res.status(404).json({
    success: false,
    message: "Route non trouvée",
    requested: `${req.method} ${req.url}`,
    request_id: req.requestId,
    help: "Voir /api pour les routes disponibles",
    available_routes: {
      documentation: "GET /api",
      health_check: "GET /api/health",
      cors_test: "GET /api/cors-test",
      database_test: "GET /api/test-db",
      external_debug: "GET /api/debug/external"
    }
  });
});

// Gestion globale des erreurs avec optimisations mémoire
app.use((err, req, res, next) => {
  console.error("❌ Erreur:", {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    url: req.url,
    method: req.method,
    request_id: req.requestId
  });
  
  // Effacer les gros buffers en cas d'erreur mémoire
  if (err.message.includes('heap') || err.message.includes('memory')) {
    console.log('🧹 Nettoyage mémoire d\'urgence');
    if (global.gc) {
      global.gc();
    }
  }
  
  // Erreur CORS
  if (err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: "Accès interdit par CORS",
      error: `L'origine '${req.headers.origin || 'undefined'}' n'est pas autorisée`,
      allowed_origins: allowedOrigins.filter(o => o !== undefined),
      help: "Contactez l'administrateur pour ajouter votre origine",
      request_id: req.requestId
    });
  }
  
  // Erreur de rate limiting
  if (err.statusCode === 429) {
    return res.status(429).json({
      success: false,
      message: "Trop de requêtes",
      ...(isRenderFreeTier && {
        advice: "Limite du plan gratuit atteinte. Réessayez plus tard."
      }),
      request_id: req.requestId
    });
  }
  
  // Erreur de validation
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: "Erreur de validation",
      errors: err.errors,
      request_id: req.requestId
    });
  }
  
  // Erreur JWT
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: "Token invalide",
      request_id: req.requestId
    });
  }
  
  // Erreur d'authentification
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      success: false,
      message: "Non autorisé",
      request_id: req.requestId
    });
  }

  // Erreur de base de données PostgreSQL
  if (err.code && err.code.startsWith('23') || err.code === '23505') {
    return res.status(400).json({
      success: false,
      message: "Erreur de données",
      details: "Violation de contrainte (doublon ou donnée invalide)",
      request_id: req.requestId
    });
  }

  if (err.code === '23503') {
    return res.status(400).json({
      success: false,
      message: "Erreur de référence",
      details: "Référence à un enregistrement inexistant",
      request_id: req.requestId
    });
  }
  
  // Erreur de pool de connexions
  if (err.message && err.message.includes('pool')) {
    console.error('❌ Erreur pool PostgreSQL:', err.message);
    return res.status(503).json({
      success: false,
      message: "Service temporairement indisponible",
      error: "Problème de connexion à la base de données",
      request_id: req.requestId,
      timestamp: new Date().toISOString()
    });
  }
  
  // Erreur mémoire spécifique
  if (err.message.includes('heap') || err.message.includes('memory')) {
    return res.status(500).json({
      success: false,
      message: "Erreur mémoire",
      error: "Mémoire insuffisante. Essayez d'exporter par filtres ou utilisez l'export streaming.",
      advice: isRenderFreeTier ? [
        "Utilisez /api/import-export/export/stream",
        "Exportez par filtres (site/date)",
        "Réduisez la taille du fichier d'import"
      ] : [
        "Contactez l'administrateur système"
      ],
      request_id: req.requestId
    });
  }

  // Erreur générique adaptée à l'environnement
  const errorResponse = {
    success: false,
    message: "Erreur interne du serveur",
    request_id: req.requestId,
    timestamp: new Date().toISOString()
  };
  
  if (process.env.NODE_ENV === 'development') {
    errorResponse.error = err.message;
    errorResponse.stack = err.stack;
  } else {
    errorResponse.error = "Une erreur est survenue. Veuillez réessayer.";
  }
  
  res.status(500).json(errorResponse);
});

// ========== GESTION MEMOIRE POUR RENDER GRATUIT ==========

if (isRenderFreeTier) {
  // Surveiller la mémoire
  const memoryMonitor = setInterval(() => {
    const memory = process.memoryUsage();
    const usedMB = Math.round(memory.heapUsed / 1024 / 1024);
    const totalMB = Math.round(memory.heapTotal / 1024 / 1024);
    
    if (usedMB > 400) {
      console.warn(`⚠️ Mémoire élevée: ${usedMB}/${totalMB}MB - ID: ${Date.now().toString(36)}`);
      
      // Actions correctives si mémoire trop élevée
      if (usedMB > 450) {
        console.log('🚨 CRITIQUE: Mémoire presque saturée - Réduction des logs');
        // Réduire la verbosité des logs
        console.debug = () => {};
      }
    }
  }, 30000); // Toutes les 30 secondes
  
  // Nettoyage périodique
  const memoryCleanup = setInterval(() => {
    console.log('🧹 Nettoyage périodique mémoire');
    if (global.gc) {
      global.gc();
    }
  }, 5 * 60 * 1000); // Toutes les 5 minutes
  
  // Nettoyer les intervalles au shutdown
  process.on('SIGTERM', () => {
    clearInterval(memoryMonitor);
    clearInterval(memoryCleanup);
  });
}

// ========== GESTION DU PROCESS ==========
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesse rejetée non gérée:', {
    reason: reason.message || reason,
    promise: promise,
    timestamp: new Date().toISOString()
  });
});

process.on('uncaughtException', (error) => {
  console.error('❌ Exception non capturée:', {
    message: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
  
  // Ne pas quitter immédiatement sur Render, laisser le système redémarrer
  // Render gère automatiquement les redémarrages
  if (!isRenderFreeTier) {
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  }
});

// ========== LANCEMENT OPTIMISÉ ==========
const server = app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`🌐 Environnement: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Plan Render: ${isRenderFreeTier ? 'GRATUIT (optimisé 512MB)' : 'PAYANT'}`);
  console.log(`🗄️ Base de données: PostgreSQL`);
  console.log(`🔒 CORS configuré pour: https://gescardcocody.netlify.app`);
  console.log(`⏰ Démarrage: ${new Date().toLocaleString()}`);
  console.log(`📊 PID: ${process.pid}`);
  
  // Afficher les variables de configuration
  console.log(`⚙️ Configuration:`);
  console.log(`   - Compression: Activée`);
  console.log(`   - Rate Limiting: ${isRenderFreeTier ? '100 req/15min' : '1000 req/15min'}`);
  console.log(`   - Max Request Size: ${isRenderFreeTier ? '5MB' : '50MB'}`);
  console.log(`   - DB Connections: ${isRenderFreeTier ? '4 max' : '20 max'}`);
  
  if (isRenderFreeTier) {
    console.log(`\n📋 CONSEILS POUR RENDER GRATUIT:`);
    console.log(`   • Utilisez /api/import-export/export/stream pour les gros exports`);
    console.log(`   • Exportez par lots de 1000-5000 lignes maximum`);
    console.log(`   • Utilisez /api/import-export/import/smart-sync pour la synchronisation`);
    console.log(`   • Limitez les imports à 5MB maximum`);
    console.log(`   • Utilisez les filtres pour réduire la taille des données`);
    console.log(`\n⚠️ LIMITATIONS:`);
    console.log(`   • Mémoire: 512MB`);
    console.log(`   • Requêtes: 100/15min`);
    console.log(`   • Idle shutdown: 15 minutes d'inactivité`);
  }
});

// Configuration du timeout du serveur
server.keepAliveTimeout = 65000; // 65 secondes
server.headersTimeout = 66000; // 66 secondes

// Gestion propre du shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Signal SIGTERM reçu, arrêt propre du serveur...');
  server.close(() => {
    console.log('✅ Serveur arrêté proprement');
    process.exit(0);
  });
  
  // Timeout de sécurité
  setTimeout(() => {
    console.error('⏰ Timeout lors de l\'arrêt, arrêt forcé');
    process.exit(1);
  }, 10000);
});

module.exports = app;