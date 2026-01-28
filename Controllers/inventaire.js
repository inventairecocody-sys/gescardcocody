const db = require('../db/db');

const inventaireController = {
  // 🔍 RECHERCHE MULTICRITÈRES AVEC PAGINATION - VERSION POSTGRESQL
  rechercheCartes: async (req, res) => {
    try {
      const {
        nom,
        prenom, 
        contact,
        siteRetrait,
        lieuNaissance, 
        dateNaissance,
        rangement,
        page = 1,
        limit = 50
      } = req.query;

      console.log('📦 Critères reçus:', req.query);

      // ✅ CALCUL PAGINATION
      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const offset = (pageNum - 1) * limitNum;

      // ✅ CONSTRUIRE LA REQUÊTE AVEC ID (ESSENTIEL POUR LES MODIFICATIONS)
      let query = `SELECT 
        id, -- ⚠️ AJOUT CRITIQUE : L'ID EST NÉCESSAIRE POUR LES MODIFICATIONS
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
        "DATE DE DELIVRANCE"
      FROM cartes WHERE 1=1`;
      
      let countQuery = 'SELECT COUNT(*) as total FROM cartes WHERE 1=1';
      const params = [];
      const countParams = [];
      let paramCount = 0;

      // 🔤 NOM (recherche partielle)
      if (nom && nom.trim() !== '') {
        paramCount++;
        query += ` AND nom ILIKE $${paramCount}`;
        countQuery += ` AND nom ILIKE $${paramCount}`;
        params.push(`%${nom.trim()}%`);
        countParams.push(`%${nom.trim()}%`);
      }

      // 🔤 PRÉNOM (recherche partielle)  
      if (prenom && prenom.trim() !== '') {
        paramCount++;
        query += ` AND prenoms ILIKE $${paramCount}`;
        countQuery += ` AND prenoms ILIKE $${paramCount}`;
        params.push(`%${prenom.trim()}%`);
        countParams.push(`%${prenom.trim()}%`);
      }

      // 📞 CONTACT (recherche partielle)
      if (contact && contact.trim() !== '') {
        paramCount++;
        query += ` AND contact ILIKE $${paramCount}`;
        countQuery += ` AND contact ILIKE $${paramCount}`;
        params.push(`%${contact.trim()}%`);
        countParams.push(`%${contact.trim()}%`);
      }

      // 🏢 SITE DE RETRAIT (recherche partielle)
      if (siteRetrait && siteRetrait.trim() !== '') {
        paramCount++;
        query += ` AND "SITE DE RETRAIT" ILIKE $${paramCount}`;
        countQuery += ` AND "SITE DE RETRAIT" ILIKE $${paramCount}`;
        params.push(`%${siteRetrait.trim()}%`);
        countParams.push(`%${siteRetrait.trim()}%`);
      }

      // 🗺️ LIEU DE NAISSANCE (recherche partielle)
      if (lieuNaissance && lieuNaissance.trim() !== '') {
        paramCount++;
        query += ` AND "LIEU NAISSANCE" ILIKE $${paramCount}`;
        countQuery += ` AND "LIEU NAISSANCE" ILIKE $${paramCount}`;
        params.push(`%${lieuNaissance.trim()}%`);
        countParams.push(`%${lieuNaissance.trim()}%`);
      }

      // 🎂 DATE DE NAISSANCE (exacte)
      if (dateNaissance && dateNaissance.trim() !== '') {
        paramCount++;
        query += ` AND "DATE DE NAISSANCE" = $${paramCount}`;
        countQuery += ` AND "DATE DE NAISSANCE" = $${paramCount}`;
        params.push(dateNaissance.trim());
        countParams.push(dateNaissance.trim());
      }

      // 📦 RANGEMENT (recherche partielle)
      if (rangement && rangement.trim() !== '') {
        paramCount++;
        query += ` AND rangement ILIKE $${paramCount}`;
        countQuery += ` AND rangement ILIKE $${paramCount}`;
        params.push(`%${rangement.trim()}%`);
        countParams.push(`%${rangement.trim()}%`);
      }

      // ✅ AJOUTER LA PAGINATION - PostgreSQL
      query += ` ORDER BY "SITE DE RETRAIT", nom LIMIT $${paramCount + 1} OFFSET $${paramCount + 2}`;
      params.push(limitNum, offset);

      console.log('📋 Requête SQL:', query);
      console.log('🔢 Paramètres:', params);

      // 🗄️ EXÉCUTER LES REQUÊTES
      
      // Requête pour les données
      const result = await db.query(query, params);

      // Requête pour le total (sans pagination)
      const countResult = await db.query(countQuery, countParams);

      const total = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(total / limitNum);

      console.log(`✅ ${result.rows.length} cartes trouvées sur ${total} total`);
      
      // Debug: vérifier que les IDs sont présents
      if (result.rows.length > 0) {
        console.log(`🔍 Premier résultat avec ID: ${result.rows[0].id}`);
        console.log(`🔍 Dernier résultat avec ID: ${result.rows[result.rows.length - 1].id}`);
      }

      res.json({
        success: true,
        cartes: result.rows,
        total: total,
        page: pageNum,
        totalPages: totalPages,
        limit: limitNum
      });

    } catch (error) {
      console.error('❌ Erreur recherche:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la recherche dans la base de données',
        details: error.message
      });
    }
  },

  // 📊 STATISTIQUES D'INVENTAIRE
  getStatistiques: async (req, res) => {
    try {
      // Total des cartes
      const totalResult = await db.query('SELECT COUNT(*) as total FROM cartes');
      
      // Cartes retirées
      const retiresResult = await db.query(`
        SELECT COUNT(*) as retires FROM cartes 
        WHERE delivrance IS NOT NULL AND delivrance != ''
      `);
      
      // Statistiques par site
      const sitesResult = await db.query(`
        SELECT 
          "SITE DE RETRAIT" as site,
          COUNT(*) as total,
          COUNT(CASE WHEN delivrance IS NOT NULL AND delivrance != '' THEN 1 END) as retires
        FROM cartes 
        WHERE "SITE DE RETRAIT" IS NOT NULL AND "SITE DE RETRAIT" != ''
        GROUP BY "SITE DE RETRAIT"
        ORDER BY total DESC
      `);
      
      // Dernières cartes ajoutées
      const recentesResult = await db.query(`
        SELECT 
          id, nom, prenoms, "SITE DE RETRAIT" as site, dateimport
        FROM cartes 
        ORDER BY dateimport DESC 
        LIMIT 10
      `);

      const total = parseInt(totalResult.rows[0].total);
      const retires = parseInt(retiresResult.rows[0].retires);
      const disponibles = total - retires;

      res.json({
        success: true,
        statistiques: {
          total: total,
          retires: retires,
          disponibles: disponibles,
          tauxRetrait: total > 0 ? Math.round((retires / total) * 100) : 0
        },
        parSite: sitesResult.rows,
        recentes: recentesResult.rows
      });

    } catch (error) {
      console.error('❌ Erreur statistiques:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors du calcul des statistiques',
        details: error.message
      });
    }
  },

  // 🔍 RECHERCHE RAPIDE (pour la barre de recherche globale)
  rechercheRapide: async (req, res) => {
    try {
      const { q, limit = 20 } = req.query;

      if (!q || q.trim() === '') {
        return res.json({
          success: true,
          resultats: [],
          total: 0
        });
      }

      const searchTerm = `%${q.trim()}%`;
      const limitNum = parseInt(limit);

      const result = await db.query(`
        SELECT 
          id,
          nom,
          prenoms,
          "SITE DE RETRAIT" as site,
          contact,
          delivrance
        FROM cartes 
        WHERE 
          nom ILIKE $1 OR
          prenoms ILIKE $1 OR
          contact ILIKE $1 OR
          "SITE DE RETRAIT" ILIKE $1 OR
          "LIEU NAISSANCE" ILIKE $1
        ORDER BY 
          CASE 
            WHEN nom ILIKE $1 THEN 1
            WHEN prenoms ILIKE $1 THEN 2
            ELSE 3
          END,
          nom
        LIMIT $2
      `, [searchTerm, limitNum]);

      res.json({
        success: true,
        resultats: result.rows,
        total: result.rows.length
      });

    } catch (error) {
      console.error('❌ Erreur recherche rapide:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la recherche rapide',
        details: error.message
      });
    }
  },

  // 📋 LISTE DES SITES DISTINCTS
  getSites: async (req, res) => {
    try {
      const result = await db.query(`
        SELECT DISTINCT "SITE DE RETRAIT" as site
        FROM cartes 
        WHERE "SITE DE RETRAIT" IS NOT NULL AND "SITE DE RETRAIT" != ''
        ORDER BY "SITE DE RETRAIT"
      `);

      const sites = result.rows.map(row => row.site);

      res.json({
        success: true,
        sites: sites
      });

    } catch (error) {
      console.error('❌ Erreur récupération sites:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des sites',
        details: error.message
      });
    }
  },

  // 🎯 CARTES PAR SITE
  getCartesParSite: async (req, res) => {
    try {
      const { site, page = 1, limit = 50 } = req.query;

      if (!site) {
        return res.status(400).json({
          success: false,
          error: 'Le paramètre site est obligatoire'
        });
      }

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const offset = (pageNum - 1) * limitNum;

      // Requête des données
      const result = await db.query(`
        SELECT 
          id,
          "LIEU D'ENROLEMENT",
          rangement,
          nom,
          prenoms,
          "DATE DE NAISSANCE",
          "LIEU NAISSANCE",
          contact,
          delivrance,
          "CONTACT DE RETRAIT",
          "DATE DE DELIVRANCE"
        FROM cartes 
        WHERE "SITE DE RETRAIT" = $1
        ORDER BY nom, prenoms
        LIMIT $2 OFFSET $3
      `, [site, limitNum, offset]);

      // Requête du total
      const countResult = await db.query(`
        SELECT COUNT(*) as total 
        FROM cartes 
        WHERE "SITE DE RETRAIT" = $1
      `, [site]);

      const total = parseInt(countResult.rows[0].total);
      const totalPages = Math.ceil(total / limitNum);

      res.json({
        success: true,
        cartes: result.rows,
        total: total,
        page: pageNum,
        totalPages: totalPages,
        limit: limitNum,
        site: site
      });

    } catch (error) {
      console.error('❌ Erreur cartes par site:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des cartes par site',
        details: error.message
      });
    }
  }
};

module.exports = inventaireController;