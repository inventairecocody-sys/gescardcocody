const db = require('../db/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const csv = require('csv-parser');
const journalController = require('./journalController');

// 🔧 CONFIGURATION OPTIMISÉE POUR CSV ET RENDER GRATUIT
const CONFIG = {
  // Formats supportés
  supportedFormats: ['.csv', '.xlsx', '.xls'],
  csvDelimiter: ',',
  
  // Limites Render gratuit
  maxFileSize: 30 * 1024 * 1024, // 30MB max pour CSV
  maxRowsPerImport: 10000,
  importBatchSize: 1000,
  exportBatchSize: 2000,
  
  // CSV configuration
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
  
  requiredHeaders: ['NOM', 'PRENOMS'],
  isRenderFreeTier: process.env.NODE_ENV === 'production'
};

// 🛠️ CLASSES UTILITAIRES POUR CSV
class CSVProcessor {
  /**
   * Parser CSV avec streaming
   */
  static parseCSVStream(filePath) {
    return new Promise((resolve, reject) => {
      const results = [];
      let lineCount = 0;
      
      fs.createReadStream(filePath)
        .pipe(csv({
          separator: CONFIG.csvDelimiter,
          mapHeaders: ({ header }) => header.trim().toUpperCase(),
          mapValues: ({ value }) => value ? value.toString().trim() : ''
        }))
        .on('data', (data) => {
          results.push(data);
          lineCount++;
          
          if (lineCount % 1000 === 0) {
            console.log(`📊 CSV: ${lineCount} lignes lues`);
          }
        })
        .on('end', () => {
          console.log(`✅ CSV parsing complet: ${lineCount} lignes`);
          resolve({ data: results, total: lineCount });
        })
        .on('error', reject);
    });
  }

  /**
   * Générer CSV en streaming
   */
  static async generateCSV(data, res, filename) {
    return new Promise((resolve, reject) => {
      // En-têtes
      const headers = CONFIG.csvHeaders.join(CONFIG.csvDelimiter) + '\n';
      res.write(headers);
      
      let written = 0;
      let buffer = '';
      
      data.forEach((row, index) => {
        const csvRow = CONFIG.csvHeaders.map(header => {
          let value = row[header] || '';
          
          if (typeof value === 'string' && (value.includes(',') || value.includes('"') || value.includes('\n'))) {
            value = `"${value.replace(/"/g, '""')}"`;
          }
          
          if (header.includes('DATE') && value) {
            try {
              const date = new Date(value);
              if (!isNaN(date.getTime())) {
                value = date.toISOString().split('T')[0];
              }
            } catch (e) {}
          }
          
          return value;
        }).join(CONFIG.csvDelimiter);
        
        buffer += csvRow + '\n';
        written++;
        
        // Écrire par blocs de 1000 lignes
        if (written % 1000 === 0) {
          res.write(buffer);
          buffer = '';
          console.log(`📝 CSV: ${written} lignes écrites`);
          
          // Pause pour Render gratuit
          if (CONFIG.isRenderFreeTier && written % 5000 === 0) {
            setTimeout(() => {}, 100);
          }
        }
      });
      
      // Écrire le reste
      if (buffer.length > 0) {
        res.write(buffer);
      }
      
      res.end();
      resolve(written);
    });
  }
}

class DateParserCSV {
  /**
   * Parser robuste pour dates CSV
   */
  static parseDate(value) {
    if (!value || value === '') return null;
    
    // Format: "Thu Jul 12 2001 00:00:00 GMT+0000"
    const jsDateMatch = String(value).match(/(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4})/);
    if (jsDateMatch) {
      const date = new Date(jsDateMatch[0]);
      if (!isNaN(date.getTime())) return date;
    }
    
    // Format Excel
    const num = parseFloat(value);
    if (!isNaN(num) && num > 1000) {
      const excelEpoch = new Date(1899, 11, 30);
      const date = new Date(excelEpoch.getTime() + (num - 1) * 86400000);
      if (!isNaN(date.getTime())) return date;
    }
    
    // Formats standards
    const formats = [
      { regex: /^(\d{4})-(\d{2})-(\d{2})$/, parts: [1, 2, 3] }, // YYYY-MM-DD
      { regex: /^(\d{2})\/(\d{2})\/(\d{4})$/, parts: [3, 2, 1] }, // DD/MM/YYYY
      { regex: /^(\d{2})-(\d{2})-(\d{4})$/, parts: [3, 2, 1] }, // DD-MM-YYYY
      { regex: /^(\d{4})\/(\d{2})\/(\d{2})$/, parts: [1, 2, 3] }  // YYYY/MM/DD
    ];
    
    for (const format of formats) {
      const match = String(value).match(format.regex);
      if (match) {
        const year = parseInt(match[format.parts[0]], 10);
        const month = parseInt(match[format.parts[1]], 10) - 1;
        const day = parseInt(match[format.parts[2]], 10);
        
        const date = new Date(year, month, day);
        if (!isNaN(date.getTime())) return date;
      }
    }
    
    // Dernier essai
    const parsed = Date.parse(value);
    if (!isNaN(parsed)) return new Date(parsed);
    
    console.warn(`⚠️ Date non parsable: ${value}`);
    return null;
  }
  
  static formatForDB(date) {
    if (!date) return null;
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return null;
    
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
  }
}

// 🎯 CONTROLEUR PRINCIPAL IMPORT/EXPORT
class ImportExportController {
  // ============================================
  // IMPORT CSV - NOUVEAU
  // ============================================
  static async importCSV(req, res) {
    console.time('⏱️ Import CSV');
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier uploadé'
      });
    }
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== '.csv') {
      return res.status(400).json({
        success: false,
        error: 'Format de fichier non supporté. Utilisez .CSV'
      });
    }
    
    const importBatchID = uuidv4();
    const client = await db.getClient();
    
    try {
      console.log(`📥 Import CSV: ${req.file.originalname} (${req.file.size} octets)`);
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_IMPORT_CSV',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import CSV: ${req.file.originalname}`
      });
      
      await client.query('BEGIN');
      
      // Parser le CSV
      const { data: csvData, total: totalRows } = await CSVProcessor.parseCSVStream(req.file.path);
      
      let imported = 0;
      let errors = 0;
      const errorDetails = [];
      
      // Traiter par lots de 500
      const batchSize = 500;
      for (let i = 0; i < csvData.length; i += batchSize) {
        const batch = csvData.slice(i, i + batchSize);
        const batchResult = await this.processCSVBatch(client, batch, i + 1, importBatchID);
        
        imported += batchResult.imported;
        errors += batchResult.errors;
        
        if (batchResult.errorDetails.length > 0) {
          errorDetails.push(...batchResult.errorDetails);
        }
        
        // Log progression
        if (i % 1000 === 0) {
          console.log(`📈 Progression: ${i + batch.length}/${totalRows} lignes`);
        }
        
        // Pause pour Render gratuit
        if (CONFIG.isRenderFreeTier && i % 2000 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      await client.query('COMMIT');
      console.timeEnd('⏱️ Import CSV');
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_IMPORT_CSV',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import CSV terminé: ${imported} importées, ${errors} erreurs`
      });
      
      res.json({
        success: true,
        message: 'Import CSV terminé',
        stats: {
          totalRows,
          imported,
          errors,
          successRate: totalRows > 0 ? Math.round((imported / totalRows) * 100) : 0,
          importBatchID
        },
        errorDetails: errorDetails.slice(0, 10)
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
        error: 'Erreur import CSV: ' + error.message,
        importBatchID
      });
    } finally {
      // Nettoyage
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
  // TRAITEMENT LOT CSV
  // ============================================
  static async processCSVBatch(client, batch, startLine, importBatchID) {
    const result = {
      imported: 0,
      errors: 0,
      errorDetails: []
    };
    
    const queries = [];
    const values = [];
    
    for (let i = 0; i < batch.length; i++) {
      const data = batch[i];
      const lineNumber = startLine + i;
      
      try {
        // Validation requise
        if (!data.NOM || !data.PRENOMS) {
          throw new Error('NOM et PRENOMS requis');
        }
        
        // Nettoyer les données
        const cleanedData = this.cleanData(data);
        
        // Vérifier doublon
        const isDuplicate = await this.checkDuplicate(client, cleanedData);
        
        if (!isDuplicate) {
          // Préparer insertion
          const paramIndex = queries.length * 11 + 1;
          
          queries.push(`(
            $${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, 
            $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5},
            $${paramIndex + 6}, $${paramIndex + 7}, $${paramIndex + 8},
            $${paramIndex + 9}, $${paramIndex + 10}
          )`);
          
          values.push(
            cleanedData["LIEU D'ENROLEMENT"] || '',
            cleanedData["SITE DE RETRAIT"] || '',
            cleanedData["RANGEMENT"] || '',
            cleanedData["NOM"] || '',
            cleanedData["PRENOMS"] || '',
            DateParserCSV.formatForDB(cleanedData["DATE DE NAISSANCE"]),
            cleanedData["LIEU NAISSANCE"] || '',
            this.formatPhone(cleanedData["CONTACT"] || ''),
            cleanedData["DELIVRANCE"] || '',
            this.formatPhone(cleanedData["CONTACT DE RETRAIT"] || ''),
            DateParserCSV.formatForDB(cleanedData["DATE DE DELIVRANCE"])
          );
          
          result.imported++;
        } else {
          result.errors++;
          result.errorDetails.push(`Ligne ${lineNumber}: Doublon - ${data.NOM} ${data.PRENOMS}`);
        }
        
      } catch (error) {
        result.errors++;
        result.errorDetails.push(`Ligne ${lineNumber}: ${error.message}`);
      }
    }
    
    // Exécuter batch insert
    if (queries.length > 0) {
      try {
        const query = `
          INSERT INTO cartes (
            "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, nom, prenoms,
            "DATE DE NAISSANCE", "LIEU NAISSANCE", contact, delivrance,
            "CONTACT DE RETRAIT", "DATE DE DELIVRANCE", importbatchid
          ) VALUES ${queries.join(', ')}
        `;
        
        await client.query(query, [...values, importBatchID]);
      } catch (error) {
        console.error('❌ Erreur insertion batch:', error);
        throw error;
      }
    }
    
    return result;
  }
  
  // ============================================
  // EXPORT CSV - NOUVEAU
  // ============================================
  static async exportCSV(req, res) {
    try {
      console.log('📤 Export CSV demandé');
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_CSV',
        tableName: 'Cartes',
        details: 'Export CSV démarré'
      });
      
      // Récupérer toutes les données
      const result = await db.query(
        'SELECT * FROM cartes ORDER BY id LIMIT 10000'
      );
      
      console.log(`📊 ${result.rows.length} lignes à exporter`);
      
      // Configurer réponse CSV
      const filename = `export-cartes-${new Date().toISOString().split('T')[0]}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      // Générer CSV
      await CSVProcessor.generateCSV(result.rows, res, filename);
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_CSV',
        tableName: 'Cartes',
        details: `Export CSV terminé: ${result.rows.length} lignes`
      });
      
      console.log(`✅ Export CSV terminé: ${result.rows.length} lignes`);
      
    } catch (error) {
      console.error('❌ Erreur export CSV:', error);
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur export CSV: ' + error.message
        });
      }
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_CSV',
        tableName: 'Cartes',
        details: `Erreur export CSV: ${error.message}`
      });
    }
  }
  
  // ============================================
  // EXPORT CSV FILTRÉ PAR SITE
  // ============================================
  static async exportCSVBySite(req, res) {
    try {
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
      
      // Vérifier existence
      const siteCheck = await db.query(
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
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_SITE_CSV',
        tableName: 'Cartes',
        details: `Export CSV site: ${decodedSite}`
      });
      
      // Récupérer données
      const result = await db.query(
        'SELECT * FROM cartes WHERE "SITE DE RETRAIT" = $1 ORDER BY id',
        [decodedSite]
      );
      
      // Configurer réponse
      const filename = `export-${decodedSite.replace(/[^a-z0-9]/gi, '-')}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      // Générer CSV
      await CSVProcessor.generateCSV(result.rows, res, filename);
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_SITE_CSV',
        tableName: 'Cartes',
        details: `Export CSV site terminé: ${result.rows.length} lignes`
      });
      
      console.log(`✅ Export CSV site terminé: ${decodedSite} - ${result.rows.length} lignes`);
      
    } catch (error) {
      console.error('❌ Erreur export CSV site:', error);
      
      res.status(500).json({
        success: false,
        error: 'Erreur export CSV site: ' + error.message
      });
    }
  }
  
  // ============================================
  // IMPORT EXCEL (Compatibilité)
  // ============================================
  static async importExcel(req, res) {
    console.warn('⚠️ IMPORT EXCEL - Utilisez CSV pour de meilleures performances');
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier uploadé'
      });
    }
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext === '.csv') {
      // Rediriger vers import CSV
      return this.importCSV(req, res);
    }
    
    // Si c'est Excel, continuer avec l'ancienne logique
    try {
      const importBatchID = uuidv4();
      const client = await db.getClient();
      
      await client.query('BEGIN');
      
      // Lire fichier Excel
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(req.file.path);
      const worksheet = workbook.getWorksheet(1);
      
      if (!worksheet) {
        throw new Error('Aucune feuille trouvée');
      }
      
      const totalRows = worksheet.rowCount - 1;
      console.log(`📊 Fichier Excel: ${totalRows} lignes`);
      
      let imported = 0;
      let errors = 0;
      
      // Traiter ligne par ligne
      for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
        try {
          const row = worksheet.getRow(rowNumber);
          const rowData = {};
          
          row.eachCell((cell, colNumber) => {
            if (colNumber <= CONFIG.csvHeaders.length) {
              const header = CONFIG.csvHeaders[colNumber - 1];
              rowData[header] = cell.value?.toString().trim() || '';
            }
          });
          
          // Validation
          if (!rowData.NOM || !rowData.PRENOMS) {
            errors++;
            continue;
          }
          
          // Insertion
          await client.query(`
            INSERT INTO cartes (
              "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, nom, prenoms,
              "DATE DE NAISSANCE", "LIEU NAISSANCE", contact, delivrance,
              "CONTACT DE RETRAIT", "DATE DE DELIVRANCE", importbatchid
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [
            rowData["LIEU D'ENROLEMENT"] || '',
            rowData["SITE DE RETRAIT"] || '',
            rowData["RANGEMENT"] || '',
            rowData["NOM"] || '',
            rowData["PRENOMS"] || '',
            DateParserCSV.formatForDB(DateParserCSV.parseDate(rowData["DATE DE NAISSANCE"])),
            rowData["LIEU NAISSANCE"] || '',
            this.formatPhone(rowData["CONTACT"] || ''),
            rowData["DELIVRANCE"] || '',
            this.formatPhone(rowData["CONTACT DE RETRAIT"] || ''),
            DateParserCSV.formatForDB(DateParserCSV.parseDate(rowData["DATE DE DELIVRANCE"])),
            importBatchID
          ]);
          
          imported++;
          
          // Pause pour Render gratuit
          if (CONFIG.isRenderFreeTier && rowNumber % 500 === 0) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          
        } catch (error) {
          errors++;
          console.warn(`❌ Erreur ligne ${rowNumber}:`, error.message);
        }
      }
      
      await client.query('COMMIT');
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_IMPORT_EXCEL',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import Excel terminé: ${imported} importées, ${errors} erreurs`
      });
      
      res.json({
        success: true,
        message: 'Import Excel terminé',
        stats: {
          totalRows,
          imported,
          errors,
          successRate: totalRows > 0 ? Math.round((imported / totalRows) * 100) : 0,
          importBatchID
        }
      });
      
    } catch (error) {
      console.error('❌ Erreur import Excel:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur import Excel: ' + error.message
      });
    }
  }
  
  // ============================================
  // MÉTHODES MANQUANTES POUR COMPATIBILITÉ
  // ============================================
  
  /**
   * Import intelligent (Smart Sync)
   */
  static async importSmartSync(req, res) {
    console.log('🔄 Import intelligent - Redirection vers import CSV');
    return this.importCSV(req, res);
  }
  
  /**
   * Export streaming Excel
   */
  static async exportStream(req, res) {
    console.log('📤 Export streaming Excel - Redirection vers CSV');
    return this.exportCSV(req, res);
  }
  
  /**
   * Export Excel standard
   */
  static async exportExcel(req, res) {
    console.log('📤 Export Excel standard - Redirection vers CSV');
    return this.exportCSV(req, res);
  }
  
  /**
   * Export optimisé
   */
  static async exportOptimized(req, res) {
    console.log('📤 Export optimisé - Redirection vers CSV');
    return this.exportCSV(req, res);
  }
  
  /**
   * Export filtré
   */
  static async exportFiltered(req, res) {
    console.log('🔍 Export filtré - Redirection vers CSV par site');
    
    const { siteRetrait, filters } = req.body;
    
    if (!siteRetrait) {
      return res.status(400).json({
        success: false,
        error: 'Paramètre siteRetrait requis'
      });
    }
    
    req.query = { siteRetrait };
    if (filters) {
      try {
        req.query.filters = JSON.stringify(filters);
      } catch (e) {
        console.warn('⚠️ Erreur parsing filters:', e.message);
      }
    }
    
    return this.exportCSVBySite(req, res);
  }
  
  /**
   * Export résultats
   */
  static async exportResultats(req, res) {
    console.log('🔍 Export résultats - Redirection vers CSV par site');
    
    const { siteRetrait } = req.query;
    
    if (!siteRetrait) {
      return res.status(400).json({
        success: false,
        error: 'Paramètre siteRetrait requis'
      });
    }
    
    return this.exportCSVBySite(req, res);
  }
  
  /**
   * Statistiques d'import
   */
  static async getImportStats(req, res) {
    try {
      const result = await db.query(`
        SELECT 
          COUNT(*) as total_cards,
          COUNT(DISTINCT "SITE DE RETRAIT") as total_sites,
          COUNT(DISTINCT importbatchid) as total_imports,
          MIN("DATE DE DELIVRANCE") as oldest_date,
          MAX("DATE DE DELIVRANCE") as newest_date
        FROM cartes
      `);
      
      res.json({
        success: true,
        stats: result.rows[0]
      });
    } catch (error) {
      console.error('❌ Erreur récupération stats:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur récupération stats: ' + error.message
      });
    }
  }
  
  // ============================================
  // MÉTHODES UTILITAIRES
  // ============================================
  static cleanData(data) {
    const cleaned = {};
    
    Object.keys(data).forEach(key => {
      let value = data[key] || '';
      
      if (typeof value === 'string') {
        value = value.trim();
        
        if (key.includes('DATE')) {
          const parsed = DateParserCSV.parseDate(value);
          if (parsed) value = parsed;
        }
      }
      
      cleaned[key] = value;
    });
    
    return cleaned;
  }
  
  static async checkDuplicate(client, data) {
    try {
      const result = await client.query(`
        SELECT COUNT(*) as count 
        FROM cartes 
        WHERE LOWER(TRIM(nom)) = LOWER(TRIM($1))
          AND LOWER(TRIM(prenoms)) = LOWER(TRIM($2))
      `, [data.NOM || '', data.PRENOMS || '']);
      
      return parseInt(result.rows[0].count) > 0;
    } catch (error) {
      console.error('❌ Erreur vérification doublon:', error);
      return false;
    }
  }
  
  static formatPhone(value) {
    if (!value) return '';
    const digits = value.toString().replace(/\D/g, '');
    return digits.substring(0, 8);
  }
  
  // ============================================
  // AUTRES FONCTIONS
  // ============================================
  static async getSitesList(req, res) {
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
  
  static async downloadTemplate(req, res) {
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Template');
      
      // En-têtes
      worksheet.columns = CONFIG.csvHeaders.map(header => ({
        header,
        key: header.replace(/\s+/g, '_'),
        width: 20
      }));
      
      // Exemple
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
      
      await workbook.xlsx.write(res);
      console.log('✅ Template généré');
      
    } catch (error) {
      console.error('❌ Erreur génération template:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur génération template: ' + error.message
      });
    }
  }
}

// 🚀 EXPORT
module.exports = {
  // CSV (Nouveau)
  importCSV: ImportExportController.importCSV.bind(ImportExportController),
  exportCSV: ImportExportController.exportCSV.bind(ImportExportController),
  exportCSVBySite: ImportExportController.exportCSVBySite.bind(ImportExportController),
  
  // Excel (Compatibilité)
  importExcel: ImportExportController.importExcel.bind(ImportExportController),
  importSmartSync: ImportExportController.importSmartSync.bind(ImportExportController),
  
  // Export (Compatibilité)
  exportExcel: ImportExportController.exportExcel.bind(ImportExportController),
  exportOptimized: ImportExportController.exportOptimized.bind(ImportExportController),
  exportStream: ImportExportController.exportStream.bind(ImportExportController),
  exportFiltered: ImportExportController.exportFiltered.bind(ImportExportController),
  exportResultats: ImportExportController.exportResultats.bind(ImportExportController),
  
  // Utilitaires
  getImportStats: ImportExportController.getImportStats.bind(ImportExportController),
  getSitesList: ImportExportController.getSitesList.bind(ImportExportController),
  downloadTemplate: ImportExportController.downloadTemplate.bind(ImportExportController)
};