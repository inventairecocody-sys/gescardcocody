const { poolPromise, sql } = require('../db/db');
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
        DateImport
      FROM Cartes 
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 0;

    // Appliquer les filtres
    if (nom) {
      paramCount++;
      query += ` AND NOM LIKE @nom${paramCount}`;
      params.push({ name: `nom${paramCount}`, value: `%${nom}%` });
    }

    if (prenom) {
      paramCount++;
      query += ` AND PRENOMS LIKE @prenom${paramCount}`;
      params.push({ name: `prenom${paramCount}`, value: `%${prenom}%` });
    }

    if (contact) {
      paramCount++;
      query += ` AND CONTACT LIKE @contact${paramCount}`;
      params.push({ name: `contact${paramCount}`, value: `%${contact}%` });
    }

    if (siteRetrait) {
      paramCount++;
      query += ` AND [SITE DE RETRAIT] LIKE @siteRetrait${paramCount}`;
      params.push({ name: `siteRetrait${paramCount}`, value: `%${siteRetrait}%` });
    }

    if (dateDebut) {
      paramCount++;
      query += ` AND DateImport >= @dateDebut${paramCount}`;
      params.push({ name: `dateDebut${paramCount}`, value: new Date(dateDebut) });
    }

    if (dateFin) {
      paramCount++;
      query += ` AND DateImport <= @dateFin${paramCount}`;
      params.push({ name: `dateFin${paramCount}`, value: new Date(dateFin + ' 23:59:59') });
    }

    // Pagination
    const offset = (actualPage - 1) * actualLimit;
    query += ` ORDER BY ID DESC OFFSET ${offset} ROWS FETCH NEXT ${actualLimit} ROWS ONLY`;

    const request = pool.request();
    params.forEach(param => {
      request.input(param.name, param.value);
    });

    const result = await request.query(query);

    // Compter le total
    let countQuery = 'SELECT COUNT(*) as total FROM Cartes WHERE 1=1';
    const countParams = params;

    const countRequest = pool.request();
    countParams.forEach(param => {
      countRequest.input(param.name, param.value);
    });

    const countResult = await countRequest.query(countQuery);
    const total = countResult.recordset[0].total;

    res.json({
      success: true,
      data: result.recordset,
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
  const transaction = new sql.Transaction(await poolPromise);
  
  try {
    await transaction.begin();
    
    const { donnees, source = 'python_app' } = req.body;
    
    if (!donnees || !Array.isArray(donnees)) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        error: 'Format invalide: données doit être un tableau'
      });
    }

    // Limiter le nombre d'enregistrements par requête
    if (donnees.length > 1000) {
      await transaction.rollback();
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

        // Vérifier les doublons
        const duplicateCheck = await transaction.request()
          .input('nom', sql.NVarChar(255), item.NOM)
          .input('prenoms', sql.NVarChar(255), item.PRENOMS)
          .query('SELECT COUNT(*) as count FROM Cartes WHERE NOM = @nom AND PRENOMS = @prenoms');

        if (duplicateCheck.recordset[0].count > 0) {
          duplicates++;
          continue;
        }

        // Insérer la donnée
        const request = transaction.request();
        const sqlParams = {
          'LIEU_D_ENROLEMENT': [sql.NVarChar(255), item["LIEU D'ENROLEMENT"] || ''],
          'SITE_DE_RETRAIT': [sql.NVarChar(255), item["SITE DE RETRAIT"] || ''],
          'RANGEMENT': [sql.NVarChar(100), item.RANGEMENT || ''],
          'NOM': [sql.NVarChar(255), item.NOM || ''],
          'PRENOMS': [sql.NVarChar(255), item.PRENOMS || ''],
          'DATE_DE_NAISSANCE': [sql.Date, item["DATE DE NAISSANCE"] ? new Date(item["DATE DE NAISSANCE"]) : null],
          'LIEU_NAISSANCE': [sql.NVarChar(255), item["LIEU NAISSANCE"] || ''],
          'CONTACT': [sql.NVarChar(20), item.CONTACT || ''],
          'DELIVRANCE': [sql.NVarChar(255), item.DELIVRANCE || ''],
          'CONTACT_DE_RETRAIT': [sql.NVarChar(255), item["CONTACT DE RETRAIT"] || ''],
          'DATE_DE_DELIVRANCE': [sql.Date, item["DATE DE DELIVRANCE"] ? new Date(item["DATE DE DELIVRANCE"]) : null],
          'SOURCE_IMPORT': [sql.NVarChar(50), source]
        };

        Object.entries(sqlParams).forEach(([key, [type, value]]) => {
          request.input(key, type, value);
        });

        await request.query(`
          INSERT INTO Cartes (
            [LIEU D'ENROLEMENT], [SITE DE RETRAIT], RANGEMENT, NOM, PRENOMS,
            [DATE DE NAISSANCE], [LIEU NAISSANCE], CONTACT, DELIVRANCE,
            [CONTACT DE RETRAIT], [DATE DE DELIVRANCE], SourceImport
          ) VALUES (
            @LIEU_D_ENROLEMENT, @SITE_DE_RETRAIT, @RANGEMENT, @NOM, @PRENOMS,
            @DATE_DE_NAISSANCE, @LIEU_NAISSANCE, @CONTACT, @DELIVRANCE,
            @CONTACT_DE_RETRAIT, @DATE_DE_DELIVRANCE, @SOURCE_IMPORT
          )
        `);

        imported++;

      } catch (error) {
        errors++;
        errorDetails.push(`Enregistrement ${i}: ${error.message}`);
      }
    }

    await transaction.commit();

    // Journaliser la synchronisation
    await journalController.logAction({
      nomUtilisateur: 'API_EXTERNE',
      nomComplet: 'Application Python Collègue',
      role: 'API_CLIENT',
      agence: 'EXTERNE',
      actionType: 'SYNC_API',
      tableName: 'Cartes',
      details: `Synchronisation API - ${imported} importés, ${duplicates} doublons, ${errors} erreurs - Source: ${source}`
    });

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
    await transaction.rollback();
    console.error('❌ Erreur API syncData:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la synchronisation',
      details: error.message
    });
  }
};

// 🔹 STATISTIQUES POUR L'API
exports.getStats = async (req, res) => {
  try {
    const pool = await poolPromise;

    const stats = await pool.request().query(`
      SELECT 
        COUNT(*) as totalCartes,
        COUNT(CASE WHEN DELIVRANCE IS NOT NULL AND DELIVRANCE != '' THEN 1 END) as cartesRetirees,
        COUNT(DISTINCT [SITE DE RETRAIT]) as sitesDistincts,
        MIN(DateImport) as datePremierImport,
        MAX(DateImport) as dateDernierImport
      FROM Cartes
    `);

    const sitesStats = await pool.request().query(`
      SELECT 
        [SITE DE RETRAIT] as site,
        COUNT(*) as total,
        COUNT(CASE WHEN DELIVRANCE IS NOT NULL AND DELIVRANCE != '' THEN 1 END) as retires
      FROM Cartes 
      WHERE [SITE DE RETRAIT] IS NOT NULL 
      GROUP BY [SITE DE RETRAIT]
      ORDER BY total DESC
    `);

    res.json({
      success: true,
      stats: stats.recordset[0],
      sites: sitesStats.recordset,
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
    const pool = await poolPromise;
    
    // Tester la connexion à la base de données
    await pool.request().query('SELECT 1 as test');
    
    // Récupérer quelques métriques
    const countResult = await pool.request().query('SELECT COUNT(*) as total FROM Cartes');
    
    res.json({
      success: true,
      status: 'healthy',
      database: 'connected',
      totalRecords: countResult.recordset[0].total,
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