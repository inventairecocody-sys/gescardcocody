const { Transform } = require('stream');
const EventEmitter = require('events');
const ExcelJS = require('exceljs');
const db = require('../db/db');
const fs = require('fs').promises;
const path = require('path');

class BulkImportService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Configuration par défaut adaptée à Render gratuit
    this.options = {
      batchSize: 500,                    // Taille optimale pour PostgreSQL
      maxConcurrentBatches: 2,           // Limité pour éviter la surcharge
      memoryLimitMB: 100,                // Limite mémoire par import
      validateEachRow: true,             // Validation ligne par ligne
      skipDuplicates: true,              // Sauter les doublons automatiquement
      timeoutPerBatch: 30000,            // 30s max par lot
      cleanupTempFiles: true,            // Nettoyer les fichiers temporaires
      enableProgressTracking: true,      // Suivi de progression
      maxRowsPerImport: 100000,          // Limite sécurité
      ...options
    };
    
    // Statistiques de l'import
    this.stats = {
      totalRows: 0,
      processed: 0,
      imported: 0,
      updated: 0,
      duplicates: 0,
      skipped: 0,
      errors: 0,
      startTime: null,
      endTime: null,
      batches: 0,
      memoryPeakMB: 0
    };
    
    // Configuration Render
    this.isRenderFreeTier = db.isRenderFreeTier;
    
    // État de l'import
    this.isRunning = false;
    this.isCancelled = false;
    
    console.log('🚀 Service BulkImport initialisé avec options:', {
      batchSize: this.options.batchSize,
      maxConcurrentBatches: this.options.maxConcurrentBatches,
      isRenderFreeTier: this.isRenderFreeTier
    });
  }

  // ==================== MÉTHODE PRINCIPALE ====================

  /**
   * Importe un fichier Excel volumineux avec traitement par lots
   */
  async importLargeExcelFile(filePath, userId = null, importBatchId = null) {
    if (this.isRunning) {
      throw new Error('Un import est déjà en cours');
    }

    this.isRunning = true;
    this.isCancelled = false;
    this.stats.startTime = new Date();
    
    const finalImportBatchId = importBatchId || `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.emit('start', { 
      filePath: path.basename(filePath),
      startTime: this.stats.startTime,
      importBatchId: finalImportBatchId,
      userId 
    });

    try {
      // 1. Analyser le fichier (sans tout charger en mémoire)
      console.log('📊 Analyse du fichier Excel...');
      await this.analyzeExcelFile(filePath);
      
      if (this.stats.totalRows > this.options.maxRowsPerImport) {
        throw new Error(`Fichier trop volumineux: ${this.stats.totalRows} lignes (max: ${this.options.maxRowsPerImport})`);
      }

      this.emit('analysis', { 
        totalRows: this.stats.totalRows,
        estimatedBatches: Math.ceil(this.stats.totalRows / this.options.batchSize)
      });

      // 2. Lire et traiter le fichier par lots streamés
      console.log(`🎯 Début du traitement de ${this.stats.totalRows} lignes...`);
      await this.processExcelInBatches(filePath, finalImportBatchId, userId);

      // 3. Finaliser
      this.stats.endTime = new Date();
      const duration = this.stats.endTime - this.stats.startTime;
      
      // Calculer les performances
      const rowsPerSecond = Math.round(this.stats.processed / (duration / 1000));
      const avgBatchTime = this.stats.batches > 0 ? Math.round(duration / this.stats.batches) : 0;

      this.emit('complete', {
        stats: { ...this.stats },
        duration,
        rowsPerSecond,
        avgBatchTime,
        importBatchId: finalImportBatchId,
        successRate: this.stats.totalRows > 0 ? 
          Math.round(((this.stats.imported + this.stats.updated) / this.stats.totalRows) * 100) : 0
      });

      console.log(`✅ Import terminé en ${Math.round(duration / 1000)}s:`, {
        importés: this.stats.imported,
        misÀJour: this.stats.updated,
        doublons: this.stats.duplicates,
        erreurs: this.stats.errors,
        vitesse: `${rowsPerSecond} lignes/sec`
      });

      return {
        success: true,
        importBatchId: finalImportBatchId,
        stats: { ...this.stats },
        duration
      };

    } catch (error) {
      this.stats.endTime = new Date();
      this.emit('error', { 
        error: error.message,
        stats: { ...this.stats },
        importBatchId: finalImportBatchId
      });
      
      console.error('❌ Erreur import massif:', error);
      throw error;
      
    } finally {
      this.isRunning = false;
      
      // Nettoyage des fichiers temporaires
      if (this.options.cleanupTempFiles) {
        await this.cleanupFile(filePath);
      }
      
      // Libération mémoire
      this.forceGarbageCollection();
    }
  }

  // ==================== MÉTHODES D'ANALYSE ====================

  /**
   * Analyser le fichier Excel pour déterminer sa taille
   */
  async analyzeExcelFile(filePath) {
    try {
      // Lecture légère uniquement des métadonnées
      const workbook = new ExcelJS.Workbook();
      
      // Mode streaming pour économiser la mémoire
      await workbook.xlsx.readFile(filePath, {
        worksheets: 'emit',
        sharedStrings: 'cache',
        hyperlinks: 'ignore',
        styles: 'ignore'
      });
      
      const worksheet = workbook.getWorksheet(1);
      if (!worksheet) {
        throw new Error('Aucune feuille trouvée dans le fichier Excel');
      }
      
      this.stats.totalRows = worksheet.rowCount - 1; // Exclure l'en-tête
      this.headers = this.extractHeaders(worksheet);
      
      console.log(`📊 Fichier analysé: ${this.stats.totalRows} lignes, ${this.headers.length} colonnes`);
      
    } catch (error) {
      console.error('❌ Erreur analyse fichier:', error);
      throw new Error(`Impossible d'analyser le fichier Excel: ${error.message}`);
    }
  }

  /**
   * Extraire les en-têtes du fichier Excel
   */
  extractHeaders(worksheet) {
    const headers = [];
    const headerRow = worksheet.getRow(1);
    
    headerRow.eachCell((cell, colNumber) => {
      const header = cell.value?.toString().trim() || '';
      headers.push(header);
    });
    
    // Vérifier les en-têtes obligatoires
    const requiredHeaders = ['NOM', 'PRENOMS'];
    const missingHeaders = requiredHeaders.filter(h => 
      !headers.some(header => header.toUpperCase() === h)
    );
    
    if (missingHeaders.length > 0) {
      throw new Error(`En-têtes manquants: ${missingHeaders.join(', ')}`);
    }
    
    return headers;
  }

  // ==================== TRAITEMENT PAR LOTS ====================

  /**
   * Traiter le fichier Excel par lots streamés
   */
  async processExcelInBatches(filePath, importBatchId, userId) {
    let currentBatch = [];
    let rowNumber = 0;
    let batchIndex = 0;
    
    // Créer un reader stream pour économiser la mémoire
    const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
      worksheets: 'emit',
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      entries: 'emit'
    });
    
    for await (const worksheetReader of workbook.reader.worksheets) {
      worksheetReader.on('row', async (row) => {
        if (this.isCancelled) {
          worksheetReader.emit('stop');
          return;
        }
        
        rowNumber++;
        
        // Ignorer la ligne d'en-tête
        if (row.number === 1) return;
        
        // Extraire les données de la ligne
        const rowData = this.parseExcelRow(row, this.headers);
        
        if (this.isEmptyRow(rowData)) {
          this.stats.skipped++;
          return;
        }
        
        currentBatch.push({
          rowNumber,
          data: rowData
        });
        
        // Si le lot est complet, le traiter
        if (currentBatch.length >= this.options.batchSize) {
          await this.processBatch([...currentBatch], batchIndex, importBatchId, userId);
          currentBatch = [];
          batchIndex++;
        }
        
        // Mettre à jour la progression
        if (this.options.enableProgressTracking && rowNumber % 100 === 0) {
          const progress = Math.round((rowNumber / this.stats.totalRows) * 100);
          this.emit('progress', {
            processed: rowNumber,
            total: this.stats.totalRows,
            percentage: progress,
            currentBatch: batchIndex
          });
        }
      });
      
      // Traiter la dernière ligne
      await new Promise((resolve, reject) => {
        worksheetReader.on('end', async () => {
          try {
            // Traiter le dernier lot incomplet
            if (currentBatch.length > 0 && !this.isCancelled) {
              await this.processBatch(currentBatch, batchIndex, importBatchId, userId);
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        
        worksheetReader.on('error', reject);
        worksheetReader.process();
      });
    }
  }

  /**
   * Traiter un lot de données
   */
  async processBatch(batch, batchIndex, importBatchId, userId) {
    if (this.isCancelled || batch.length === 0) return;
    
    const batchStartTime = Date.now();
    this.stats.batches++;
    
    this.emit('batchStart', {
      batchIndex,
      size: batch.length,
      startTime: new Date()
    });
    
    const client = await db.getClient();
    
    try {
      await client.query('BEGIN');
      
      const batchResults = {
        imported: 0,
        updated: 0,
        duplicates: 0,
        errors: 0
      };
      
      // Préparer les requêtes batch
      const insertValues = [];
      const insertParams = [];
      const updateQueries = [];
      let paramIndex = 1;
      
      for (const item of batch) {
        try {
          const { rowNumber, data } = item;
          
          // Validation
          const validationErrors = this.validateRow(data, rowNumber);
          if (validationErrors.length > 0) {
            batchResults.errors++;
            this.emit('rowError', {
              rowNumber,
              errors: validationErrors,
              data
            });
            continue;
          }
          
          // Nettoyer les données
          const cleanedData = this.cleanRowData(data);
          
          // Vérifier les doublons
          if (this.options.skipDuplicates) {
            const duplicate = await this.checkDuplicate(client, cleanedData);
            if (duplicate) {
              batchResults.duplicates++;
              this.stats.duplicates++;
              continue;
            }
          }
          
          // Vérifier si mise à jour nécessaire (pour smart sync)
          const existingRecord = await this.findExistingRecord(client, cleanedData);
          
          if (existingRecord) {
            // Fusion intelligente (optionnel, selon vos règles)
            const shouldUpdate = this.shouldUpdateRecord(existingRecord, cleanedData);
            
            if (shouldUpdate) {
              await this.updateRecord(client, existingRecord.id, cleanedData);
              batchResults.updated++;
              this.stats.updated++;
            } else {
              batchResults.duplicates++;
              this.stats.duplicates++;
            }
          } else {
            // Préparer l'insertion batch
            insertValues.push(`(
              $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
              $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
              $${paramIndex++}, $${paramIndex++}, $${paramIndex++},
              $${paramIndex++}, $${paramIndex++}, $${paramIndex++}
            )`);
            
            insertParams.push(
              cleanedData["LIEU D'ENROLEMENT"] || '',
              cleanedData["SITE DE RETRAIT"] || '',
              cleanedData["RANGEMENT"] || '',
              cleanedData["NOM"] || '',
              cleanedData["PRENOMS"] || '',
              cleanedData["DATE DE NAISSANCE"] || null,
              cleanedData["LIEU NAISSANCE"] || '',
              cleanedData["CONTACT"] || '',
              cleanedData["DELIVRANCE"] || '',
              cleanedData["CONTACT DE RETRAIT"] || '',
              cleanedData["DATE DE DELIVRANCE"] || null,
              importBatchId
            );
            
            batchResults.imported++;
            this.stats.imported++;
          }
          
          this.stats.processed++;
          
        } catch (error) {
          batchResults.errors++;
          this.stats.errors++;
          console.error(`❌ Erreur ligne ${item.rowNumber}:`, error.message);
        }
      }
      
      // Exécuter l'insertion batch si nécessaire
      if (insertValues.length > 0) {
        const query = `
          INSERT INTO cartes (
            "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, nom, prenoms,
            "DATE DE NAISSANCE", "LIEU NAISSANCE", contact, delivrance,
            "CONTACT DE RETRAIT", "DATE DE DELIVRANCE", importbatchid
          ) VALUES ${insertValues.join(', ')}
        `;
        
        await client.query(query, insertParams);
      }
      
      // Journaliser le batch
      await this.logBatchImport(client, userId, importBatchId, batchIndex, batchResults);
      
      await client.query('COMMIT');
      
      const batchDuration = Date.now() - batchStartTime;
      
      this.emit('batchComplete', {
        batchIndex,
        results: batchResults,
        duration: batchDuration,
        memory: this.getMemoryUsage()
      });
      
      // Pause stratégique pour GC sur Render gratuit
      if (this.isRenderFreeTier && batchIndex % 10 === 0) {
        await this.sleep(100);
        this.forceGarbageCollection();
      }
      
      return batchResults;
      
    } catch (error) {
      await client.query('ROLLBACK');
      this.emit('batchError', {
        batchIndex,
        error: error.message,
        size: batch.length
      });
      throw error;
    } finally {
      client.release();
    }
  }

  // ==================== UTILITAIRES ====================

  /**
   * Parser une ligne Excel
   */
  parseExcelRow(row, headers) {
    const rowData = {};
    
    row.eachCell((cell, colNumber) => {
      const headerIndex = colNumber - 1;
      if (headerIndex < headers.length && cell.value !== null && cell.value !== undefined) {
        const header = headers[headerIndex];
        rowData[header] = cell.value.toString().trim();
      }
    });
    
    return rowData;
  }

  /**
   * Valider une ligne de données
   */
  validateRow(data, rowNumber) {
    const errors = [];
    
    if (!data.NOM || data.NOM.trim() === '') {
      errors.push('NOM manquant');
    }
    
    if (!data.PRENOMS || data.PRENOMS.trim() === '') {
      errors.push('PRENOMS manquant');
    }
    
    // Validation des dates
    const dateFields = ['DATE DE NAISSANCE', 'DATE DE DELIVRANCE'];
    dateFields.forEach(field => {
      if (data[field] && data[field].trim() !== '') {
        const date = new Date(data[field]);
        if (isNaN(date.getTime())) {
          errors.push(`${field} invalide: ${data[field]}`);
        }
      }
    });
    
    return errors;
  }

  /**
   * Nettoyer les données d'une ligne
   */
  cleanRowData(data) {
    const cleaned = {};
    
    Object.keys(data).forEach(key => {
      let value = data[key] || '';
      
      // Traitements spécifiques par type
      if (key.includes('DATE')) {
        if (value) {
          const date = new Date(value);
          value = isNaN(date.getTime()) ? '' : date.toISOString().split('T')[0];
        }
      } else if (key.includes('CONTACT')) {
        // Formater les numéros de téléphone
        value = this.formatPhoneNumber(value);
      } else if (typeof value === 'string') {
        value = value.trim();
      }
      
      cleaned[key] = value;
    });
    
    return cleaned;
  }

  /**
   * Formater un numéro de téléphone
   */
  formatPhoneNumber(phone) {
    if (!phone) return '';
    
    let cleaned = phone.toString().replace(/\D/g, '');
    
    // Formater pour la Côte d'Ivoire
    if (cleaned.startsWith('225')) {
      cleaned = cleaned.substring(3);
    } else if (cleaned.startsWith('00225')) {
      cleaned = cleaned.substring(5);
    }
    
    // Compléter avec des zéros si nécessaire
    if (cleaned.length > 0 && cleaned.length < 8) {
      cleaned = cleaned.padStart(8, '0');
    }
    
    return cleaned;
  }

  /**
   * Vérifier les doublons
   */
  async checkDuplicate(client, data) {
    const result = await client.query(
      `SELECT COUNT(*) as count FROM cartes 
       WHERE nom = $1 AND prenoms = $2 
       AND "DATE DE NAISSANCE"::text = COALESCE($3::text, '')
       AND "LIEU NAISSANCE" = COALESCE($4, '')`,
      [
        data.NOM || '',
        data.PRENOMS || '',
        data["DATE DE NAISSANCE"] || '',
        data["LIEU NAISSANCE"] || ''
      ]
    );
    
    return parseInt(result.rows[0].count) > 0;
  }

  /**
   * Trouver un enregistrement existant
   */
  async findExistingRecord(client, data) {
    const result = await client.query(
      `SELECT * FROM cartes 
       WHERE nom = $1 AND prenoms = $2 
       AND "DATE DE NAISSANCE"::text = COALESCE($3::text, '')
       AND "LIEU NAISSANCE" = COALESCE($4, '')
       LIMIT 1`,
      [
        data.NOM || '',
        data.PRENOMS || '',
        data["DATE DE NAISSANCE"] || '',
        data["LIEU NAISSANCE"] || ''
      ]
    );
    
    return result.rows[0] || null;
  }

  /**
   * Déterminer si une mise à jour est nécessaire
   */
  shouldUpdateRecord(existing, newData) {
    // Implémentez votre logique de fusion intelligente ici
    // Pour l'instant, on considère qu'une mise à jour est nécessaire si DELIVRANCE change
    return existing.delivrance !== newData.DELIVRANCE;
  }

  /**
   * Mettre à jour un enregistrement
   */
  async updateRecord(client, recordId, newData) {
    await client.query(`
      UPDATE cartes 
      SET delivrance = $1,
          "DATE DE DELIVRANCE" = $2,
          "CONTACT DE RETRAIT" = $3,
          dateimport = NOW()
      WHERE id = $4
    `, [
      newData.DELIVRANCE || '',
      newData["DATE DE DELIVRANCE"] || null,
      newData["CONTACT DE RETRAIT"] || '',
      recordId
    ]);
  }

  /**
   * Journaliser l'import d'un batch
   */
  async logBatchImport(client, userId, importBatchId, batchIndex, results) {
    try {
      await client.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, dateaction, action, 
          actiontype, tablename, importbatchid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        userId,
        'bulk_import_service',
        new Date(),
        `Import batch ${batchIndex}`,
        'BATCH_IMPORT',
        'Cartes',
        importBatchId,
        `Batch ${batchIndex}: ${JSON.stringify(results)}`
      ]);
    } catch (error) {
      console.warn('⚠️ Impossible de journaliser le batch:', error.message);
    }
  }

  /**
   * Vérifier si une ligne est vide
   */
  isEmptyRow(rowData) {
    return !rowData || 
           Object.keys(rowData).length === 0 || 
           Object.values(rowData).every(value => 
             value === null || value === undefined || value === '');
  }

  /**
   * Forcer le garbage collection
   */
  forceGarbageCollection() {
    if (global.gc) {
      try {
        global.gc();
        console.log('🧹 Nettoyage mémoire forcé');
      } catch (error) {
        console.warn('⚠️ Impossible de forcer le GC:', error.message);
      }
    }
  }

  /**
   * Nettoyer un fichier temporaire
   */
  async cleanupFile(filePath) {
    try {
      if (filePath && await fs.access(filePath).then(() => true).catch(() => false)) {
        await fs.unlink(filePath);
        console.log(`🗑️ Fichier temporaire supprimé: ${path.basename(filePath)}`);
      }
    } catch (error) {
      console.warn('⚠️ Impossible de supprimer le fichier temporaire:', error.message);
    }
  }

  /**
   * Pause contrôlée
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Obtenir l'utilisation mémoire
   */
  getMemoryUsage() {
    const memory = process.memoryUsage();
    const usedMB = Math.round(memory.heapUsed / 1024 / 1024);
    
    // Mettre à jour le pic mémoire
    if (usedMB > this.stats.memoryPeakMB) {
      this.stats.memoryPeakMB = usedMB;
    }
    
    return {
      usedMB,
      totalMB: Math.round(memory.heapTotal / 1024 / 1024),
      externalMB: Math.round(memory.external / 1024 / 1024),
      rssMB: Math.round(memory.rss / 1024 / 1024)
    };
  }

  /**
   * Annuler l'import en cours
   */
  cancel() {
    this.isCancelled = true;
    this.emit('cancelled', {
      stats: { ...this.stats },
      timestamp: new Date()
    });
    
    console.log('🛑 Import annulé par l\'utilisateur');
  }

  /**
   * Obtenir le statut de l'import
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      isCancelled: this.isCancelled,
      stats: { ...this.stats },
      memory: this.getMemoryUsage(),
      progress: this.stats.totalRows > 0 ? 
        Math.round((this.stats.processed / this.stats.totalRows) * 100) : 0
    };
  }
}

module.exports = BulkImportService;