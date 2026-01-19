const db = require('../db/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const csv = require('csv-parser');
const journalController = require('./journalController');

class BulkImportController {
  constructor() {
    this.activeImports = new Map();
    this.isRenderFreeTier = process.env.NODE_ENV === 'production';
    console.log('🚀 BulkImportController initialisé (Render gratuit: ' + this.isRenderFreeTier + ')');
  }

  // ============================================
  // DÉMARRER IMPORT MASSIF
  // ============================================
  async startBulkImport(req, res) {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier uploadé'
      });
    }

    const importId = uuidv4();
    const filePath = req.file.path;
    const originalName = req.file.originalname;
    
    console.log(`🚀 Démarrage import massif: ${originalName} (ID: ${importId})`);
    
    // Initialiser l'état de l'import
    const importState = {
      id: importId,
      filename: originalName,
      status: 'processing',
      progress: 0,
      totalRows: 0,
      importedRows: 0,
      errors: 0,
      startTime: new Date(),
      endTime: null,
      userId: req.user.id,
      fileType: path.extname(originalName).toLowerCase()
    };
    
    this.activeImports.set(importId, importState);
    
    // Répondre immédiatement avec l'ID d'import
    res.json({
      success: true,
      message: 'Import massif démarré',
      importId,
      statusUrl: `/api/import-export/bulk-import/status/${importId}`
    });
    
    // Traiter l'import en arrière-plan
    this.processBulkImport(importId, filePath, req.user.id).catch(error => {
      console.error(`❌ Erreur import massif ${importId}:`, error);
      
      const state = this.activeImports.get(importId);
      if (state) {
        state.status = 'failed';
        state.error = error.message;
        state.endTime = new Date();
      }
    });
  }

  // ============================================
  // TRAITEMENT IMPORT MASSIF EN ARRIÈRE-PLAN
  // ============================================
  async processBulkImport(importId, filePath, userId) {
    const state = this.activeImports.get(importId);
    if (!state) return;
    
    try {
      console.log(`📊 Traitement import massif ${importId}...`);
      
      // Déterminer le type de fichier
      const isCSV = state.fileType === '.csv';
      
      let rows = [];
      
      if (isCSV) {
        // Parser CSV
        const result = await this.parseCSVFile(filePath);
        rows = result.data;
        state.totalRows = result.total;
      } else {
        // Parser Excel
        rows = await this.parseExcelFile(filePath);
        state.totalRows = rows.length;
      }
      
      console.log(`📊 ${state.totalRows} lignes à importer pour ${importId}`);
      
      // Traiter par lots
      const batchSize = this.isRenderFreeTier ? 500 : 1000;
      let imported = 0;
      let errors = 0;
      
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        const batchResult = await this.processBatch(batch, userId, importId);
        
        imported += batchResult.imported;
        errors += batchResult.errors;
        
        // Mettre à jour la progression
        state.importedRows = imported;
        state.errors = errors;
        state.progress = Math.round((i + batch.length) / rows.length * 100);
        
        console.log(`📈 Import ${importId}: ${state.progress}% (${imported}/${state.totalRows})`);
        
        // Pause pour Render gratuit
        if (this.isRenderFreeTier && i % 2000 === 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      // Finaliser
      state.status = 'completed';
      state.progress = 100;
      state.endTime = new Date();
      
      await journalController.logAction({
        utilisateurId: userId,
        actionType: 'FIN_IMPORT_MASSIF',
        tableName: 'Cartes',
        importBatchID: importId,
        details: `Import massif terminé: ${imported} importées, ${errors} erreurs`
      });
      
      console.log(`✅ Import massif ${importId} terminé: ${imported} importées, ${errors} erreurs`);
      
    } catch (error) {
      console.error(`❌ Erreur traitement import massif ${importId}:`, error);
      
      state.status = 'failed';
      state.error = error.message;
      state.endTime = new Date();
      
      await journalController.logAction({
        utilisateurId: userId,
        actionType: 'ERREUR_IMPORT_MASSIF',
        tableName: 'Cartes',
        importBatchID: importId,
        details: `Erreur import massif: ${error.message}`
      });
    } finally {
      // Nettoyer le fichier
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Fichier import massif ${importId} nettoyé`);
        }
      } catch (cleanupError) {
        console.warn(`⚠️ Erreur nettoyage fichier ${importId}:`, cleanupError.message);
      }
    }
  }

  // ============================================
  // PARSER FICHIER CSV
  // ============================================
  async parseCSVFile(filePath) {
    return new Promise((resolve, reject) => {
      const results = [];
      let lineCount = 0;
      
      fs.createReadStream(filePath)
        .pipe(csv({
          separator: ',',
          mapHeaders: ({ header }) => header.trim().toUpperCase(),
          mapValues: ({ value }) => value ? value.toString().trim() : ''
        }))
        .on('data', (data) => {
          results.push(data);
          lineCount++;
          
          if (lineCount % 5000 === 0) {
            console.log(`📊 CSV parsing: ${lineCount} lignes lues`);
          }
        })
        .on('end', () => {
          console.log(`✅ CSV parsing complet: ${lineCount} lignes`);
          resolve({ data: results, total: lineCount });
        })
        .on('error', reject);
    });
  }

  // ============================================
  // PARSER FICHIER EXCEL
  // ============================================
  async parseExcelFile(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.getWorksheet(1);
    
    if (!worksheet) {
      throw new Error('Aucune feuille trouvée dans le fichier Excel');
    }
    
    const rows = [];
    const headers = [
      "LIEU D'ENROLEMENT",
      "SITE DE RETRAIT", 
      "RANGEMENT",
      "NOM",
      "PRENOMS",
      "DATE DE NAISSANCE",
      "LIEU NAISSANCE",
      "CONTACT",
      "DELIVRANCE",
      "CONTACT DE RETRAIT",
      "DATE DE DELIVRANCE"
    ];
    
    // Lire les lignes (en supposant que la première ligne contient les en-têtes)
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const rowData = {};
      
      row.eachCell((cell, colNumber) => {
        if (colNumber <= headers.length) {
          const header = headers[colNumber - 1];
          rowData[header] = cell.value?.toString().trim() || '';
        }
      });
      
      if (rowData.NOM || rowData.PRENOMS) {
        rows.push(rowData);
      }
      
      if (rowNumber % 1000 === 0) {
        console.log(`📊 Excel parsing: ${rowNumber} lignes lues`);
      }
    }
    
    console.log(`✅ Excel parsing complet: ${rows.length} lignes valides`);
    return rows;
  }

  // ============================================
  // TRAITER UN LOT DE DONNÉES
  // ============================================
  async processBatch(batch, userId, importBatchID) {
    const result = {
      imported: 0,
      errors: 0
    };
    
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const queries = [];
      const values = [];
      
      for (let i = 0; i < batch.length; i++) {
        const data = batch[i];
        
        try {
          // Validation basique
          if (!data.NOM || !data.PRENOMS) {
            result.errors++;
            continue;
          }
          
          // Préparer insertion
          const paramIndex = queries.length * 11 + 1;
          
          queries.push(`(
            $${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, 
            $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5},
            $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8},
            $${paramIndex + 9}, $${paramIndex + 10}
          )`);
          
          // Nettoyer et formater les données
          const formatDate = (value) => {
            if (!value) return null;
            try {
              const date = new Date(value);
              if (isNaN(date.getTime())) return null;
              
              const year = date.getFullYear();
              const month = String(date.getMonth() + 1).padStart(2, '0');
              const day = String(date.getDate()).padStart(2, '0');
              return `${year}-${month}-${day}`;
            } catch {
              return null;
            }
          };
          
          const formatPhone = (value) => {
            if (!value) return '';
            const digits = value.toString().replace(/\D/g, '');
            return digits.substring(0, 8);
          };
          
          values.push(
            data["LIEU D'ENROLEMENT"] || '',
            data["SITE DE RETRAIT"] || '',
            data["RANGEMENT"] || '',
            data["NOM"] || '',
            data["PRENOMS"] || '',
            formatDate(data["DATE DE NAISSANCE"]),
            data["LIEU NAISSANCE"] || '',
            formatPhone(data["CONTACT"] || ''),
            data["DELIVRANCE"] || '',
            formatPhone(data["CONTACT DE RETRAIT"] || ''),
            formatDate(data["DATE DE DELIVRANCE"])
          );
          
          result.imported++;
          
        } catch (error) {
          result.errors++;
          console.warn(`⚠️ Erreur traitement ligne ${i + 1}:`, error.message);
        }
      }
      
      // Exécuter l'insertion batch si nécessaire
      if (queries.length > 0) {
        const query = `
          INSERT INTO cartes (
            "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, nom, prenoms,
            "DATE DE NAISSANCE", "LIEU NAISSANCE", contact, delivrance,
            "CONTACT DE RETRAIT", "DATE DE DELIVRANCE", importbatchid
          ) VALUES ${queries.join(', ')}
        `;
        
        await client.query(query, [...values, importBatchID]);
      }
      
      await client.query('COMMIT');
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('❌ Erreur traitement batch:', error);
      throw error;
    } finally {
      if (client?.release) client.release();
    }
    
    return result;
  }

  // ============================================
  // OBTENIR LE STATUT D'UN IMPORT MASSIF
  // ============================================
  async getImportStatus(req, res) {
    const { importId } = req.params;
    
    const state = this.activeImports.get(importId);
    
    if (!state) {
      return res.status(404).json({
        success: false,
        error: 'Import non trouvé'
      });
    }
    
    // Calculer la durée
    const duration = state.endTime 
      ? (state.endTime - state.startTime) / 1000 
      : (new Date() - state.startTime) / 1000;
    
    res.json({
      success: true,
      importId,
      status: state.status,
      progress: state.progress,
      stats: {
        totalRows: state.totalRows,
        importedRows: state.importedRows,
        errors: state.errors,
        filename: state.filename,
        startTime: state.startTime,
        endTime: state.endTime,
        duration: `${Math.round(duration)}s`
      },
      error: state.error
    });
  }

  // ============================================
  // ANNULER UN IMPORT MASSIF
  // ============================================
  async cancelImport(req, res) {
    const { importId } = req.params;
    
    const state = this.activeImports.get(importId);
    
    if (!state) {
      return res.status(404).json({
        success: false,
        error: 'Import non trouvé'
      });
    }
    
    if (state.status === 'completed' || state.status === 'failed') {
      return res.status(400).json({
        success: false,
        error: 'Import déjà terminé ou échoué'
      });
    }
    
    // Marquer comme annulé
    state.status = 'cancelled';
    state.endTime = new Date();
    
    await journalController.logAction({
      utilisateurId: req.user.id,
      actionType: 'ANNULATION_IMPORT_MASSIF',
      tableName: 'Cartes',
      importBatchID: importId,
      details: 'Import massif annulé par l\'utilisateur'
    });
    
    res.json({
      success: true,
      message: 'Import annulé avec succès',
      importId
    });
  }

  // ============================================
  // LISTER LES IMPORTS ACTIFS/RÉCENTS
  // ============================================
  async listActiveImports(req, res) {
    const imports = Array.from(this.activeImports.values())
      .sort((a, b) => b.startTime - a.startTime)
      .slice(0, 20) // Limiter à 20 derniers imports
      .map(state => ({
        id: state.id,
        filename: state.filename,
        status: state.status,
        progress: state.progress,
        totalRows: state.totalRows,
        importedRows: state.importedRows,
        errors: state.errors,
        startTime: state.startTime,
        endTime: state.endTime,
        fileType: state.fileType
      }));
    
    res.json({
      success: true,
      imports,
      total: imports.length
    });
  }

  // ============================================
  // OBTENIR LES STATISTIQUES DES IMPORTS MASSIFS
  // ============================================
  async getImportStats(req, res) {
    try {
      // Récupérer les statistiques depuis la base de données
      const result = await db.query(`
        SELECT 
          COUNT(DISTINCT importbatchid) as total_imports,
          COUNT(*) as total_cards_imported,
          MIN(created_at) as first_import_date,
          MAX(created_at) as last_import_date
        FROM cartes
        WHERE importbatchid IS NOT NULL
      `);
      
      // Compter les imports par statut
      const activeImports = Array.from(this.activeImports.values());
      const stats = {
        totalImports: parseInt(result.rows[0].total_imports || 0),
        totalCardsImported: parseInt(result.rows[0].total_cards_imported || 0),
        firstImportDate: result.rows[0].first_import_date,
        lastImportDate: result.rows[0].last_import_date,
        activeImports: activeImports.filter(i => i.status === 'processing').length,
        completedImports: activeImports.filter(i => i.status === 'completed').length,
        failedImports: activeImports.filter(i => i.status === 'failed').length,
        cancelledImports: activeImports.filter(i => i.status === 'cancelled').length
      };
      
      res.json({
        success: true,
        stats
      });
      
    } catch (error) {
      console.error('❌ Erreur récupération stats imports massifs:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur récupération statistiques'
      });
    }
  }
}

// Singleton
const bulkImportController = new BulkImportController();

module.exports = {
  startBulkImport: bulkImportController.startBulkImport.bind(bulkImportController),
  getImportStatus: bulkImportController.getImportStatus.bind(bulkImportController),
  cancelImport: bulkImportController.cancelImport.bind(bulkImportController),
  listActiveImports: bulkImportController.listActiveImports.bind(bulkImportController),
  getImportStats: bulkImportController.getImportStats.bind(bulkImportController)
};