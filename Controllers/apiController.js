const db = require('../db/db');
const journalController = require('./journalController');

// 🔧 CONFIGURATION API EXTERNE
const API_CONFIG = {
  maxResults: 1000,
  defaultLimit: 100
};

// 📊 ENDPOINTS API POUR VOTRE COLLÈGUE

// 🔹 RÉCUPÉRER LES CARTES (avec filtres)
exports.getCartes = async (req, res) => {
  try {
    const {
      nom,
      prenom,
      contact,
      siteRetrait,
      dateDebut,
      dateFin,
      page = 1,
      limit = API_CONFIG.defaultLimit
    } = req.query;

    // Valider et limiter les paramètres
    const actualLimit = Math.min(parseInt(limit), API_CONFIG.maxResults);
    const actualPage = Math.max(1, parseInt(page));
    const offset = (actualPage - 1) * actualLimit;

    let query = `
      SELECT 
        id,
        "LIEU D'ENROLEMENT",
        "SITE DE RETRAIT",
        rangement,
        nom,
        prenoms,
        "DATE DE NAISSANCE",
        "LIEU NAISSANCE",
        contact,
        delivrance,
        "CONTACT DE RETRAIT",
        "DATE DE DELIVRANCE",
        dateimport
      FROM cartes 
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 0;

    // Appliquer les filtres
    if (nom) {
      paramCount++;
      query += ` AND nom ILIKE $${paramCount}`;
      params.push(`%${nom}%`);
    }

    if (prenom) {
      paramCount++;
      query += ` AND prenoms ILIKE $${paramCount}`;
      params.push(`%${prenom}%`);
    }

    if (contact) {
      paramCount++;
      query += ` AND contact ILIKE $${paramCount}`;
      params.push(`%${contact}%`);
    }

    if (siteRetrait) {
      paramCount++;
      query += ` AND "SITE DE RETRAIT" ILIKE $${paramCount}`;
      params.push(`%${siteRetrait}%`);
    }

    if (dateDebut) {
      paramCount++;
      query += ` AND dateimport >= $${paramCount}`;
      params.push(new Date(dateDebut));
    }

    if (dateFin) {
      paramCount++;
      query += ` AND dateimport <= $${paramCount}`;
      params.push(new Date(dateFin + ' 23:59:59'));
    }

    // Pagination (PostgreSQL)
    query += ` ORDER BY id DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(actualLimit, offset);

    const result = await db.query(query, params);

    // Compter le total (sans pagination)
    let countQuery = 'SELECT COUNT(*) as total FROM cartes WHERE 1=1';
    const countParams = [];

    // Reconstruction des paramètres pour le COUNT
    let countParamCount = 0;
    if (nom) {
      countParamCount++;
      countQuery += ` AND nom ILIKE $${countParamCount}`;
      countParams.push(`%${nom}%`);
    }
    if (prenom) {
      countParamCount++;
      countQuery += ` AND prenoms ILIKE $${countParamCount}`;
      countParams.push(`%${prenom}%`);
    }
    if (contact) {
      countParamCount++;
      countQuery += ` AND contact ILIKE $${countParamCount}`;
      countParams.push(`%${contact}%`);
    }
    if (siteRetrait) {
      countParamCount++;
      countQuery += ` AND "SITE DE RETRAIT" ILIKE $${countParamCount}`;
      countParams.push(`%${siteRetrait}%`);
    }
    if (dateDebut) {
      countParamCount++;
      countQuery += ` AND dateimport >= $${countParamCount}`;
      countParams.push(new Date(dateDebut));
    }
    if (dateFin) {
      countParamCount++;
      countQuery += ` AND dateimport <= $${countParamCount}`;
      countParams.push(new Date(dateFin + ' 23:59:59'));
    }

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      data: result.rows,
      pagination: {
        page: actualPage,
        limit: actualLimit,
        total: total,
        totalPages: Math.ceil(total / actualLimit)
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erreur API getCartes:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur serveur',
      details: error.message
    });
  }
};

// 🔹 SYNCHRONISER DES DONNÉES (votre collègue envoie ses données)
exports.syncData = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { donnees, source = 'python_app' } = req.body;
    
    if (!donnees || !Array.isArray(donnees)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Format invalide: données doit être un tableau'
      });
    }

    // Limiter le nombre d'enregistrements par requête
    if (donnees.length > 1000) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: 'Trop d\'enregistrements. Maximum 1000 par requête.'
      });
    }

    console.log(`🔄 Synchronisation de ${donnees.length} enregistrements depuis ${source}`);

    let imported = 0;
    let duplicates = 0;
    let errors = 0;
    const errorDetails = [];

    // Traiter chaque enregistrement
    for (let i = 0; i < donnees.length; i++) {
      try {
        const item = donnees[i];
        
        // Vérifier les champs obligatoires
        if (!item.NOM || !item.PRENOMS) {
          errors++;
          errorDetails.push(`Enregistrement ${i}: NOM et PRENOMS obligatoires`);
          continue;
        }

        // Vérifier les doublons (PostgreSQL)
        const duplicateCheck = await client.query(
          'SELECT COUNT(*) as count FROM cartes WHERE nom = $1 AND prenoms = $2',
          [item.NOM, item.PRENOMS]
        );

        if (parseInt(duplicateCheck.rows[0].count) > 0) {
          duplicates++;
          continue;
        }

        // Insérer la donnée (PostgreSQL)
        await client.query(`
          INSERT INTO cartes (
            "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, nom, prenoms,
            "DATE DE NAISSANCE", "LIEU NAISSANCE", contact, delivrance,
            "CONTACT DE RETRAIT", "DATE DE DELIVRANCE", sourceimport
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `, [
          item["LIEU D'ENROLEMENT"] || '',
          item["SITE DE RETRAIT"] || '',
          item.RANGEMENT || '',
          item.NOM || '',
          item.PRENOMS || '',
          item["DATE DE NAISSANCE"] ? new Date(item["DATE DE NAISSANCE"]) : null,
          item["LIEU NAISSANCE"] || '',
          item.CONTACT || '',
          item.DELIVRANCE || '',
          item["CONTACT DE RETRAIT"] || '',
          item["DATE DE DELIVRANCE"] ? new Date(item["DATE DE DELIVRANCE"]) : null,
          source
        ]);

        imported++;

      } catch (error) {
        errors++;
        errorDetails.push(`Enregistrement ${i}: ${error.message}`);
      }
    }

    await client.query('COMMIT');

    // Journaliser la synchronisation
    try {
      await journalController.logAction({
        nomUtilisateur: 'API_EXTERNE',
        nomComplet: 'Application Python Collègue',
        role: 'API_CLIENT',
        agence: 'EXTERNE',
        actionType: 'SYNC_API',
        tableName: 'Cartes',
        details: `Synchronisation API - ${imported} importés, ${duplicates} doublons, ${errors} erreurs - Source: ${source}`
      });
    } catch (journalError) {
      console.warn('⚠️ Impossible de journaliser:', journalError.message);
    }

    res.json({
      success: true,
      message: 'Synchronisation terminée',
      stats: {
        imported,
        duplicates,
        errors,
        totalProcessed: donnees.length
      },
      errorDetails: errorDetails.slice(0, 10)
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Erreur API syncData:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la synchronisation',
      details: error.message
    });
  } finally {
    client.release();
  }
};

// 🔹 STATISTIQUES POUR L'API
exports.getStats = async (req, res) => {
  try {
    const stats = await db.query(`
      SELECT 
        COUNT(*) as totalcartes,
        COUNT(CASE WHEN delivrance IS NOT NULL AND delivrance != '' THEN 1 END) as cartesretirees,
        COUNT(DISTINCT "SITE DE RETRAIT") as sitesdistincts,
        MIN(dateimport) as datepremierimport,
        MAX(dateimport) as datedernierimport
      FROM cartes
    `);

    const sitesStats = await db.query(`
      SELECT 
        "SITE DE RETRAIT" as site,
        COUNT(*) as total,
        COUNT(CASE WHEN delivrance IS NOT NULL AND delivrance != '' THEN 1 END) as retires
      FROM cartes 
      WHERE "SITE DE RETRAIT" IS NOT NULL 
      GROUP BY "SITE DE RETRAIT"
      ORDER BY total DESC
    `);

    res.json({
      success: true,
      stats: stats.rows[0],
      sites: sitesStats.rows,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erreur API getStats:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur serveur',
      details: error.message
    });
  }
};

// 🔹 VÉRIFICATION DE SANTÉ DE L'API
exports.healthCheck = async (req, res) => {
  try {
    // Tester la connexion à la base de données
    await db.query('SELECT 1 as test');
    
    // Récupérer quelques métriques
    const countResult = await db.query('SELECT COUNT(*) as total FROM cartes');
    
    res.json({
      success: true,
      status: 'healthy',
      database: 'connected',
      totalRecords: parseInt(countResult.rows[0].total),
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 EXPORT POUR LES TESTS (optionnel)
exports.API_CONFIG = API_CONFIG;