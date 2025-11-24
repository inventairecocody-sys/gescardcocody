const { poolPromise } = require('../db/db');

const inventaireController = {
  // 🔍 RECHERCHE MULTICRITÈRES AVEC PAGINATION - VERSION CORRIGÉE
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
        ID, -- ⚠️ AJOUT CRITIQUE : L'ID EST NÉCESSAIRE POUR LES MODIFICATIONS
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
        [DATE DE DELIVRANCE]
      FROM cartes WHERE 1=1`;
      
      let countQuery = 'SELECT COUNT(*) as total FROM cartes WHERE 1=1';
      const params = [];
      const countParams = [];

      // 🔤 NOM (recherche partielle)
      if (nom && nom.trim() !== '') {
        query += ' AND NOM LIKE @nom';
        countQuery += ' AND NOM LIKE @nom';
        params.push({ name: 'nom', value: `%${nom.trim()}%` });
        countParams.push({ name: 'nom', value: `%${nom.trim()}%` });
      }

      // 🔤 PRÉNOM (recherche partielle)  
      if (prenom && prenom.trim() !== '') {
        query += ' AND PRENOMS LIKE @prenom';
        countQuery += ' AND PRENOMS LIKE @prenom';
        params.push({ name: 'prenom', value: `%${prenom.trim()}%` });
        countParams.push({ name: 'prenom', value: `%${prenom.trim()}%` });
      }

      // 📞 CONTACT (recherche partielle)
      if (contact && contact.trim() !== '') {
        query += ' AND CONTACT LIKE @contact';
        countQuery += ' AND CONTACT LIKE @contact';
        params.push({ name: 'contact', value: `%${contact.trim()}%` });
        countParams.push({ name: 'contact', value: `%${contact.trim()}%` });
      }

      // 🏢 SITE DE RETRAIT (recherche partielle)
      if (siteRetrait && siteRetrait.trim() !== '') {
        query += ' AND [SITE DE RETRAIT] LIKE @siteRetrait';
        countQuery += ' AND [SITE DE RETRAIT] LIKE @siteRetrait';
        params.push({ name: 'siteRetrait', value: `%${siteRetrait.trim()}%` });
        countParams.push({ name: 'siteRetrait', value: `%${siteRetrait.trim()}%` });
      }

      // 🗺️ LIEU DE NAISSANCE (recherche partielle)
      if (lieuNaissance && lieuNaissance.trim() !== '') {
        query += ' AND [LIEU NAISSANCE] LIKE @lieuNaissance';
        countQuery += ' AND [LIEU NAISSANCE] LIKE @lieuNaissance';
        params.push({ name: 'lieuNaissance', value: `%${lieuNaissance.trim()}%` });
        countParams.push({ name: 'lieuNaissance', value: `%${lieuNaissance.trim()}%` });
      }

      // 🎂 DATE DE NAISSANCE (exacte)
      if (dateNaissance && dateNaissance.trim() !== '') {
        query += ' AND [DATE DE NAISSANCE] = @dateNaissance';
        countQuery += ' AND [DATE DE NAISSANCE] = @dateNaissance';
        params.push({ name: 'dateNaissance', value: dateNaissance.trim() });
        countParams.push({ name: 'dateNaissance', value: dateNaissance.trim() });
      }

      // 📦 RANGEMENT (recherche partielle)
      if (rangement && rangement.trim() !== '') {
        query += ' AND RANGEMENT LIKE @rangement';
        countQuery += ' AND RANGEMENT LIKE @rangement';
        params.push({ name: 'rangement', value: `%${rangement.trim()}%` });
        countParams.push({ name: 'rangement', value: `%${rangement.trim()}%` });
      }

      // ✅ AJOUTER LA PAGINATION - Utiliser une sous-requête pour le tri
      query = `SELECT * FROM (${query}) AS subquery ORDER BY [SITE DE RETRAIT], NOM OFFSET ${offset} ROWS FETCH NEXT ${limitNum} ROWS ONLY`;

      console.log('📋 Requête SQL:', query);
      console.log('🔢 Paramètres:', params);

      // 🗄️ EXÉCUTER LES REQUÊTES
      const pool = await poolPromise;
      
      // Requête pour les données
      const request = pool.request();
      params.forEach(param => {
        request.input(param.name, param.value);
      });
      const result = await request.query(query);

      // Requête pour le total
      const countRequest = pool.request();
      countParams.forEach(param => {
        countRequest.input(param.name, param.value);
      });
      const countResult = await countRequest.query(countQuery);

      const total = countResult.recordset[0].total;
      const totalPages = Math.ceil(total / limitNum);

      console.log(`✅ ${result.recordset.length} cartes trouvées sur ${total} total`);
      
      // Debug: vérifier que les IDs sont présents
      if (result.recordset.length > 0) {
        console.log(`🔍 Premier résultat avec ID: ${result.recordset[0].ID}`);
        console.log(`🔍 Dernier résultat avec ID: ${result.recordset[result.recordset.length - 1].ID}`);
      }

      res.json({
        success: true,
        cartes: result.recordset,
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
  }
};

module.exports = inventaireController;