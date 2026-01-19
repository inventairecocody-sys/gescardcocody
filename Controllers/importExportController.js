const db = require('../db/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const csv = require('csv-parser');
const journalController = require('./journalController');

// ============================================
// CONFIGURATION GLOBALE
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
  
  // Limites
  maxExportRows: 10000,
  maxImportRows: 50000
};

// ============================================
// SERVICE IMPORT CSV SIMPLE (SANS BulkImportServiceCSV)
// ============================================
class SimpleCSVImportService {
  constructor() {
    this.activeImports = new Map();
    this.listeners = new Map();
    console.log('📥 Service CSV simple initialisé');
  }

  // Émettre un événement
  emit(event, data) {
    const callbacks = this.listeners.get(event) || [];
    callbacks.forEach(callback => callback(data));
  }

  // Écouter un événement
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return this;
  }

  // Importer un fichier CSV
  async importLargeCSVFile(filePath, userId, importBatchId) {
    console.log(`📥 Import CSV avancé: ${path.basename(filePath)}`);
    
    // Émettre l'événement de début
    this.emit('start', {
      filePath: path.basename(filePath),
      startTime: new Date(),
      importBatchId,
      userId,
      environment: CONFIG.isRenderFreeTier ? 'render-free' : 'normal',
      format: 'CSV'
    });

    try {
      // Analyser le fichier CSV
      const stats = await fs.promises.stat(filePath);
      const fileSizeMB = stats.size / 1024 / 1024;
      
      // Lire et traiter le CSV
      const result = await this.processCSVFile(filePath, importBatchId, userId);
      
      // Émettre l'événement de complétion
      this.emit('complete', {
        stats: result.stats,
        duration: result.duration,
        importBatchId,
        environment: CONFIG.isRenderFreeTier ? 'render-free' : 'normal',
        format: 'CSV'
      });

      return {
        success: true,
        importBatchId,
        stats: result.stats,
        duration: result.duration
      };
      
    } catch (error) {
      console.error('❌ Erreur import CSV avancé:', error);
      
      this.emit('error', {
        error: error.message,
        importBatchId,
        duration: 0,
        format: 'CSV'
      });
      
      throw error;
    }
  }

  // Traiter un fichier CSV
  async processCSVFile(filePath, importBatchId, userId) {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const rows = [];
      let lineCount = 0;
      
      fs.createReadStream(filePath)
        .pipe(csv({
          separator: CONFIG.csvDelimiter,
          mapHeaders: ({ header }) => header.trim().toUpperCase(),
          mapValues: ({ value }) => value ? value.toString().trim() : ''
        }))
        .on('data', (data) => {
          rows.push(data);
          lineCount++;
          
          // Émettre progression
          if (lineCount % 1000 === 0) {
            this.emit('progress', {
              processed: lineCount,
              percentage: Math.round((lineCount / 10000) * 100), // Estimation
              currentBatch: Math.floor(lineCount / 1000),
              memory: this.getMemoryUsage()
            });
          }
        })
        .on('end', async () => {
          console.log(`✅ CSV analysé: ${lineCount} lignes`);
          
          try {
            const client = await db.getClient();
            await client.query('BEGIN');
            
            let imported = 0;
            let errors = 0;
            
            // Traiter par lots de 500
            for (let i = 0; i < rows.length; i += 500) {
              const batch = rows.slice(i, i + 500);
              const batchResult = await this.processBatch(client, batch, importBatchId);
              
              imported += batchResult.imported;
              errors += batchResult.errors;
              
              // Émettre progression batch
              this.emit('batchComplete', {
                batchIndex: Math.floor(i / 500),
                results: batchResult,
                duration: Date.now() - startTime
              });
            }
            
            await client.query('COMMIT');
            client.release();
            
            const duration = Date.now() - startTime;
            
            resolve({
              stats: {
                totalRows: lineCount,
                imported,
                errors,
                successRate: lineCount > 0 ? Math.round((imported / lineCount) * 100) : 0
              },
              duration
            });
            
          } catch (error) {
            reject(error);
          }
        })
        .on('error', reject);
    });
  }

  // Traiter un lot de données
  async processBatch(client, batch, importBatchId) {
    const result = {
      imported: 0,
      errors: 0
    };
    
    const queries = [];
    const values = [];
    
    for (const data of batch) {
      try {
        // Validation
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
      
      await client.query(query, [...values, importBatchId]);
    }
    
    return result;
  }

  // Format date
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

  // Format téléphone
  formatPhone(value) {
    if (!value) return '';
    const digits = value.toString().replace(/\D/g, '');
    return digits.substring(0, 8);
  }

  // Obtenir l'utilisation mémoire
  getMemoryUsage() {
    const memory = process.memoryUsage();
    return {
      usedMB: Math.round(memory.heapUsed / 1024 / 1024),
      totalMB: Math.round(memory.heapTotal / 1024 / 1024)
    };
  }

  // Obtenir le statut d'un import
  getImportStatus(importId) {
    return this.activeImports.get(importId) || null;
  }

  // Lister les imports actifs
  listActiveImports() {
    return Array.from(this.activeImports.values())
      .filter(imp => ['processing', 'completed', 'failed'].includes(imp.status))
      .map(imp => ({
        id: imp.id,
        filename: imp.filename,
        status: imp.status,
        progress: imp.progress,
        totalRows: imp.totalRows,
        importedRows: imp.importedRows,
        errors: imp.errors,
        startTime: imp.startTime,
        endTime: imp.endTime
      }));
  }

  // Annuler un import
  cancel() {
    console.log('🛑 Import annulé');
    this.emit('cancelled', {
      timestamp: new Date(),
      message: 'Import annulé par l\'utilisateur'
    });
  }
}

// ============================================
// CONTROLEUR PRINCIPAL UNIFIÉ
// ============================================
class UnifiedImportExportController {
  constructor() {
    this.csvImportService = new SimpleCSVImportService();
    this.activeImports = new Map();
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
        details: `Import CSV standard: ${req.file.originalname}`
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
        details: `Import CSV standard terminé: ${imported} importées, ${errors} erreurs`
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
  // IMPORT CSV AVANCÉ (BULK)
  // ============================================
  async importCSVAdvanced(req, res) {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier uploadé'
      });
    }
    
    try {
      const importBatchId = `csv_adv_${uuidv4()}`;
      
      // Stocker l'état
      const importState = {
        id: importBatchId,
        filename: req.file.originalname,
        status: 'processing',
        progress: 0,
        startTime: new Date(),
        userId: req.user.id
      };
      
      this.activeImports.set(importBatchId, importState);
      
      // Démarrer l'import en arrière-plan
      this.csvImportService.importLargeCSVFile(
        req.file.path,
        req.user.id,
        importBatchId
      ).then(result => {
        // Mettre à jour l'état
        const state = this.activeImports.get(importBatchId);
        if (state) {
          state.status = 'completed';
          state.progress = 100;
          state.endTime = new Date();
          state.stats = result.stats;
        }
      }).catch(error => {
        // Mettre à jour l'état en erreur
        const state = this.activeImports.get(importBatchId);
        if (state) {
          state.status = 'failed';
          state.error = error.message;
          state.endTime = new Date();
        }
      });
      
      res.json({
        success: true,
        message: 'Import CSV avancé démarré',
        importId: importBatchId,
        statusUrl: `/api/import-export/import-status/${importBatchId}`
      });
      
    } catch (error) {
      console.error('❌ Erreur import CSV avancé:', error);
      res.status(500).json({
        success: false,
        error: 'Erreur import CSV avancé: ' + error.message
      });
    }
  }
  
  // ============================================
  // EXPORT EXCEL
  // ============================================
  async exportExcel(req, res) {
    let client;
    
    try {
      console.log('📤 Export Excel demandé');
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_EXCEL',
        tableName: 'Cartes',
        details: 'Export Excel démarré'
      });
      
      client = await db.getClient();
      
      // Récupérer les données
      const result = await client.query(
        'SELECT * FROM cartes ORDER BY id LIMIT $1',
        [CONFIG.maxExportRows]
      );
      
      const rows = result.rows;
      console.log(`📊 ${rows.length} lignes à exporter en Excel`);
      
      // Créer le workbook Excel
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'GESCARD Cocody';
      workbook.created = new Date();
      
      const worksheet = workbook.addWorksheet('Cartes');
      
      // Ajouter les en-têtes
      worksheet.columns = CONFIG.csvHeaders.map(header => ({
        header,
        key: header.replace(/\s+/g, '_'),
        width: 20
      }));
      
      // Ajouter les données
      rows.forEach(row => {
        worksheet.addRow(row);
      });
      
      // Style de l'en-tête
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }
      };
      
      // Configurer la réponse POUR TÉLÉCHARGEMENT
      const filename = `export-cartes-${new Date().toISOString().split('T')[0]}.xlsx`;
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      // Écrire le fichier Excel
      await workbook.xlsx.write(res);
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_EXCEL',
        tableName: 'Cartes',
        details: `Export Excel terminé: ${rows.length} lignes`
      });
      
      console.log(`✅ Export Excel terminé: ${rows.length} lignes`);
      
    } catch (error) {
      console.error('❌ Erreur export Excel:', error);
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur export Excel: ' + error.message
        });
      }
    } finally {
      if (client?.release) client.release();
    }
  }
  
  // ============================================
  // EXPORT CSV
  // ============================================
  async exportCSV(req, res) {
    let client;
    
    try {
      console.log('📤 Export CSV demandé');
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_CSV',
        tableName: 'Cartes',
        details: 'Export CSV démarré'
      });
      
      client = await db.getClient();
      
      // Récupérer les données
      const result = await client.query(
        'SELECT * FROM cartes ORDER BY id LIMIT $1',
        [CONFIG.maxExportRows]
      );
      
      const rows = result.rows;
      console.log(`📊 ${rows.length} lignes à exporter en CSV`);
      
      // Configurer réponse CSV
      const filename = `export-cartes-${new Date().toISOString().split('T')[0]}.csv`;
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      
      // Écrire les en-têtes CSV
      const headers = CONFIG.csvHeaders.join(CONFIG.csvDelimiter) + '\n';
      res.write(headers);
      
      let written = 0;
      
      // Écrire les données
      for (const row of rows) {
        const csvRow = CONFIG.csvHeaders.map(header => {
          let value = row[header] || '';
          
          if (typeof value === 'string' && (value.includes(CONFIG.csvDelimiter) || value.includes('"') || value.includes('\n'))) {
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
        
        res.write(csvRow + '\n');
        written++;
        
        if (written % 1000 === 0) {
          console.log(`📝 CSV: ${written} lignes écrites`);
        }
      }
      
      res.end();
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_CSV',
        tableName: 'Cartes',
        details: `Export CSV terminé: ${written} lignes`
      });
      
      console.log(`✅ Export CSV terminé: ${written} lignes`);
      
    } catch (error) {
      console.error('❌ Erreur export CSV:', error);
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur export CSV: ' + error.message
        });
      }
    } finally {
      if (client?.release) client.release();
    }
  }
  
  // ============================================
  // EXPORT CSV PAR SITE
  // ============================================
  async exportCSVBySite(req, res) {
    let client;
    
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
      
      // Récupérer données
      const result = await client.query(
        'SELECT * FROM cartes WHERE "SITE DE RETRAIT" = $1 ORDER BY id',
        [decodedSite]
      );
      
      const rows = result.rows;
      
      // Configurer réponse
      const safeSiteName = decodedSite.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      const filename = `export-${safeSiteName}.csv`;
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      
      // Écrire les en-têtes CSV
      const headers = CONFIG.csvHeaders.join(CONFIG.csvDelimiter) + '\n';
      res.write(headers);
      
      let written = 0;
      
      // Écrire les données
      for (const row of rows) {
        const csvRow = CONFIG.csvHeaders.map(header => {
          let value = row[header] || '';
          
          if (typeof value === 'string' && (value.includes(CONFIG.csvDelimiter) || value.includes('"') || value.includes('\n'))) {
            value = `"${value.replace(/"/g, '""')}"`;
          }
          
          return value;
        }).join(CONFIG.csvDelimiter);
        
        res.write(csvRow + '\n');
        written++;
      }
      
      res.end();
      
      console.log(`✅ Export CSV site terminé: ${decodedSite} - ${written} lignes`);
      
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
  // STATUT IMPORT CSV AVANCÉ
  // ============================================
  async getImportStatus(req, res) {
    const { importId } = req.params;
    
    const status = this.csvImportService.getImportStatus(importId) || 
                   this.activeImports.get(importId);
    
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Import non trouvé'
      });
    }
    
    res.json({
      success: true,
      status
    });
  }
  
  // ============================================
  // LISTE DES IMPORTS ACTIFS
  // ============================================
  async listActiveImports(req, res) {
    const imports = this.csvImportService.listActiveImports();
    
    res.json({
      success: true,
      imports,
      total: imports.length
    });
  }
  
  // ============================================
  // ANNULER UN IMPORT
  // ============================================
  async cancelImport(req, res) {
    const { importId } = req.params;
    
    this.csvImportService.cancel();
    
    // Mettre à jour l'état local
    const state = this.activeImports.get(importId);
    if (state) {
      state.status = 'cancelled';
      state.endTime = new Date();
    }
    
    res.json({
      success: true,
      message: 'Import annulé'
    });
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
  // AUTRES MÉTHODES (COMPATIBILITÉ)
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
  // MÉTHODES DE COMPATIBILITÉ (alias)
  // ============================================
  
  async importExcel(req, res) {
    console.log('🔄 Import Excel redirigé vers import CSV');
    return this.importCSV(req, res);
  }
  
  async importSmartSync(req, res) {
    console.log('🔄 Import Smart Sync redirigé vers import CSV');
    return this.importCSV(req, res);
  }
  
  async exportStream(req, res) {
    console.log('🔄 Export Stream redirigé vers export Excel');
    return this.exportExcel(req, res);
  }
  
  async exportOptimized(req, res) {
    console.log('🔄 Export Optimized redirigé vers export CSV');
    return this.exportCSV(req, res);
  }
  
  async exportFiltered(req, res) {
    console.log('🔄 Export Filtered redirigé vers export CSV par site');
    
    const { siteRetrait, filters } = req.body;
    
    if (!siteRetrait) {
      return res.status(400).json({
        success: false,
        error: 'Paramètre siteRetrait requis'
      });
    }
    
    req.query = { siteRetrait };
    return this.exportCSVBySite(req, res);
  }
  
  async exportResultats(req, res) {
    console.log('🔄 Export Resultats redirigé vers export CSV par site');
    
    const { siteRetrait } = req.query;
    
    if (!siteRetrait) {
      return res.status(400).json({
        success: false,
        error: 'Paramètre siteRetrait requis'
      });
    }
    
    return this.exportCSVBySite(req, res);
  }
}

// ============================================
// EXPORT UNIFIÉ
// ============================================
const controller = new UnifiedImportExportController();

module.exports = {
  // Import CSV
  importCSV: controller.importCSV.bind(controller),
  importCSVAdvanced: controller.importCSVAdvanced.bind(controller),
  
  // Import (compatibilité)
  importExcel: controller.importExcel.bind(controller),
  importSmartSync: controller.importSmartSync.bind(controller),
  
  // Export
  exportExcel: controller.exportExcel.bind(controller),
  exportCSV: controller.exportCSV.bind(controller),
  exportCSVBySite: controller.exportCSVBySite.bind(controller),
  
  // Export (compatibilité)
  exportStream: controller.exportStream.bind(controller),
  exportOptimized: controller.exportOptimized.bind(controller),
  exportFiltered: controller.exportFiltered.bind(controller),
  exportResultats: controller.exportResultats.bind(controller),
  
  // Gestion imports
  getImportStatus: controller.getImportStatus.bind(controller),
  listActiveImports: controller.listActiveImports.bind(controller),
  cancelImport: controller.cancelImport.bind(controller),
  
  // Utilitaires
  getSitesList: controller.getSitesList.bind(controller),
  downloadTemplate: controller.downloadTemplate.bind(controller),
  
  // Accès au contrôleur pour debug
  _controller: controller
};