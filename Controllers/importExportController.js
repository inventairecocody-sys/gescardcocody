const db = require('../db/db');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const csv = require('csv-parser');
const journalController = require('./journalController');

// ============================================
// CONFIGURATION GLOBALE OPTIMISÉE
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
  
  // ✅ CONFIGURATION EXPORT COMPLET
  maxExportRows: 1000000, // Très haute limite pour export complet
  maxExportRowsRenderFree: 50000, // Limite pour Render gratuit
  
  // ✅ TIMEOUTS OPTIMISÉS
  exportTimeout: 300000, // 5 minutes pour les exports complets
  importTimeout: 240000, // 4 minutes pour l'import
  chunkSize: 5000, // Taille des chunks pour le streaming
  memoryLimitMB: 100
};

// ============================================
// CONTROLEUR PRINCIPAL OPTIMISÉ
// ============================================
class OptimizedImportExportController {
  constructor() {
    this.activeExports = new Map();
    console.log('🚀 Contrôleur Import/Export optimisé pour export COMPLET');
  }
  
  // ============================================
  // EXPORT EXCEL OPTIMISÉ (EXPORT LIMITÉ)
  // ============================================
  async exportExcel(req, res) {
    const exportId = `excel_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    console.log(`📤 Export Excel limité demandé (ID: ${exportId})`);
    
    // Vérifier les paramètres
    const isTest = req.query.test === 'true' || req.query.limit === '5';
    const limit = isTest ? 5 : 5000; // Limite à 5000 pour compatibilité
    
    let client;
    
    try {
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_EXCEL_LIMITE',
        tableName: 'Cartes',
        details: `Export Excel limité (max ${limit}) démarré`
      });
      
      client = await db.getClient();
      
      // Récupérer le COUNT d'abord
      const countResult = await client.query('SELECT COUNT(*) as total FROM cartes');
      const totalRows = parseInt(countResult.rows[0].total);
      
      console.log(`📊 ${totalRows} cartes au total, export limité à ${limit}`);
      
      if (limit < totalRows) {
        console.warn(`⚠️ Export limité à ${limit}/${totalRows} lignes`);
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
      
      // Créer le workbook
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'GESCARD Cocody';
      workbook.created = new Date();
      
      const worksheet = workbook.addWorksheet('Cartes');
      
      // Ajouter les en-têtes
      worksheet.columns = CONFIG.csvHeaders.map(header => ({
        header,
        key: header.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, ''),
        width: 20
      }));
      
      // Ajouter les données
      rows.forEach(row => {
        worksheet.addRow(row);
      });
      
      // Style des en-têtes
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF4472C4' }
      };
      
      // Configurer la réponse
      const timestamp = new Date().toISOString().split('T')[0];
      const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `export-cartes-limité-${timestamp}-${time}.xlsx`;
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Export-Limit', limit.toString());
      res.setHeader('X-Total-Rows', rows.length);
      res.setHeader('X-Export-Type', 'limited');
      
      // Écrire le fichier
      await workbook.xlsx.write(res);
      
      const duration = Date.now() - startTime;
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_EXCEL_LIMITE',
        tableName: 'Cartes',
        details: `Export Excel limité terminé: ${rows.length} lignes en ${duration}ms`
      });
      
      console.log(`✅ Export Excel limité réussi: ${rows.length} lignes en ${duration}ms`);
      
    } catch (error) {
      console.error(`❌ Erreur export Excel:`, error);
      
      const duration = Date.now() - startTime;
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur lors de l\'export Excel',
          message: error.message,
          duration: `${duration}ms`,
          exportId
        });
      }
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_EXCEL',
        tableName: 'Cartes',
        details: `Erreur export Excel: ${error.message} (${duration}ms)`
      });
      
    } finally {
      if (client?.release) client.release();
      this.activeExports.delete(exportId);
    }
  }
  
  // ============================================
  // EXPORT CSV OPTIMISÉ (EXPORT LIMITÉ)
  // ============================================
  async exportCSV(req, res) {
    const exportId = `csv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    console.log(`📤 Export CSV limité demandé (ID: ${exportId})`);
    
    // Vérifier les paramètres
    const isTest = req.query.test === 'true' || req.query.limit === '5';
    const limit = isTest ? 5 : 5000; // Limite à 5000 pour compatibilité
    
    let client;
    
    try {
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_CSV_LIMITE',
        tableName: 'Cartes',
        details: `Export CSV limité (max ${limit}) démarré`
      });
      
      client = await db.getClient();
      
      // Récupérer le COUNT
      const countResult = await client.query('SELECT COUNT(*) as total FROM cartes');
      const totalRows = parseInt(countResult.rows[0].total);
      
      console.log(`📊 ${totalRows} cartes au total, export CSV limité à ${limit}`);
      
      // Configurer la réponse
      const timestamp = new Date().toISOString().split('T')[0];
      const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `export-cartes-limité-${timestamp}-${time}.csv`;
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Export-Limit', limit.toString());
      res.setHeader('X-Export-Type', 'limited');
      
      // Écrire les en-têtes
      const headers = CONFIG.csvHeaders.join(CONFIG.csvDelimiter) + '\n';
      res.write(headers);
      
      // Utiliser un curseur pour le streaming
      let offset = 0;
      const chunkSize = 1000;
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
            
            return value;
          }).join(CONFIG.csvDelimiter);
          
          res.write(csvRow + '\n');
          totalWritten++;
        }
        
        offset += rows.length;
        
        // Log de progression
        if (totalWritten % 1000 === 0) {
          console.log(`📝 CSV limité: ${totalWritten}/${limit} lignes écrites`);
        }
      }
      
      res.end();
      
      const duration = Date.now() - startTime;
      const speed = totalWritten > 0 ? Math.round(totalWritten / (duration / 1000)) : 0;
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_CSV_LIMITE',
        tableName: 'Cartes',
        details: `Export CSV limité terminé: ${totalWritten} lignes en ${duration}ms (${speed} lignes/sec)`
      });
      
      console.log(`✅ Export CSV limité réussi: ${totalWritten} lignes en ${duration}ms (${speed} lignes/sec)`);
      
    } catch (error) {
      console.error(`❌ Erreur export CSV:`, error);
      
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
        try {
          res.end();
        } catch (e) {}
      }
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_CSV',
        tableName: 'Cartes',
        details: `Erreur export CSV: ${error.message} (${duration}ms)`
      });
      
    } finally {
      if (client?.release) client.release();
      this.activeExports.delete(exportId);
    }
  }
  
  // ============================================
  // EXPORT EXCEL COMPLET (TOUTES LES DONNÉES) - NOUVELLE MÉTHODE
  // ============================================
  async exportCompleteExcel(req, res) {
    const exportId = `excel_complete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    console.log(`🚀 EXPORT EXCEL COMPLET demandé (ID: ${exportId})`);
    
    let client;
    
    try {
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_EXCEL_COMPLET',
        tableName: 'Cartes',
        details: `Export Excel COMPLET démarré`
      });
      
      client = await db.getClient();
      
      // ✅ COMPTER TOUTES LES DONNÉES
      const countResult = await client.query('SELECT COUNT(*) as total FROM cartes');
      const totalRows = parseInt(countResult.rows[0].total);
      
      console.log(`📊 TOTAL DES DONNÉES: ${totalRows} cartes`);
      
      if (totalRows === 0) {
        return res.status(404).json({
          success: false,
          error: 'Aucune donnée à exporter'
        });
      }
      
      // ✅ VÉRIFIER LES LIMITES RENDER GRATUIT
      const maxRows = CONFIG.isRenderFreeTier ? CONFIG.maxExportRowsRenderFree : CONFIG.maxExportRows;
      if (totalRows > maxRows) {
        console.warn(`⚠️ Gros export: ${totalRows} lignes (max recommandé: ${maxRows})`);
        
        await journalController.logAction({
          utilisateurId: req.user.id,
          actionType: 'AVERTISSEMENT_EXPORT',
          tableName: 'Cartes',
          details: `Export très volumineux: ${totalRows} lignes, peut être lent`
        });
      }
      
      // ✅ RÉCUPÉRER LES COLONNES DYNAMIQUEMENT
      const sampleResult = await client.query('SELECT * FROM cartes LIMIT 1');
      const firstRow = sampleResult.rows[0] || {};
      
      // Exclure certaines colonnes techniques
      const excludedColumns = ['importbatchid', 'dateimport', 'created_at', 'updated_at', 'id'];
      const headers = Object.keys(firstRow).filter(key => 
        !excludedColumns.includes(key.toLowerCase())
      );
      
      console.log(`📋 ${headers.length} colonnes détectées`);
      
      // ✅ CONFIGURER LA RÉPONSE POUR UN GROS FICHIER
      const timestamp = new Date().toISOString().split('T')[0];
      const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `export-complet-cartes-${timestamp}-${time}.xlsx`;
      
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Export-Complete', 'true');
      res.setHeader('X-Total-Rows', totalRows);
      res.setHeader('X-Export-ID', exportId);
      
      // ✅ CRÉER LE WORKBOOK
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'GESCARD Cocody';
      workbook.created = new Date();
      
      const worksheet = workbook.addWorksheet('Cartes');
      
      // ✅ AJOUTER LES EN-TÊTES AVEC FORMAT CORRECT
      worksheet.columns = headers.map(header => ({
        header: header.replace(/_/g, ' ').toUpperCase(),
        key: header,
        width: 25
      }));
      
      // ✅ RÉCUPÉRER ET ÉCRIRE LES DONNÉES PAR LOTS
      console.log(`⏳ Récupération et écriture des données...`);
      
      let offset = 0;
      const chunkSize = 2000; // Plus petit pour Excel (mémoire)
      let totalWritten = 0;
      let batchCount = 0;
      
      while (true) {
        batchCount++;
        
        const result = await client.query(
          'SELECT * FROM cartes ORDER BY id LIMIT $1 OFFSET $2',
          [chunkSize, offset]
        );
        
        const rows = result.rows;
        if (rows.length === 0) break;
        
        // Ajouter chaque ligne au Excel
        for (const row of rows) {
          const rowData = {};
          headers.forEach(header => {
            rowData[header] = row[header] || '';
          });
          worksheet.addRow(rowData);
          totalWritten++;
        }
        
        offset += rows.length;
        
        // Log de progression
        const progress = Math.round((totalWritten / totalRows) * 100);
        if (batchCount % 5 === 0 || progress % 10 === 0) {
          console.log(`📊 Progression Excel: ${totalWritten}/${totalRows} lignes (${progress}%)`);
        }
        
        // Petite pause pour éviter le blocage
        if (batchCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        // Vérifier la fin
        if (rows.length < chunkSize) break;
      }
      
      // ✅ STYLISER LES EN-TÊTES
      const headerRow = worksheet.getRow(1);
      headerRow.eachCell((cell) => {
        cell.font = { 
          bold: true, 
          color: { argb: 'FFFFFFFF' },
          size: 11
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF2E75B5' }
        };
        cell.alignment = { 
          vertical: 'middle', 
          horizontal: 'center',
          wrapText: true
        };
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        };
      });
      
      // ✅ GELER LA LIGNE D'EN-TÊTE
      worksheet.views = [
        { state: 'frozen', xSplit: 0, ySplit: 1 }
      ];
      
      // ✅ APPLIQUER L'AUTO-FILTRE
      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: headers.length }
      };
      
      // ✅ ÉCRIRE LE FICHIER EXCEL
      console.log(`⏳ Génération finale du fichier Excel...`);
      const writeStartTime = Date.now();
      
      await workbook.xlsx.write(res);
      
      const writeTime = Date.now() - writeStartTime;
      const totalTime = Date.now() - startTime;
      const speed = totalWritten > 0 ? Math.round(totalWritten / (totalTime / 1000)) : 0;
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_EXCEL_COMPLET',
        tableName: 'Cartes',
        details: `Export Excel COMPLET terminé: ${totalWritten} lignes en ${totalTime}ms (${speed} lignes/sec)`
      });
      
      console.log(`🎉 Export Excel COMPLET réussi !`);
      console.log(`📊 Statistiques:`);
      console.log(`   - Lignes exportées: ${totalWritten}`);
      console.log(`   - Colonnes: ${headers.length}`);
      console.log(`   - Temps total: ${totalTime}ms`);
      console.log(`   - Vitesse: ${speed} lignes/sec`);
      console.log(`   - Mémoire max: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
      
    } catch (error) {
      console.error(`❌ ERREUR export Excel complet (ID: ${exportId}):`, error);
      
      const duration = Date.now() - startTime;
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur lors de l\'export Excel complet',
          message: error.message,
          duration: `${duration}ms`,
          exportId,
          advice: [
            'Le fichier peut être trop volumineux pour Excel',
            'Essayez d\'exporter en CSV pour les très gros fichiers',
            'Divisez vos données en plusieurs exports si nécessaire'
          ]
        });
      }
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_EXCEL_COMPLET',
        tableName: 'Cartes',
        details: `Erreur export Excel complet: ${error.message} (${duration}ms)`
      });
      
    } finally {
      if (client?.release) client.release();
      this.activeExports.delete(exportId);
    }
  }
  
  // ============================================
  // EXPORT CSV COMPLET (TOUTES LES DONNÉES) - NOUVELLE MÉTHODE
  // ============================================
  async exportCompleteCSV(req, res) {
    const exportId = `csv_complete_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const startTime = Date.now();
    
    console.log(`🚀 EXPORT CSV COMPLET demandé (ID: ${exportId})`);
    
    let client;
    
    try {
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_CSV_COMPLET',
        tableName: 'Cartes',
        details: `Export CSV COMPLET démarré`
      });
      
      client = await db.getClient();
      
      // ✅ COMPTER TOUTES LES DONNÉES
      const countResult = await client.query('SELECT COUNT(*) as total FROM cartes');
      const totalRows = parseInt(countResult.rows[0].total);
      
      console.log(`📊 TOTAL DES DONNÉES: ${totalRows} cartes`);
      
      if (totalRows === 0) {
        return res.status(404).json({
          success: false,
          error: 'Aucune donnée à exporter'
        });
      }
      
      // ✅ CONFIGURER LA RÉPONSE CSV
      const timestamp = new Date().toISOString().split('T')[0];
      const time = new Date().toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `export-complet-cartes-${timestamp}-${time}.csv`;
      
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Export-Complete', 'true');
      res.setHeader('X-Total-Rows', totalRows);
      res.setHeader('X-Export-ID', exportId);
      
      // ✅ RÉCUPÉRER LES COLONNES DYNAMIQUEMENT
      const sampleResult = await client.query('SELECT * FROM cartes LIMIT 1');
      const firstRow = sampleResult.rows[0] || {};
      
      // Exclure certaines colonnes techniques
      const excludedColumns = ['importbatchid', 'dateimport', 'created_at', 'updated_at'];
      const headers = Object.keys(firstRow).filter(key => 
        !excludedColumns.includes(key.toLowerCase())
      );
      
      // ✅ ÉCRIRE LES EN-TÊTES CSV
      const csvHeaders = headers.map(header => 
        `"${header.replace(/"/g, '""').replace(/_/g, ' ').toUpperCase()}"`
      ).join(';');
      
      res.write(csvHeaders + '\n');
      
      // ✅ EXPORT PAR LOTS (STREAMING OPTIMISÉ)
      let offset = 0;
      const chunkSize = CONFIG.chunkSize;
      let totalWritten = 0;
      let batchCount = 0;
      
      console.log(`⏳ Début de l'export streaming CSV...`);
      
      while (true) {
        batchCount++;
        
        const result = await client.query(
          'SELECT * FROM cartes ORDER BY id LIMIT $1 OFFSET $2',
          [chunkSize, offset]
        );
        
        const rows = result.rows;
        if (rows.length === 0) break;
        
        // Préparer et écrire le lot CSV
        let batchCSV = '';
        for (const row of rows) {
          const csvRow = headers.map(header => {
            let value = row[header];
            
            // Gérer les valeurs null/undefined
            if (value === null || value === undefined) {
              return '';
            }
            
            // Convertir en string
            let stringValue;
            if (value instanceof Date) {
              stringValue = value.toISOString().split('T')[0];
            } else {
              stringValue = String(value);
            }
            
            // Échapper les caractères spéciaux CSV
            if (stringValue.includes(';') || stringValue.includes('"') || stringValue.includes('\n') || stringValue.includes('\r')) {
              stringValue = `"${stringValue.replace(/"/g, '""')}"`;
            }
            
            return stringValue;
          }).join(';');
          
          batchCSV += csvRow + '\n';
          totalWritten++;
        }
        
        // Écrire le lot
        res.write(batchCSV);
        offset += rows.length;
        
        // Log de progression
        if (batchCount % 5 === 0 || totalWritten % 10000 === 0) {
          const progress = Math.round((totalWritten / totalRows) * 100);
          console.log(`📊 Progression CSV: ${totalWritten}/${totalRows} lignes (${progress}%)`);
          
          // Envoyer un heartbeat pour garder la connexion active
          res.flush && res.flush();
        }
        
        // Pause stratégique pour Render gratuit
        if (CONFIG.isRenderFreeTier && batchCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Vérifier la fin
        if (rows.length < chunkSize) break;
      }
      
      // ✅ TERMINER LA RÉPONSE
      res.end();
      
      const duration = Date.now() - startTime;
      const speed = totalWritten > 0 ? Math.round(totalWritten / (duration / 1000)) : 0;
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'FIN_EXPORT_CSV_COMPLET',
        tableName: 'Cartes',
        details: `Export CSV COMPLET terminé: ${totalWritten} lignes en ${duration}ms (${speed} lignes/sec)`
      });
      
      console.log(`🎉 Export CSV COMPLET réussi !`);
      console.log(`📊 Statistiques:`);
      console.log(`   - Lignes exportées: ${totalWritten}`);
      console.log(`   - Colonnes: ${headers.length}`);
      console.log(`   - Temps total: ${duration}ms`);
      console.log(`   - Vitesse: ${speed} lignes/sec`);
      console.log(`   - Mémoire max: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
      
    } catch (error) {
      console.error(`❌ ERREUR export CSV complet (ID: ${exportId}):`, error);
      
      const duration = Date.now() - startTime;
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur lors de l\'export CSV complet',
          message: error.message,
          duration: `${duration}ms`,
          exportId
        });
      } else {
        // Impossible d'envoyer une erreur, les en-têtes sont déjà partis
        console.error('⚠️ En-têtes déjà envoyés, impossible de renvoyer une erreur');
        try {
          res.end();
        } catch (e) {}
      }
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_CSV_COMPLET',
        tableName: 'Cartes',
        details: `Erreur export CSV complet: ${error.message} (${duration}ms)`
      });
      
    } finally {
      if (client?.release) client.release();
      this.activeExports.delete(exportId);
    }
  }
  
  // ============================================
  // EXPORT TOUT EN UN CLIC (CHOIX AUTOMATIQUE)
  // ============================================
  async exportAllData(req, res) {
    const exportId = `all_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    console.log(`🚀 Export "TOUT EN UN" demandé (ID: ${exportId})`);
    
    try {
      const client = await db.getClient();
      
      // Compter toutes les données
      const countResult = await client.query('SELECT COUNT(*) as total FROM cartes');
      const totalRows = parseInt(countResult.rows[0].total);
      
      console.log(`📊 TOTAL: ${totalRows} cartes`);
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'DEBUT_EXPORT_TOUT_EN_UN',
        tableName: 'Cartes',
        details: `Export "TOUT EN UN" démarré: ${totalRows} cartes`
      });
      
      // ✅ CHOIX INTELLIGENT DU FORMAT
      let chosenFormat;
      let reason;
      
      if (CONFIG.isRenderFreeTier && totalRows > 20000) {
        // Render gratuit + gros fichier = CSV
        chosenFormat = 'csv';
        reason = `Render gratuit + ${totalRows} lignes = CSV recommandé`;
      } else if (totalRows > 50000) {
        // Très gros fichier = CSV
        chosenFormat = 'csv';
        reason = `${totalRows} lignes = CSV (meilleur pour les gros fichiers)`;
      } else {
        // Fichier moyen = Excel
        chosenFormat = 'excel';
        reason = `${totalRows} lignes = Excel (format standard)`;
      }
      
      console.log(`🤔 Format choisi: ${chosenFormat.toUpperCase()} - ${reason}`);
      
      // Rediriger vers la méthode appropriée
      if (chosenFormat === 'excel') {
        req.url = '/api/import-export/export/complete';
        await this.exportCompleteExcel(req, res);
      } else {
        req.url = '/api/import-export/export/complete/csv';
        await this.exportCompleteCSV(req, res);
      }
      
    } catch (error) {
      console.error('❌ Erreur export tout en un:', error);
      
      if (!res.headersSent) {
        res.status(500).json({
          success: false,
          error: 'Erreur lors du choix de la méthode d\'export',
          message: error.message,
          advice: [
            'Essayez d\'utiliser directement /export/complete pour Excel',
            'Ou /export/complete/csv pour CSV',
            'Vérifiez que la base de données est accessible'
          ]
        });
      }
      
      await journalController.logAction({
        utilisateurId: req.user.id,
        actionType: 'ERREUR_EXPORT_TOUT_EN_UN',
        tableName: 'Cartes',
        details: `Erreur export tout en un: ${error.message}`
      });
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
      
      // Compter les données
      const countResult = await db.query('SELECT COUNT(*) as total FROM cartes');
      const totalRows = parseInt(countResult.rows[0].total);
      
      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        service: 'import-export-complet',
        environment: CONFIG.isRenderFreeTier ? 'render-free' : 'normal',
        data: {
          total_cartes: totalRows,
          export_complet_disponible: true
        },
        config: {
          maxExportRows: CONFIG.maxExportRows,
          maxExportRowsRenderFree: CONFIG.maxExportRowsRenderFree,
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
        endpoints: {
          export_complet_excel: '/api/import-export/export/complete',
          export_complet_csv: '/api/import-export/export/complete/csv',
          export_tout_en_un: '/api/import-export/export/all',
          export_limite_excel: '/api/import-export/export',
          export_limite_csv: '/api/import-export/export/csv'
        },
        recommendations: CONFIG.isRenderFreeTier ? [
          `✅ ${totalRows} cartes - export complet disponible`,
          '📊 Utilisez /export/all pour le format optimal automatique',
          '⚡ CSV recommandé pour les exports > 20,000 lignes',
          '⏱️ Les exports complets peuvent prendre plusieurs minutes'
        ] : [
          `✅ ${totalRows} cartes - export complet disponible`,
          '📊 Utilisez /export/all pour le format optimal',
          '⚡ Excel pour < 50,000 lignes, CSV pour plus',
          '🚀 Performance optimale'
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
  
  // Export standard (limité)
  exportExcel: controller.exportExcel.bind(controller),
  exportCSV: controller.exportCSV.bind(controller),
  
  // Export COMPLET (nouvelles méthodes)
  exportCompleteExcel: controller.exportCompleteExcel.bind(controller),
  exportCompleteCSV: controller.exportCompleteCSV.bind(controller),
  exportAllData: controller.exportAllData.bind(controller),
  
  // Export par site
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