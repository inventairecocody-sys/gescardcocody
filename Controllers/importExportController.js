const db = require('../db/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const csv = require('csv-parser');
const journalController = require('./journalController');

// ============================================
// CONFIGURATION GLOBALE OPTIMISÉE POUR RENDER GRATUIT
// ============================================
const CONFIG = {
  // Formats supportés
  supportedFormats: ['.csv', '.xlsx', '.xls'],
  csvDelimiter: ',',
  
  // Colonnes standard
  csvHeaders: [
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
  ],
  
  // Contrôles
  requiredHeaders: ['NOM', 'PRENOMS'],
  isRenderFreeTier: process.env.NODE_ENV === 'production',
  
  // ✅ LIMITES OPTIMISÉES POUR RENDER GRATUIT
  maxExportRows: 5000, // Réduit de 10000 à 5000 pour éviter les timeouts
  maxImportRows: 10000,
  
  // ✅ TIMEOUTS OPTIMISÉS
  exportTimeout: 90000, // 90 secondes (Render gratuit a des limites)
  chunkSize: 1000, // Taille des chunks pour le streaming
  memoryLimitMB: 100 // Limite mémoire
};

// ============================================
// CONTROLEUR PRINCIPAL OPTIMISÉ
// ============================================
class OptimizedImportExportController {
  constructor() {
    this.activeExports = new Map();
    console.log('🚀 Contrôleur Import/Export optimisé pour Render gratuit');
  }
  
  // ============================================
  // EXPORT EXCEL OPTIMISÉ (CORRIGÉ)
  // ============================================
  async exportExcel(req, res) {
    const exportId = `excel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    console.log(`📤 Export Excel demandé (ID: ${exportId})`);
    
    // Vérifier les paramètres de test
    const isTest = req.query.test === 'true' || req.query.limit === '5';
    const limit = isTest ? 5 : CONFIG.maxExportRows;
    
    let client;
    
    try {
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_EXCEL',
        tableName: 'Cartes',
        details: `Export Excel démarré ${isTest ? '(TEST)' : ''}`
      });
      
      client = await db.getClient();
      
      // ✅ Récupérer le COUNT d'abord pour estimer la taille
      const countResult = await client.query('SELECT COUNT(*) as total FROM cartes');
      const totalRows = parseInt(countResult.rows[0].total);
      
      console.log(`📊 ${totalRows} cartes au total, limité à ${limit} pour l'export`);
      
      // ✅ VÉRIFICATION DE LA TAILLE
      if (totalRows > 10000 && !isTest) {
        console.warn(`⚠️ Gros export détecté: ${totalRows} cartes`);
        // On continue mais on log un avertissement
      }
      
      // Récupérer les données avec limite
      const result = await client.query(
        'SELECT * FROM cartes ORDER BY id LIMIT $1',
        [limit]
      );
      
      const rows = result.rows;
      console.log(`📊 ${rows.length} lignes à exporter en Excel`);
      
      if (rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: 'Aucune donnée à exporter'
        });
      }
      
      // ✅ CRÉER LE WORKBOOK AVEC OPTIMISATION
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'GESCARD Cocody';
      workbook.created = new Date();
      
      const worksheet = workbook.addWorksheet('Cartes');
      
      // ✅ AJOUTER LES EN-TÊTES
      worksheet.columns = CONFIG.csvHeaders.map(header => ({
        header,
        key: header.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, ''),
        width: 20
      }));
      
      // ✅ AJOUTER LES DONNÉES PAR LOTS (évite la mémoire excessive)
      const batchSize = 500;
      for (let i = 0; i < rows.length; i += batchSize) {
        const batch = rows.slice(i, i + batchSize);
        batch.forEach(row => {
          worksheet.addRow(row);
        });
        
        // ✅ ÉMULER LA PROGRESSION POUR LE FRONTEND
        if (i % 1000 === 0) {
          console.log(`📝 Excel: ${i} lignes ajoutées`);
        }
      }
      
      // ✅ STYLE OPTIMISÉ (léger)
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }
      };
      
      // ✅ CONFIGURER LA RÉPONSE POUR TÉLÉCHARGEMENT
      const timestamp = new Date().toISOString().split('T')[0];
      const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `export-cartes-${timestamp}-${time}.xlsx`;
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Export-ID', exportId);
      res.setHeader('X-Total-Rows', rows.length);
      
      // ✅ ÉCRIRE LE FICHIER EXCEL DIRECTEMENT DANS LA RÉPONSE
      await workbook.xlsx.write(res);
      
      const duration = Date.now() - startTime;
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_EXCEL',
        tableName: 'Cartes',
        details: `Export Excel terminé: ${rows.length} lignes en ${duration}ms`
      });
      
      console.log(`✅ Export Excel réussi (ID: ${exportId}): ${rows.length} lignes en ${duration}ms`);
      
    } catch (error) {
      console.error(`❌ Erreur export Excel (ID: ${exportId}):`, error);
      
      const duration = Date.now() - startTime;
      
      // ✅ NE PAS ENVOYER D'ERREUR SI LES EN-TÊTES ONT DÉJÀ ÉTÉ ENVOYÉS
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur lors de l\'export Excel',
          message: error.message,
          duration: `${duration}ms`,
          exportId
        });
      } else {
        // Juste logger l'erreur, on ne peut plus envoyer de réponse
        console.error('❌ En-têtes déjà envoyés, impossible de renvoyer une erreur');
      }
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_EXCEL',
        tableName: 'Cartes',
        details: `Erreur export Excel: ${error.message} (${duration}ms)`
      });
      
    } finally {
      if (client?.release) client.release();
      
      // Nettoyer la référence
      this.activeExports.delete(exportId);
    }
  }
  
  // ============================================
  // EXPORT CSV OPTIMISÉ (CORRIGÉ - STREAMING)
  // ============================================
  async exportCSV(req, res) {
    const exportId = `csv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    console.log(`📤 Export CSV demandé (ID: ${exportId})`);
    
    // Vérifier les paramètres de test
    const isTest = req.query.test === 'true' || req.query.limit === '5';
    const limit = isTest ? 5 : CONFIG.maxExportRows;
    
    let client;
    
    try {
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_CSV',
        tableName: 'Cartes',
        details: `Export CSV démarré ${isTest ? '(TEST)' : ''}`
      });
      
      client = await db.getClient();
      
      // Récupérer le COUNT d'abord
      const countResult = await client.query('SELECT COUNT(*) as total FROM cartes');
      const totalRows = parseInt(countResult.rows[0].total);
      
      console.log(`📊 ${totalRows} cartes au total, limité à ${limit} pour l'export CSV`);
      
      // ✅ CONFIGURER LA RÉPONSE CSV
      const timestamp = new Date().toISOString().split('T')[0];
      const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `export-cartes-${timestamp}-${time}.csv`;
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('X-Export-ID', exportId);
      res.setHeader('X-Total-Rows', Math.min(totalRows, limit));
      
      // ✅ ÉCRIRE LES EN-TÊTES CSV
      const headers = CONFIG.csvHeaders.join(CONFIG.csvDelimiter) + '\n';
      res.write(headers);
      
      // ✅ UTILISER UN CURSEUR POUR LE STREAMING (optimisé pour la mémoire)
      let offset = 0;
      const chunkSize = CONFIG.chunkSize;
      let totalWritten = 0;
      
      while (offset < limit) {
        const currentLimit = Math.min(chunkSize, limit - offset);
        
        const result = await client.query(
          'SELECT * FROM cartes ORDER BY id LIMIT $1 OFFSET $2',
          [currentLimit, offset]
        );
        
        const rows = result.rows;
        
        if (rows.length === 0) break;
        
        // Écrire les données CSV
        for (const row of rows) {
          const csvRow = CONFIG.csvHeaders.map(header => {
            let value = row[header] || '';
            
            // Échapper les caractères spéciaux CSV
            if (typeof value === 'string') {
              if (value.includes(CONFIG.csvDelimiter) || value.includes('"') || value.includes('\n')) {
                value = `"${value.replace(/"/g, '""')}"`;
              }
            }
            
            // Formater les dates
            if (header.includes('DATE') && value) {
              try {
                const date = new Date(value);
                if (!isNaN(date.getTime())) {
                  value = date.toISOString().split('T')[0];
                }
              } catch (e) {
                // Garder la valeur originale en cas d'erreur
              }
            }
            
            return value;
          }).join(CONFIG.csvDelimiter);
          
          res.write(csvRow + '\n');
          totalWritten++;
        }
        
        offset += rows.length;
        
        // Log de progression
        if (offset % 5000 === 0) {
          console.log(`📝 CSV: ${offset} lignes écrites`);
        }
        
        // Petit délai pour éviter de surcharger le serveur Render
        if (CONFIG.isRenderFreeTier && offset % 10000 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      res.end();
      
      const duration = Date.now() - startTime;
      const speed = duration > 0 ? Math.round((totalWritten / (duration / 1000))) : 0;
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_CSV',
        tableName: 'Cartes',
        details: `Export CSV terminé: ${totalWritten} lignes en ${duration}ms (${speed} lignes/sec)`
      });
      
      console.log(`✅ Export CSV réussi (ID: ${exportId}): ${totalWritten} lignes en ${duration}ms (${speed} lignes/sec)`);
      
    } catch (error) {
      console.error(`❌ Erreur export CSV (ID: ${exportId}):`, error);
      
      const duration = Date.now() - startTime;
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur lors de l\'export CSV',
          message: error.message,
          duration: `${duration}ms`,
          exportId
        });
      } else {
        console.error('❌ En-têtes déjà envoyés, impossible de renvoyer une erreur CSV');
        try {
          res.end(); // Terminer la réponse
        } catch (e) {
          // Ignorer les erreurs de fin de réponse
        }
      }
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_CSV',
        tableName: 'Cartes',
        details: `Erreur export CSV: ${error.message} (${duration}ms)`
      });
      
    } finally {
      if (client?.release) client.release();
      
      // Nettoyer la référence
      this.activeExports.delete(exportId);
    }
  }
  
  // ============================================
  // EXPORT CSV PAR SITE (OPTIMISÉ)
  // ============================================
  async exportCSVBySite(req, res) {
    const { siteRetrait } = req.query;
    
    if (!siteRetrait) {
      return res.status(400).json({
        success: false,
        error: 'Paramètre siteRetrait requis'
      });
    }
    
    const decodedSite = decodeURIComponent(siteRetrait)
      .replace(/\+/g, ' ')
      .trim();
    
    console.log(`📤 Export CSV pour site: ${decodedSite}`);
    
    let client;
    
    try {
      client = await db.getClient();
      
      // Vérifier existence
      const siteCheck = await client.query(
        'SELECT COUNT(*) as count FROM cartes WHERE "SITE DE RETRAIT" = $1',
        [decodedSite]
      );
      
      const count = parseInt(siteCheck.rows[0].count);
      
      if (count === 0) {
        return res.status(404).json({
          success: false,
          error: `Aucune donnée pour le site: ${decodedSite}`
        });
      }
      
      // Configurer réponse
      const safeSiteName = decodedSite.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const filename = `export-${safeSiteName}.csv`;
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      
      // Écrire les en-têtes CSV
      const headers = CONFIG.csvHeaders.join(CONFIG.csvDelimiter) + '\n';
      res.write(headers);
      
      // Utiliser un curseur pour le streaming
      let offset = 0;
      const chunkSize = 1000;
      let totalWritten = 0;
      
      while (true) {
        const result = await client.query(
          `SELECT * FROM cartes WHERE "SITE DE RETRAIT" = $1 ORDER BY id LIMIT $2 OFFSET $3`,
          [decodedSite, chunkSize, offset]
        );
        
        const rows = result.rows;
        if (rows.length === 0) break;
        
        // Écrire les données CSV
        for (const row of rows) {
          const csvRow = CONFIG.csvHeaders.map(header => {
            let value = row[header] || '';
            
            if (typeof value === 'string' && (value.includes(CONFIG.csvDelimiter) || value.includes('"') || value.includes('\n'))) {
              value = `"${value.replace(/"/g, '""')}"`;
            }
            
            return value;
          }).join(CONFIG.csvDelimiter);
          
          res.write(csvRow + '\n');
          totalWritten++;
        }
        
        offset += rows.length;
        
        // Petit délai sur Render gratuit
        if (CONFIG.isRenderFreeTier && offset % 5000 === 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      
      res.end();
      
      console.log(`✅ Export CSV site terminé: ${decodedSite} - ${totalWritten} lignes`);
      
    } catch (error) {
      console.error('❌ Erreur export CSV site:', error);
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur export CSV site: ' + error.message
        });
      }
    } finally {
      if (client?.release) client.release();
    }
  }
  
  // ============================================
  // IMPORT CSV (STANDARD)
  // ============================================
  async importCSV(req, res) {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier uploadé'
      });
    }
    
    const importBatchId = uuidv4();
    const client = await db.getClient();
    
    try {
      console.log(`📥 Import CSV: ${req.file.originalname}`);
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_IMPORT_CSV',
        tableName: 'Cartes',
        importBatchID: importBatchId,
        details: `Import CSV: ${req.file.originalname}`
      });
      
      await client.query('BEGIN');
      
      // Parser CSV
      const csvData = await this.parseCSVStream(req.file.path);
      
      let imported = 0;
      let errors = 0;
      
      // Traiter par lots
      const batchSize = CONFIG.isRenderFreeTier ? 500 : 1000;
      for (let i = 0; i < csvData.length; i += batchSize) {
        const batch = csvData.slice(i, i + batchSize);
        const batchResult = await this.processCSVBatch(client, batch, i + 1, importBatchId);
        
        imported += batchResult.imported;
        errors += batchResult.errors;
        
        if (i % 1000 === 0) {
          console.log(`📈 Progression: ${i + batch.length}/${csvData.length} lignes`);
        }
      }
      
      await client.query('COMMIT');
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_IMPORT_CSV',
        tableName: 'Cartes',
        importBatchID: importBatchId,
        details: `Import CSV terminé: ${imported} importées, ${errors} erreurs`
      });
      
      res.json({
        success: true,
        message: 'Import CSV terminé',
        stats: {
          totalRows: csvData.length,
          imported,
          errors,
          importBatchID: importBatchId
        }
      });
      
    } catch (error) {
      console.error('❌ Erreur import CSV:', error);
      
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.warn('⚠️ Erreur rollback:', rollbackError.message);
      }
      
      res.status(500).json({
        success: false,
        error: 'Erreur import CSV: ' + error.message
      });
    } finally {
      if (req.file?.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (e) {
          console.warn('⚠️ Impossible supprimer fichier:', e.message);
        }
      }
      
      if (client?.release) client.release();
    }
  }
  
  // ============================================
  // MÉTHODES UTILITAIRES
  // ============================================
  
  parseCSVStream(filePath) {
    return new Promise((resolve, reject) => {
      const results = [];
      
      fs.createReadStream(filePath)
        .pipe(csv({
          separator: CONFIG.csvDelimiter,
          mapHeaders: ({ header }) => header.trim().toUpperCase(),
          mapValues: ({ value }) => value ? value.toString().trim() : ''
        }))
        .on('data', (data) => {
          results.push(data);
        })
        .on('end', () => {
          resolve(results);
        })
        .on('error', reject);
    });
  }
  
  async processCSVBatch(client, batch, startLine, importBatchID) {
    const result = {
      imported: 0,
      errors: 0
    };
    
    const queries = [];
    const values = [];
    
    for (let i = 0; i < batch.length; i++) {
      const data = batch[i];
      
      try {
        if (!data.NOM || !data.PRENOMS) {
          result.errors++;
          continue;
        }
        
        const paramIndex = queries.length * 11 + 1;
        
        queries.push(`(
          $${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, 
          $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5},
          $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8},
          $${paramIndex + 9}, $${paramIndex + 10}
        )`);
        
        values.push(
          data["LIEU D'ENROLEMENT"] || '',
          data["SITE DE RETRAIT"] || '',
          data["RANGEMENT"] || '',
          data["NOM"] || '',
          data["PRENOMS"] || '',
          this.formatDate(data["DATE DE NAISSANCE"]),
          data["LIEU NAISSANCE"] || '',
          this.formatPhone(data["CONTACT"] || ''),
          data["DELIVRANCE"] || '',
          this.formatPhone(data["CONTACT DE RETRAIT"] || ''),
          this.formatDate(data["DATE DE DELIVRANCE"])
        );
        
        result.imported++;
        
      } catch (error) {
        result.errors++;
      }
    }
    
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
    
    return result;
  }
  
  formatDate(value) {
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
  }
  
  formatPhone(value) {
    if (!value) return '';
    const digits = value.toString().replace(/\D/g, '');
    return digits.substring(0, 8);
  }
  
  // ============================================
  // AUTRES MÉTHODES
  // ============================================
  
  async getSitesList(req, res) {
    try {
      const result = await db.query(
        'SELECT DISTINCT "SITE DE RETRAIT" as site FROM cartes WHERE "SITE DE RETRAIT" IS NOT NULL ORDER BY site'
      );
      
      const sites = result.rows.map(row => row.site).filter(site => site);
      
      res.json({
        success: true,
        sites,
        count: sites.length
      });
      
    } catch (error) {
      console.error('❌ Erreur récupération sites:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur récupération sites: ' + error.message
      });
    }
  }
  
  async downloadTemplate(req, res) {
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Template');
      
      worksheet.columns = CONFIG.csvHeaders.map(header => ({
        header,
        key: header.replace(/\s+/g, '_'),
        width: 20
      }));
      
      const exampleData = {
        "LIEU D'ENROLEMENT": "Abidjan Plateau",
        "SITE DE RETRAIT": "Yopougon",
        "RANGEMENT": "A1-001",
        "NOM": "KOUAME",
        "PRENOMS": "Jean",
        "DATE DE NAISSANCE": "1990-05-15",
        "LIEU NAISSANCE": "Abidjan",
        "CONTACT": "01234567",
        "DELIVRANCE": "OUI",
        "CONTACT DE RETRAIT": "07654321",
        "DATE DE DELIVRANCE": "2024-11-20"
      };
      
      worksheet.addRow(exampleData);
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="template-import-cartes.xlsx"');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      
      await workbook.xlsx.write(res);
      
    } catch (error) {
      console.error('❌ Erreur génération template:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur génération template: ' + error.message
      });
    }
  }
  
  // ============================================
  // MÉTHODES DE DIAGNOSTIC
  // ============================================
  
  async diagnostic(req, res) {
    try {
      const memoryUsage = process.memoryUsage();
      const uptime = process.uptime();
      
      // Vérifier la connexion à la base de données
      const dbCheck = await db.query('SELECT 1 as test');
      
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        service: 'import-export-optimized',
        environment: CONFIG.isRenderFreeTier ? 'render-free' : 'normal',
        config: {
          maxExportRows: CONFIG.maxExportRows,
          maxImportRows: CONFIG.maxImportRows,
          exportTimeout: CONFIG.exportTimeout,
          memoryLimitMB: CONFIG.memoryLimitMB
        },
        memory: {
          heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
          heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
          rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB',
          external: Math.round(memoryUsage.external / 1024 / 1024) + 'MB'
        },
        uptime: Math.round(uptime) + ' seconds',
        database: dbCheck.rows.length > 0 ? 'connected' : 'disconnected',
        activeExports: this.activeExports.size,
        recommendations: CONFIG.isRenderFreeTier ? [
          '✅ Utilisez CSV pour les exports (plus rapide et stable)',
          '⚠️ Limitez les exports à 5000 lignes maximum',
          '⏱️ Les exports prennent plus de temps sur Render gratuit',
          '💡 Exportez par site pour réduire la taille des fichiers'
        ] : [
          '✅ Tous les formats sont supportés',
          '⚡ Performance normale'
        ]
      });
      
    } catch (error) {
      console.error('❌ Erreur diagnostic:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur diagnostic: ' + error.message
      });
    }
  }
}

// ============================================
// EXPORT OPTIMISÉ
// ============================================
const controller = new OptimizedImportExportController();

module.exports = {
  // Import
  importCSV: controller.importCSV.bind(controller),
  
  // Export
  exportExcel: controller.exportExcel.bind(controller),
  exportCSV: controller.exportCSV.bind(controller),
  exportCSVBySite: controller.exportCSVBySite.bind(controller),
  
  // Utilitaires
  getSitesList: controller.getSitesList.bind(controller),
  downloadTemplate: controller.downloadTemplate.bind(controller),
  diagnostic: controller.diagnostic.bind(controller),
  
  // Compatibilité
  importExcel: controller.importCSV.bind(controller),
  importSmartSync: controller.importCSV.bind(controller),
  exportStream: controller.exportExcel.bind(controller),
  exportOptimized: controller.exportCSV.bind(controller),
  exportFiltered: controller.exportCSVBySite.bind(controller),
  exportResultats: controller.exportCSVBySite.bind(controller),
  
  // Accès au contrôleur pour debug
  _controller: controller
};