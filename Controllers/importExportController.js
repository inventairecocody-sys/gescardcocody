const db = require('../db/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const journalController = require('./journalController');

// 🔧 CONFIGURATION CENTRALISÉE - OPTIMISÉE POUR RENDER GRATUIT
const CONFIG = {
  maxErrorDisplay: 10,
  dateFormat: 'YYYY-MM-DD',
  phoneFormat: '@',
  maxFileSize: 50 * 1024 * 1024,
  uploadDir: 'uploads/',
  batchSize: 500,
  
  // ⚠️ CONFIGURATION OPTIMISÉE POUR RENDER GRATUIT
  renderFreeTier: db.isRenderFreeTier || process.env.NODE_ENV === 'production',
  exportBatchSize: 1000, // Réduit pour éviter les timeouts
  importBatchSize: 500,  // Traitement par petits lots
  maxConcurrentImports: 2,
  pauseBetweenBatches: 100, // Pause en ms entre les lots
  timeoutMinutes: 10,       // Timeout total augmenté
  
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
    if (this.errorDetails.length < CONFIG.maxErrorDisplay) {
      this.errorDetails.push(error);
    }
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
      durationMs: duration,
      memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
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
      // Essayer de parser différentes formats de date
      const formats = [
        'YYYY-MM-DD',
        'DD/MM/YYYY',
        'MM/DD/YYYY',
        'YYYY/MM/DD'
      ];
      
      let date;
      for (const format of formats) {
        const moment = require('moment');
        const parsed = moment(dateString, format, true);
        if (parsed.isValid()) {
          date = parsed.toDate();
          break;
        }
      }
      
      if (!date) {
        date = new Date(dateString);
      }
      
      if (!isNaN(date.getTime())) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      }
    } catch (error) {
      console.warn(`⚠️ Impossible de parser la date: ${dateString}`);
    }
    return '';
  }

  static formatPhone(value) {
    if (!value && value !== 0) return '';
    
    const strValue = value.toString().trim();
    
    // Garder uniquement les chiffres
    const digits = strValue.replace(/\D/g, '');
    
    if (digits.length >= 8) {
      return digits.substring(0, 8);
    }
    
    return digits.padStart(8, '0');
  }
}

class PersonMatcher {
  /**
   * Détection améliorée des doublons - CORRECTION CRITIQUE
   */
  static async findExistingPerson(client, rowData) {
    try {
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
        WHERE (
          -- Matching exact des noms (insensible à la casse)
          LOWER(TRIM(nom)) = LOWER(TRIM($1))
          OR 
          -- Gestion des accents et espaces multiples
          UNACCENT(LOWER(TRIM(nom))) = UNACCENT(LOWER(TRIM($1)))
        )
        AND (
          -- Matching exact des prénoms (insensible à la casse)
          LOWER(TRIM(prenoms)) = LOWER(TRIM($2))
          OR
          -- Gestion des prénoms partiels
          LOWER(TRIM(prenoms)) LIKE LOWER(TRIM($2)) || '%'
          OR
          LOWER(TRIM($2)) LIKE LOWER(TRIM(prenoms)) || '%'
          OR
          -- Gestion des accents
          UNACCENT(LOWER(TRIM(prenoms))) = UNACCENT(LOWER(TRIM($2)))
        )
        AND (
          -- Gestion flexible des dates de naissance
          ("DATE DE NAISSANCE" IS NULL AND ($3::date IS NULL OR $3 = ''))
          OR "DATE DE NAISSANCE" = $3::date
          OR (
            $3::date IS NOT NULL 
            AND EXTRACT(YEAR FROM "DATE DE NAISSANCE") = EXTRACT(YEAR FROM $3::date)
            AND EXTRACT(MONTH FROM "DATE DE NAISSANCE") = EXTRACT(MONTH FROM $3::date)
            AND EXTRACT(DAY FROM "DATE DE NAISSANCE") = EXTRACT(DAY FROM $3::date)
          )
        )
        LIMIT 1
      `, [
        rowData.NOM || '',
        rowData.PRENOMS || '',
        rowData["DATE DE NAISSANCE"] || null
      ]);

      return result.rows[0] || null;
    } catch (error) {
      console.error('❌ Erreur lors de la recherche de doublons:', error);
      return null;
    }
  }
}

class SmartSync {
  static syncWithExisting(existingPerson, newData) {
    const updates = {};
    const changes = [];
    
    // 1. DÉLIVRANCE - TOUJOURS mettre à jour si différent
    if (newData.DELIVRANCE && newData.DELIVRANCE !== existingPerson.delivrance) {
      updates.delivrance = newData.DELIVRANCE;
      changes.push(`Délivrance: ${existingPerson.delivrance || '(vide)'} → ${newData.DELIVRANCE}`);
    }
    
    // 2. AUTRES CHAMPS - Mettre à jour si différent ET non vide
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
      existingId: existingPerson.id
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

// 🎯 SERVICE PRINCIPAL - IMPORT/EXPORT OPTIMISÉ
class CarteImportExportService {
  // ============================================
  // IMPORTATION STANDARD - CORRIGÉE
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
    let transactionActive = false;
    
    try {
      console.log('📁 Fichier reçu:', {
        name: req.file.originalname,
        size: req.file.size,
        importBatchID: importBatchID
      });

      if (!req.user) {
        FileHelper.safeDelete(req.file.path);
        return res.status(401).json({
          success: false,
          error: 'Utilisateur non authentifié'
        });
      }

      // Journaliser début
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_IMPORT',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import standard: ${req.file.originalname} (${req.file.size} octets)`
      });

      await client.query('BEGIN');
      transactionActive = true;

      const worksheet = await ExcelHelper.readExcelFile(req.file.path);
      console.log(`📊 Fichier chargé: ${worksheet.rowCount} lignes`);

      const headers = this.extractHeaders(worksheet);
      const missingHeaders = DataValidator.validateHeaders(headers);
      
      if (missingHeaders.length > 0) {
        FileHelper.safeDelete(req.file.path);
        await client.query('ROLLBACK');
        transactionActive = false;
        
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
      const startTime = Date.now();
      
      // Traitement optimisé avec pauses
      await this.processImportOptimized(client, worksheet, headers, result, req, importBatchID);
      
      await client.query('COMMIT');
      transactionActive = false;
      
      FileHelper.safeDelete(req.file.path);
      console.timeEnd('⏱️ Import Excel');

      const stats = result.getStats();
      console.log('📊 RÉSULTAT FINAL:', stats);

      // Journaliser fin
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_IMPORT',
        tableName: 'Cartes',
        importBatchID: importBatchID,
        details: `Import standard terminé - ${stats.imported} importées, ${stats.errors} erreurs en ${stats.duration}`
      });

      res.json({
        success: true,
        message: 'Import standard terminé',
        stats: stats,
        importBatchID: importBatchID
      });

    } catch (error) {
      console.error('❌ Erreur import standard:', error);
      
      if (transactionActive) {
        try {
          await client.query('ROLLBACK');
          transactionActive = false;
        } catch (rollbackError) {
          console.warn('⚠️ Erreur lors du rollback:', rollbackError.message);
        }
      }
      
      FileHelper.safeDelete(req.file.path);
      
      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'import: ' + error.message,
        importBatchID: importBatchID
      });
    } finally {
      // CORRECTION CRITIQUE : UNIQUEMENT ICI on libère le client
      if (client && typeof client.release === 'function') {
        try {
          client.release();
        } catch (releaseError) {
          console.warn('⚠️ Client déjà libéré, ignore...');
        }
      }
    }
  }

  // ============================================
  // TRAITEMENT IMPORT OPTIMISÉ - AVEC PAUSES
  // ============================================
  static async processImportOptimized(client, worksheet, headers, result, req, importBatchID) {
    const totalRows = worksheet.rowCount - 1;
    console.log(`🎯 Début traitement de ${totalRows} lignes`);
    
    let batchCount = 0;
    const startTime = Date.now();

    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      try {
        result.totalProcessed++;
        
        // Log de progression
        if (rowNumber % 500 === 0) {
          const elapsed = Date.now() - startTime;
          const progress = Math.round((rowNumber / worksheet.rowCount) * 100);
          const speed = Math.round(rowNumber / (elapsed / 1000));
          console.log(`📈 Progression: ${progress}% (${rowNumber}/${worksheet.rowCount}) - ${speed} lignes/sec`);
        }

        const rowData = this.extractRowData(worksheet.getRow(rowNumber), headers);
        
        if (this.isEmptyRow(rowData)) {
          continue;
        }

        // Validation et nettoyage
        const validationErrors = DataValidator.validateRow(rowData, rowNumber);
        if (validationErrors.length > 0) {
          result.errorDetails.push(...validationErrors);
          result.errors++;
          continue;
        }

        const cleanedData = this.cleanRowData(rowData);

        // VÉRIFICATION DES DOUBLONS AMÉLIORÉE - CORRECTION CRITIQUE
        const isDuplicate = await this.checkForDuplicate(client, cleanedData, rowNumber);
        
        if (isDuplicate) {
          console.log(`⚠️ Doublon détecté ligne ${rowNumber}: ${cleanedData.NOM} ${cleanedData.PRENOMS}`);
          result.duplicates++;
          continue;
        }

        // Insertion
        const carteId = await this.insertRowData(client, cleanedData, importBatchID);
        result.imported++;

        // Journaliser (uniquement toutes les 100 lignes pour éviter la surcharge)
        if (rowNumber % 100 === 0) {
          await journalController.logAction({
            utilisateurId: req.user.id,
            actionType: 'IMPORT_CARTE_BATCH',
            tableName: 'Cartes',
            importBatchID: importBatchID,
            details: `Import batch - ${rowNumber} lignes traitées, ${result.imported} importées`
          });
        }

        // PAUSE STRATÉGIQUE POUR RENDER GRATUIT
        if (CONFIG.renderFreeTier && rowNumber % CONFIG.importBatchSize === 0) {
          batchCount++;
          console.log(`⏸️ Pause stratégique après lot ${batchCount} (ligne ${rowNumber})`);
          await new Promise(resolve => setTimeout(resolve, CONFIG.pauseBetweenBatches));
          
          // Nettoyage mémoire périodique
          if (global.gc && batchCount % 5 === 0) {
            global.gc();
            console.log(`🧹 GC forcé après lot ${batchCount}`);
          }
        }

      } catch (error) {
        result.addError(`Ligne ${rowNumber}: ${error.message}`);
        console.error(`❌ Erreur ligne ${rowNumber}:`, error.message);
        
        // Continuer avec la ligne suivante même en cas d'erreur
        continue;
      }
    }

    console.log('✅ Traitement de toutes les lignes terminé');
  }

  // ============================================
  // VÉRIFICATION DOUBLONS AMÉLIORÉE - CORRECTION
  // ============================================
  static async checkForDuplicate(client, rowData, rowNumber) {
    try {
      // Requête de détection de doublon optimisée
      const result = await client.query(`
        SELECT COUNT(*) as count 
        FROM cartes 
        WHERE (
          -- Matching strict (insensible à la casse)
          LOWER(TRIM(nom)) = LOWER(TRIM($1))
          AND LOWER(TRIM(prenoms)) = LOWER(TRIM($2))
        )
        OR (
          -- Matching flexible pour noms similaires
          (
            LOWER(TRIM(nom)) LIKE LOWER(TRIM($1)) || '%'
            OR LOWER(TRIM($1)) LIKE LOWER(TRIM(nom)) || '%'
          )
          AND (
            LOWER(TRIM(prenoms)) LIKE LOWER(TRIM($2)) || '%'
            OR LOWER(TRIM($2)) LIKE LOWER(TRIM(prenoms)) || '%'
          )
          -- Vérification additionnelle pour éviter faux positifs
          AND (
            COALESCE("DATE DE NAISSANCE"::text, '') = COALESCE($3::text, '')
            OR COALESCE("LIEU NAISSANCE", '') = COALESCE($4, '')
          )
        )
        LIMIT 1
      `, [
        rowData.NOM || '',
        rowData.PRENOMS || '',
        rowData["DATE DE NAISSANCE"] || null,
        rowData["LIEU NAISSANCE"] || ''
      ]);

      const isDuplicate = parseInt(result.rows[0].count) > 0;
      
      // Log détaillé pour débogage
      if (isDuplicate) {
        console.log(`🔍 Détection doublon ligne ${rowNumber}:`, {
          nom: rowData.NOM,
          prenoms: rowData.PRENOMS,
          dateNaissance: rowData["DATE DE NAISSANCE"],
          count: result.rows[0].count
        });
      }
      
      return isDuplicate;
    } catch (error) {
      console.error(`❌ Erreur vérification doublon ligne ${rowNumber}:`, error.message);
      return false; // En cas d'erreur, ne pas bloquer l'import
    }
  }

  // ============================================
  // IMPORTATION INTELLIGENTE (SMART SYNC)
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
    let transactionActive = false;
    
    try {
      console.log('📁 Fichier reçu (smart sync):', {
        name: req.file.originalname,
        importBatchID: importBatchID
      });

      if (!req.user) {
        FileHelper.safeDelete(req.file.path);
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

      await client.query('BEGIN');
      transactionActive = true;

      const worksheet = await ExcelHelper.readExcelFile(req.file.path);
      console.log(`📊 Fichier chargé: ${worksheet.rowCount} lignes`);

      const headers = this.extractHeaders(worksheet);
      const missingHeaders = DataValidator.validateHeaders(headers);
      
      if (missingHeaders.length > 0) {
        FileHelper.safeDelete(req.file.path);
        await client.query('ROLLBACK');
        transactionActive = false;
        
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

      // Traitement intelligent optimisé
      const result = await this.processSmartImportOptimized(
        client, 
        worksheet, 
        headers, 
        req, 
        importBatchID
      );
      
      await client.query('COMMIT');
      transactionActive = false;
      
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
      console.error('❌ Erreur import intelligent:', error);
      
      if (transactionActive) {
        try {
          await client.query('ROLLBACK');
          transactionActive = false;
        } catch (rollbackError) {
          console.warn('⚠️ Erreur lors du rollback:', rollbackError.message);
        }
      }
      
      FileHelper.safeDelete(req.file.path);
      
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la synchronisation: ' + error.message,
        importBatchID: importBatchID
      });
    } finally {
      // CORRECTION CRITIQUE : UNIQUEMENT ICI on libère le client
      if (client && typeof client.release === 'function') {
        try {
          client.release();
        } catch (releaseError) {
          console.warn('⚠️ Client déjà libéré, ignore...');
        }
      }
    }
  }

  // ============================================
  // TRAITEMENT IMPORT INTELLIGENT OPTIMISÉ
  // ============================================
  static async processSmartImportOptimized(client, worksheet, headers, req, importBatchID) {
    const stats = {
      processed: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      errors: 0
    };
    
    const startTime = Date.now();
    let batchCount = 0;

    console.log(`🎯 Début traitement intelligent de ${worksheet.rowCount - 1} lignes`);

    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      try {
        stats.processed++;
        
        // Log de progression
        if (rowNumber % 500 === 0) {
          const elapsed = Date.now() - startTime;
          const progress = Math.round((rowNumber / worksheet.rowCount) * 100);
          console.log(`📈 Smart sync: ${progress}% (${rowNumber}/${worksheet.rowCount})`);
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
          stats.errors++;
          console.warn(`⚠️ Validation erreur ligne ${rowNumber}:`, validationErrors);
          continue;
        }

        // Recherche de la personne existante
        const existingPerson = await PersonMatcher.findExistingPerson(client, cleanedData);
        
        if (existingPerson) {
          // Synchronisation selon les règles
          const syncResult = SmartSync.syncWithExisting(existingPerson, cleanedData);
          
          if (syncResult.shouldUpdate) {
            // Mise à jour
            await this.updatePerson(client, existingPerson.id, syncResult.updates);
            stats.updated++;
            
            // Journaliser (batch)
            if (rowNumber % 100 === 0) {
              await journalController.logAction({
                utilisateurId: req.user.id,
                actionType: 'UPDATE_CARTE_BATCH',
                tableName: 'Cartes',
                importBatchID: importBatchID,
                details: `Mises à jour batch - ${rowNumber} lignes traitées`
              });
            }
          } else {
            // Aucun changement - ignorer
            stats.skipped++;
          }
        } else {
          // NOUVELLE PERSONNE
          const carteId = await this.insertRowData(client, cleanedData, importBatchID);
          stats.imported++;
        }

        // PAUSE STRATÉGIQUE POUR RENDER GRATUIT
        if (CONFIG.renderFreeTier && rowNumber % CONFIG.importBatchSize === 0) {
          batchCount++;
          console.log(`⏸️ Pause stratégique smart sync lot ${batchCount} (ligne ${rowNumber})`);
          await new Promise(resolve => setTimeout(resolve, CONFIG.pauseBetweenBatches));
        }

      } catch (error) {
        stats.errors++;
        console.error(`❌ Erreur ligne ${rowNumber}:`, error.message);
      }
    }

    console.log('✅ Traitement intelligent terminé');
    
    return {
      stats,
      summary: {
        total: stats.processed,
        new: stats.imported,
        updated: stats.updated,
        skipped: stats.skipped,
        errors: stats.errors,
        duration: `${Math.round((Date.now() - startTime) / 1000)}s`
      }
    };
  }

  // ============================================
  // EXPORT STREAMING OPTIMISÉ POUR RENDER
  // ============================================
  static async exportStream(req, res) {
    console.time('⏱️ Export Streaming');
    console.log('🚀 DEBUT EXPORT STREAMING OPTIMISÉ');
    
    const streamId = `export_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Journaliser début export
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_STREAM',
        tableName: 'Cartes',
        details: 'Export streaming optimisé démarré'
      });
      
      // Configuration streaming
      res.setTimeout(300000); // Timeout de 5 minutes
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="cartes-export.xlsx"');
      
      const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: res,
        useStyles: false,
        useSharedStrings: false
      });
      
      const worksheet = workbook.addWorksheet('Cartes');
      
      // En-têtes
      const headerRow = worksheet.addRow(CONFIG.columns.map(col => col.key));
      headerRow.font = { bold: true };
      headerRow.commit();
      
      let totalRows = 0;
      let batchCount = 0;
      const startTime = Date.now();
      
      // Utilisation du streaming de PostgreSQL
      const query = 'SELECT * FROM cartes ORDER BY id';
      const stream = await db.queryStreamOptimized(query, [], CONFIG.exportBatchSize);
      
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
          console.log(`📦 Export: ${totalRows} lignes, ${batchCount} lots, mémoire: ${Math.round(memory.heapUsed / 1024 / 1024)}MB`);
        }
        
        // Pause pour GC sur Render gratuit
        if (CONFIG.renderFreeTier && batchCount % 20 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
          if (global.gc) global.gc();
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
      
    } catch (error) {
      console.error('❌ Erreur export streaming:', error);
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_STREAM',
        tableName: 'Cartes',
        details: `Erreur export streaming: ${error.message}`
      });
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur lors de l\'export streaming: ' + error.message
        });
      }
    }
  }

  // ============================================
  // EXPORT FILTRÉ - FONCTION AJOUTÉE POUR RÉSOUDRE L'ERREUR
  // ============================================
  static async exportFiltered(req, res) {
    try {
      console.log('🔍 Export filtré avec paramètres:', req.body);
      
      const { filters = {} } = req.body;
      
      let query = 'SELECT * FROM cartes WHERE 1=1';
      const params = [];
      let paramIndex = 1;
      
      // Appliquer les filtres
      if (filters.sites && filters.sites.length > 0) {
        const placeholders = filters.sites.map((_, i) => `$${paramIndex + i}`).join(', ');
        query += ` AND "SITE DE RETRAIT" IN (${placeholders})`;
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
      
      console.log('📝 Requête SQL filtrée:', query);
      const result = await db.query(query, params);
      console.log(`📊 Résultats filtrés à exporter: ${result.rows.length} lignes`);

      const normalizedData = this.normalizeSQLData(result.rows);
      const filename = FileHelper.generateFilename('export-filtre');
      
      // Journaliser l'export filtré
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'EXPORT_FILTRE',
        tableName: 'Cartes',
        details: `Export filtré - ${result.rows.length} cartes - Filtres: ${JSON.stringify(filters)}`
      });
      
      // Utiliser l'export standard pour les données filtrées
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

      query += ' ORDER BY id LIMIT 10000'; // Limite de sécurité
      
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
        details: `Export résultats recherche - ${result.rows.length} cartes`
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
  // MÉTHODES UTILITAIRES
  // ============================================
  
  static async updatePerson(client, personId, updates) {
    if (Object.keys(updates).length === 0) return;
    
    const setClauses = [];
    const values = [];
    let paramIndex = 1;
    
    Object.entries(updates).forEach(([field, value]) => {
      let columnName = field;
      
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

      // Limiter à 10000 lignes pour éviter les problèmes de mémoire
      const limitedData = data.slice(0, 10000);
      
      limitedData.forEach(item => {
        const rowData = {};
        CONFIG.columns.forEach(column => {
          rowData[column.key.replace(/\s+/g, '_')] = item[column.key] || '';
        });
        worksheet.addRow(rowData);
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      await workbook.xlsx.write(res);
      console.timeEnd(`⏱️ Export ${filename}`);

    } catch (error) {
      console.error(`❌ Erreur export ${filename}:`, error);
      throw error;
    }
  }

  // ============================================
  // AUTRES FONCTIONNALITÉS
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
      console.error('❌ Erreur statistiques import:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération des statistiques import'
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
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="template-import-cartes.xlsx"');

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
  // FONCTIONS MANQUANTES POUR ÉVITER LES ERREURS
  // ============================================

  static async getExportStatus(req, res) {
    try {
      const { batchId } = req.params;
      
      res.json({
        success: true,
        message: 'Fonctionnalité de suivi d\'export',
        batchId,
        status: 'completed',
        timestamp: new Date().toISOString(),
        note: 'Pour les exports en streaming, utilisez les logs en temps réel'
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Erreur lors de la récupération du statut d\'export'
      });
    }
  }

  static async exportPDF(req, res) {
    res.status(501).json({
      success: false,
      error: 'Export PDF non disponible pour le moment. Utilisez l\'export Excel.'
    });
  }
}

// 🚀 EXPORT DES FONCTIONNALITÉS COMPLÈTES
module.exports = {
  // Import
  importExcel: CarteImportExportService.importExcel.bind(CarteImportExportService),
  importSmartSync: CarteImportExportService.importSmartSync.bind(CarteImportExportService),
  
  // Export
  exportStream: CarteImportExportService.exportStream.bind(CarteImportExportService),
  exportFiltered: CarteImportExportService.exportFiltered.bind(CarteImportExportService), // AJOUTÉ
  exportResultats: CarteImportExportService.exportSearchResults.bind(CarteImportExportService),
  
  // Fonctions redirigées pour Render
  exportExcel: async (req, res) => {
    return CarteImportExportService.exportStream(req, res);
  },
  
  exportOptimized: async (req, res) => {
    return CarteImportExportService.exportStream(req, res);
  },
  
  // Utilitaires
  downloadTemplate: CarteImportExportService.downloadTemplate.bind(CarteImportExportService),
  getSitesList: CarteImportExportService.getSitesList.bind(CarteImportExportService),
  getImportStats: CarteImportExportService.getImportStats.bind(CarteImportExportService),
  
  // Fonctions pour éviter les erreurs de route
  getExportStatus: CarteImportExportService.getExportStatus.bind(CarteImportExportService),
  exportPDF: CarteImportExportService.exportPDF.bind(CarteImportExportService)
};