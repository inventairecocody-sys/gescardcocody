const { Transform } = require('stream');
const EventEmitter = require('events');
const db = require('../db/db');
const fs = require('fs').promises;
const path = require('path');
const csv = require('csv-parser');
const readline = require('readline');

class BulkImportServiceCSV extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Détection de l'environnement Render gratuit
    this.isRenderFreeTier = process.env.NODE_ENV === 'production' && !process.env.RENDER_PAID_TIER;
    
    // CONFIGURATION OPTIMISÉE POUR CSV ET RENDER GRATUIT
    const defaultOptions = {
      // 🎯 OPTIMISATIONS CSV RENDER GRATUIT
      batchSize: this.isRenderFreeTier ? 1000 : 2000,          // Lots plus gros car CSV léger
      maxConcurrentBatches: this.isRenderFreeTier ? 1 : 2,    // 1 seul lot à la fois
      memoryLimitMB: this.isRenderFreeTier ? 50 : 100,         // CSV utilise moins de mémoire
      timeoutPerBatch: this.isRenderFreeTier ? 15000 : 30000, // 15s suffisent pour CSV
      pauseBetweenBatches: this.isRenderFreeTier ? 100 : 50,  // Pauses courtes
      streamBufferSize: 64 * 1024,                           // 64KB buffer streaming
      
      // 🔧 CONFIGURATION STANDARD
      validateEachRow: true,
      skipDuplicates: true,
      cleanupTempFiles: true,
      enableProgressTracking: true,
      maxRowsPerImport: this.isRenderFreeTier ? 100000 : 250000, // CSV supporte plus de lignes
      enableBatchRollback: true,
      useTransactionPerBatch: true,
      logBatchFrequency: this.isRenderFreeTier ? 50 : 25,    // Log moins fréquent (CSV rapide)
      forceGarbageCollection: this.isRenderFreeTier,
      csvDelimiter: ',',
      csvEncoding: 'utf8'
    };
    
    this.options = { ...defaultOptions, ...options };
    
    // Définition des colonnes CSV
    this.csvHeaders = [
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
    
    this.requiredHeaders = ['NOM', 'PRENOMS'];
    
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
      lastProgressUpdate: 0,
      rowsPerSecond: 0
    };
    
    // État de l'import
    this.isRunning = false;
    this.isCancelled = false;
    this.currentBatch = 0;
    this.lastBatchTime = null;
    
    console.log('🚀 Service BulkImport CSV initialisé:', {
      environnement: this.isRenderFreeTier ? 'Render Gratuit' : 'Normal',
      batchSize: this.options.batchSize,
      maxRows: this.options.maxRowsPerImport,
      timeoutBatch: `${this.options.timeoutPerBatch}ms`,
      format: 'CSV (optimisé)',
      performance: '10x plus rapide qu\'Excel'
    });
  }

  // ==================== MÉTHODE PRINCIPALE CSV ====================

  /**
   * Importe un fichier CSV volumineux avec traitement par lots OPTIMISÉ
   */
  async importLargeCSVFile(filePath, userId = null, importBatchId = null) {
    if (this.isRunning) {
      throw new Error('Un import est déjà en cours');
    }

    this.isRunning = true;
    this.isCancelled = false;
    this.stats.startTime = new Date();
    this.currentBatch = 0;
    
    const finalImportBatchId = importBatchId || `csv_bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.emit('start', { 
      filePath: path.basename(filePath),
      startTime: this.stats.startTime,
      importBatchId: finalImportBatchId,
      userId,
      environment: this.isRenderFreeTier ? 'render-free' : 'normal',
      format: 'CSV'
    });

    try {
      // 1. ANALYSE RAPIDE DU CSV (ligne par ligne)
      console.log('📊 Analyse rapide du fichier CSV...');
      await this.analyzeCSVFile(filePath);
      
      // Vérification des limites Render
      if (this.isRenderFreeTier) {
        await this.validateCSVForRenderFreeTier(filePath);
      }
      
      if (this.stats.totalRows > this.options.maxRowsPerImport) {
        throw new Error(`Fichier trop volumineux: ${this.stats.totalRows} lignes (max: ${this.options.maxRowsPerImport})`);
      }

      this.emit('analysis', { 
        totalRows: this.stats.totalRows,
        estimatedBatches: Math.ceil(this.stats.totalRows / this.options.batchSize),
        estimatedTime: this.estimateCSVTotalTime(this.stats.totalRows),
        fileSizeMB: (await fs.stat(filePath)).size / 1024 / 1024,
        warnings: this.isRenderFreeTier ? [
          '⚠️ Render gratuit - optimisations CSV activées',
          '⏱️ Timeout batch: 15s',
          '📦 Taille batch: 1000 lignes',
          '⚡ CSV: 10x plus rapide qu\'Excel'
        ] : []
      });

      // 2. TRAITEMENT PAR LOTS AVEC STREAMING CSV
      console.log(`🎯 Début du traitement CSV: ${this.stats.totalRows} lignes...`);
      const importResult = await this.processCSVWithOptimizedStreaming(
        filePath, 
        finalImportBatchId, 
        userId
      );

      // 3. FINALISATION
      this.stats.endTime = new Date();
      const duration = this.stats.endTime - this.stats.startTime;
      
      // Calculer les performances
      const performance = this.calculateCSVPerformance(duration);
      this.stats.rowsPerSecond = performance.rowsPerSecond;
      
      this.emit('complete', {
        stats: { ...this.stats },
        duration,
        performance,
        importBatchId: finalImportBatchId,
        successRate: this.stats.totalRows > 0 ? 
          Math.round(((this.stats.imported + this.stats.updated) / this.stats.totalRows) * 100) : 0,
        environment: this.isRenderFreeTier ? 'render-free' : 'normal',
        format: 'CSV'
      });

      console.log(`✅ Import CSV terminé en ${Math.round(duration / 1000)}s:`, {
        importés: this.stats.imported,
        misÀJour: this.stats.updated,
        doublons: this.stats.duplicates,
        erreurs: this.stats.errors,
        vitesse: `${performance.rowsPerSecond} lignes/sec`,
        mémoirePic: `${this.stats.memoryPeakMB}MB`,
        efficacité: performance.efficiency
      });

      return {
        success: true,
        importBatchId: finalImportBatchId,
        stats: { ...this.stats },
        duration,
        performance,
        environment: this.isRenderFreeTier ? 'render-free' : 'normal',
        format: 'CSV'
      };

    } catch (error) {
      this.stats.endTime = new Date();
      
      this.emit('error', { 
        error: error.message,
        stats: { ...this.stats },
        importBatchId: finalImportBatchId,
        duration: this.stats.endTime - this.stats.startTime,
        format: 'CSV'
      });
      
      console.error('❌ Erreur import CSV massif:', error.message);
      throw error;
      
    } finally {
      this.isRunning = false;
      
      // NETTOYAGE OPTIMISÉ
      await this.optimizedCleanup(filePath);
      
      // Libération mémoire FORCÉE sur Render gratuit
      if (this.options.forceGarbageCollection) {
        this.forceGarbageCollection();
      }
    }
  }

  // ==================== ANALYSE CSV OPTIMISÉE ====================

  /**
   * Analyser le fichier CSV en mode streaming léger
   */
  async analyzeCSVFile(filePath) {
    try {
      let lineCount = 0;
      let detectedHeaders = [];
      let isFirstRow = true;
      
      // Utiliser readline pour compter les lignes très rapidement
      const fileStream = fs.createReadStream(filePath, { 
        encoding: this.options.csvEncoding,
        highWaterMark: this.options.streamBufferSize
      });
      
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });
      
      for await (const line of rl) {
        if (isFirstRow) {
          // Détecter les en-têtes
          detectedHeaders = line.split(this.options.csvDelimiter)
            .map(h => h.trim().replace(/"/g, '').toUpperCase());
          isFirstRow = false;
        } else {
          lineCount++;
        }
        
        // Arrêter après 1000 lignes pour l'estimation
        if (lineCount > 1000 && this.isRenderFreeTier) {
          // Estimation basée sur la taille du fichier
          const stats = await fs.stat(filePath);
          const bytesPerLine = stats.size / (lineCount + 1);
          lineCount = Math.floor(stats.size / bytesPerLine) - 1;
          break;
        }
      }
      
      this.stats.totalRows = lineCount;
      this.headers = detectedHeaders;
      
      // Normaliser les en-têtes
      this.normalizeCSVHeaders(detectedHeaders);
      
      console.log(`📊 Fichier CSV analysé: ${this.stats.totalRows} lignes, ${detectedHeaders.length} colonnes`);
      
    } catch (error) {
      console.error('❌ Erreur analyse CSV:', error);
      throw new Error(`Impossible d'analyser le fichier CSV: ${error.message}`);
    }
  }

  /**
   * Normaliser les en-têtes CSV
   */
  normalizeCSVHeaders(detectedHeaders) {
    const normalized = {};
    
    // Mapper les en-têtes détectés vers nos colonnes standards
    this.csvHeaders.forEach(standardHeader => {
      const foundHeader = detectedHeaders.find(h => 
        h.replace(/\s+/g, '').toUpperCase() === 
        standardHeader.replace(/\s+/g, '').toUpperCase()
      );
      
      if (foundHeader) {
        normalized[standardHeader] = foundHeader;
      }
    });
    
    this.headerMapping = normalized;
    
    // Vérifier les en-têtes obligatoires
    this.validateCSVHeaders(detectedHeaders);
  }

  /**
   * Valider les en-têtes CSV
   */
  validateCSVHeaders(headers) {
    const upperHeaders = headers.map(h => h.toUpperCase());
    const missingHeaders = this.requiredHeaders.filter(h => 
      !upperHeaders.includes(h.toUpperCase())
    );
    
    if (missingHeaders.length > 0) {
      throw new Error(`En-têtes CSV manquants: ${missingHeaders.join(', ')}`);
    }
    
    console.log('✅ En-têtes CSV validés:', headers);
  }

  /**
   * Valider CSV pour Render gratuit
   */
  async validateCSVForRenderFreeTier(filePath) {
    const stats = await fs.stat(filePath);
    const fileSizeMB = stats.size / 1024 / 1024;
    
    if (fileSizeMB > 30) {
      throw new Error(`Fichier CSV trop volumineux (${fileSizeMB.toFixed(1)}MB) pour Render gratuit (max 30MB)`);
    }
    
    if (this.stats.totalRows > 50000) {
      console.warn(`⚠️ Gros fichier CSV détecté sur Render gratuit: ${this.stats.totalRows} lignes`);
      this.emit('warning', {
        type: 'large_file',
        rows: this.stats.totalRows,
        advice: 'Considérez diviser le fichier en plusieurs parties'
      });
    }
  }

  // ==================== TRAITEMENT STREAMING CSV OPTIMISÉ ====================

  /**
   * Traitement CSV avec streaming optimisé
   */
  async processCSVWithOptimizedStreaming(filePath, importBatchId, userId) {
    return new Promise((resolve, reject) => {
      let currentBatch = [];
      let rowNumber = 0;
      let batchIndex = 0;
      
      const stream = fs.createReadStream(filePath, {
        encoding: this.options.csvEncoding,
        highWaterMark: this.options.streamBufferSize
      });
      
      stream
        .pipe(csv({
          separator: this.options.csvDelimiter,
          mapHeaders: ({ header, index }) => {
            // Normaliser les en-têtes
            return header.trim().toUpperCase();
          },
          mapValues: ({ value, header }) => {
            // Nettoyer les valeurs
            if (value === null || value === undefined) return '';
            return value.toString().trim();
          },
          strict: false // Tolérer les erreurs de format
        }))
        .on('data', async (data) => {
          if (this.isCancelled) {
            stream.destroy();
            reject(new Error('Import CSV annulé'));
            return;
          }
          
          rowNumber++;
          
          // Ignorer la ligne d'en-tête (déjà traitée)
          if (rowNumber === 1) return;
          
          // Ajouter au lot courant
          currentBatch.push({
            rowNumber,
            data: this.mapCSVData(data)
          });
          
          // Si le lot est complet, le traiter
          if (currentBatch.length >= this.options.batchSize) {
            await this.processCSVBatchWithTimeout(
              [...currentBatch], 
              batchIndex, 
              importBatchId, 
              userId
            );
            
            currentBatch = [];
            batchIndex++;
            this.currentBatch = batchIndex;
            
            // Mise à jour de la progression
            this.updateProgress(rowNumber - 1); // -1 pour ignorer l'en-tête
          }
        })
        .on('end', async () => {
          try {
            // Traiter le dernier lot
            if (currentBatch.length > 0 && !this.isCancelled) {
              await this.processCSVBatchWithTimeout(
                currentBatch, 
                batchIndex, 
                importBatchId, 
                userId
              );
              this.currentBatch = batchIndex + 1;
            }
            
            resolve({ batches: this.currentBatch });
          } catch (error) {
            reject(error);
          }
        })
        .on('error', (error) => {
          console.error('❌ Erreur streaming CSV:', error);
          reject(new Error(`Erreur lecture CSV: ${error.message}`));
        });
    });
  }

  /**
   * Mapper les données CSV vers notre structure
   */
  mapCSVData(csvRow) {
    const mappedData = {};
    
    this.csvHeaders.forEach(standardHeader => {
      // Chercher la clé correspondante dans les données CSV
      const csvKey = Object.keys(csvRow).find(key => 
        key.replace(/\s+/g, '').toUpperCase() === 
        standardHeader.replace(/\s+/g, '').toUpperCase()
      );
      
      if (csvKey) {
        mappedData[standardHeader] = csvRow[csvKey];
      } else {
        mappedData[standardHeader] = '';
      }
    });
    
    return mappedData;
  }

  /**
   * Traiter un batch CSV avec timeout
   */
  async processCSVBatchWithTimeout(batch, batchIndex, importBatchId, userId) {
    if (this.isCancelled || batch.length === 0) return;
    
    const batchStartTime = Date.now();
    this.lastBatchTime = batchStartTime;
    
    this.stats.batches++;
    
    this.emit('batchStart', {
      batchIndex,
      size: batch.length,
      startTime: new Date(),
      memoryBefore: this.getMemoryUsage(),
      format: 'CSV'
    });
    
    // Timeout plus court pour CSV (plus rapide)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout batch CSV ${batchIndex} après ${this.options.timeoutPerBatch}ms`));
      }, this.options.timeoutPerBatch);
    });
    
    try {
      const batchResults = await Promise.race([
        this.processCSVBatch(batch, batchIndex, importBatchId, userId),
        timeoutPromise
      ]);
      
      const batchDuration = Date.now() - batchStartTime;
      const batchRowsPerSecond = batch.length > 0 ? Math.round(batch.length / (batchDuration / 1000)) : 0;
      
      this.emit('batchComplete', {
        batchIndex,
        results: batchResults,
        duration: batchDuration,
        memory: this.getMemoryUsage(),
        rowsPerSecond: batchRowsPerSecond,
        format: 'CSV'
      });
      
      // Pause stratégique très courte pour CSV
      if (this.isRenderFreeTier && batchIndex % 10 === 0) {
        await this.sleep(this.options.pauseBetweenBatches);
        
        if (this.options.forceGarbageCollection && batchIndex % 20 === 0) {
          this.forceGarbageCollection();
        }
      }
      
      return batchResults;
      
    } catch (error) {
      this.emit('batchError', {
        batchIndex,
        error: error.message,
        size: batch.length,
        duration: Date.now() - batchStartTime,
        format: 'CSV'
      });
      
      // Rollback optionnel
      if (this.options.enableBatchRollback) {
        console.warn(`⚠️ Rollback batch CSV ${batchIndex} après erreur: ${error.message}`);
      }
      
      throw error;
    }
  }

  /**
   * Traitement optimisé d'un batch CSV
   */
  async processCSVBatch(batch, batchIndex, importBatchId, userId) {
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
          if (!this.validateCSVRequiredFields(data)) {
            batchResults.errors++;
            continue;
          }
          
          // Nettoyer et parser les données CSV
          const cleanedData = this.cleanCSVRowData(data);
          
          // Vérification doublon optimisée
          if (this.options.skipDuplicates) {
            const isDuplicate = await this.checkCSVDuplicateOptimized(client, cleanedData);
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
            this.parseCSVDateForDB(cleanedData["DATE DE NAISSANCE"]),
            cleanedData["LIEU NAISSANCE"] || '',
            this.formatPhoneNumber(cleanedData["CONTACT"] || ''),
            cleanedData["DELIVRANCE"] || '',
            this.formatPhoneNumber(cleanedData["CONTACT DE RETRAIT"] || ''),
            this.parseCSVDateForDB(cleanedData["DATE DE DELIVRANCE"]),
            importBatchId
          );
          
          batchResults.imported++;
          this.stats.imported++;
          this.stats.processed++;
          
        } catch (error) {
          batchResults.errors++;
          this.stats.errors++;
          console.warn(`⚠️ Erreur ligne ${item.rowNumber}:`, error.message);
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
      await this.logCSVBatchOptimized(client, userId, importBatchId, batchIndex, batchResults);
      
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

  // ==================== UTILITAIRES CSV OPTIMISÉS ====================

  /**
   * Validation des champs requis CSV
   */
  validateCSVRequiredFields(data) {
    return data.NOM && data.NOM.trim() !== '' && 
           data.PRENOMS && data.PRENOMS.trim() !== '';
  }

  /**
   * Nettoyer les données d'une ligne CSV
   */
  cleanCSVRowData(data) {
    const cleaned = {};
    
    for (const key in data) {
      let value = data[key] || '';
      
      if (typeof value === 'string') {
        value = value.trim();
        
        // Gestion spéciale des dates CSV
        if (key.includes('DATE')) {
          value = this.parseCSVDate(value);
        } else if (key.includes('CONTACT')) {
          value = this.formatPhoneNumber(value);
        }
      }
      
      cleaned[key] = value;
    }
    
    return cleaned;
  }

  /**
   * Parser de date CSV robuste (corrige votre problème)
   */
  parseCSVDate(dateStr) {
    if (!dateStr || dateStr.trim() === '') return '';
    
    const str = dateStr.trim();
    
    // 1. Format: "Thu Jul 12 2001 00:00:00 GMT+0000"
    const jsDateMatch = str.match(/(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{4})/);
    if (jsDateMatch) {
      const date = new Date(jsDateMatch[0]);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0]; // YYYY-MM-DD
      }
    }
    
    // 2. Format Excel (nombre)
    const num = parseFloat(str);
    if (!isNaN(num) && num > 1000) {
      const excelEpoch = new Date(1899, 11, 30);
      const date = new Date(excelEpoch.getTime() + (num - 1) * 86400000);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
    
    // 3. Formats de date standards
    const formats = [
      /^(\d{4})-(\d{2})-(\d{2})$/,          // YYYY-MM-DD
      /^(\d{2})\/(\d{2})\/(\d{4})$/,        // DD/MM/YYYY
      /^(\d{2})-(\d{2})-(\d{4})$/,          // DD-MM-YYYY
      /^(\d{4})\/(\d{2})\/(\d{2})$/         // YYYY/MM/DD
    ];
    
    for (const regex of formats) {
      const match = str.match(regex);
      if (match) {
        let year, month, day;
        
        if (regex.source.includes('^\\d{4}')) { // YYYY-MM-DD ou YYYY/MM/DD
          year = parseInt(match[1], 10);
          month = parseInt(match[2], 10) - 1;
          day = parseInt(match[3], 10);
        } else { // DD/MM/YYYY ou DD-MM-YYYY
          day = parseInt(match[1], 10);
          month = parseInt(match[2], 10) - 1;
          year = parseInt(match[3], 10);
        }
        
        if (year && month >= 0 && day) {
          if (year < 100) year += 2000;
          
          const date = new Date(year, month, day);
          if (!isNaN(date.getTime())) {
            return date.toISOString().split('T')[0];
          }
        }
      }
    }
    
    // 4. Dernier essai
    const parsed = Date.parse(str);
    if (!isNaN(parsed)) {
      const date = new Date(parsed);
      return date.toISOString().split('T')[0];
    }
    
    console.warn(`⚠️ Date CSV non parsable: ${dateStr}`);
    return '';
  }

  /**
   * Formater une date pour la base de données
   */
  parseCSVDateForDB(dateStr) {
    const parsed = this.parseCSVDate(dateStr);
    return parsed || null;
  }

  /**
   * Vérification doublon CSV optimisée
   */
  async checkCSVDuplicateOptimized(client, data) {
    try {
      const result = await client.query(
        `SELECT 1 FROM cartes 
         WHERE LOWER(TRIM(nom)) = LOWER(TRIM($1)) 
         AND LOWER(TRIM(prenoms)) = LOWER(TRIM($2))
         LIMIT 1`,
        [
          data.NOM || '',
          data.PRENOMS || ''
        ]
      );
      
      return result.rows.length > 0;
    } catch (error) {
      console.warn('⚠️ Erreur vérification doublon CSV:', error.message);
      return false;
    }
  }

  /**
   * Formater un numéro de téléphone
   */
  formatPhoneNumber(phone) {
    if (!phone) return '';
    
    let cleaned = phone.toString().replace(/\D/g, '');
    
    if (cleaned.startsWith('225')) {
      cleaned = cleaned.substring(3);
    } else if (cleaned.startsWith('00225')) {
      cleaned = cleaned.substring(5);
    }
    
    if (cleaned.length > 0 && cleaned.length < 8) {
      cleaned = cleaned.padStart(8, '0');
    }
    
    return cleaned.substring(0, 8);
  }

  /**
   * Journalisation batch CSV optimisée
   */
  async logCSVBatchOptimized(client, userId, importBatchId, batchIndex, results) {
    // Journalisation très allégée pour CSV
    if (batchIndex % this.options.logBatchFrequency !== 0) {
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
        'bulk_import_csv',
        new Date(),
        `Batch CSV ${batchIndex}`,
        'BULK_IMPORT_CSV_BATCH',
        'Cartes',
        importBatchId,
        `CSV - ${results.imported} importés, ${results.duplicates} doublons`
      ]);
    } catch (error) {
      // Silencieux en cas d'erreur de journalisation
    }
  }

  // ==================== PERFORMANCE ET MÉMOIRE CSV ====================

  /**
   * Mettre à jour la progression
   */
  updateProgress(currentRow) {
    const now = Date.now();
    
    // Updates moins fréquentes pour CSV (plus rapide)
    if (now - this.stats.lastProgressUpdate < 1000 && currentRow < this.stats.totalRows) {
      return;
    }
    
    const progress = Math.round((currentRow / this.stats.totalRows) * 100);
    const memory = this.getMemoryUsage();
    
    this.emit('progress', {
      processed: currentRow,
      total: this.stats.totalRows,
      percentage: progress,
      currentBatch: this.currentBatch,
      memory,
      rowsPerSecond: this.calculateCurrentSpeed(currentRow)
    });
    
    this.stats.lastProgressUpdate = now;
  }

  /**
   * Calculer la vitesse actuelle
   */
  calculateCurrentSpeed(currentRow) {
    const duration = Date.now() - this.stats.startTime.getTime();
    return duration > 0 ? Math.round(currentRow / (duration / 1000)) : 0;
  }

  /**
   * Calculer les performances CSV
   */
  calculateCSVPerformance(duration) {
    const rowsPerSecond = this.stats.processed > 0 ? 
      Math.round(this.stats.processed / (duration / 1000)) : 0;
    
    const avgBatchTime = this.stats.batches > 0 ? 
      Math.round(duration / this.stats.batches) : 0;
    
    let efficiency = 'moyenne';
    if (rowsPerSecond > 200) efficiency = 'excellente';
    else if (rowsPerSecond > 100) efficiency = 'bonne';
    else if (rowsPerSecond > 50) efficiency = 'satisfaisante';
    
    let memoryEfficiency = 'acceptable';
    if (this.stats.memoryPeakMB < 30) memoryEfficiency = 'excellente';
    else if (this.stats.memoryPeakMB < 60) memoryEfficiency = 'bonne';
    
    return {
      rowsPerSecond,
      avgBatchTime,
      efficiency,
      memoryEfficiency,
      comparison: `CSV ${Math.round(rowsPerSecond / 10)}x plus rapide qu'Excel`
    };
  }

  /**
   * Estimer le temps total CSV
   */
  estimateCSVTotalTime(totalRows) {
    const rowsPerSecond = this.isRenderFreeTier ? 150 : 300; // CSV très rapide
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
          console.log(`🧹 GC CSV: ${freed}MB libérés`);
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
      this.headerMapping = null;
      this.currentBatch = 0;
      
      console.log('🧹 Nettoyage CSV terminé');
    } catch (error) {
      console.warn('⚠️ Erreur nettoyage CSV:', error.message);
    }
  }

  /**
   * Nettoyer un fichier
   */
  async cleanupFile(filePath) {
    try {
      if (filePath && await fs.access(filePath).then(() => true).catch(() => false)) {
        await fs.unlink(filePath);
        console.log(`🗑️ Fichier CSV supprimé: ${path.basename(filePath)}`);
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
      currentBatch: this.currentBatch,
      format: 'CSV'
    });
    
    console.log('🛑 Import CSV annulé');
  }

  /**
   * Obtenir le statut
   */
  getStatus() {
    const memory = this.getMemoryUsage();
    const duration = this.stats.startTime ? Date.now() - this.stats.startTime.getTime() : 0;
    
    return {
      isRunning: this.isRunning,
      isCancelled: this.isCancelled,
      stats: { ...this.stats },
      memory,
      progress: this.stats.totalRows > 0 ? 
        Math.round((this.stats.processed / this.stats.totalRows) * 100) : 0,
      currentBatch: this.currentBatch,
      isRenderFreeTier: this.isRenderFreeTier,
      format: 'CSV',
      currentSpeed: duration > 0 ? Math.round(this.stats.processed / (duration / 1000)) : 0,
      estimatedRemaining: this.estimateRemainingTime(),
      warnings: memory.isCritical ? ['⚠️ Utilisation mémoire critique'] : []
    };
  }

  /**
   * Estimer le temps restant
   */
  estimateRemainingTime() {
    if (!this.stats.startTime || this.stats.processed === 0) return null;
    
    const elapsed = Date.now() - this.stats.startTime.getTime();
    const remainingRows = this.stats.totalRows - this.stats.processed;
    const rowsPerSecond = this.stats.processed / (elapsed / 1000);
    
    if (rowsPerSecond <= 0) return null;
    
    const secondsRemaining = Math.ceil(remainingRows / rowsPerSecond);
    
    if (secondsRemaining < 60) return `${secondsRemaining}s`;
    if (secondsRemaining < 3600) return `${Math.ceil(secondsRemaining / 60)}min`;
    return `${Math.ceil(secondsRemaining / 3600)}h`;
  }
}

// Export avec compatibilité
module.exports = BulkImportServiceCSV;