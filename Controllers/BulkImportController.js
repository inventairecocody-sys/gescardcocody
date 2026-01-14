const BulkImportService = require('../Services/BulkImportService');
const journalController = require('./journalController');
const fs = require('fs').promises;
const path = require('path');

class BulkImportController {
  constructor() {
    // Stocker les imports actifs
    this.activeImports = new Map();
    
    // Configuration
    this.maxConcurrentImports = 2; // Limite sur Render gratuit
    this.importTimeout = 30 * 60 * 1000; // 30 minutes max
    this.cleanupInterval = 5 * 60 * 1000; // Nettoyer toutes les 5 minutes
    
    // Démarrer le nettoyage périodique
    this.startCleanupInterval();
    
    console.log('🚀 BulkImportController initialisé');
  }

  /**
   * Lancer un import massif
   */
  async startBulkImport(req, res) {
    // Vérifier l'authentification
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentification requise'
      });
    }

    // Vérifier le fichier
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'Aucun fichier fourni'
      });
    }

    // Vérifier le nombre d'imports concurrents
    if (this.getActiveImportCount() >= this.maxConcurrentImports) {
      return res.status(429).json({
        success: false,
        error: 'Trop d\'imports en cours',
        message: `Maximum ${this.maxConcurrentImports} imports simultanés autorisés`,
        queuePosition: this.getActiveImportCount() + 1
      });
    }

    const importId = `bulk_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    try {
      // Journaliser le début
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        nomComplet: req.user.NomComplet,
        role: req.user.Role,
        agence: req.user.Agence,
        actionType: 'START_BULK_IMPORT',
        tableName: 'Cartes',
        importBatchID: importId,
        details: `Début import massif: ${req.file.originalname} (${req.file.size} bytes)`
      });

      // Répondre immédiatement avec l'ID d'import
      res.json({
        success: true,
        message: 'Import démarré en arrière-plan',
        importId,
        statusUrl: `/api/import-export/bulk-import/status/${importId}`,
        cancelUrl: `/api/import-export/bulk-import/cancel/${importId}`,
        estimatedTime: this.estimateProcessingTime(req.file.size),
        user: req.user.NomUtilisateur,
        timestamp: new Date().toISOString()
      });

      // Lancer le traitement en arrière-plan
      this.processImportBackground(importId, req.file, req.user);

    } catch (error) {
      console.error('❌ Erreur démarrage import:', error);
      
      // Nettoyer le fichier temporaire
      await this.cleanupTempFile(req.file.path);
      
      res.status(500).json({
        success: false,
        error: 'Erreur lors du démarrage de l\'import',
        details: error.message
      });
    }
  }

  /**
   * Traiter l'import en arrière-plan
   */
  async processImportBackground(importId, file, user) {
    console.log(`🎯 Démarrage import ${importId} pour ${user.NomUtilisateur}`);
    
    // Créer le service d'import
    const importService = new BulkImportService({
      batchSize: user.Role === 'Administrateur' ? 1000 : 500,
      maxConcurrentBatches: user.Role === 'Administrateur' ? 3 : 2,
      memoryLimitMB: 150
    });

    // Stocker les informations de l'import
    const importInfo = {
      id: importId,
      fileName: file.originalname,
      fileSize: file.size,
      user: {
        id: user.id,
        nomUtilisateur: user.NomUtilisateur,
        role: user.Role
      },
      startTime: new Date(),
      status: 'initializing',
      progress: 0,
      stats: null,
      service: importService,
      lastUpdate: new Date()
    };

    this.activeImports.set(importId, importInfo);

    try {
      // Configurer les écouteurs d'événements
      this.setupServiceListeners(importService, importId, user);

      // Lancer l'import
      importInfo.status = 'processing';
      this.updateImportInfo(importId, { status: 'processing' });

      const result = await importService.importLargeExcelFile(file.path, user.id, importId);

      // Mettre à jour les informations
      importInfo.status = 'completed';
      importInfo.stats = result.stats;
      importInfo.endTime = new Date();
      importInfo.result = result;
      this.updateImportInfo(importId, importInfo);

      // Journaliser la réussite
      await journalController.logAction({
        utilisateurId: user.id,
        nomUtilisateur: user.NomUtilisateur,
        actionType: 'COMPLETE_BULK_IMPORT',
        tableName: 'Cartes',
        importBatchID: importId,
        details: `Import massif terminé avec succès: ${result.stats.imported} importés, ${result.stats.updated} mis à jour, ${result.stats.errors} erreurs en ${Math.round(result.duration / 1000)}s`
      });

      console.log(`✅ Import ${importId} terminé avec succès`);

    } catch (error) {
      console.error(`❌ Erreur import ${importId}:`, error);
      
      importInfo.status = 'error';
      importInfo.error = error.message;
      importInfo.endTime = new Date();
      this.updateImportInfo(importId, importInfo);

      // Journaliser l'erreur
      await journalController.logAction({
        utilisateurId: user.id,
        nomUtilisateur: user.NomUtilisateur,
        actionType: 'ERROR_BULK_IMPORT',
        tableName: 'Cartes',
        importBatchID: importId,
        details: `Erreur import massif: ${error.message}`
      });

    } finally {
      // Nettoyer le fichier temporaire
      await this.cleanupTempFile(file.path);
      
      // Supprimer le service de la mémoire
      importInfo.service = null;
      
      // Marquer comme terminé
      importInfo.lastUpdate = new Date();
    }
  }

  /**
   * Configurer les écouteurs d'événements du service
   */
  setupServiceListeners(service, importId, user) {
    service.on('start', (data) => {
      this.updateImportInfo(importId, {
        status: 'started',
        progress: 0,
        estimatedRows: data.totalRows
      });
    });

    service.on('analysis', (data) => {
      this.updateImportInfo(importId, {
        status: 'analyzing',
        totalRows: data.totalRows,
        estimatedBatches: data.estimatedBatches
      });
    });

    service.on('progress', (data) => {
      this.updateImportInfo(importId, {
        status: 'processing',
        progress: data.percentage,
        processedRows: data.processed,
        currentBatch: data.currentBatch
      });
    });

    service.on('batchStart', (data) => {
      console.log(`📦 Import ${importId} - Batch ${data.batchIndex} démarré (${data.size} lignes)`);
    });

    service.on('batchComplete', (data) => {
      // Mettre à jour périodiquement, pas à chaque batch
      if (data.batchIndex % 5 === 0) {
        this.updateImportInfo(importId, {
          lastBatch: data.batchIndex,
          batchResults: data.results,
          memoryUsage: data.memory
        });
      }
    });

    service.on('complete', (data) => {
      console.log(`🎉 Import ${importId} terminé:`, data.stats);
    });

    service.on('error', (data) => {
      console.error(`❌ Erreur import ${importId}:`, data.error);
    });

    service.on('cancelled', () => {
      this.updateImportInfo(importId, {
        status: 'cancelled',
        endTime: new Date()
      });
    });
  }

  /**
   * Obtenir le statut d'un import
   */
  getImportStatus(req, res) {
    const { importId } = req.params;
    const importInfo = this.activeImports.get(importId);

    if (!importInfo) {
      return res.status(404).json({
        success: false,
        error: 'Import non trouvé',
        message: 'L\'import a peut-être été terminé ou supprimé'
      });
    }

    // Obtenir les stats en temps réel du service
    let serviceStatus = null;
    if (importInfo.service && importInfo.service.getStatus) {
      serviceStatus = importInfo.service.getStatus();
    }

    const response = {
      success: true,
      import: {
        id: importInfo.id,
        fileName: importInfo.fileName,
        fileSize: importInfo.fileSize,
        user: importInfo.user,
        startTime: importInfo.startTime,
        endTime: importInfo.endTime,
        status: importInfo.status,
        progress: importInfo.progress || 0,
        totalRows: importInfo.totalRows,
        processedRows: importInfo.processedRows,
        stats: importInfo.stats,
        serviceStatus,
        duration: importInfo.endTime ? 
          importInfo.endTime - importInfo.startTime :
          Date.now() - importInfo.startTime.getTime(),
        lastUpdate: importInfo.lastUpdate,
        error: importInfo.error
      }
    };

    res.json(response);
  }

  /**
   * Annuler un import en cours
   */
  async cancelImport(req, res) {
    const { importId } = req.params;
    const importInfo = this.activeImports.get(importId);

    if (!importInfo) {
      return res.status(404).json({
        success: false,
        error: 'Import non trouvé'
      });
    }

    if (!['initializing', 'processing', 'started', 'analyzing'].includes(importInfo.status)) {
      return res.status(400).json({
        success: false,
        error: 'Import non annulable',
        currentStatus: importInfo.status
      });
    }

    try {
      // Annuler le service
      if (importInfo.service && importInfo.service.cancel) {
        importInfo.service.cancel();
      }

      // Mettre à jour le statut
      importInfo.status = 'cancelled';
      importInfo.endTime = new Date();
      importInfo.lastUpdate = new Date();
      
      this.activeImports.set(importId, importInfo);

      // Journaliser l'annulation
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        actionType: 'CANCEL_BULK_IMPORT',
        tableName: 'Cartes',
        importBatchID: importId,
        details: 'Import massif annulé par l\'utilisateur'
      });

      res.json({
        success: true,
        message: 'Import annulé avec succès',
        importId,
        cancelledAt: new Date().toISOString()
      });

    } catch (error) {
      console.error(`❌ Erreur annulation import ${importId}:`, error);
      res.status(500).json({
        success: false,
        error: 'Erreur lors de l\'annulation de l\'import'
      });
    }
  }

  /**
   * Lister tous les imports actifs/récents
   */
  listActiveImports(req, res) {
    const imports = Array.from(this.activeImports.values())
      .sort((a, b) => b.startTime - a.startTime)
      .map(imp => ({
        id: imp.id,
        fileName: imp.fileName,
        user: imp.user,
        startTime: imp.startTime,
        status: imp.status,
        progress: imp.progress || 0,
        totalRows: imp.totalRows,
        processedRows: imp.processedRows,
        duration: imp.endTime ? 
          imp.endTime - imp.startTime :
          Date.now() - imp.startTime.getTime(),
        stats: imp.stats,
        error: imp.error
      }));

    res.json({
      success: true,
      imports,
      total: imports.length,
      active: imports.filter(i => ['initializing', 'processing', 'started', 'analyzing'].includes(i.status)).length,
      completed: imports.filter(i => i.status === 'completed').length,
      cancelled: imports.filter(i => i.status === 'cancelled').length,
      errored: imports.filter(i => i.status === 'error').length
    });
  }

  /**
   * Obtenir les statistiques des imports
   */
  getImportStats(req, res) {
    const allImports = Array.from(this.activeImports.values());
    
    const stats = {
      totalImports: allImports.length,
      activeImports: allImports.filter(i => ['initializing', 'processing', 'started', 'analyzing'].includes(i.status)).length,
      successfulImports: allImports.filter(i => i.status === 'completed').length,
      failedImports: allImports.filter(i => i.status === 'error').length,
      cancelledImports: allImports.filter(i => i.status === 'cancelled').length,
      totalRowsProcessed: allImports.reduce((sum, imp) => sum + (imp.stats?.imported || 0) + (imp.stats?.updated || 0), 0),
      avgProcessingTime: this.calculateAverageProcessingTime(allImports),
      memoryUsage: this.calculateMemoryUsage(allImports)
    };

    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString()
    });
  }

  /**
   * Nettoyer les anciens imports
   */
  cleanupOldImports() {
    const now = Date.now();
    const cutoffTime = now - (60 * 60 * 1000); // 1 heure
    
    let cleanedCount = 0;
    
    for (const [importId, importInfo] of this.activeImports.entries()) {
      const importAge = now - importInfo.startTime.getTime();
      const isOld = importAge > cutoffTime;
      const isFinished = ['completed', 'error', 'cancelled'].includes(importInfo.status);
      
      if (isOld && isFinished) {
        this.activeImports.delete(importId);
        cleanedCount++;
        console.log(`🧹 Import ${importId} nettoyé (âge: ${Math.round(importAge / 1000 / 60)} minutes)`);
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`🧹 Nettoyage terminé: ${cleanedCount} imports supprimés`);
    }
  }

  // ==================== MÉTHODES UTILITAIRES ====================

  /**
   * Mettre à jour les informations d'un import
   */
  updateImportInfo(importId, updates) {
    const current = this.activeImports.get(importId);
    if (current) {
      this.activeImports.set(importId, {
        ...current,
        ...updates,
        lastUpdate: new Date()
      });
    }
  }

  /**
   * Obtenir le nombre d'imports actifs
   */
  getActiveImportCount() {
    return Array.from(this.activeImports.values())
      .filter(i => ['initializing', 'processing', 'started', 'analyzing'].includes(i.status))
      .length;
  }

  /**
   * Estimer le temps de traitement
   */
  estimateProcessingTime(fileSize) {
    // Estimation basée sur l'expérience : ~100 lignes/sec sur Render gratuit
    const estimatedRows = Math.ceil(fileSize / 1000); // Estimation approximative
    const seconds = Math.ceil(estimatedRows / 100);
    
    if (seconds < 60) {
      return `${seconds} secondes`;
    } else if (seconds < 3600) {
      return `${Math.ceil(seconds / 60)} minutes`;
    } else {
      return `${Math.ceil(seconds / 3600)} heures`;
    }
  }

  /**
   * Nettoyer un fichier temporaire
   */
  async cleanupTempFile(filePath) {
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
   * Calculer le temps de traitement moyen
   */
  calculateAverageProcessingTime(imports) {
    const completedImports = imports.filter(i => i.status === 'completed' && i.endTime);
    
    if (completedImports.length === 0) return 0;
    
    const totalDuration = completedImports.reduce((sum, imp) => {
      return sum + (imp.endTime.getTime() - imp.startTime.getTime());
    }, 0);
    
    return Math.round(totalDuration / completedImports.length / 1000); // en secondes
  }

  /**
   * Calculer l'utilisation mémoire moyenne
   */
  calculateMemoryUsage(imports) {
    const importsWithStats = imports.filter(i => i.stats && i.stats.memoryPeakMB);
    
    if (importsWithStats.length === 0) return { avgMB: 0, maxMB: 0 };
    
    const totalMemory = importsWithStats.reduce((sum, imp) => sum + imp.stats.memoryPeakMB, 0);
    const maxMemory = Math.max(...importsWithStats.map(imp => imp.stats.memoryPeakMB));
    
    return {
      avgMB: Math.round(totalMemory / importsWithStats.length),
      maxMB: maxMemory
    };
  }

  /**
   * Démarrer l'intervalle de nettoyage
   */
  startCleanupInterval() {
    setInterval(() => {
      this.cleanupOldImports();
    }, this.cleanupInterval);
    
    console.log(`🧹 Nettoyage périodique configuré: ${this.cleanupInterval / 1000}s`);
  }
}

// Exporter une instance singleton
module.exports = new BulkImportController();