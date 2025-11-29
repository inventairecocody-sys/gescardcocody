const db = require('../db/db');

// 🔧 CONFIGURATION API EXTERNE
const API_CONFIG = {
  maxResults: 1000,
  defaultLimit: 100,
  maxSyncRecords: 500,
  
  SITES: [
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
  ]
};

// 🔄 FONCTION DE FUSION INTELLIGENTE POUR TOUTES LES COLONNES
exports.mettreAJourCarte = async (client, carteExistante, nouvellesDonnees) => {
  let updated = false;
  const updates = [];
  const params = [];
  let paramCount = 0;

  // ✅ TOUTES LES COLONNES PRINCIPALES À FUSIONNER
  const colonnesAFusionner = {
    // Colonnes texte avec priorité aux valeurs les plus complètes
    'LIEU D\'ENROLEMENT': 'texte',
    'SITE DE RETRAIT': 'texte', 
    'RANGEMENT': 'texte',
    'NOM': 'texte',
    'PRENOMS': 'texte',
    'LIEU NAISSANCE': 'texte',
    'CONTACT': 'contact',
    'CONTACT DE RETRAIT': 'contact',
    'DELIVRANCE': 'delivrance', // Gestion spéciale
    // Colonnes dates avec priorité aux plus récentes
    'DATE DE NAISSANCE': 'date',
    'DATE DE DELIVRANCE': 'date'
  };

  for (const [colonne, type] of Object.entries(colonnesAFusionner)) {
    const valeurExistante = carteExistante[colonne] || '';
    const nouvelleValeur = nouvellesDonnees[colonne]?.toString().trim() || '';

    // 🔄 FUSION INTELLIGENTE PAR TYPE DE COLONNE
    switch (type) {
      
      case 'delivrance':
        // ✅ LOGIQUE SPÉCIALE POUR DELIVRANCE
        const isOuiExistante = valeurExistante.toUpperCase() === 'OUI';
        const isOuiNouvelle = nouvelleValeur.toUpperCase() === 'OUI';
        
        // PRIORITÉ AUX NOMS SUR "OUI"
        if (isOuiExistante && !isOuiNouvelle && nouvelleValeur) {
          // "OUI" → Nom : METTRE À JOUR
          updates.push(`"${colonne}" = $${++paramCount}`);
          params.push(nouvelleValeur);
          updated = true;
          console.log(`  🔄 ${colonne}: "OUI" → "${nouvelleValeur}" (priorité nom)`);
        }
        else if (!isOuiExistante && isOuiNouvelle && valeurExistante) {
          // Nom → "OUI" : GARDER le nom
          console.log(`  ✅ ${colonne}: "${valeurExistante}" gardé vs "OUI"`);
        }
        else if (valeurExistante && nouvelleValeur && valeurExistante !== nouvelleValeur) {
          // Conflit entre deux noms → priorité date récente
          await this.resoudreConflitNom(client, updates, params, colonne, 
            valeurExistante, nouvelleValeur, carteExistante, nouvellesDonnees, updated);
        }
        else if (nouvelleValeur && !valeurExistante) {
          // Vide → Valeur : AJOUTER
          updates.push(`"${colonne}" = $${++paramCount}`);
          params.push(nouvelleValeur);
          updated = true;
          console.log(`  🔄 ${colonne}: "" → "${nouvelleValeur}" (ajout)`);
        }
        break;

      case 'contact':
        // ✅ CONTACTS : Priorité aux numéros les plus complets
        if (this.estContactPlusComplet(nouvelleValeur, valeurExistante)) {
          updates.push(`"${colonne}" = $${++paramCount}`);
          params.push(nouvelleValeur);
          updated = true;
          console.log(`  🔄 ${colonne}: "${valeurExistante}" → "${nouvelleValeur}" (plus complet)`);
        }
        break;

      case 'date':
        // ✅ DATES : Priorité aux dates les plus récentes
        const dateExistante = valeurExistante ? new Date(valeurExistante) : null;
        const nouvelleDate = nouvelleValeur ? new Date(nouvelleValeur) : null;
        
        if (nouvelleDate && this.estDatePlusRecente(nouvelleDate, dateExistante, colonne)) {
          updates.push(`"${colonne}" = $${++paramCount}`);
          params.push(nouvelleDate);
          updated = true;
          console.log(`  🔄 ${colonne}: ${valeurExistante} → ${nouvelleValeur} (plus récente)`);
        }
        break;

      case 'texte':
      default:
        // ✅ TEXTE : Priorité aux valeurs les plus complètes
        if (this.estValeurPlusComplete(nouvelleValeur, valeurExistante, colonne)) {
          updates.push(`"${colonne}" = $${++paramCount}`);
          params.push(nouvelleValeur);
          updated = true;
          console.log(`  🔄 ${colonne}: "${valeurExistante}" → "${nouvelleValeur}" (plus complet)`);
        }
        break;
    }
  }

  // Application des mises à jour
  if (updated && updates.length > 0) {
    updates.push(`dateimport = $${++paramCount}`);
    params.push(new Date());
    params.push(carteExistante.id);

    const updateQuery = `
      UPDATE cartes 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
    `;

    await client.query(updateQuery, params);
    console.log(`✅ Carte ${carteExistante.nom} ${carteExistante.prenoms} mise à jour: ${updates.length - 1} champs`);
  }

  return { updated };
};

// 🔧 FONCTIONS UTILITAIRES POUR LA FUSION INTELLIGENTE

// ✅ Résoudre les conflits entre noms dans DELIVRANCE
exports.resoudreConflitNom = async (client, updates, params, colonne, 
  valeurExistante, nouvelleValeur, carteExistante, nouvellesDonnees, updated) => {
  
  const dateExistante = carteExistante["DATE DE DELIVRANCE"];
  const nouvelleDate = nouvellesDonnees["DATE DE DELIVRANCE"] ? 
    new Date(nouvellesDonnees["DATE DE DELIVRANCE"]) : null;
  
  if (nouvelleDate && (!dateExistante || nouvelleDate > new Date(dateExistante))) {
    updates.push(`"${colonne}" = $${++params.length}`);
    params.push(nouvelleValeur);
    updated = true;
    console.log(`  🔄 ${colonne}: "${valeurExistante}" → "${nouvelleValeur}" (date plus récente)`);
  } else {
    console.log(`  ✅ ${colonne}: "${valeurExistante}" gardé (date plus récente ou égale)`);
  }
};

// ✅ Vérifier si un contact est plus complet
exports.estContactPlusComplet = (nouveauContact, ancienContact) => {
  if (!nouveauContact) return false;
  if (!ancienContact) return true;
  
  // Priorité aux numéros avec indicatif complet
  const hasIndicatifComplet = (contact) => contact.startsWith('+225') || contact.startsWith('00225');
  const isNumerique = (contact) => /^[\d+\s\-()]+$/.test(contact);
  
  // Règles de priorité
  if (hasIndicatifComplet(nouveauContact) && !hasIndicatifComplet(ancienContact)) return true;
  if (isNumerique(nouveauContact) && !isNumerique(ancienContact)) return true;
  if (nouveauContact.length > ancienContact.length) return true;
  
  return false;
};

// ✅ Vérifier si une date est plus récente
exports.estDatePlusRecente = (nouvelleDate, dateExistante, colonne) => {
  if (!dateExistante) return true;
  
  // Pour DATE DE DELIVRANCE, priorité absolue à la plus récente
  if (colonne === 'DATE DE DELIVRANCE') {
    return nouvelleDate > dateExistante;
  }
  
  // Pour DATE DE NAISSANCE, on garde celle qui est renseignée (pas de priorité de récence)
  return false; // On ne change pas la date de naissance existante
};

// ✅ Vérifier si une valeur texte est plus complète
exports.estValeurPlusComplete = (nouvelleValeur, valeurExistante, colonne) => {
  if (!nouvelleValeur) return false;
  if (!valeurExistante) return true;
  
  // Règles spécifiques par colonne
  switch (colonne) {
    case 'NOM':
    case 'PRENOMS':
      // Pour les noms, priorité aux versions avec accents/caractères complets
      const hasAccents = (texte) => /[àâäéèêëîïôöùûüÿçñ]/i.test(texte);
      if (hasAccents(nouvelleValeur) && !hasAccents(valeurExistante)) return true;
      if (nouvelleValeur.length > valeurExistante.length) return true;
      break;
      
    case 'LIEU NAISSANCE':
    case 'LIEU D\'ENROLEMENT':
      // Pour les lieux, priorité aux noms complets
      const motsNouveaux = nouvelleValeur.split(/\s+/).length;
      const motsExistants = valeurExistante.split(/\s+/).length;
      if (motsNouveaux > motsExistants) return true;
      if (nouvelleValeur.length > valeurExistante.length) return true;
      break;
      
    default:
      // Règle générale : priorité aux valeurs plus longues
      if (nouvelleValeur.length > valeurExistante.length) return true;
  }
  
  return false;
};

// 🔹 VÉRIFICATION DE SANTÉ
exports.healthCheck = async (req, res) => {
  try {
    const dbTest = await db.query('SELECT 1 as test, version() as postgres_version, NOW() as server_time');
    
    const statsResult = await db.query(`
      SELECT 
        COUNT(*) as total_cartes,
        COUNT(DISTINCT "SITE DE RETRAIT") as sites_actifs,
        COUNT(DISTINCT nom) as beneficiaires_uniques
      FROM cartes
    `);

    const sitesStats = await db.query(`
      SELECT 
        "SITE DE RETRAIT" as site,
        COUNT(*) as total_cartes
      FROM cartes 
      WHERE "SITE DE RETRAIT" IS NOT NULL 
      GROUP BY "SITE DE RETRAIT"
      ORDER BY total_cartes DESC
    `);

    res.json({
      success: true,
      status: 'healthy',
      database: {
        status: 'connected',
        version: dbTest.rows[0].postgres_version.split(',')[0],
        server_time: dbTest.rows[0].server_time
      },
      statistics: {
        total_cartes: parseInt(statsResult.rows[0].total_cartes),
        sites_actifs: parseInt(statsResult.rows[0].sites_actifs),
        beneficiaires_uniques: parseInt(statsResult.rows[0].beneficiaires_uniques)
      },
      sites_configures: API_CONFIG.SITES,
      sites_statistiques: sitesStats.rows,
      api: {
        version: '3.0.0',
        environment: process.env.NODE_ENV || 'production',
        max_results: API_CONFIG.maxResults,
        rate_limit: '100 req/min',
        features: ['fusion_intelligente', 'gestion_conflits', 'synchronisation_multicolonne']
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erreur API healthCheck:', error);
    res.status(500).json({
      success: false,
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 SYNCHRONISATION AVEC FUSION INTELLIGENTE COMPLÈTE
exports.syncData = async (req, res) => {
  const client = await db.getClient();
  
  try {
    await client.query('BEGIN');
    
    const { donnees, source = 'python_app', batch_id } = req.body;
    
    if (!donnees || !Array.isArray(donnees)) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({
        success: false,
        error: 'Format invalide',
        message: 'Le champ "donnees" doit être un tableau'
      });
    }

    if (donnees.length > API_CONFIG.maxSyncRecords) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(400).json({
        success: false,
        error: 'Trop d\'enregistrements',
        message: `Maximum ${API_CONFIG.maxSyncRecords} enregistrements par requête`
      });
    }

    console.log(`🔄 Synchronisation intelligente: ${donnees.length} enregistrements depuis ${source}`);

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
        const existingCarte = await client.query(
          `SELECT * FROM cartes 
           WHERE nom = $1 AND prenoms = $2 AND "SITE DE RETRAIT" = $3`,
          [nom, prenoms, siteRetrait]
        );

        if (existingCarte.rows.length > 0) {
          // ✅ CARTE EXISTANTE - FUSION INTELLIGENTE MULTI-COLONNES
          const carteExistante = existingCarte.rows[0];
          const resultUpdate = await this.mettreAJourCarte(client, carteExistante, item);
          
          if (resultUpdate.updated) {
            updated++;
            console.log(`🔄 Carte fusionnée: ${nom} ${prenoms} (${siteRetrait})`);
          } else {
            duplicates++;
            console.log(`⚠️ Carte identique: ${nom} ${prenoms} (${siteRetrait})`);
          }
          
        } else {
          // ✅ NOUVELLE CARTE - INSÉRER
          const insertData = {
            "LIEU D'ENROLEMENT": item["LIEU D'ENROLEMENT"]?.toString().trim() || '',
            "SITE DE RETRAIT": siteRetrait,
            "RANGEMENT": item["RANGEMENT"]?.toString().trim() || '',
            "NOM": nom,
            "PRENOMS": prenoms,
            "DATE DE NAISSANCE": item["DATE DE NAISSANCE"] ? new Date(item["DATE DE NAISSANCE"]) : null,
            "LIEU NAISSANCE": item["LIEU NAISSANCE"]?.toString().trim() || '',
            "CONTACT": item["CONTACT"]?.toString().trim() || '',
            "DELIVRANCE": item["DELIVRANCE"]?.toString().trim() || '',
            "CONTACT DE RETRAIT": item["CONTACT DE RETRAIT"]?.toString().trim() || '',
            "DATE DE DELIVRANCE": item["DATE DE DELIVRANCE"] ? new Date(item["DATE DE DELIVRANCE"]) : null,
            "sourceimport": source,
            "batch_id": batch_id || null
          };

          await client.query(`
            INSERT INTO cartes (
              "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, nom, prenoms,
              "DATE DE NAISSANCE", "LIEU NAISSANCE", contact, delivrance,
              "CONTACT DE RETRAIT", "DATE DE DELIVRANCE", sourceimport, batch_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          `, Object.values(insertData));

          imported++;
          console.log(`✅ Nouvelle carte: ${nom} ${prenoms} (${siteRetrait})`);
        }

      } catch (error) {
        errors++;
        errorDetails.push(`Enregistrement ${i}: ${error.message}`);
        console.error(`❌ Erreur enregistrement ${i}:`, error.message);
      }
    }

    await client.query('COMMIT');
    client.release();

    console.log(`✅ Sync UP réussie: ${imported} nouvelles, ${updated} mises à jour, ${duplicates} identiques, ${errors} erreurs`);

    res.json({
      success: true,
      message: 'Synchronisation avec fusion intelligente réussie',
      stats: {
        imported,
        updated, 
        duplicates,
        errors,
        totalProcessed: donnees.length,
        successRate: donnees.length > 0 ? Math.round(((imported + updated) / donnees.length) * 100) : 0
      },
      fusion: {
        strategy: "intelligente_multicolonnes",
        rules: [
          "DELIVRANCE: noms prioritaires sur 'OUI' + dates récentes",
          "CONTACTS: numéros complets avec indicatif prioritaire",
          "NOMS/PRENOMS: versions avec accents et caractères complets", 
          "LIEUX: noms géographiques complets",
          "DATES: plus récentes pour délivrance, conservation pour naissance",
          "TEXTES: valeurs les plus longues et complètes"
        ],
        colonnes_traitees: Object.keys(this.getColonnesAFusionner())
      },
      batch_info: {
        batch_id: batch_id || 'N/A',
        source: source,
        timestamp: new Date().toISOString()
      },
      errorDetails: errorDetails.slice(0, 10)
    });

  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    console.error('❌ Erreur syncData avec fusion intelligente:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la synchronisation avec fusion intelligente',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 FONCTION POUR OBTENIR LA CONFIGURATION DES COLONNES
exports.getColonnesAFusionner = () => {
  return {
    'LIEU D\'ENROLEMENT': 'texte',
    'SITE DE RETRAIT': 'texte', 
    'RANGEMENT': 'texte',
    'NOM': 'texte',
    'PRENOMS': 'texte',
    'LIEU NAISSANCE': 'texte',
    'CONTACT': 'contact',
    'CONTACT DE RETRAIT': 'contact',
    'DELIVRANCE': 'delivrance',
    'DATE DE NAISSANCE': 'date',
    'DATE DE DELIVRANCE': 'date'
  };
};

// 🔹 RÉCUPÉRER LES CARTES AVEC FILTRES
exports.getCartes = async (req, res) => {
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
      limit = API_CONFIG.defaultLimit
    } = req.query;

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

    if (lieuNaissance) {
      paramCount++;
      query += ` AND "LIEU NAISSANCE" ILIKE $${paramCount}`;
      params.push(`%${lieuNaissance}%`);
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

    if (delivrance) {
      paramCount++;
      query += ` AND delivrance ILIKE $${paramCount}`;
      params.push(`%${delivrance}%`);
    }

    // Pagination
    query += ` ORDER BY id DESC LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
    params.push(actualLimit, offset);

    const result = await db.query(query, params);

    // Compter le total
    let countQuery = 'SELECT COUNT(*) as total FROM cartes WHERE 1=1';
    const countParams = [];

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
    // ... autres filtres

    const countResult = await db.query(countQuery, countParams);
    const total = parseInt(countResult.rows[0].total);

    res.json({
      success: true,
      data: result.rows,
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
    console.error('❌ Erreur API getCartes:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des cartes',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔹 STATISTIQUES DÉTAILLÉES
exports.getStats = async (req, res) => {
  try {
    const globalStats = await db.query(`
      SELECT 
        COUNT(*) as total_cartes,
        COUNT(CASE WHEN delivrance IS NOT NULL AND delivrance != '' THEN 1 END) as cartes_retirees,
        COUNT(DISTINCT "SITE DE RETRAIT") as sites_actifs,
        COUNT(DISTINCT nom) as beneficiaires_uniques,
        MIN(dateimport) as premiere_importation,
        MAX(dateimport) as derniere_importation
      FROM cartes
    `);

    const topSites = await db.query(`
      SELECT 
        "SITE DE RETRAIT" as site,
        COUNT(*) as total_cartes,
        COUNT(CASE WHEN delivrance IS NOT NULL AND delivrance != '' THEN 1 END) as cartes_retirees
      FROM cartes 
      WHERE "SITE DE RETRAIT" IS NOT NULL AND "SITE DE RETRAIT" != ''
      GROUP BY "SITE DE RETRAIT"
      ORDER BY total_cartes DESC
      LIMIT 10
    `);

    res.json({
      success: true,
      data: {
        global: globalStats.rows[0],
        top_sites: topSites.rows,
        sites_configures: API_CONFIG.SITES
      },
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Erreur API getStats:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur lors de la récupération des statistiques',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
};

// 🔄 AUTRES FONCTIONS
exports.getModifications = async (req, res) => {
  try {
    const { site, derniereSync, limit = 1000 } = req.query;

    if (!site || !derniereSync) {
      return res.status(400).json({
        success: false,
        error: 'Paramètres manquants: site et derniereSync requis'
      });
    }

    if (!API_CONFIG.SITES.includes(site)) {
      return res.status(400).json({
        success: false,
        error: 'Site non reconnu',
        message: `Sites valides: ${API_CONFIG.SITES.join(', ')}`
      });
    }

    let query = `
      SELECT * FROM cartes 
      WHERE "SITE DE RETRAIT" = $1 
      AND dateimport > $2
      ORDER BY dateimport ASC
      LIMIT $3
    `;

    const result = await db.query(query, [site, new Date(derniereSync), limit]);

    let derniereModification = derniereSync;
    if (result.rows.length > 0) {
      derniereModification = result.rows[result.rows.length - 1].dateimport;
    }

    res.json({
      success: true,
      data: result.rows,
      total: result.rows.length,
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

exports.getSites = async (req, res) => {
  try {
    res.json({
      success: true,
      sites: API_CONFIG.SITES,
      total_sites: API_CONFIG.SITES.length,
      description: "10 sites avec synchronisation intelligente multi-colonnes",
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Erreur getSites:', error);
    res.status(500).json({
      success: false,
      error: 'Erreur serveur',
      details: error.message
    });
  }
};

exports.API_CONFIG = API_CONFIG;