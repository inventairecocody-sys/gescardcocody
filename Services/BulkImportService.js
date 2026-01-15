const { Transform } = require('stream');
const EventEmitter = require('events');
const ExcelJS = require('exceljs');
const db = require('../db/db');
const fs = require('fs').promises;
const path = require('path');

class BulkImportService extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Détection de l'environnement Render gratuit
    this.isRenderFreeTier = process.env.NODE_ENV === 'production' && !process.env.RENDER_PAID_TIER;
    
    // CONFIGURATION OPTIMISÉE POUR RENDER GRATUIT
    const defaultOptions = {
      // 🎯 OPTIMISATIONS RENDER GRATUIT
      batchSize: this.isRenderFreeTier ? 250 : 500,           // Lots plus petits sur Render
      maxConcurrentBatches: this.isRenderFreeTier ? 1 : 2,   // 1 seul lot à la fois
      memoryLimitMB: this.isRenderFreeTier ? 80 : 150,        // Limite mémoire stricte
      timeoutPerBatch: this.isRenderFreeTier ? 25000 : 30000, // 25s sur Render (prévenir 30s)
      pauseBetweenBatches: this.isRenderFreeTier ? 200 : 100, // Pauses plus longues
      
      // 🔧 CONFIGURATION STANDARD
      validateEachRow: true,
      skipDuplicates: true,
      cleanupTempFiles: true,
      enableProgressTracking: true,
      maxRowsPerImport: this.isRenderFreeTier ? 50000 : 100000,
      enableBatchRollback: true,           // Rollback par batch en cas d'erreur
      useTransactionPerBatch: true,        // Transaction par batch pour isolation
      logBatchFrequency: this.isRenderFreeTier ? 20 : 10, // Log moins fréquent
      forceGarbageCollection: this.isRenderFreeTier // GC forcé sur Render
    };
    
    this.options = { ...defaultOptions, ...options };
    
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
      memoryPeakMB: 0,
      lastProgressUpdate: 0
    };
    
    // État de l'import
    this.isRunning = false;
    this.isCancelled = false;
    this.currentBatch = 0;
    this.lastBatchTime = null;
    
    console.log('🚀 Service BulkImport initialisé:', {
      environnement: this.isRenderFreeTier ? 'Render Gratuit' : 'Normal',
      batchSize: this.options.batchSize,
      maxRows: this.options.maxRowsPerImport,
      timeoutBatch: `${this.options.timeoutPerBatch}ms`,
      pauseBetweenBatches: `${this.options.pauseBetweenBatches}ms`
    });
  }

  // ==================== MÉTHODE PRINCIPALE - OPTIMISÉE ====================

  /**
   * Importe un fichier Excel volumineux avec traitement par lots OPTIMISÉ
   */
  async importLargeExcelFile(filePath, userId = null, importBatchId = null) {
    if (this.isRunning) {
      throw new Error('Un import est déjà en cours');
    }

    this.isRunning = true;
    this.isCancelled = false;
    this.stats.startTime = new Date();
    this.currentBatch = 0;
    
    const finalImportBatchId = importBatchId || `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.emit('start', { 
      filePath: path.basename(filePath),
      startTime: this.stats.startTime,
      importBatchId: finalImportBatchId,
      userId,
      environment: this.isRenderFreeTier ? 'render-free' : 'normal'
    });

    try {
      // 1. ANALYSE LÉGÈRE DU FICHIER (Streaming uniquement)
      console.log('📊 Analyse légère du fichier Excel (mode streaming)...');
      await this.analyzeExcelFileStreaming(filePath);
      
      // Vérification des limites Render
      if (this.isRenderFreeTier) {
        await this.validateForRenderFreeTier(filePath);
      }
      
      if (this.stats.totalRows > this.options.maxRowsPerImport) {
        throw new Error(`Fichier trop volumineux: ${this.stats.totalRows} lignes (max: ${this.options.maxRowsPerImport})`);
      }

      this.emit('analysis', { 
        totalRows: this.stats.totalRows,
        estimatedBatches: Math.ceil(this.stats.totalRows / this.options.batchSize),
        estimatedTime: this.estimateTotalTime(this.stats.totalRows),
        warnings: this.isRenderFreeTier ? [
          '⚠️ Render gratuit - optimisations activées',
          '⏱️ Timeout batch: 25s',
          '📦 Taille batch: 250 lignes',
          '⏸️ Pause entre batches: 200ms'
        ] : []
      });

      // 2. TRAITEMENT PAR LOTS AVEC STREAMING OPTIMISÉ
      console.log(`🎯 Début du traitement de ${this.stats.totalRows} lignes...`);
      const importResult = await this.processExcelWithOptimizedStreaming(
        filePath, 
        finalImportBatchId, 
        userId
      );

      // 3. FINALISATION
      this.stats.endTime = new Date();
      const duration = this.stats.endTime - this.stats.startTime;
      
      // Calculer les performances
      const performance = this.calculatePerformance(duration);
      
      this.emit('complete', {
        stats: { ...this.stats },
        duration,
        performance,
        importBatchId: finalImportBatchId,
        successRate: this.stats.totalRows > 0 ? 
          Math.round(((this.stats.imported + this.stats.updated) / this.stats.totalRows) * 100) : 0,
        environment: this.isRenderFreeTier ? 'render-free' : 'normal'
      });

      console.log(`✅ Import terminé en ${Math.round(duration / 1000)}s:`, {
        importés: this.stats.imported,
        misÀJour: this.stats.updated,
        doublons: this.stats.duplicates,
        erreurs: this.stats.errors,
        vitesse: `${performance.rowsPerSecond} lignes/sec`,
        mémoirePic: `${this.stats.memoryPeakMB}MB`
      });

      return {
        success: true,
        importBatchId: finalImportBatchId,
        stats: { ...this.stats },
        duration,
        performance,
        environment: this.isRenderFreeTier ? 'render-free' : 'normal'
      };

    } catch (error) {
      this.stats.endTime = new Date();
      
      this.emit('error', { 
        error: error.message,
        stats: { ...this.stats },
        importBatchId: finalImportBatchId,
        duration: this.stats.endTime - this.stats.startTime
      });
      
      console.error('❌ Erreur import massif:', error.message);
      throw error;
      
    } finally {
      this.isRunning = false;
      
      // NETTOYAGE OPTIMISÉ POUR RENDER
      await this.optimizedCleanup(filePath);
      
      // Libération mémoire FORCÉE sur Render gratuit
      if (this.options.forceGarbageCollection) {
        this.forceGarbageCollection();
      }
    }
  }

  // ==================== ANALYSE OPTIMISÉE ====================

  /**
   * Analyser le fichier Excel en mode streaming pour économiser la mémoire
   */
  async analyzeExcelFileStreaming(filePath) {
    try {
      // Utiliser WorkbookReader au lieu de Workbook pour économiser la mémoire
      const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
        worksheets: 'emit',
        sharedStrings: 'ignore',      // Ignorer les strings partagées pour économiser
        hyperlinks: 'ignore',         // Ignorer les hyperliens
        styles: 'ignore',             // Ignorer les styles
        entries: 'emit'
      });
      
      let rowCount = 0;
      let headers = [];
      
      for await (const worksheetReader of workbookReader.reader.worksheets) {
        let isFirstRow = true;
        
        await new Promise((resolve, reject) => {
          worksheetReader.on('row', (row) => {
            if (isFirstRow) {
              // Extraire les en-têtes de la première ligne
              headers = this.extractHeadersFromRow(row);
              isFirstRow = false;
            } else {
              rowCount++;
            }
          });
          
          worksheetReader.on('end', resolve);
          worksheetReader.on('error', reject);
          worksheetReader.process();
        });
        
        break; // On ne traite que la première feuille
      }
      
      this.stats.totalRows = rowCount;
      this.headers = headers;
      
      // Vérifier les en-têtes obligatoires
      this.validateHeaders(headers);
      
      console.log(`📊 Fichier analysé (streaming): ${this.stats.totalRows} lignes`);
      
    } catch (error) {
      console.error('❌ Erreur analyse streaming:', error);
      throw new Error(`Impossible d'analyser le fichier Excel: ${error.message}`);
    }
  }

  /**
   * Valider pour Render gratuit
   */
  async validateForRenderFreeTier(filePath) {
    if (!this.isRenderFreeTier) return;
    
    const stats = await fs.stat(filePath);
    const fileSizeMB = stats.size / 1024 / 1024;
    
    if (fileSizeMB > 30) {
      throw new Error(`Fichier trop volumineux (${fileSizeMB.toFixed(1)}MB) pour Render gratuit (max 30MB)`);
    }
    
    if (this.stats.totalRows > 20000) {
      console.warn(`⚠️ Gros fichier détecté sur Render gratuit: ${this.stats.totalRows} lignes`);
    }
  }

  // ==================== TRAITEMENT STREAMING OPTIMISÉ ====================

  /**
   * Traitement par lots avec streaming optimisé pour Render
   */
  async processExcelWithOptimizedStreaming(filePath, importBatchId, userId) {
    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
      worksheets: 'emit',
      sharedStrings: 'cache',
      hyperlinks: 'ignore',
      styles: 'ignore',
      entries: 'emit'
    });
    
    let currentBatch = [];
    let rowNumber = 0;
    let batchIndex = 0;
    
    for await (const worksheetReader of workbookReader.reader.worksheets) {
      await new Promise((resolve, reject) => {
        worksheetReader.on('row', async (row) => {
          if (this.isCancelled) {
            worksheetReader.emit('stop');
            reject(new Error('Import annulé'));
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
          
          // Si le lot est complet, le traiter avec timeout
          if (currentBatch.length >= this.options.batchSize) {
            await this.processBatchWithTimeout(
              [...currentBatch], 
              batchIndex, 
              importBatchId, 
              userId
            );
            currentBatch = [];
            batchIndex++;
            this.currentBatch = batchIndex;
            
            // Mise à jour de la progression
            this.updateProgress(rowNumber);
          }
        });
        
        worksheetReader.on('end', async () => {
          try {
            // Traiter le dernier lot
            if (currentBatch.length > 0 && !this.isCancelled) {
              await this.processBatchWithTimeout(
                currentBatch, 
                batchIndex, 
                importBatchId, 
                userId
              );
              this.currentBatch = batchIndex + 1;
            }
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        
        worksheetReader.on('error', reject);
        worksheetReader.process();
      });
      
      break; // Une seule feuille
    }
    
    return { batches: this.currentBatch };
  }

  /**
   * Traiter un lot avec timeout contrôlé
   */
  async processBatchWithTimeout(batch, batchIndex, importBatchId, userId) {
    if (this.isCancelled || batch.length === 0) return;
    
    const batchStartTime = Date.now();
    this.lastBatchTime = batchStartTime;
    
    this.stats.batches++;
    
    this.emit('batchStart', {
      batchIndex,
      size: batch.length,
      startTime: new Date(),
      memoryBefore: this.getMemoryUsage()
    });
    
    // Timeout pour éviter les blocs sur Render
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout batch ${batchIndex} après ${this.options.timeoutPerBatch}ms`));
      }, this.options.timeoutPerBatch);
    });
    
    try {
      const batchResults = await Promise.race([
        this.processOptimizedBatch(batch, batchIndex, importBatchId, userId),
        timeoutPromise
      ]);
      
      const batchDuration = Date.now() - batchStartTime;
      
      this.emit('batchComplete', {
        batchIndex,
        results: batchResults,
        duration: batchDuration,
        memory: this.getMemoryUsage(),
        rowsPerSecond: batch.length > 0 ? Math.round(batch.length / (batchDuration / 1000)) : 0
      });
      
      // Pause stratégique pour GC sur Render
      if (this.isRenderFreeTier && batchIndex % 5 === 0) {
        await this.sleep(this.options.pauseBetweenBatches);
        
        if (this.options.forceGarbageCollection && batchIndex % 10 === 0) {
          this.forceGarbageCollection();
        }
      }
      
      return batchResults;
      
    } catch (error) {
      this.emit('batchError', {
        batchIndex,
        error: error.message,
        size: batch.length,
        duration: Date.now() - batchStartTime
      });
      
      // Rollback optionnel
      if (this.options.enableBatchRollback) {
        console.warn(`⚠️ Rollback batch ${batchIndex} après erreur: ${error.message}`);
      }
      
      throw error;
    }
  }

  /**
   * Traitement optimisé d'un batch
   */
  async processOptimizedBatch(batch, batchIndex, importBatchId, userId) {
    const client = await db.getClient();
    const batchResults = {
      imported: 0,
      updated: 0,
      duplicates: 0,
      errors: 0
    };
    
    try {
      if (this.options.useTransactionPerBatch) {
        await client.query('BEGIN');
      }
      
      // Préparer les requêtes batch
      const insertValues = [];
      const insertParams = [];
      let paramIndex = 1;
      
      for (const item of batch) {
        try {
          const { rowNumber, data } = item;
          
          // Validation rapide
          if (!this.validateRequiredFields(data)) {
            batchResults.errors++;
            continue;
          }
          
          // Nettoyer les données
          const cleanedData = this.cleanRowData(data);
          
          // Vérification doublon optimisée
          if (this.options.skipDuplicates) {
            const isDuplicate = await this.checkDuplicateOptimized(client, cleanedData);
            if (isDuplicate) {
              batchResults.duplicates++;
              this.stats.duplicates++;
              continue;
            }
          }
          
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
          this.stats.processed++;
          
        } catch (error) {
          batchResults.errors++;
          this.stats.errors++;
        }
      }
      
      // Insertion batch si nécessaire
      if (insertValues.length > 0) {
        const query = `
          INSERT INTO cartes (
            "LIEU D'ENROLEMENT", "SITE DE RETRAIT", rangement, nom, prenoms,
            "DATE DE NAISSANCE", "LIEU NAISSANCE", contact, delivrance,
            "CONTACT DE RETRAIT", "DATE DE DELIVRANCE", importbatchid
          ) VALUES ${insertValues.join(', ')}
          ON CONFLICT (nom, prenoms, "DATE DE NAISSANCE", "LIEU NAISSANCE") 
          DO UPDATE SET 
            delivrance = EXCLUDED.delivrance,
            "CONTACT DE RETRAIT" = COALESCE(EXCLUDED."CONTACT DE RETRAIT", cartes."CONTACT DE RETRAIT"),
            dateimport = NOW()
          RETURNING id
        `;
        
        const result = await client.query(query, insertParams);
        batchResults.updated = result.rowCount - insertValues.length;
        this.stats.updated += batchResults.updated;
      }
      
      // Journalisation allégée
      await this.logBatchOptimized(client, userId, importBatchId, batchIndex, batchResults);
      
      if (this.options.useTransactionPerBatch) {
        await client.query('COMMIT');
      }
      
      return batchResults;
      
    } catch (error) {
      if (this.options.useTransactionPerBatch) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  // ==================== UTILITAIRES OPTIMISÉS ====================

  /**
   * Extraire les en-têtes d'une ligne
   */
  extractHeadersFromRow(row) {
    const headers = [];
    row.eachCell((cell, colNumber) => {
      headers.push(cell.value?.toString().trim() || `Colonne${colNumber}`);
    });
    return headers;
  }

  /**
   * Valider les en-têtes
   */
  validateHeaders(headers) {
    const requiredHeaders = ['NOM', 'PRENOMS'];
    const missingHeaders = requiredHeaders.filter(h => 
      !headers.some(header => header.toUpperCase() === h)
    );
    
    if (missingHeaders.length > 0) {
      throw new Error(`En-têtes manquants: ${missingHeaders.join(', ')}`);
    }
  }

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
   * Validation rapide des champs requis
   */
  validateRequiredFields(data) {
    return data.NOM && data.NOM.trim() !== '' && 
           data.PRENOMS && data.PRENOMS.trim() !== '';
  }

  /**
   * Nettoyer les données d'une ligne
   */
  cleanRowData(data) {
    const cleaned = {};
    
    for (const key in data) {
      let value = data[key] || '';
      
      if (typeof value === 'string') {
        value = value.trim();
        
        if (key.includes('DATE')) {
          if (value) {
            const date = new Date(value);
            value = isNaN(date.getTime()) ? '' : date.toISOString().split('T')[0];
          }
        } else if (key.includes('CONTACT')) {
          value = this.formatPhoneNumber(value);
        }
      }
      
      cleaned[key] = value;
    }
    
    return cleaned;
  }

  /**
   * Vérification doublon optimisée
   */
  async checkDuplicateOptimized(client, data) {
    try {
      const result = await client.query(
        `SELECT 1 FROM cartes 
         WHERE nom = $1 AND prenoms = $2 
         AND COALESCE("DATE DE NAISSANCE"::text, '') = COALESCE($3::text, '')
         LIMIT 1`,
        [
          data.NOM || '',
          data.PRENOMS || '',
          data["DATE DE NAISSANCE"] || ''
        ]
      );
      
      return result.rows.length > 0;
    } catch (error) {
      console.warn('⚠️ Erreur vérification doublon:', error.message);
      return false; // En cas d'erreur, on continue
    }
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
    
    if (cleaned.length > 0 && cleaned.length < 8) {
      cleaned = cleaned.padStart(8, '0');
    }
    
    return cleaned.substring(0, 8); // Limiter à 8 chiffres
  }

  /**
   * Journalisation batch optimisée
   */
  async logBatchOptimized(client, userId, importBatchId, batchIndex, results) {
    // Journalisation moins fréquente sur Render gratuit
    if (this.isRenderFreeTier && batchIndex % this.options.logBatchFrequency !== 0) {
      return;
    }
    
    try {
      await client.query(`
        INSERT INTO journalactivite (
          utilisateurid, nomutilisateur, dateaction, action, 
          actiontype, tablename, importbatchid, detailsaction
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        userId,
        'bulk_import',
        new Date(),
        `Batch ${batchIndex}`,
        'BULK_IMPORT_BATCH',
        'Cartes',
        importBatchId,
        `Résultats: ${JSON.stringify(results)}`
      ]);
    } catch (error) {
      // Silencieux en cas d'erreur de journalisation
    }
  }

  /**
   * Mettre à jour la progression
   */
  updateProgress(currentRow) {
    const now = Date.now();
    
    // Éviter les updates trop fréquentes
    if (now - this.stats.lastProgressUpdate < 2000 && currentRow < this.stats.totalRows) {
      return;
    }
    
    const progress = Math.round((currentRow / this.stats.totalRows) * 100);
    
    this.emit('progress', {
      processed: currentRow,
      total: this.stats.totalRows,
      percentage: progress,
      currentBatch: this.currentBatch,
      memory: this.getMemoryUsage()
    });
    
    this.stats.lastProgressUpdate = now;
  }

  /**
   * Vérifier si une ligne est vide
   */
  isEmptyRow(rowData) {
    if (!rowData) return true;
    
    for (const key in rowData) {
      const value = rowData[key];
      if (value !== null && value !== undefined && value !== '') {
        return false;
      }
    }
    
    return true;
  }

  // ==================== PERFORMANCE ET MÉMOIRE ====================

  /**
   * Calculer les performances
   */
  calculatePerformance(duration) {
    const rowsPerSecond = this.stats.processed > 0 ? 
      Math.round(this.stats.processed / (duration / 1000)) : 0;
    
    const avgBatchTime = this.stats.batches > 0 ? 
      Math.round(duration / this.stats.batches) : 0;
    
    return {
      rowsPerSecond,
      avgBatchTime,
      efficiency: rowsPerSecond > 50 ? 'excellente' : rowsPerSecond > 20 ? 'bonne' : 'moyenne',
      memoryEfficiency: this.stats.memoryPeakMB < 100 ? 'excellente' : 'acceptable'
    };
  }

  /**
   * Estimer le temps total
   */
  estimateTotalTime(totalRows) {
    const rowsPerSecond = this.isRenderFreeTier ? 40 : 80;
    const seconds = Math.ceil(totalRows / rowsPerSecond);
    
    if (seconds < 60) return `${seconds} secondes`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} minutes`;
    return `${Math.ceil(seconds / 3600)} heures`;
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
      rssMB: Math.round(memory.rss / 1024 / 1024),
      isCritical: usedMB > this.options.memoryLimitMB * 0.9
    };
  }

  /**
   * Forcer le garbage collection
   */
  forceGarbageCollection() {
    if (global.gc) {
      try {
        const before = this.getMemoryUsage();
        global.gc();
        const after = this.getMemoryUsage();
        
        const freed = before.usedMB - after.usedMB;
        if (freed > 0) {
          console.log(`🧹 GC: ${freed}MB libérés (${before.usedMB}MB → ${after.usedMB}MB)`);
        }
      } catch (error) {
        // Ignorer les erreurs GC
      }
    }
  }

  /**
   * Nettoyage optimisé
   */
  async optimizedCleanup(filePath) {
    try {
      // Suppression du fichier
      if (this.options.cleanupTempFiles && filePath) {
        await this.cleanupFile(filePath);
      }
      
      // Nettoyage des références
      this.headers = null;
      this.currentBatch = 0;
      
      console.log('🧹 Nettoyage terminé');
    } catch (error) {
      console.warn('⚠️ Erreur nettoyage:', error.message);
    }
  }

  /**
   * Nettoyer un fichier
   */
  async cleanupFile(filePath) {
    try {
      if (filePath && await fs.access(filePath).then(() => true).catch(() => false)) {
        await fs.unlink(filePath);
        console.log(`🗑️ Fichier supprimé: ${path.basename(filePath)}`);
      }
    } catch (error) {
      // Ignorer les erreurs de suppression
    }
  }

  /**
   * Pause contrôlée
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Annuler l'import
   */
  cancel() {
    this.isCancelled = true;
    this.emit('cancelled', {
      stats: { ...this.stats },
      timestamp: new Date(),
      currentBatch: this.currentBatch
    });
    
    console.log('🛑 Import annulé');
  }

  /**
   * Obtenir le statut
   */
  getStatus() {
    const memory = this.getMemoryUsage();
    
    return {
      isRunning: this.isRunning,
      isCancelled: this.isCancelled,
      stats: { ...this.stats },
      memory,
      progress: this.stats.totalRows > 0 ? 
        Math.round((this.stats.processed / this.stats.totalRows) * 100) : 0,
      currentBatch: this.currentBatch,
      isRenderFreeTier: this.isRenderFreeTier,
      warnings: memory.isCritical ? ['⚠️ Utilisation mémoire critique'] : []
    };
  }
}

module.exports = BulkImportService;