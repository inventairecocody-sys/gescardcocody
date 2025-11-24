const express = require("express");
const router = express.Router();
const { poolPromise } = require("../db/db");

// 🔹 STATISTIQUES GLOBALES OPTIMISÉES
router.get("/globales", async (req, res) => {
  let pool;
  try {
    console.log("📊 Calcul des statistiques globales...");
    
    pool = await poolPromise;
    
    const result = await pool.request().query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE 
          WHEN DELIVRANCE IS NOT NULL 
          AND LTRIM(RTRIM(ISNULL(DELIVRANCE, ''))) != '' 
          THEN 1 ELSE 0 
        END) as retires
      FROM dbo.Cartes
    `);

    const stats = result.recordset[0];
    const response = {
      total: parseInt(stats.total) || 0,
      retires: parseInt(stats.retires) || 0,
      restants: (parseInt(stats.total) || 0) - (parseInt(stats.retires) || 0)
    };

    console.log("✅ Statistiques globales:", response);
    res.json(response);
    
  } catch (error) {
    console.error("❌ Erreur statistiques globales:", error);
    res.status(500).json({ 
      error: "Erreur lors du calcul des statistiques globales",
      details: error.message 
    });
  }
});

// 🔹 STATISTIQUES PAR SITE OPTIMISÉES
router.get("/sites", async (req, res) => {
  let pool;
  try {
    console.log("🏢 Calcul des statistiques par site...");
    
    pool = await poolPromise;
    
    const result = await pool.request().query(`
      SELECT 
        [SITE DE RETRAIT] as site,
        COUNT(*) as total,
        SUM(CASE 
          WHEN DELIVRANCE IS NOT NULL 
          AND LTRIM(RTRIM(ISNULL(DELIVRANCE, ''))) != '' 
          THEN 1 ELSE 0 
        END) as retires
      FROM dbo.Cartes
      WHERE [SITE DE RETRAIT] IS NOT NULL 
      AND LTRIM(RTRIM(ISNULL([SITE DE RETRAIT], ''))) != ''
      GROUP BY [SITE DE RETRAIT]
      ORDER BY total DESC
    `);

    const stats = result.recordset.map(row => ({
      site: row.site,
      total: parseInt(row.total) || 0,
      retires: parseInt(row.retires) || 0,
      restants: (parseInt(row.total) || 0) - (parseInt(row.retires) || 0)
    }));

    console.log(`✅ ${stats.length} sites trouvés`);
    res.json(stats);
    
  } catch (error) {
    console.error("❌ Erreur statistiques sites:", error);
    res.status(500).json({ 
      error: "Erreur lors du calcul des statistiques par site",
      details: error.message 
    });
  }
});

// 🔹 STATISTIQUES DÉTAILLÉES (tout en un)
router.get("/detail", async (req, res) => {
  let pool;
  try {
    pool = await poolPromise;
    
    // Exécuter les deux requêtes en parallèle
    const [globalesResult, sitesResult] = await Promise.all([
      pool.request().query(`
        SELECT 
          COUNT(*) as total,
          SUM(CASE 
            WHEN DELIVRANCE IS NOT NULL 
            AND LTRIM(RTRIM(ISNULL(DELIVRANCE, ''))) != '' 
            THEN 1 ELSE 0 
          END) as retires
        FROM dbo.Cartes
      `),
      pool.request().query(`
        SELECT 
          [SITE DE RETRAIT] as site,
          COUNT(*) as total,
          SUM(CASE 
            WHEN DELIVRANCE IS NOT NULL 
            AND LTRIM(RTRIM(ISNULL(DELIVRANCE, ''))) != '' 
            THEN 1 ELSE 0 
          END) as retires
        FROM dbo.Cartes
        WHERE [SITE DE RETRAIT] IS NOT NULL 
        AND LTRIM(RTRIM(ISNULL([SITE DE RETRAIT], ''))) != ''
        GROUP BY [SITE DE RETRAIT]
        ORDER BY total DESC
      `)
    ]);

    const globales = globalesResult.recordset[0];
    const sites = sitesResult.recordset;

    const response = {
      globales: {
        total: parseInt(globales.total) || 0,
        retires: parseInt(globales.retires) || 0,
        restants: (parseInt(globales.total) || 0) - (parseInt(globales.retires) || 0)
      },
      sites: sites.map(row => ({
        site: row.site,
        total: parseInt(row.total) || 0,
        retires: parseInt(row.retires) || 0,
        restants: (parseInt(row.total) || 0) - (parseInt(row.retires) || 0)
      }))
    };

    res.json(response);
    
  } catch (error) {
    console.error("❌ Erreur statistiques détail:", error);
    res.status(500).json({ 
      error: "Erreur lors du calcul des statistiques détaillées",
      details: error.message 
    });
  }
});

// 🔥 ENDPOINT POUR FORCER LE REFRESH
router.post("/refresh", async (req, res) => {
  try {
    console.log("🔄 Forçage du recalcul des statistiques...");
    
    // Cette endpoint ne fait rien de spécial car les stats sont déjà en temps réel
    // Mais il sert de point de synchronisation
    res.json({ 
      message: "Synchronisation des statistiques déclenchée",
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error("❌ Erreur refresh statistiques:", error);
    res.status(500).json({ 
      error: "Erreur lors du refresh des statistiques",
      details: error.message 
    });
  }
});

module.exports = router;