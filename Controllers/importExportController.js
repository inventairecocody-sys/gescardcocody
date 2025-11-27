const db = require('../db/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const journalController = require('./journalController');

// 🔧 CONFIGURATION CENTRALISÉE
const CONFIG = {
  maxErrorDisplay: 10,
  dateFormat: 'YYYY-MM-DD',
  phoneFormat: '@',
  maxFileSize: 10 * 1024 * 1024,
  uploadDir: 'uploads/',
  batchSize: 100,
  
  columns: [
    { key: "LIEU D'ENROLEMENT", required: false, type: 'string', maxLength: 255 },
    { key: "SITE DE RETRAIT", required: false, type: 'string', maxLength: 255 },
    { key: "RANGEMENT", required: false, type: 'string', maxLength: 100 },
    { key: "NOM", required: true, type: 'string', maxLength: 255 },
    { key: "PRENOMS", required: true, type: 'string', maxLength: 255 },
    { key: "DATE DE NAISSANCE", required: false, type: 'date', maxLength: 10 },
    { key: "LIEU NAISSANCE", required: false, type: 'string', maxLength: 255 },
    { key: "CONTACT", required: false, type: 'string', maxLength: 20 },
    { key: "DELIVRANCE", required: false, type: 'string', maxLength: 255 },
    { key: "CONTACT DE RETRAIT", required: false, type: 'string', maxLength: 255 },
    { key: "DATE DE DELIVRANCE", required: false, type: 'date', maxLength: 10 }
  ],
  requiredHeaders: ['NOM', 'PRENOMS']
};

// 🛠️ CLASSES UTILITAIRES
class ImportResult {
  constructor(importBatchID) {
    this.imported = 0;
    this.duplicates = 0;
    this.errors = 0;
    this.totalProcessed = 0;
    this.errorDetails = [];
    this.importBatchID = importBatchID;
    this.startTime = new Date();
  }

  addError(error) {
    this.errors++;
    this.errorDetails.push(error);
  }

  getStats() {
    const duration = new Date() - this.startTime;
    return {
      imported: this.imported,
      duplicates: this.duplicates,
      errors: this.errors,
      totalProcessed: this.totalProcessed,
      successRate: this.totalProcessed > 0 ? Math.round((this.imported / this.totalProcessed) * 100) : 0,
      importBatchID: importBatchID,
      duration: `${Math.round(duration / 1000)}s`
    };
  }
}

class DataValidator {
  static validateRow(rowData, rowNumber) {
    const errors = [];

    if (!rowData.NOM || rowData.NOM.toString().trim() === '') {
      errors.push(`Ligne ${rowNumber}: Le champ NOM est obligatoire`);
    }
    
    if (!rowData.PRENOMS || rowData.PRENOMS.toString().trim() === '') {
      errors.push(`Ligne ${rowNumber}: Le champ PRENOMS est obligatoire`);
    }

    return errors;
  }

  static validateHeaders(headers) {
    const missingHeaders = CONFIG.requiredHeaders.filter(header => 
      !headers.some(h => h.toUpperCase() === header.toUpperCase())
    );
    return missingHeaders;
  }
}

class DataCleaner {
  static cleanValue(value, columnType) {
    if (value === null || value === undefined || value === '') {
      return '';
    }

    let cleaned = value.toString().trim();

    if (cleaned.toUpperCase() === 'NULL') {
      return '';
    }

    if (columnType === 'date' && cleaned) {
      return this.cleanDate(cleaned);
    }

    return cleaned;
  }

  static cleanDate(dateString) {
    try {
      const date = new Date(dateString);
      if (!isNaN(date.getTime())) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    } catch (error) {
      // Silently fail for invalid dates
    }
    return '';
  }

  static formatPhone(value) {
    if (!value && value !== 0) return '';
    
    const strValue = value.toString().trim();
    
    if (!isNaN(strValue) && strValue !== '') {
      return strValue.padStart(8, '0');
    }
    
    return strValue;
  }
}

class ExcelHelper {
  static async readExcelFile(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const worksheet = workbook.getWorksheet(1);
    
    if (!worksheet) {
      throw new Error('Aucune feuille trouvée dans le fichier Excel');
    }
    
    return worksheet;
  }

  static setupWorksheet(workbook, sheetName) {
    const worksheet = workbook.addWorksheet(sheetName);
    
    worksheet.columns = CONFIG.columns.map(column => ({
      header: column.key,
      key: column.key.replace(/\s+/g, '_'),
      width: 20
    }));

    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF2E86AB' }
    };

    return worksheet;
  }

  static formatContactColumns(worksheet) {
    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        const contactCell = row.getCell(8);
        const contactRetraitCell = row.getCell(10);
        
        [contactCell, contactRetraitCell].forEach(cell => {
          if (cell.value) {
            cell.numFmt = CONFIG.phoneFormat;
            cell.value = cell.value.toString();
          }
        });
      }
    });
  }
}

class FileHelper {
  static safeDelete(filePath) {
    try {
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('🗑️ Fichier temporaire supprimé:', path.basename(filePath));
      }
    } catch (error) {
      console.warn('⚠️ Impossible de supprimer le fichier temporaire:', error.message);
    }
  }

  static generateFilename(prefix, extension = 'xlsx') {
    const date = new Date().toISOString().split('T')[0];
    return `${prefix}-${date}.${extension}`;
  }
}

// 🎯 SERVICE PRINCIPAL - VERSION POSTGRESQL
class CarteImportExportService {
  /**
   * Import d'un fichier Excel - VERSION POSTGRESQL
   */
  static async importExcel(req, res) {
    console.time('⏱️ Import Excel');
    console.log('🚀 DEBUT IMPORT - Version PostgreSQL');
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier uploadé'
      });
    }

    const importBatchID = uuidv4();
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      console.log('📁 Fichier reçu:', {
        name: req.file.originalname,
        size: req.file.size,
        path: req.file.path,
        importBatchID: importBatchID
      });

      // Vérification req.user
      if (!req.user) {
        FileHelper.safeDelete(req.file.path);
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          error: 'Utilisateur non authentifié'
        });
      }

      // Journaliser le début de l'importation
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        nomComplet: req.user.NomComplet,
        role: req.user.Role || req.user.role,
        agence: req.user.Agence,
        actionType: 'DEBUT_IMPORT',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        ip: req.ip,
        details: `Début importation fichier: ${req.file.originalname} - Batch: ${importBatchID}`
      });

      const worksheet = await ExcelHelper.readExcelFile(req.file.path);
      console.log(`📊 Fichier chargé: ${req.file.originalname}, Lignes: ${worksheet.rowCount}`);

      // Extraction des en-têtes
      const headers = this.extractHeaders(worksheet);
      console.log('🔍 DEBUG - En-têtes détectés:', headers);

      // Validation des en-têtes
      const missingHeaders = DataValidator.validateHeaders(headers);
      
      if (missingHeaders.length > 0) {
        FileHelper.safeDelete(req.file.path);
        await client.query('ROLLBACK');
        
        await journalController.logAction({
          utilisateurId: req.user.id,
          nomUtilisateur: req.user.NomUtilisateur,
          nomComplet: req.user.NomComplet,
          role: req.user.Role || req.user.role,
          agence: req.user.Agence,
          actionType: 'ERREUR_IMPORT',
          tableName: 'Cartes',
          importBatchID: importBatchID,
          ip: req.ip,
          details: `Échec validation en-têtes - Fichier: ${req.file.originalname} - En-têtes manquants: ${missingHeaders.join(', ')}`
        });

        return res.status(400).json({
          success: false,
          error: `En-têtes manquants: ${missingHeaders.join(', ')}. Utilisez le template fourni.`,
          detectedHeaders: headers
        });
      }

      console.log('✅ Validation des en-têtes réussie');

      // Traitement
      const result = new ImportResult(importBatchID);
      await this.processImport(client, worksheet, headers, result, req, importBatchID);
      
      await client.query('COMMIT');
      FileHelper.safeDelete(req.file.path);
      console.timeEnd('⏱️ Import Excel');

      console.log('📊 RÉSULTAT FINAL:', result.getStats());

      // Journaliser la fin de l'importation
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        nomComplet: req.user.NomComplet,
        role: req.user.Role || req.user.role,
        agence: req.user.Agence,
        actionType: 'FIN_IMPORT',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        ip: req.ip,
        details: `Importation terminée - ${result.imported} importées, ${result.duplicates} doublons, ${result.errors} erreurs - Fichier: ${req.file.originalname}`
      });

      res.json({
        success: true,
        message: 'Import terminé avec succès',
        stats: result.getStats(),
        importBatchID: importBatchID,
        erreursDetail: result.errorDetails.slice(0, CONFIG.maxErrorDisplay)
      });

    } catch (error) {
      await client.query('ROLLBACK');
      FileHelper.safeDelete(req.file.path);
      console.error('❌ Erreur import:', error);
      
      await journalController.logAction({
        utilisateurId: req.user?.id,
        nomUtilisateur: req.user?.NomUtilisateur,
        nomComplet: req.user?.NomComplet,
        role: req.user?.Role || req.user?.role,
        agence: req.user?.Agence,
        actionType: 'ERREUR_IMPORT',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        ip: req.ip,
        details: `Erreur importation: ${error.message} - Fichier: ${req.file.originalname}`
      });

      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'import: ' + error.message,
        importBatchID: importBatchID
      });
    } finally {
      client.release();
    }
  }

  /**
   * Processus d'import principal - POSTGRESQL
   */
  static async processImport(client, worksheet, headers, result, req, importBatchID) {
    console.log(`🎯 Début traitement de ${worksheet.rowCount - 1} lignes`);

    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      try {
        if (rowNumber % 1000 === 0) {
          console.log(`📈 Traitement en cours... Ligne ${rowNumber}/${worksheet.rowCount}`);
        }

        const rowData = this.extractRowData(worksheet.getRow(rowNumber), headers);
        
        if (this.isEmptyRow(rowData)) {
          continue;
        }

        result.totalProcessed++;
        await this.processSingleRow(client, rowData, rowNumber, result, req, importBatchID);

      } catch (error) {
        result.addError(`Ligne ${rowNumber}: Erreur inattendue - ${error.message}`);
        console.error(`❌ Erreur inattendue ligne ${rowNumber}:`, error.message);
      }
    }

    console.log('✅ Traitement de toutes les lignes terminé');
  }

  /**
   * Traitement d'une seule ligne - POSTGRESQL
   */
  static async processSingleRow(client, rowData, rowNumber, result, req, importBatchID) {
    try {
      // Mapping des données
      const mappedData = {
        "LIEU D'ENROLEMENT": rowData["LIEU D'ENROLEMENT"] || '',
        "SITE DE RETRAIT": rowData["SITE DE RETRAIT"] || '',
        "RANGEMENT": rowData["RANGEMENT"] || '',
        "NOM": rowData["NOM"] || '',
        "PRENOMS": rowData["PRENOMS"] || '',
        "DATE DE NAISSANCE": rowData["DATE DE NAISSANCE"] || '',
        "LIEU NAISSANCE": rowData["LIEU NAISSANCE"] || '',
        "CONTACT": rowData["CONTACT"] || '',
        "DELIVRANCE": rowData["DELIVRANCE"] || '',
        "CONTACT DE RETRAIT": rowData["CONTACT DE RETRAIT"] || '',
        "DATE DE DELIVRANCE": rowData["DATE DE DELIVRANCE"] || ''
      };

      // Validation
      const validationErrors = DataValidator.validateRow(mappedData, rowNumber);
      if (validationErrors.length > 0) {
        result.errorDetails.push(...validationErrors);
        result.errors++;
        return;
      }

      // Nettoyage
      const cleanedData = this.cleanRowData(mappedData);

      // Vérifier les doublons - POSTGRESQL
      const duplicateCheck = await client.query(
        'SELECT COUNT(*) as count FROM cartes WHERE nom = $1 AND prenoms = $2',
        [cleanedData.NOM, cleanedData.PRENOMS]
      );

      if (parseInt(duplicateCheck.rows[0].count) > 0) {
        console.log(`⚠️ Ligne ${rowNumber} doublon ignoré: ${cleanedData.NOM} ${cleanedData.PRENOMS}`);
        result.duplicates++;
        return;
      }

      // Insertion avec ImportBatchID - POSTGRESQL
      const carteId = await this.insertRowData(client, cleanedData, importBatchID);

      result.imported++;

      // Journaliser chaque carte importée avec succès
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        nomComplet: req.user.NomComplet,
        role: req.user.Role || req.user.role,
        agence: req.user.Agence,
        actionType: 'IMPORT_CARTE',
        tableName: 'Cartes',
        recordId: carteId.toString(),
        newValue: JSON.stringify({
          ...cleanedData,
          ID: carteId,
          ImportBatchID: importBatchID
        }),
        importBatchID: importBatchID,
        ip: req.ip,
        details: `Import carte ligne ${rowNumber} - ${cleanedData.NOM} ${cleanedData.PRENOMS}`
      });

      if (rowNumber % 100 === 0) {
        console.log(`✅ ${rowNumber} lignes traitées - ${result.imported} importées`);
      }

    } catch (error) {
      const errorMsg = `Ligne ${rowNumber}: ${error.message}`;
      result.addError(errorMsg);
      console.error(`❌ Erreur ligne ${rowNumber}:`, error.message);
    }
  }

  /**
   * Insertion d'une ligne de données - POSTGRESQL
   */
  static async insertRowData(client, data, importBatchID) {
    const result = await client.query(`
      INSERT INTO cartes (
        "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, nom, prenoms,
        "DATE DE NAISSANCE", "LIEU NAISSANCE", contact, delivrance,
        "CONTACT DE RETRAIT", "DATE DE DELIVRANCE", importbatchid
      ) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `, [
      data["LIEU D'ENROLEMENT"] || '',
      data["SITE DE RETRAIT"] || '',
      data["RANGEMENT"] || '',
      data["NOM"] || '',
      data["PRENOMS"] || '',
      data["DATE DE NAISSANCE"] ? new Date(data["DATE DE NAISSANCE"]) : null,
      data["LIEU NAISSANCE"] || '',
      data["CONTACT"] || '',
      data["DELIVRANCE"] || '',
      data["CONTACT DE RETRAIT"] || '',
      data["DATE DE DELIVRANCE"] ? new Date(data["DATE DE DELIVRANCE"]) : null,
      importBatchID
    ]);

    return result.rows[0].id;
  }

  // 🔥 MÉTHODES D'EXPORT (ADAPTÉES POUR POSTGRESQL)
  static async exportAll(req, res) {
    try {
      const result = await db.query(
        'SELECT * FROM cartes ORDER BY id'
      );

      console.log(`📊 Toutes les cartes à exporter: ${result.rows.length} lignes`);
      
      const normalizedData = this.normalizeSQLData(result.rows);
      const filename = FileHelper.generateFilename('toutes-les-cartes');
      
      // Journaliser l'export
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        nomComplet: req.user.NomComplet,
        role: req.user.Role || req.user.role,
        agence: req.user.Agence,
        actionType: 'EXPORT_CARTES',
        tableName: 'Cartes',
        ip: req.ip,
        details: `Export complet - ${result.rows.length} cartes - Fichier: ${filename}`
      });

      await this.exportToExcel(res, normalizedData, filename);

    } catch (error) {
      console.error('❌ Erreur export toutes les cartes:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'export Excel: ' + error.message
      });
    }
  }

  static async exportSearchResults(req, res) {
    try {
      console.log('🔍 Paramètres reçus pour export résultats:', req.query);
      
      let query = 'SELECT * FROM cartes WHERE 1=1';
      const conditions = [];
      const params = [];
      let paramCount = 0;

      const filterMap = {
        nom: { column: 'nom', operator: 'ILIKE' },
        prenom: { column: 'prenoms', operator: 'ILIKE' },
        contact: { column: 'contact', operator: 'ILIKE' },
        siteRetrait: { column: '"SITE DE RETRAIT"', operator: 'ILIKE' },
        lieuNaissance: { column: '"LIEU NAISSANCE"', operator: 'ILIKE' },
        dateNaissance: { column: '"DATE DE NAISSANCE"', operator: '=' },
        rangement: { column: 'rangement', operator: 'ILIKE' }
      };

      Object.entries(filterMap).forEach(([key, config]) => {
        if (req.query[key] && req.query[key].trim() !== '') {
          paramCount++;
          let paramValue = req.query[key].trim();
          
          if (config.operator === 'ILIKE') {
            paramValue = `%${paramValue}%`;
          }
          
          conditions.push(`${config.column} ${config.operator} $${paramCount}`);
          params.push(paramValue);
        }
      });

      if (conditions.length > 0) {
        query += ' AND ' + conditions.join(' AND ');
      }

      query += ' ORDER BY id';
      
      console.log('📝 Requête SQL générée:', query);
      const result = await db.query(query, params);
      console.log(`📊 Résultats à exporter: ${result.rows.length} lignes`);

      const normalizedData = this.normalizeSQLData(result.rows);
      const filename = FileHelper.generateFilename('resultats-recherche');
      
      // Journaliser l'export des résultats
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        nomComplet: req.user.NomComplet,
        role: req.user.Role || req.user.role,
        agence: req.user.Agence,
        actionType: 'EXPORT_RECHERCHE',
        tableName: 'Cartes',
        ip: req.ip,
        details: `Export résultats recherche - ${result.rows.length} cartes - Fichier: ${filename} - Critères: ${JSON.stringify(req.query)}`
      });
      
      await this.exportToExcel(res, normalizedData, filename);

    } catch (error) {
      console.error('❌ Erreur export résultats:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'export des résultats: ' + error.message
      });
    }
  }

  static async downloadTemplate(req, res) {
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = ExcelHelper.setupWorksheet(workbook, 'Template Import Cartes');

      // Données d'exemple
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
      ExcelHelper.formatContactColumns(worksheet);
      this.addInstructions(worksheet);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="template-import-cartes.xlsx"');

      // Journaliser le téléchargement du template
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        nomComplet: req.user.NomComplet,
        role: req.user.Role || req.user.role,
        agence: req.user.Agence,
        actionType: 'TELECHARGEMENT_TEMPLATE',
        tableName: 'Cartes',
        ip: req.ip,
        details: 'Téléchargement du template d\'import'
      });

      await workbook.xlsx.write(res);
      console.log('✅ Template généré avec succès');

    } catch (error) {
      console.error('❌ Erreur génération template:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la génération du template'
      });
    }
  }

  // 🔧 MÉTHODES INTERNES
  static async exportToExcel(res, data, filename) {
    console.time(`⏱️ Export ${filename}`);
    
    try {
      const workbook = new ExcelJS.Workbook();
      const worksheet = ExcelHelper.setupWorksheet(workbook, 'Données Cartes');

      data.forEach(item => {
        const rowData = {};
        CONFIG.columns.forEach(column => {
          rowData[column.key.replace(/\s+/g, '_')] = item[column.key] || '';
        });
        worksheet.addRow(rowData);
      });

      ExcelHelper.formatContactColumns(worksheet);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      await workbook.xlsx.write(res);
      console.timeEnd(`⏱️ Export ${filename}`);

    } catch (error) {
      console.error(`❌ Erreur export ${filename}:`, error);
      throw error;
    }
  }

  static extractHeaders(worksheet) {
    const firstRow = worksheet.getRow(1);
    const headers = [];
    
    firstRow.eachCell((cell, colNumber) => {
      const header = cell.value?.toString().trim() || '';
      headers.push(header);
    });

    return headers;
  }

  static extractRowData(row, headers) {
    const rowData = {};
    let hasData = false;

    row.eachCell((cell, colNumber) => {
      const headerIndex = colNumber - 1;
      if (headerIndex < headers.length && cell.value !== null && cell.value !== undefined) {
        const header = headers[headerIndex];
        const value = cell.value.toString().trim();
        
        rowData[header] = value;
        hasData = true;
      }
    });

    return hasData ? rowData : null;
  }

  static cleanRowData(rowData) {
    const cleaned = {};
    
    Object.keys(rowData).forEach(key => {
      let value = rowData[key] || '';
      
      if (key.includes('CONTACT')) {
        value = DataCleaner.formatPhone(value);
      } else if (key.includes('DATE')) {
        value = DataCleaner.cleanValue(value, 'date');
      } else {
        value = DataCleaner.cleanValue(value, 'string');
      }
      
      cleaned[key] = value;
    });
    
    return cleaned;
  }

  static isEmptyRow(rowData) {
    return !rowData || 
           Object.keys(rowData).length === 0 || 
           Object.values(rowData).every(value => 
             value === null || value === undefined || value === '');
  }

  static normalizeSQLData(rows) {
    if (!rows || !Array.isArray(rows)) {
      return [];
    }

    return rows.map(record => {
      const normalized = {};
      CONFIG.columns.forEach(column => {
        let value = this.getSafeValue(record, column.key);
        
        if ((column.key === 'CONTACT' || column.key === 'CONTACT DE RETRAIT') && value) {
          value = DataCleaner.formatPhone(value);
        }
        
        normalized[column.key] = value || '';
      });
      return normalized;
    });
  }

  static getSafeValue(record, columnName) {
    if (!record || typeof record !== 'object') return '';
    
    if (record[columnName] !== undefined && record[columnName] !== null) {
      return record[columnName];
    }
    
    const lowerKey = Object.keys(record).find(key => 
      key.toLowerCase() === columnName.toLowerCase()
    );
    
    return lowerKey ? record[lowerKey] : '';
  }

  static addInstructions(worksheet) {
    worksheet.addRow([]);
    const instructionRow = worksheet.addRow(['INSTRUCTIONS:']);
    instructionRow.font = { bold: true, color: { argb: 'FFFF0000' } };
    
    const instructions = [
      '1. Ne modifiez pas les noms des colonnes',
      '2. Les champs NOM et PRENOMS sont obligatoires',
      '3. Format des dates: AAAA-MM-JJ',
      '4. Les contacts doivent être en format texte pour garder le 0 initial',
      '5. Supprimez cette ligne d\'instructions avant import',
      '6. Les doublons (même NOM + PRENOMS) seront automatiquement ignorés'
    ];

    instructions.forEach(instruction => {
      worksheet.addRow([instruction]);
    });
  }
}

// 🚀 EXPORT DES FONCTIONNALITÉS
module.exports = {
  importExcel: CarteImportExportService.importExcel.bind(CarteImportExportService),
  exportExcel: CarteImportExportService.exportAll.bind(CarteImportExportService),
  exportResultats: CarteImportExportService.exportSearchResults.bind(CarteImportExportService),
  downloadTemplate: CarteImportExportService.downloadTemplate.bind(CarteImportExportService),
  exportPDF: async (req, res) => {
    res.status(501).json({
      success: false,
      error: 'Export PDF non disponible pour le moment. Utilisez l\'export Excel.'
    });
  }
};