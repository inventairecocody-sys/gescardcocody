const express = require("express");
const router = express.Router();
const { poolPromise, sql } = require("../db/db");
const { verifyToken } = require("../middleware/auth");

// ✅ Middleware d'authentification sur toutes les routes
router.use(verifyToken);

// ✅ FONCTIONS DU CONTRÔLEUR (inline pour éviter les erreurs de chargement)

// 🔹 VÉRIFICATION DE SANTÉ
const healthCheck = async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT 
        COUNT(*) as total_cartes,
        MIN([DATE IMPORT]) as premiere_importation,
        MAX([DATE IMPORT]) as derniere_importation
      FROM Cartes
    `);

    res.json({
      success: true,
      status: 'healthy',
      database: 'connected',
      statistics: {
        total_cartes: parseInt(result.recordset[0].total_cartes),
        premiere_importation: result.recordset[0].premiere_importation,
        derniere_importation: result.recordset[0].derniere_importation
      },
      api: {
        version: '3.0.0',
        environment: process.env.NODE_ENV || 'production'
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erreur healthCheck:', error);
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 SYNCHRONISATION - RÉCUPÉRER LES CHANGEMENTS
const getChanges = async (req, res) => {
  try {
    const { since } = req.query;
    
    console.log('📡 Récupération des changements depuis:', since);
    
    // Si since n'est pas fourni, utiliser 24h
    const sinceDate = since 
      ? new Date(since)
      : new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h par défaut
    
    const pool = await poolPromise;
    
    const query = `
      SELECT 
        ID,
        [LIEU D'ENROLEMENT],
        [SITE DE RETRAIT],
        RANGEMENT,
        NOM,
        PRENOMS,
        [DATE DE NAISSANCE],
        [LIEU NAISSANCE],
        CONTACT,
        DELIVRANCE,
        [CONTACT DE RETRAIT],
        [DATE DE DELIVRANCE],
        [DATE IMPORT],
        'UPDATE' as operation
      FROM Cartes 
      WHERE [DATE IMPORT] > @sinceDate
      ORDER BY [DATE IMPORT] ASC
    `;
    
    const result = await pool.request()
      .input('sinceDate', sql.DateTime, sinceDate)
      .query(query);
    
    const derniereModification = result.recordset.length > 0
      ? result.recordset[result.recordset.length - 1]['DATE IMPORT']
      : sinceDate.toISOString();
    
    res.json({
      success: true,
      data: result.recordset,
      total: result.recordset.length,
      derniereModification: derniereModification,
      since: sinceDate.toISOString(),
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erreur getChanges:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des changements',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 SYNCHRONISATION - RECEVOIR LES DONNÉES
const syncData = async (req, res) => {
  const pool = await poolPromise;
  const transaction = new sql.Transaction(pool);
  
  try {
    await transaction.begin();
    
    const { donnees, source = 'python_app', batch_id } = req.body;
    
    if (!donnees || !Array.isArray(donnees)) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        error: 'Format invalide',
        message: 'Le champ "donnees" doit être un tableau'
      });
    }

    console.log(`🔄 Synchronisation: ${donnees.length} enregistrements depuis ${source}`);

    let imported = 0;
    let updated = 0;
    let duplicates = 0;
    let errors = 0;
    const errorDetails = [];

    for (let i = 0; i < donnees.length; i++) {
      try {
        const item = donnees[i];
        
        // Validation des champs obligatoires
        if (!item.NOM || !item.PRENOMS) {
          errors++;
          errorDetails.push(`Enregistrement ${i}: NOM et PRENOMS obligatoires`);
          continue;
        }

        const nom = item.NOM.toString().trim();
        const prenoms = item.PRENOMS.toString().trim();
        const siteRetrait = item["SITE DE RETRAIT"]?.toString().trim() || '';

        // ✅ Vérifier si la carte existe
        const checkQuery = `
          SELECT * FROM Cartes 
          WHERE NOM = @nom AND PRENOMS = @prenoms AND [SITE DE RETRAIT] = @siteRetrait
        `;
        
        const checkRequest = new sql.Request(transaction);
        checkRequest.input('nom', sql.NVarChar(100), nom);
        checkRequest.input('prenoms', sql.NVarChar(100), prenoms);
        checkRequest.input('siteRetrait', sql.NVarChar(255), siteRetrait);
        
        const existingResult = await checkRequest.query(checkQuery);

        if (existingResult.recordset.length > 0) {
          // ✅ CARTE EXISTANTE - MISE À JOUR
          const carteExistante = existingResult.recordset[0];
          
          const updateQuery = `
            UPDATE Cartes 
            SET [LIEU D'ENROLEMENT] = @lieuEnrolement,
                [SITE DE RETRAIT] = @siteRetrait,
                RANGEMENT = @rangement,
                NOM = @nom,
                PRENOMS = @prenoms,
                [DATE DE NAISSANCE] = @dateNaissance,
                [LIEU NAISSANCE] = @lieuNaissance,
                CONTACT = @contact,
                DELIVRANCE = @delivrance,
                [CONTACT DE RETRAIT] = @contactRetrait,
                [DATE DE DELIVRANCE] = @dateDelivrance,
                [DATE IMPORT] = @dateImport
            WHERE ID = @id
          `;
          
          const updateRequest = new sql.Request(transaction);
          updateRequest.input('lieuEnrolement', sql.NVarChar(255), item["LIEU D'ENROLEMENT"]?.toString().trim() || '');
          updateRequest.input('siteRetrait', sql.NVarChar(255), siteRetrait);
          updateRequest.input('rangement', sql.NVarChar(100), item["RANGEMENT"]?.toString().trim() || '');
          updateRequest.input('nom', sql.NVarChar(100), nom);
          updateRequest.input('prenoms', sql.NVarChar(100), prenoms);
          updateRequest.input('dateNaissance', sql.NVarChar(50), item["DATE DE NAISSANCE"]?.toString().trim() || '');
          updateRequest.input('lieuNaissance', sql.NVarChar(100), item["LIEU NAISSANCE"]?.toString().trim() || '');
          updateRequest.input('contact', sql.NVarChar(50), item["CONTACT"]?.toString().trim() || '');
          updateRequest.input('delivrance', sql.NVarChar(100), item["DELIVRANCE"]?.toString().trim() || '');
          updateRequest.input('contactRetrait', sql.NVarChar(50), item["CONTACT DE RETRAIT"]?.toString().trim() || '');
          updateRequest.input('dateDelivrance', sql.NVarChar(50), item["DATE DE DELIVRANCE"]?.toString().trim() || '');
          updateRequest.input('dateImport', sql.DateTime, new Date());
          updateRequest.input('id', sql.Int, carteExistante.ID);
          
          await updateRequest.query(updateQuery);
          updated++;
          console.log(`🔄 Carte mise à jour: ${nom} ${prenoms} (${siteRetrait})`);
          
        } else {
          // ✅ NOUVELLE CARTE - INSÉRER
          const insertQuery = `
            INSERT INTO Cartes (
              [LIEU D'ENROLEMENT], [SITE DE RETRAIT], RANGEMENT, NOM, PRENOMS,
              [DATE DE NAISSANCE], [LIEU NAISSANCE], CONTACT, DELIVRANCE,
              [CONTACT DE RETRAIT], [DATE DE DELIVRANCE], [DATE IMPORT]
            ) VALUES (
              @lieuEnrolement, @siteRetrait, @rangement, @nom, @prenoms,
              @dateNaissance, @lieuNaissance, @contact, @delivrance,
              @contactRetrait, @dateDelivrance, @dateImport
            )
          `;
          
          const insertRequest = new sql.Request(transaction);
          insertRequest.input('lieuEnrolement', sql.NVarChar(255), item["LIEU D'ENROLEMENT"]?.toString().trim() || '');
          insertRequest.input('siteRetrait', sql.NVarChar(255), siteRetrait);
          insertRequest.input('rangement', sql.NVarChar(100), item["RANGEMENT"]?.toString().trim() || '');
          insertRequest.input('nom', sql.NVarChar(100), nom);
          insertRequest.input('prenoms', sql.NVarChar(100), prenoms);
          insertRequest.input('dateNaissance', sql.NVarChar(50), item["DATE DE NAISSANCE"]?.toString().trim() || '');
          insertRequest.input('lieuNaissance', sql.NVarChar(100), item["LIEU NAISSANCE"]?.toString().trim() || '');
          insertRequest.input('contact', sql.NVarChar(50), item["CONTACT"]?.toString().trim() || '');
          insertRequest.input('delivrance', sql.NVarChar(100), item["DELIVRANCE"]?.toString().trim() || '');
          insertRequest.input('contactRetrait', sql.NVarChar(50), item["CONTACT DE RETRAIT"]?.toString().trim() || '');
          insertRequest.input('dateDelivrance', sql.NVarChar(50), item["DATE DE DELIVRANCE"]?.toString().trim() || '');
          insertRequest.input('dateImport', sql.DateTime, new Date());
          
          await insertRequest.query(insertQuery);
          imported++;
          console.log(`✅ Nouvelle carte: ${nom} ${prenoms} (${siteRetrait})`);
        }

      } catch (error) {
        errors++;
        errorDetails.push(`Enregistrement ${i}: ${error.message}`);
        console.error(`❌ Erreur enregistrement ${i}:`, error.message);
      }
    }

    await transaction.commit();

    console.log(`✅ Sync réussie: ${imported} nouvelles, ${updated} mises à jour, ${errors} erreurs`);

    res.json({
      success: true,
      message: 'Synchronisation réussie',
      stats: {
        imported,
        updated, 
        duplicates,
        errors,
        totalProcessed: donnees.length
      },
      batch_info: {
        batch_id: batch_id || 'N/A',
        source: source,
        timestamp: new Date().toISOString()
      },
      errorDetails: errorDetails.slice(0, 10)
    });

  } catch (error) {
    await transaction.rollback();
    console.error('❌ Erreur syncData:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la synchronisation',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 STATISTIQUES DÉTAILLÉES
const getStats = async (req, res) => {
  try {
    const pool = await poolPromise;
    
    const globalStats = await pool.request().query(`
      SELECT 
        COUNT(*) as total_cartes,
        COUNT(CASE WHEN DELIVRANCE IS NOT NULL AND DELIVRANCE != '' THEN 1 END) as cartes_retirees,
        COUNT(DISTINCT [SITE DE RETRAIT]) as sites_actifs,
        COUNT(DISTINCT NOM) as beneficiaires_uniques,
        MIN([DATE IMPORT]) as premiere_importation,
        MAX([DATE IMPORT]) as derniere_importation
      FROM Cartes
    `);

    const topSites = await pool.request().query(`
      SELECT 
        [SITE DE RETRAIT] as site,
        COUNT(*) as total_cartes,
        COUNT(CASE WHEN DELIVRANCE IS NOT NULL AND DELIVRANCE != '' THEN 1 END) as cartes_retirees
      FROM Cartes 
      WHERE [SITE DE RETRAIT] IS NOT NULL AND [SITE DE RETRAIT] != ''
      GROUP BY [SITE DE RETRAIT]
      ORDER BY total_cartes DESC
    `);

    const sitesConfigures = [
      "ADJAME",
      "CHU D'ANGRE", 
      "UNIVERSITE DE COCODY",
      "LYCEE HOTELIER",
      "BINGERVILLE",
      "SITE_6",
      "SITE_7",
      "SITE_8", 
      "SITE_9",
      "SITE_10"
    ];

    res.json({
      success: true,
      data: {
        global: globalStats.recordset[0],
        top_sites: topSites.recordset,
        sites_configures: sitesConfigures
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erreur getStats:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des statistiques',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 RÉCUPÉRER LES SITES CONFIGURÉS
const getSites = async (req, res) => {
  try {
    const sites = [
      "ADJAME",
      "CHU D'ANGRE", 
      "UNIVERSITE DE COCODY",
      "LYCEE HOTELIER",
      "BINGERVILLE",
      "SITE_6",
      "SITE_7",
      "SITE_8", 
      "SITE_9",
      "SITE_10"
    ];
    
    res.json({
      success: true,
      sites: sites,
      total_sites: sites.length,
      description: "10 sites avec synchronisation",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erreur getSites:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur serveur',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 RÉCUPÉRER LES CARTES AVEC FILTRES
const getCartes = async (req, res) => {
  try {
    const {
      nom,
      prenom,
      contact,
      siteRetrait,
      lieuNaissance,
      dateDebut,
      dateFin,
      delivrance,
      page = 1,
      limit = 100
    } = req.query;

    const actualLimit = Math.min(parseInt(limit), 1000);
    const actualPage = Math.max(1, parseInt(page));
    const offset = (actualPage - 1) * actualLimit;

    const pool = await poolPromise;
    
    let query = `
      SELECT 
        ID,
        [LIEU D'ENROLEMENT],
        [SITE DE RETRAIT],
        RANGEMENT,
        NOM,
        PRENOMS,
        [DATE DE NAISSANCE],
        [LIEU NAISSANCE],
        CONTACT,
        DELIVRANCE,
        [CONTACT DE RETRAIT],
        [DATE DE DELIVRANCE],
        [DATE IMPORT]
      FROM Cartes 
      WHERE 1=1
    `;

    const request = pool.request();
    let paramCount = 0;

    // Appliquer les filtres
    if (nom) {
      paramCount++;
      query += ` AND NOM LIKE @nom${paramCount}`;
      request.input(`nom${paramCount}`, sql.NVarChar(100), `%${nom}%`);
    }

    if (prenom) {
      paramCount++;
      query += ` AND PRENOMS LIKE @prenom${paramCount}`;
      request.input(`prenom${paramCount}`, sql.NVarChar(100), `%${prenom}%`);
    }

    if (contact) {
      paramCount++;
      query += ` AND CONTACT LIKE @contact${paramCount}`;
      request.input(`contact${paramCount}`, sql.NVarChar(50), `%${contact}%`);
    }

    if (siteRetrait) {
      paramCount++;
      query += ` AND [SITE DE RETRAIT] LIKE @siteRetrait${paramCount}`;
      request.input(`siteRetrait${paramCount}`, sql.NVarChar(255), `%${siteRetrait}%`);
    }

    if (lieuNaissance) {
      paramCount++;
      query += ` AND [LIEU NAISSANCE] LIKE @lieuNaissance${paramCount}`;
      request.input(`lieuNaissance${paramCount}`, sql.NVarChar(100), `%${lieuNaissance}%`);
    }

    if (dateDebut) {
      paramCount++;
      query += ` AND [DATE IMPORT] >= @dateDebut${paramCount}`;
      request.input(`dateDebut${paramCount}`, sql.DateTime, new Date(dateDebut));
    }

    if (dateFin) {
      paramCount++;
      query += ` AND [DATE IMPORT] <= @dateFin${paramCount}`;
      request.input(`dateFin${paramCount}`, sql.DateTime, new Date(dateFin + ' 23:59:59'));
    }

    if (delivrance) {
      paramCount++;
      query += ` AND DELIVRANCE LIKE @delivrance${paramCount}`;
      request.input(`delivrance${paramCount}`, sql.NVarChar(100), `%${delivrance}%`);
    }

    // Pagination
    query += ` ORDER BY ID DESC OFFSET ${offset} ROWS FETCH NEXT ${actualLimit} ROWS ONLY`;

    const result = await request.query(query);

    // Compter le total
    let countQuery = 'SELECT COUNT(*) as total FROM Cartes WHERE 1=1';
    const countRequest = pool.request();
    paramCount = 0;

    if (nom) {
      paramCount++;
      countQuery += ` AND NOM LIKE @nom${paramCount}`;
      countRequest.input(`nom${paramCount}`, sql.NVarChar(100), `%${nom}%`);
    }
    if (prenom) {
      paramCount++;
      countQuery += ` AND PRENOMS LIKE @prenom${paramCount}`;
      countRequest.input(`prenom${paramCount}`, sql.NVarChar(100), `%${prenom}%`);
    }
    // ... autres filtres similaires

    const countResult = await countRequest.query(countQuery);
    const total = parseInt(countResult.recordset[0].total);

    res.json({
      success: true,
      data: result.recordset,
      pagination: {
        page: actualPage,
        limit: actualLimit,
        total: total,
        totalPages: Math.ceil(total / actualLimit),
        hasNext: actualPage < Math.ceil(total / actualLimit),
        hasPrev: actualPage > 1
      },
      filters: {
        nom: nom || null,
        prenom: prenom || null,
        contact: contact || null,
        siteRetrait: siteRetrait || null,
        lieuNaissance: lieuNaissance || null,
        dateDebut: dateDebut || null,
        dateFin: dateFin || null,
        delivrance: delivrance || null
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erreur getCartes:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des cartes',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 MODIFICATIONS PAR SITE
const getModifications = async (req, res) => {
  try {
    const { site, derniereSync, limit = 1000 } = req.query;

    if (!site || !derniereSync) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants: site et derniereSync requis',
        timestamp: new Date().toISOString()
      });
    }

    const sitesValides = [
      "ADJAME",
      "CHU D'ANGRE", 
      "UNIVERSITE DE COCODY",
      "LYCEE HOTELIER",
      "BINGERVILLE",
      "SITE_6",
      "SITE_7",
      "SITE_8", 
      "SITE_9",
      "SITE_10"
    ];
    
    if (!sitesValides.includes(site)) {
      return res.status(400).json({
        success: false,
        error: 'Site non reconnu',
        message: `Sites valides: ${sitesValides.join(', ')}`,
        timestamp: new Date().toISOString()
      });
    }

    const pool = await poolPromise;
    
    const query = `
      SELECT * FROM Cartes 
      WHERE [SITE DE RETRAIT] = @site 
      AND [DATE IMPORT] > @derniereSync
      ORDER BY [DATE IMPORT] ASC
    `;

    const result = await pool.request()
      .input('site', sql.NVarChar(255), site)
      .input('derniereSync', sql.DateTime, new Date(derniereSync))
      .query(query);

    let derniereModification = derniereSync;
    if (result.recordset.length > 0) {
      derniereModification = result.recordset[result.recordset.length - 1]['DATE IMPORT'];
    }

    res.json({
      success: true,
      data: result.recordset,
      total: result.recordset.length,
      derniereModification: derniereModification,
      site: site,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erreur getModifications:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des modifications',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 ROUTES DE L'API DE SYNCHRONISATION ET FUSION INTELLIGENTE
router.get("/api/health", healthCheck);
router.get("/api/sync/changes", getChanges);
router.post("/api/sync", syncData);
router.get("/api/stats", getStats);
router.get("/api/sites", getSites);
router.get("/api/cartes", getCartes);
router.get("/api/modifications", getModifications);

// ✅ ROUTES CRUD POUR L'APPLICATION WEB (MSSQL)
router.get("/", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query(`
      SELECT TOP 100 * FROM Cartes 
      ORDER BY ID DESC
    `);
    
    res.json({
      success: true,
      data: result.recordset,
      total: result.recordset.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erreur GET /cartes:', error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la récupération des cartes",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.get("/all", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query("SELECT * FROM Cartes ORDER BY ID DESC");
    
    res.json({
      success: true,
      data: result.recordset,
      total: result.recordset.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erreur GET /cartes/all:', error);
    res.status(500).json({
      success: false,
      error: "Erreur serveur lors de la récupération de toutes les cartes",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.get("/statistiques/total", async (req, res) => {
  try {
    const pool = await poolPromise;
    
    const totalResult = await pool.request().query(`
      SELECT COUNT(*) as total FROM Cartes
    `);
    
    const sitesResult = await pool.request().query(`
      SELECT 
        [SITE DE RETRAIT] as site,
        COUNT(*) as total_cartes
      FROM Cartes 
      WHERE [SITE DE RETRAIT] IS NOT NULL 
      GROUP BY [SITE DE RETRAIT]
      ORDER BY total_cartes DESC
    `);
    
    const sites = [
      "ADJAME",
      "CHU D'ANGRE", 
      "UNIVERSITE DE COCODY",
      "LYCEE HOTELIER",
      "BINGERVILLE",
      "SITE_6",
      "SITE_7",
      "SITE_8", 
      "SITE_9",
      "SITE_10"
    ];
    
    res.json({
      success: true,
      data: {
        total_cartes: totalResult.recordset[0].total,
        sites_repartition: sitesResult.recordset,
        sites_configures: sites
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erreur GET /cartes/statistiques/total:', error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la récupération des statistiques",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await poolPromise;
    
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query("SELECT * FROM Cartes WHERE ID = @id");
    
    if (result.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Carte non trouvée",
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      success: true,
      data: result.recordset[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`❌ Erreur GET /cartes/${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la récupération de la carte",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.post("/", async (req, res) => {
  try {
    const carte = req.body;
    const pool = await poolPromise;
    
    // Validation des champs obligatoires
    if (!carte.NOM || !carte.PRENOMS) {
      return res.status(400).json({
        success: false,
        error: "Les champs NOM et PRENOMS sont obligatoires",
        timestamp: new Date().toISOString()
      });
    }
    
    const query = `
      INSERT INTO Cartes (
        [LIEU D'ENROLEMENT], [SITE DE RETRAIT], RANGEMENT, NOM, PRENOMS,
        [DATE DE NAISSANCE], [LIEU NAISSANCE], CONTACT, DELIVRANCE,
        [CONTACT DE RETRAIT], [DATE DE DELIVRANCE], [DATE IMPORT]
      ) VALUES (
        @lieuEnrolement, @siteRetrait, @rangement, @nom, @prenoms,
        @dateNaissance, @lieuNaissance, @contact, @delivrance,
        @contactRetrait, @dateDelivrance, @dateImport
      );
      SELECT SCOPE_IDENTITY() as newId;
    `;
    
    const request = pool.request();
    request.input("lieuEnrolement", sql.NVarChar(255), carte["LIEU D'ENROLEMENT"] || "");
    request.input("siteRetrait", sql.NVarChar(255), carte["SITE DE RETRAIT"] || "");
    request.input("rangement", sql.NVarChar(100), carte.RANGEMENT || "");
    request.input("nom", sql.NVarChar(100), carte.NOM || "");
    request.input("prenoms", sql.NVarChar(100), carte.PRENOMS || "");
    request.input("dateNaissance", sql.NVarChar(50), carte["DATE DE NAISSANCE"] || "");
    request.input("lieuNaissance", sql.NVarChar(100), carte["LIEU NAISSANCE"] || "");
    request.input("contact", sql.NVarChar(50), carte.CONTACT || "");
    request.input("delivrance", sql.NVarChar(100), carte.DELIVRANCE || "");
    request.input("contactRetrait", sql.NVarChar(50), carte["CONTACT DE RETRAIT"] || "");
    request.input("dateDelivrance", sql.NVarChar(50), carte["DATE DE DELIVRANCE"] || "");
    request.input("dateImport", sql.DateTime, new Date());
    
    const result = await request.query(query);
    
    // Journalisation
    await ajouterAuJournal(req.user?.username || 'system', 
      `Création carte: ${carte.NOM} ${carte.PRENOMS} (ID: ${result.recordset[0].newId})`);
    
    res.json({
      success: true,
      message: "Carte créée avec succès",
      data: {
        id: result.recordset[0].newId,
        nom: carte.NOM,
        prenoms: carte.PRENOMS
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Erreur POST /cartes:', error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la création de la carte",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ ROUTE PUT BATCH - avant /:id pour éviter les conflits
router.put("/batch", async (req, res) => {
  try {
    const { cartes, role } = req.body;

    if (!Array.isArray(cartes) || cartes.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: "Aucune carte reçue",
        timestamp: new Date().toISOString()
      });
    }

    if (!role) {
      return res.status(403).json({ 
        success: false, 
        error: "Rôle manquant",
        timestamp: new Date().toISOString()
      });
    }

    // Normalisation du rôle
    const roleNormalise = (role || "").toLowerCase().trim();
    if (roleNormalise === "operateur" || roleNormalise === "opérateur") {
      return res.status(403).json({
        success: false,
        error: "Opérateurs non autorisés à modifier les cartes",
        timestamp: new Date().toISOString()
      });
    }

    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      let cartesModifiees = 0;
      const detailsModifications = [];

      // Filtrer les cartes valides
      const cartesValides = cartes.filter((carte) => {
        if (!carte.ID) {
          console.warn("⚠️ Carte sans ID ignorée:", carte.NOM);
          return false;
        }

        const idNumber = Number(carte.ID);
        const idValide = !isNaN(idNumber) && idNumber > 0;

        if (!idValide) {
          console.warn("⚠️ Carte ignorée (ID invalide):", {
            id: carte.ID,
            nom: carte.NOM,
          });
        }
        return idValide;
      });

      console.log(`📥 ${cartesValides.length}/${cartes.length} cartes valides à traiter`);

      for (const carte of cartesValides) {
        const idNumerique = Number(carte.ID);

        const query = `
          UPDATE dbo.Cartes 
          SET [LIEU D'ENROLEMENT] = @lieuEnrolement,
              [SITE DE RETRAIT] = @siteRetrait,
              RANGEMENT = @rangement,
              NOM = @nom,
              PRENOMS = @prenoms,
              [DATE DE NAISSANCE] = @dateNaissance,
              [LIEU NAISSANCE] = @lieuNaissance,
              CONTACT = @contact,
              DELIVRANCE = @delivrance,
              [CONTACT DE RETRAIT] = @contactRetrait,
              [DATE DE DELIVRANCE] = @dateDelivrance,
              [DATE IMPORT] = @dateImport
          WHERE ID = @id
        `;

        const request = new sql.Request(transaction);
        request.input("lieuEnrolement", sql.NVarChar(255), carte["LIEU D'ENROLEMENT"] || "");
        request.input("siteRetrait", sql.NVarChar(255), carte["SITE DE RETRAIT"] || "");
        request.input("rangement", sql.NVarChar(100), carte.RANGEMENT || "");
        request.input("nom", sql.NVarChar(100), carte.NOM || "");
        request.input("prenoms", sql.NVarChar(100), carte.PRENOMS || "");
        request.input("dateNaissance", sql.NVarChar(50), carte["DATE DE NAISSANCE"] || "");
        request.input("lieuNaissance", sql.NVarChar(100), carte["LIEU NAISSANCE"] || "");
        request.input("contact", sql.NVarChar(50), carte.CONTACT || "");
        request.input("delivrance", sql.NVarChar(100), carte.DELIVRANCE || "");
        request.input("contactRetrait", sql.NVarChar(50), carte["CONTACT DE RETRAIT"] || "");
        request.input("dateDelivrance", sql.NVarChar(50), carte["DATE DE DELIVRANCE"] || "");
        request.input("dateImport", sql.DateTime, new Date());
        request.input("id", sql.Int, idNumerique);

        const result = await request.query(query);

        if (result.rowsAffected[0] > 0) {
          cartesModifiees++;
          detailsModifications.push(`ID ${idNumerique}: ${carte.NOM} ${carte.PRENOMS}`);
          
          await ajouterAuJournal(
            role,
            `Modification carte ID ${idNumerique}: ${carte.NOM} ${carte.PRENOMS}`,
            transaction
          );
        }
      }

      await transaction.commit();

      console.log("✅ Mise à jour batch terminée:", {
        modifiees: cartesModifiees,
        ignorees: cartes.length - cartesValides.length,
        total: cartes.length,
      });

      res.json({
        success: true,
        message: `${cartesModifiees} cartes mises à jour avec succès`,
        details: {
          modifiees: cartesModifiees,
          ignorees: cartes.length - cartesValides.length,
          total: cartes.length,
          modifications: detailsModifications
        },
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      await transaction.rollback();
      console.error("❌ Erreur transaction:", error);
      throw error;
    }
  } catch (error) {
    console.error("❌ Erreur PUT /cartes/batch:", error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la mise à jour des cartes: " + error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const carte = req.body;
    const pool = await poolPromise;
    
    // Vérifier si la carte existe
    const checkResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query("SELECT COUNT(*) as count FROM Cartes WHERE ID = @id");
    
    if (checkResult.recordset[0].count === 0) {
      return res.status(404).json({
        success: false,
        error: "Carte non trouvée",
        timestamp: new Date().toISOString()
      });
    }
    
    const query = `
      UPDATE Cartes 
      SET [LIEU D'ENROLEMENT] = @lieuEnrolement,
          [SITE DE RETRAIT] = @siteRetrait,
          RANGEMENT = @rangement,
          NOM = @nom,
          PRENOMS = @prenoms,
          [DATE DE NAISSANCE] = @dateNaissance,
          [LIEU NAISSANCE] = @lieuNaissance,
          CONTACT = @contact,
          DELIVRANCE = @delivrance,
          [CONTACT DE RETRAIT] = @contactRetrait,
          [DATE DE DELIVRANCE] = @dateDelivrance,
          [DATE IMPORT] = @dateImport
      WHERE ID = @id
    `;
    
    const result = await pool
      .request()
      .input("lieuEnrolement", sql.NVarChar(255), carte["LIEU D'ENROLEMENT"] || "")
      .input("siteRetrait", sql.NVarChar(255), carte["SITE DE RETRAIT"] || "")
      .input("rangement", sql.NVarChar(100), carte.RANGEMENT || "")
      .input("nom", sql.NVarChar(100), carte.NOM || "")
      .input("prenoms", sql.NVarChar(100), carte.PRENOMS || "")
      .input("dateNaissance", sql.NVarChar(50), carte["DATE DE NAISSANCE"] || "")
      .input("lieuNaissance", sql.NVarChar(100), carte["LIEU NAISSANCE"] || "")
      .input("contact", sql.NVarChar(50), carte.CONTACT || "")
      .input("delivrance", sql.NVarChar(100), carte.DELIVRANCE || "")
      .input("contactRetrait", sql.NVarChar(50), carte["CONTACT DE RETRAIT"] || "")
      .input("dateDelivrance", sql.NVarChar(50), carte["DATE DE DELIVRANCE"] || "")
      .input("dateImport", sql.DateTime, new Date())
      .input("id", sql.Int, id)
      .query(query);
    
    // Journalisation
    await ajouterAuJournal(req.user?.username || 'system', 
      `Modification carte ID ${id}: ${carte.NOM} ${carte.PRENOMS}`);
    
    res.json({
      success: true,
      message: "Carte mise à jour avec succès",
      data: {
        id: id,
        nom: carte.NOM,
        prenoms: carte.PRENOMS
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`❌ Erreur PUT /cartes/${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la mise à jour de la carte",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const pool = await poolPromise;
    
    // Récupérer les infos de la carte avant suppression
    const carteResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query("SELECT NOM, PRENOMS FROM Cartes WHERE ID = @id");
    
    if (carteResult.recordset.length === 0) {
      return res.status(404).json({
        success: false,
        error: "Carte non trouvée",
        timestamp: new Date().toISOString()
      });
    }
    
    const carte = carteResult.recordset[0];
    
    const result = await pool
      .request()
      .input("id", sql.Int, id)
      .query("DELETE FROM Cartes WHERE ID = @id");
    
    // Journalisation
    await ajouterAuJournal(req.user?.username || 'system', 
      `Suppression carte ID ${id}: ${carte.NOM} ${carte.PRENOMS}`);
    
    res.json({
      success: true,
      message: "Carte supprimée avec succès",
      data: {
        id: id,
        nom: carte.NOM,
        prenoms: carte.PRENOMS
      },
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`❌ Erreur DELETE /cartes/${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      error: "Erreur lors de la suppression de la carte",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ ROUTE DE TEST
router.get("/test/connection", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool.request().query("SELECT @@VERSION as version");
    
    res.json({
      success: true,
      message: "Connexion à la base de données réussie",
      version: result.recordset[0].version,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Erreur de connexion à la base de données",
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ✅ Fonction de journalisation
const ajouterAuJournal = async (utilisateur, action, transaction = null) => {
  try {
    if (transaction) {
      const request = new sql.Request(transaction);
      request.input("utilisateur", sql.NVarChar(100), utilisateur);
      request.input("action", sql.NVarChar(500), action);
      request.input("date", sql.DateTime, new Date());

      await request.query(`
        INSERT INTO journal (utilisateur, action, date)
        VALUES (@utilisateur, @action, @date)
      `);
    } else {
      const pool = await poolPromise;
      await pool
        .request()
        .input("utilisateur", sql.NVarChar(100), utilisateur)
        .input("action", sql.NVarChar(500), action)
        .input("date", sql.DateTime, new Date())
        .query(`
          INSERT INTO journal (utilisateur, action, date)
          VALUES (@utilisateur, @action, @date)
        `);
    }
    
    console.log(`📝 Journal: ${utilisateur} - ${action}`);
  } catch (error) {
    console.error("❌ Erreur journalisation:", error);
  }
};

module.exports = router;