const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const { query } = require("./db/db");

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

// CORS pour production et développement
app.use(cors({ 
  origin: process.env.NODE_ENV === 'production' 
    ? ["https://votre-frontend.vercel.app", "http://localhost:5173"]
    : "http://localhost:5173",
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log des requêtes
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.url}`);
  next();
});

// Test de connexion PostgreSQL
app.get("/api/test-db", async (req, res) => {
  try {
    const result = await query("SELECT 1 as test, version() as postgres_version, NOW() as server_time");
    console.log('✅ PostgreSQL connecté');
    res.json({ 
      message: "✅ Connexion PostgreSQL réussie", 
      data: result.rows,
      database: "PostgreSQL",
      version: result.rows[0].postgres_version,
      server_time: result.rows[0].server_time
    });
  } catch (err) {
    console.error('❌ Erreur PostgreSQL:', err);
    res.status(500).json({ 
      message: "❌ Erreur PostgreSQL", 
      error: err.message,
      database: "PostgreSQL"
    });
  }
});

// Racine API
app.get("/api", (req, res) => {
  res.json({
    message: "🚀 API CartesProject - PostgreSQL Edition",
    database: "PostgreSQL",
    version: "1.0.0",
    environment: process.env.NODE_ENV || 'development',
    deployment: "Render",
    routes: {
      public: [
        "GET /api/test-db", 
        "POST /api/auth/login",
        "GET /api"
      ],
      protected: [
        "GET /api/cartes",
        "GET /api/inventaire/recherche", 
        "GET /api/utilisateurs",
        "GET /api/journal",
        "GET /api/log",
        "GET /api/import-export/export",
        "GET /api/statistiques/globales",
        "GET /api/statistiques/sites",
        "GET /api/statistiques/detail",
        "POST /api/statistiques/refresh"
      ],
      external: [
        "GET /api/external/health",
        "GET /api/external/cartes",
        "POST /api/external/sync", 
        "GET /api/external/stats"
      ],
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
      timestamp: new Date().toISOString()
    }
  });
});

// Routes principales
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

// Route de santé globale
app.get("/api/health", async (req, res) => {
  try {
    // Test de la base de données
    const dbResult = await query("SELECT NOW() as server_time, current_database() as database_name, version() as postgres_version");
    
    // Statistiques basiques
    const statsResult = await query(`
      SELECT 
        (SELECT COUNT(*) FROM cartes) as total_cartes,
        (SELECT COUNT(*) FROM utilisateurs) as total_utilisateurs,
        (SELECT COUNT(*) FROM journalactivite WHERE dateaction >= NOW() - INTERVAL '24 hours') as activites_24h
    `);

    res.json({
      status: "healthy",
      database: {
        status: "connected",
        server_time: dbResult.rows[0].server_time,
        database_name: dbResult.rows[0].database_name,
        postgres_version: dbResult.rows[0].postgres_version.split(',')[0] // Version simplifiée
      },
      statistics: {
        total_cartes: parseInt(statsResult.rows[0].total_cartes),
        total_utilisateurs: parseInt(statsResult.rows[0].total_utilisateurs),
        activites_24h: parseInt(statsResult.rows[0].activites_24h)
      },
      system: {
        node_version: process.version,
        platform: process.platform,
        memory_usage: process.memoryUsage(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Health check failed:', error);
    res.status(500).json({
      status: "unhealthy",
      error: error.message,
      database: "PostgreSQL",
      timestamp: new Date().toISOString()
    });
  }
});

// Route test racine
app.get("/", (req, res) => {
  res.json({
    message: "🚀 API CartesProject PostgreSQL en ligne !",
    documentation: `http://localhost:${PORT}/api`,
    health_check: `http://localhost:${PORT}/api/health`,
    database: "PostgreSQL",
    deployment: "Render"
  });
});

// 404 - Gestion des routes non trouvées
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route non trouvée",
    requested: `${req.method} ${req.url}`,
    help: "Voir /api pour les routes disponibles",
    available_routes: {
      documentation: "GET /api",
      health_check: "GET /api/health",
      database_test: "GET /api/test-db"
    }
  });
});

// Gestion globale des erreurs
app.use((err, req, res, next) => {
  console.error("❌ Erreur serveur:", err);
  
  // Erreur de validation
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: "Erreur de validation",
      errors: err.errors
    });
  }
  
  // Erreur JWT
  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: "Token invalide"
    });
  }
  
  // Erreur d'authentification
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      success: false,
      message: "Non autorisé"
    });
  }

  // Erreur de base de données PostgreSQL
  if (err.code && err.code.startsWith('23') || err.code === '23505') { // Violation de contrainte
    return res.status(400).json({
      success: false,
      message: "Erreur de données",
      details: "Violation de contrainte (doublon ou donnée invalide)"
    });
  }

  if (err.code === '23503') { // Violation de clé étrangère
    return res.status(400).json({
      success: false,
      message: "Erreur de référence",
      details: "Référence à un enregistrement inexistant"
    });
  }

  // Erreur générique
  res.status(500).json({
    success: false,
    message: "Erreur interne du serveur",
    error: process.env.NODE_ENV === 'development' ? err.message : 'Une erreur est survenue',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// Gestion des promesses non catchées
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promesse rejetée non gérée:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Exception non capturée:', error);
  process.exit(1);
});

// Lancement du serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📖 Documentation: http://localhost:${PORT}/api`);
  console.log(`🔧 Health Check: http://localhost:${PORT}/api/health`);
  console.log(`🌐 Environnement: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🗄️ Base de données: PostgreSQL`);
  console.log(`☁️  Déploiement: Render`);
  console.log(`⏰ Démarrage: ${new Date().toLocaleString()}`);
  
  // Message spécifique pour PostgreSQL
  if (process.env.DATABASE_URL) {
    console.log(`🔗 Connexion DB: ${process.env.DATABASE_URL.split('@')[1]?.split('/')[0] || 'Render PostgreSQL'}`);
  }
});

module.exports = app;