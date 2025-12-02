const db = require('../db/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const journalController = require('./journalController');
const { Transform } = require('stream');

// 🔧 CONFIGURATION CENTRALISÉE
const CONFIG = {
  maxErrorDisplay: 10,
  dateFormat: 'YYYY-MM-DD',
  phoneFormat: '@',
  maxFileSize: 10 * 1024 * 1024,
  uploadDir: 'uploads/',
  batchSize: 100,
  
  // ⚠️ CONFIGURATION POUR RENDER GRATUIT
  renderFreeTier: db.isRenderFreeTier,
  exportBatchSize: db.isRenderFreeTier ? 1000 : 5000, // 1000 lignes par batch sur Render gratuit
  importBatchSize: db.isRenderFreeTier ? 500 : 2000,  // 500 lignes par batch sur Render gratuit
  
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
    this.updated = 0;
    this.duplicates = 0;
    this.errors = 0;
    this.skipped = 0;
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
      updated: this.updated,
      duplicates: this.duplicates,
      skipped: this.skipped,
      errors: this.errors,
      totalProcessed: this.totalProcessed,
      successRate: this.totalProcessed > 0 ? Math.round(((this.imported + this.updated) / this.totalProcessed) * 100) : 0,
      importBatchID: this.importBatchID,
      duration: `${Math.round(duration / 1000)}s`,
      memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
    };
  }
}

class SmartSyncResult extends ImportResult {
  constructor(importBatchID) {
    super(importBatchID);
    this.newRecords = [];
    this.updatedRecords = [];
    this.skippedRecords = [];
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

class PersonMatcher {
  /**
   * Trouve une personne existante avec matching strict
   */
  static async findExistingPerson(client, rowData) {
    const result = await client.query(`
      SELECT id, 
             nom, 
             prenoms, 
             "DATE DE NAISSANCE" as date_naissance,
             "LIEU NAISSANCE" as lieu_naissance,
             delivrance,
             contact,
             "CONTACT DE RETRAIT" as contact_retrait,
             "DATE DE DELIVRANCE" as date_delivrance,
             "LIEU D'ENROLEMENT" as lieu_enrolement,
             "SITE DE RETRAIT" as site_retrait,
             rangement
      FROM cartes 
      WHERE nom = $1 
        AND prenoms = $2 
        AND COALESCE("DATE DE NAISSANCE"::text, '') = COALESCE($3::text, '')
        AND COALESCE("LIEU NAISSANCE", '') = COALESCE($4, '')
    `, [
      rowData.NOM || '',
      rowData.PRENOMS || '',
      rowData["DATE DE NAISSANCE"] || '',
      rowData["LIEU NAISSANCE"] || ''
    ]);

    return result.rows[0] || null;
  }

  /**
   * Recherche avancée avec similarité (pour détection doublons approximatifs)
   */
  static async findSimilarPersons(client, rowData) {
    const result = await client.query(`
      SELECT id, nom, prenoms, 
             "DATE DE NAISSANCE" as date_naissance,
             "LIEU NAISSANCE" as lieu_naissance,
             SIMILARITY(nom, $1) + SIMILARITY(prenoms, $2) as similarity_score
      FROM cartes 
      WHERE nom % $1 OR prenoms % $2
      ORDER BY similarity_score DESC
      LIMIT 5
    `, [
      rowData.NOM || '',
      rowData.PRENOMS || ''
    ]);

    return result.rows;
  }
}

class SmartSync {
  /**
   * Synchronise une ligne avec une personne existante selon vos règles
   */
  static syncWithExisting(existingPerson, newData) {
    const updates = {};
    const changes = [];
    
    // 1. DÉLIVRANCE - TOUJOURS mettre à jour si différent
    if (newData.DELIVRANCE && newData.DELIVRANCE !== existingPerson.delivrance) {
      updates.delivrance = newData.DELIVRANCE;
      changes.push(`Délivrance: ${existingPerson.delivrance || '(vide)'} → ${newData.DELIVRANCE}`);
    }
    
    // 2. CONTACT - JAMAIS changer (garder le premier/existant)
    // On garde existingPerson.contact
    
    // 3. CONTACT DE RETRAIT - JAMAIS changer (garder le premier/existant)
    // On garde existingPerson.contact_retrait
    
    // 4. DATE DE DÉLIVRANCE - JAMAIS changer (garder la première/existante)
    // On garde existingPerson.date_delivrance
    
    // 5. AUTRES CHAMPS - Mettre à jour si différent ET non vide dans newData
    const otherFields = {
      "LIEU D'ENROLEMENT": "lieu_enrolement",
      "SITE DE RETRAIT": "site_retrait",
      "RANGEMENT": "rangement",
      "LIEU NAISSANCE": "lieu_naissance",
      "DATE DE NAISSANCE": "date_naissance"
    };
    
    Object.entries(otherFields).forEach(([key, dbField]) => {
      const existingValue = existingPerson[dbField];
      const newValue = newData[key];
      
      if (newValue && newValue !== existingValue) {
        updates[dbField] = newValue;
        changes.push(`${key}: ${existingValue || '(vide)'} → ${newValue}`);
      }
    });
    
    return {
      shouldUpdate: Object.keys(updates).length > 0,
      updates,
      changes,
      existingId: existingPerson.id,
      existingPerson: existingPerson
    };
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
    const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
    return `${prefix}-${date}-${time}.${extension}`;
  }
}

// 🎯 SERVICE PRINCIPAL - IMPORT/EXPORT INTELLIGENT
class CarteImportExportService {
  // ============================================
  // IMPORTATION STANDARD (EXISTANT)
  // ============================================
  static async importExcel(req, res) {
    console.time('⏱️ Import Excel');
    console.log('🚀 DEBUT IMPORT STANDARD');
    
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
        importBatchID: importBatchID
      });

      if (!req.user) {
        FileHelper.safeDelete(req.file.path);
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          error: 'Utilisateur non authentifié'
        });
      }

      // Journaliser
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_IMPORT',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import standard: ${req.file.originalname}`
      });

      const worksheet = await ExcelHelper.readExcelFile(req.file.path);
      console.log(`📊 Fichier chargé: ${worksheet.rowCount} lignes`);

      const headers = this.extractHeaders(worksheet);
      const missingHeaders = DataValidator.validateHeaders(headers);
      
      if (missingHeaders.length > 0) {
        FileHelper.safeDelete(req.file.path);
        await client.query('ROLLBACK');
        
        await journalController.logAction({
          utilisateurId: req.user.id,
          actionType: 'ERREUR_IMPORT',
          importBatchID: importBatchID,
          details: `En-têtes manquants: ${missingHeaders.join(', ')}`
        });

        return res.status(400).json({
          success: false,
          error: `En-têtes manquants: ${missingHeaders.join(', ')}`
        });
      }

      const result = new ImportResult(importBatchID);
      await this.processImport(client, worksheet, headers, result, req, importBatchID);
      
      await client.query('COMMIT');
      FileHelper.safeDelete(req.file.path);
      console.timeEnd('⏱️ Import Excel');

      console.log('📊 RÉSULTAT FINAL:', result.getStats());

      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_IMPORT',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import standard terminé - ${result.imported} importées, ${result.errors} erreurs`
      });

      res.json({
        success: true,
        message: 'Import standard terminé',
        stats: result.getStats(),
        importBatchID: importBatchID
      });

    } catch (error) {
      await client.query('ROLLBACK');
      FileHelper.safeDelete(req.file.path);
      console.error('❌ Erreur import standard:', error);
      
      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'import: ' + error.message
      });
    } finally {
      client.release();
    }
  }

  // ============================================
  // TRAITEMENT IMPORT STANDARD
  // ============================================
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

  // ============================================
  // TRAITEMENT D'UNE LIGNE
  // ============================================
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

  // ============================================
  // IMPORTATION INTELLIGENTE (SMART SYNC) - NOUVEAU
  // ============================================
  static async importSmartSync(req, res) {
    console.time('⏱️ Import Smart Sync');
    console.log('🚀 DEBUT IMPORT INTELLIGENT - Synchronisation');
    
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
      
      console.log('📁 Fichier reçu (smart sync):', {
        name: req.file.originalname,
        importBatchID: importBatchID
      });

      if (!req.user) {
        FileHelper.safeDelete(req.file.path);
        await client.query('ROLLBACK');
        return res.status(401).json({
          success: false,
          error: 'Utilisateur non authentifié'
        });
      }

      // Journaliser début
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_IMPORT_SMART',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import intelligent: ${req.file.originalname}`
      });

      const worksheet = await ExcelHelper.readExcelFile(req.file.path);
      console.log(`📊 Fichier chargé: ${worksheet.rowCount} lignes`);

      const headers = this.extractHeaders(worksheet);
      const missingHeaders = DataValidator.validateHeaders(headers);
      
      if (missingHeaders.length > 0) {
        FileHelper.safeDelete(req.file.path);
        await client.query('ROLLBACK');
        
        await journalController.logAction({
          utilisateurId: req.user.id,
          actionType: 'ERREUR_IMPORT',
          importBatchID: importBatchID,
          details: `En-têtes manquants: ${missingHeaders.join(', ')}`
        });

        return res.status(400).json({
          success: false,
          error: `En-têtes manquants: ${missingHeaders.join(', ')}`
        });
      }

      // Traitement intelligent
      const result = await this.processSmartImport(
        client, 
        worksheet, 
        headers, 
        req, 
        importBatchID
      );
      
      await client.query('COMMIT');
      FileHelper.safeDelete(req.file.path);
      console.timeEnd('⏱️ Import Smart Sync');

      // Journaliser fin
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_IMPORT_SMART',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import intelligent terminé - ${result.stats.imported} nouvelles, ${result.stats.updated} mises à jour, ${result.stats.skipped} ignorées`
      });

      res.json({
        success: true,
        message: 'Synchronisation intelligente terminée',
        ...result
      });

    } catch (error) {
      await client.query('ROLLBACK');
      FileHelper.safeDelete(req.file.path);
      console.error('❌ Erreur import intelligent:', error);
      
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la synchronisation: ' + error.message,
        importBatchID: importBatchID
      });
    } finally {
      client.release();
    }
  }

  // ============================================
  // TRAITEMENT IMPORT INTELLIGENT
  // ============================================
  static async processSmartImport(client, worksheet, headers, req, importBatchID) {
    const stats = {
      processed: 0,
      imported: 0,      // Nouvelles cartes
      updated: 0,       // Cartes mises à jour
      skipped: 0,       // Cartes identiques (pas de changement)
      errors: 0
    };
    
    const details = {
      new: [],
      updated: [],
      skipped: [],
      errors: []
    };

    console.log(`🎯 Début traitement intelligent de ${worksheet.rowCount - 1} lignes`);
    console.log(`⚙️ Batch size: ${CONFIG.importBatchSize} lignes`);

    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      try {
        stats.processed++;
        
        // Log de progression
        if (rowNumber % 100 === 0) {
          console.log(`📈 Smart sync: ${rowNumber}/${worksheet.rowCount} lignes traitées`);
        }

        const rowData = this.extractRowData(worksheet.getRow(rowNumber), headers);
        
        if (this.isEmptyRow(rowData)) {
          continue;
        }

        // Nettoyage
        const cleanedData = this.cleanRowData(rowData);
        
        // Validation
        const validationErrors = DataValidator.validateRow(cleanedData, rowNumber);
        if (validationErrors.length > 0) {
          details.errors.push({
            row: rowNumber,
            errors: validationErrors
          });
          stats.errors++;
          continue;
        }

        // Recherche de la personne existante
        const existingPerson = await PersonMatcher.findExistingPerson(client, cleanedData);
        
        if (existingPerson) {
          // SYNCHRONISATION selon vos règles
          const syncResult = SmartSync.syncWithExisting(existingPerson, cleanedData);
          
          if (syncResult.shouldUpdate) {
            // Mise à jour
            await this.updatePerson(client, existingPerson.id, syncResult.updates);
            
            stats.updated++;
            details.updated.push({
              row: rowNumber,
              id: existingPerson.id,
              name: `${cleanedData.NOM} ${cleanedData.PRENOMS}`,
              changes: syncResult.changes
            });
            
            // Journaliser la mise à jour
            await journalController.logAction({
              utilisateurId: req.user.id,
              actionType: 'UPDATE_CARTE_SMART',
              tableName: 'Cartes',
              recordId: existingPerson.id.toString(),
              oldValue: JSON.stringify({
                nom: existingPerson.nom,
                prenoms: existingPerson.prenoms,
                delivrance: existingPerson.delivrance,
                contact: existingPerson.contact,
                contact_retrait: existingPerson.contact_retrait
              }),
              newValue: JSON.stringify({
                nom: existingPerson.nom,
                prenoms: existingPerson.prenoms,
                delivrance: syncResult.updates.delivrance || existingPerson.delivrance,
                contact: existingPerson.contact, // Toujours garder l'ancien
                contact_retrait: existingPerson.contact_retrait // Toujours garder l'ancien
              }),
              importBatchID: importBatchID,
              details: `Mise à jour intelligente ligne ${rowNumber} - ${cleanedData.NOM} ${cleanedData.PRENOMS}`
            });
          } else {
            // Aucun changement - ignorer
            stats.skipped++;
            details.skipped.push({
              row: rowNumber,
              id: existingPerson.id,
              name: `${cleanedData.NOM} ${cleanedData.PRENOMS}`,
              reason: 'Données identiques'
            });
          }
        } else {
          // NOUVELLE PERSONNE - Insertion normale
          const carteId = await this.insertRowData(client, cleanedData, importBatchID);
          
          stats.imported++;
          details.new.push({
            row: rowNumber,
            id: carteId,
            name: `${cleanedData.NOM} ${cleanedData.PRENOMS}`
          });
          
          // Journaliser
          await journalController.logAction({
            utilisateurId: req.user.id,
            actionType: 'IMPORT_CARTE_SMART',
            tableName: 'Cartes',
            recordId: carteId.toString(),
            newValue: JSON.stringify({
              ...cleanedData,
              ID: carteId
            }),
            importBatchID: importBatchID,
            details: `Nouvelle carte ligne ${rowNumber} - ${cleanedData.NOM} ${cleanedData.PRENOMS}`
          });
        }

        // Pause pour éviter surcharge sur Render gratuit
        if (CONFIG.renderFreeTier && rowNumber % 500 === 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }

      } catch (error) {
        stats.errors++;
        details.errors.push({
          row: rowNumber,
          error: error.message
        });
        console.error(`❌ Erreur ligne ${rowNumber}:`, error.message);
      }
    }

    console.log('✅ Traitement intelligent terminé');
    
    return {
      stats,
      details: {
        summary: {
          new: stats.imported,
          updated: stats.updated,
          skipped: stats.skipped,
          errors: stats.errors,
          total: stats.processed
        },
        new: details.new.slice(0, 5), // Premières 5 seulement
        updated: details.updated.slice(0, 5),
        errors: details.errors.slice(0, 5)
      }
    };
  }

  // ============================================
  // EXPORT STREAMING (OPTIMISÉ POUR RENDER GRATUIT) - NOUVEAU
  // ============================================
  static async exportStream(req, res) {
    console.time('⏱️ Export Streaming');
    console.log('🚀 DEBUT EXPORT STREAMING OPTIMISÉ');
    
    try {
      const streamId = `export_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      db.registerExportStream && db.registerExportStream(streamId);
      
      // Créer le workbook en streaming
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: res,
        useStyles: true,
        useSharedStrings: false // Désactivé pour économiser la mémoire
      });
      
      const worksheet = workbook.addWorksheet('Cartes');
      
      // En-têtes
      const headerRow = worksheet.addRow(CONFIG.columns.map(col => col.key));
      headerRow.font = { bold: true };
      headerRow.commit();
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="cartes-export-stream.xlsx"');
      
      // Journaliser début export
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_STREAM',
        tableName: 'Cartes',
        details: 'Export streaming optimisé démarré'
      });
      
      let totalRows = 0;
      let batchCount = 0;
      const startTime = Date.now();
      
      // Utiliser le queryStream optimisé
      const stream = await db.queryStream(
        'SELECT * FROM cartes ORDER BY id',
        [],
        CONFIG.exportBatchSize
      );
      
      for await (const batch of stream) {
        batchCount++;
        totalRows += batch.length;
        
        // Ajouter chaque ligne au stream Excel
        batch.forEach(row => {
          const rowData = CONFIG.columns.map(column => 
            this.getSafeValue(row, column.key) || ''
          );
          worksheet.addRow(rowData).commit();
        });
        
        // Log de progression
        if (batchCount % 10 === 0) {
          const elapsed = Date.now() - startTime;
          const memory = process.memoryUsage();
          console.log(`📦 Export streaming: ${totalRows} lignes, batch ${batchCount}, mémoire: ${Math.round(memory.heapUsed / 1024 / 1024)}MB, temps: ${Math.round(elapsed / 1000)}s`);
        }
        
        // Pause pour GC sur Render gratuit
        if (CONFIG.renderFreeTier && batchCount % 20 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      worksheet.commit();
      await workbook.commit();
      
      console.timeEnd('⏱️ Export Streaming');
      const duration = Date.now() - startTime;
      
      // Journaliser fin export
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_STREAM',
        tableName: 'Cartes',
        details: `Export streaming terminé - ${totalRows} lignes en ${Math.round(duration / 1000)}s`
      });
      
      db.unregisterExportStream && db.unregisterExportStream(streamId);
      
    } catch (error) {
      console.error('❌ Erreur export streaming:', error);
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_STREAM',
        tableName: 'Cartes',
        details: `Erreur export streaming: ${error.message}`
      });
      
      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'export streaming: ' + error.message
      });
    }
  }

  // ============================================
  // EXPORT FILTRÉ - NOUVEAU
  // ============================================
  static async exportFiltered(req, res) {
    try {
      const filters = req.body.filters || {};
      console.log('🔍 Export avec filtres:', filters);
      
      let query = 'SELECT * FROM cartes WHERE 1=1';
      const params = [];
      let paramIndex = 1;
      
      // Construire la requête dynamiquement
      if (filters.sites && filters.sites.length > 0) {
        query += ` AND "SITE DE RETRAIT" IN (${filters.sites.map((_, i) => `$${paramIndex + i}`).join(', ')})`;
        params.push(...filters.sites);
        paramIndex += filters.sites.length;
      }
      
      if (filters.dateFrom) {
        query += ` AND "DATE DE DELIVRANCE" >= $${paramIndex}`;
        params.push(filters.dateFrom);
        paramIndex++;
      }
      
      if (filters.dateTo) {
        query += ` AND "DATE DE DELIVRANCE" <= $${paramIndex}`;
        params.push(filters.dateTo);
        paramIndex++;
      }
      
      query += ' ORDER BY id';
      
      const result = await db.query(query, params);
      const normalizedData = this.normalizeSQLData(result.rows);
      const filename = FileHelper.generateFilename('export-filtre');
      
      // Journaliser
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'EXPORT_FILTRE',
        tableName: 'Cartes',
        details: `Export filtré - ${result.rows.length} cartes - Filtres: ${JSON.stringify(filters)}`
      });
      
      await this.exportToExcel(res, normalizedData, filename);
      
    } catch (error) {
      console.error('❌ Erreur export filtré:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'export filtré: ' + error.message
      });
    }
  }

  // ============================================
  // EXPORT DES RÉSULTATS DE RECHERCHE
  // ============================================
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

  // ============================================
  // LISTE DES SITES - NOUVEAU
  // ============================================
  static async getSitesList(req, res) {
    try {
      const result = await db.query(
        'SELECT DISTINCT "SITE DE RETRAIT" as site FROM cartes WHERE "SITE DE RETRAIT" IS NOT NULL ORDER BY site'
      );
      
      const sites = result.rows.map(row => row.site).filter(site => site && site.trim() !== '');
      
      res.json({
        success: true,
        sites: sites,
        count: sites.length
      });
      
    } catch (error) {
      console.error('❌ Erreur récupération sites:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des sites'
      });
    }
  }

  // ============================================
  // STATISTIQUES IMPORT - NOUVEAU
  // ============================================
  static async getImportStats(req, res) {
    try {
      const stats = await db.query(`
        SELECT 
          COUNT(*) as total_cartes,
          COUNT(DISTINCT "SITE DE RETRAIT") as sites_count,
          COUNT(DISTINCT importbatchid) as imports_count,
          MIN(created_at) as first_import,
          MAX(created_at) as last_import
        FROM cartes
      `);
      
      const recentImports = await db.query(`
        SELECT importbatchid, COUNT(*) as count, MAX(created_at) as import_date
        FROM cartes 
        WHERE importbatchid IS NOT NULL 
        GROUP BY importbatchid 
        ORDER BY import_date DESC 
        LIMIT 10
      `);
      
      res.json({
        success: true,
        stats: {
          totalCartes: parseInt(stats.rows[0].total_cartes),
          sitesCount: parseInt(stats.rows[0].sites_count),
          importsCount: parseInt(stats.rows[0].imports_count),
          firstImport: stats.rows[0].first_import,
          lastImport: stats.rows[0].last_import
        },
        recentImports: recentImports.rows
      });
      
    } catch (error) {
      console.error('❌ Erreur statistiques:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des statistiques'
      });
    }
  }

  // ============================================
  // TÉLÉCHARGEMENT DU TEMPLATE
  // ============================================
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
      
      // Ajouter les instructions
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

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="template-import-cartes.xlsx"');

      // Journaliser le téléchargement du template
      if (req.user) {
        await journalController.logAction({
          utilisateurId: req.user.id,
          actionType: 'TELECHARGEMENT_TEMPLATE',
          tableName: 'Cartes',
          ip: req.ip,
          details: 'Téléchargement du template d\'import'
        });
      }

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

  // ============================================
  // EXPORT COMPLET
  // ============================================
  static async exportAll(req, res) {
    try {
      // Sur Render gratuit, rediriger vers l'export streaming pour éviter crash
      if (CONFIG.renderFreeTier) {
        console.log('⚠️ Render gratuit détecté, utilisation de l\'export streaming');
        return this.exportStream(req, res);
      }
      
      const result = await db.query(
        'SELECT * FROM cartes ORDER BY id LIMIT 10000' // Limite de sécurité
      );

      console.log(`📊 Cartes à exporter: ${result.rows.length} lignes`);
      
      const normalizedData = this.normalizeSQLData(result.rows);
      const filename = FileHelper.generateFilename('toutes-les-cartes');
      
      // Journaliser
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'EXPORT_CARTES',
        tableName: 'Cartes',
        details: `Export complet - ${result.rows.length} cartes`
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

  // ============================================
  // MÉTHODES UTILITAIRES
  // ============================================
  
  static async updatePerson(client, personId, updates) {
    if (Object.keys(updates).length === 0) return;
    
    const setClauses = [];
    const values = [];
    let paramIndex = 1;
    
    Object.entries(updates).forEach(([field, value]) => {
      let columnName = field;
      
      // Mapping des noms de champs
      const fieldMap = {
        'lieu_enrolement': "LIEU D'ENROLEMENT",
        'site_retrait': "SITE DE RETRAIT",
        'delivrance': "DELIVRANCE",
        'contact_retrait': "CONTACT DE RETRAIT",
        'date_delivrance': "DATE DE DELIVRANCE",
        'lieu_naissance': "LIEU NAISSANCE",
        'date_naissance': "DATE DE NAISSANCE",
        'rangement': "RANGEMENT"
      };
      
      columnName = fieldMap[field] || field;
      setClauses.push(`"${columnName}" = $${paramIndex}`);
      values.push(value);
      paramIndex++;
    });
    
    values.push(personId);
    
    const query = `
      UPDATE cartes 
      SET ${setClauses.join(', ')}
      WHERE id = $${paramIndex}
    `;
    
    await client.query(query, values);
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
}

// 🚀 EXPORT DES FONCTIONNALITÉS
module.exports = {
  importExcel: CarteImportExportService.importExcel.bind(CarteImportExportService),
  importSmartSync: CarteImportExportService.importSmartSync.bind(CarteImportExportService),
  importFiltered: CarteImportExportService.importExcel.bind(CarteImportExportService),
  exportExcel: CarteImportExportService.exportAll.bind(CarteImportExportService),
  exportStream: CarteImportExportService.exportStream.bind(CarteImportExportService),
  exportFiltered: CarteImportExportService.exportFiltered.bind(CarteImportExportService),
  exportResultats: CarteImportExportService.exportSearchResults.bind(CarteImportExportService),
  downloadTemplate: CarteImportExportService.downloadTemplate.bind(CarteImportExportService),
  getSitesList: CarteImportExportService.getSitesList.bind(CarteImportExportService),
  getImportStats: CarteImportExportService.getImportStats.bind(CarteImportExportService),
  getExportStatus: async (req, res) => {
    res.json({
      success: true,
      message: 'Fonctionnalité à implémenter'
    });
  },
  exportPDF: async (req, res) => {
    res.status(501).json({
      success: false,
      error: 'Export PDF non disponible pour le moment. Utilisez l\'export Excel.'
    });
  }
};