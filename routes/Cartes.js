const express = require("express");
const router = express.Router();
const { poolPromise, sql } = require("../db/db");
const { verifyToken } = require("../middleware/auth");
const cartesController = require("../Controllers/cartesController");

// ✅ Middleware d’authentification sur toutes les routes
router.use(verifyToken);

// ✅ ROUTES GET
router.get("/", cartesController.getAllCartes);
router.get("/all", cartesController.getAllCartes);
router.get("/statistiques/total", cartesController.getStatistiques);
router.get("/:id", cartesController.getCarteById);

// ✅ ROUTE PUT BATCH - avant /:id pour éviter les conflits
router.put("/batch", async (req, res) => {
  try {
    const { cartes, role } = req.body;

    if (!Array.isArray(cartes) || cartes.length === 0) {
      return res.status(400).json({ success: false, error: "Aucune carte reçue" });
    }

    if (!role) {
      return res.status(403).json({ success: false, error: "Rôle manquant" });
    }

    // Normalisation du rôle
    const roleNormalise = (role || "").toLowerCase().trim();
    if (roleNormalise === "operateur" || roleNormalise === "opérateur") {
      return res.status(403).json({
        success: false,
        error: "Opérateurs non autorisés à modifier les cartes",
      });
    }

    const pool = await poolPromise;
    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      let cartesModifiees = 0;

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
              [DATE DE DELIVRANCE] = @dateDelivrance
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
        request.input("id", sql.Int, idNumerique);

        const result = await request.query(query);

        if (result.rowsAffected[0] > 0) {
          cartesModifiees++;
          await ajouterAuJournal(
            role,
            `Modification carte ID ${idNumerique}: ${carte.NOM} ${carte.PRENOMS}`,
            transaction
          );
        }
      }

      await transaction.commit();

      console.log("✅ Mise à jour terminée:", {
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
        },
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
    });
  }
});

// ✅ AUTRES ROUTES CRUD
router.post("/", cartesController.createCarte);
router.put("/:id", cartesController.updateCarte);
router.delete("/:id", cartesController.deleteCarte);

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
  } catch (error) {
    console.error("❌ Erreur journalisation:", error);
  }
};

module.exports = router;