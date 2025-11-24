const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();

const { poolPromise } = require("./db/db");

// Import des routes
const authRoutes = require("./routes/authRoutes");
const cartesRoutes = require("./routes/Cartes");
const importExportRoutes = require("./routes/ImportExport");
const journalRoutes = require("./routes/journal");
const logRoutes = require("./routes/Log");
const utilisateursRoutes = require("./routes/utilisateurs");
const profilRoutes = require("./routes/profils");
const inventaireRoutes = require("./routes/Inventaire");
const statistiquesRoutes = require("./routes/statistiques");
const externalApiRoutes = require("./routes/externalApi"); // 🆕 NOUVEAU IMPORT

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log des requêtes
app.use((req, res, next) => {
  console.log(`📨 ${req.method} ${req.url}`);
  next();
});

// Vérification DB
poolPromise
  .then(() => console.log("✅ SQL Server connecté"))
  .catch((err) => console.error("❌ Erreur SQL Server :", err));

// Test DB
app.get("/api/test-db", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query("SELECT 1 as test");
    res.json({ message: "✅ Connexion DB réussie", data: result.recordset });
  } catch (err) {
    res.status(500).json({ message: "❌ Erreur DB", error: err.message });
  }
});

// Racine API
app.get("/api", (req, res) => {
  res.json({
    message: "🚀 API CartesProject",
    routes: {
      public: ["GET /api/test-db", "POST /api/auth/login"],
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
      external: [ // 🆕 NOUVELLES ROUTES EXTERNES
        "GET /api/external/health",
        "GET /api/external/cartes",
        "POST /api/external/sync", 
        "GET /api/external/stats"
      ]
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
app.use("/api/external", externalApiRoutes); // 🆕 NOUVELLE ROUTE

// Route test racine
app.get("/", (req, res) => res.send("🚀 API CartesProject en ligne !"));

// 404
app.use((req, res) =>
  res.status(404).json({
    message: "Route non trouvée",
    requested: `${req.method} ${req.url}`,
    help: "Voir /api pour les routes disponibles"
  })
);

// Gestion globale des erreurs
app.use((err, req, res, next) => {
  console.error("Erreur serveur:", err);
  res.status(500).json({
    message: "Erreur interne du serveur",
    error: process.env.NODE_ENV === "development" ? err.message : {}
  });
});

// Lancement
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📖 Documentation: http://localhost:${PORT}/api`);
  console.log(`🌐 API Externe: http://localhost:${PORT}/api/external`);
});