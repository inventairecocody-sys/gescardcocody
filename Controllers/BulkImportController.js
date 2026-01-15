const BulkImportService = require('../Services/BulkImportService');
const journalController = require('./journalController');
const fs = require('fs').promises;
const path = require('path');

class BulkImportController {
  constructor() {
    // Stocker les imports actifs
    this.activeImports = new Map();
    
    // CONFIGURATION OPTIMISÉE POUR RENDER GRATUIT
    this.isRenderFreeTier = process.env.NODE_ENV === 'production' && !process.env.RENDER_PAID_TIER;
    
    this.maxConcurrentImports = this.isRenderFreeTier ? 1 : 2; // 1 seul import simultané sur Render gratuit
    this.importTimeout = this.isRenderFreeTier ? 25 * 60 * 1000 : 30 * 60 * 1000; // 25 min max sur Render gratuit (prévenir le timeout 30s)
    this.cleanupInterval = 10 * 60 * 1000; // Nettoyer toutes les 10 minutes
    
    // Démarrer le nettoyage périodique
    this.startCleanupInterval();
    
    console.log(`🚀 BulkImportController initialisé (Render gratuit: ${this.isRenderFreeTier})`);
  }

  /**
   * Lancer un import massif - OPTIMISÉ POUR RENDER
   */
  async startBulkImport(req, res) {
    console.time('⏱️ Bulk Import Request');
    
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

    // VÉRIFIER LA TAILLE DU FICHIER POUR RENDER GRATUIT
    if (this.isRenderFreeTier && req.file.size > 30 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'Fichier trop volumineux pour Render gratuit',
        message: 'La taille maximale est de 30MB sur Render gratuit',
        maxSize: '30MB',
        advice: 'Divisez votre fichier en plusieurs parties de moins de 5000 lignes'
      });
    }

    // Vérifier le nombre d'imports concurrents
    const activeCount = this.getActiveImportCount();
    if (activeCount >= this.maxConcurrentImports) {
      return res.status(429).json({
        success: false,
        error: 'Trop d\'imports en cours',
        message: this.isRenderFreeTier 
          ? 'Un seul import simultané autorisé sur Render gratuit' 
          : `Maximum ${this.maxConcurrentImports} imports simultanés autorisés`,
        queuePosition: activeCount + 1,
        waitTime: this.estimateWaitTime(activeCount)
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
        details: `Début import massif: ${req.file.originalname} (${req.file.size} bytes) sur ${this.isRenderFreeTier ? 'Render gratuit' : 'serveur normal'}`
      });

      // Répondre IMMÉDIATEMENT (dans les 30 secondes Render)
      console.timeEnd('⏱️ Bulk Import Request');
      res.json({
        success: true,
        message: 'Import démarré en arrière-plan',
        importId,
        statusUrl: `/api/import-export/bulk-import/status/${importId}`,
        cancelUrl: `/api/import-export/bulk-import/cancel/${importId}`,
        estimatedTime: this.estimateProcessingTime(req.file.size),
        user: req.user.NomUtilisateur,
        timestamp: new Date().toISOString(),
        warnings: this.isRenderFreeTier ? [
          '⚠️ Render gratuit - limites strictes appliquées',
          '⏱️ Timeout max: 25 minutes',
          '📁 Taille max: 30MB',
          '🔢 1 import simultané seulement'
        ] : []
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
   * Traiter l'import en arrière-plan - OPTIMISÉ POUR RENDER
   */
  async processImportBackground(importId, file, user) {
    console.log(`🎯 Démarrage import ${importId} pour ${user.NomUtilisateur} (${this.isRenderFreeTier ? 'Render gratuit' : 'serveur normal'})`);
    
    // Créer le service d'import avec configuration adaptative
    const importService = new BulkImportService({
      batchSize: this.isRenderFreeTier ? 500 : (user.Role === 'Administrateur' ? 1000 : 500),
      maxConcurrentBatches: this.isRenderFreeTier ? 1 : (user.Role === 'Administrateur' ? 3 : 2),
      memoryLimitMB: this.isRenderFreeTier ? 100 : 150,
      timeoutMinutes: this.isRenderFreeTier ? 25 : 30, // Prévenir timeout 30s Render
      pauseBetweenBatches: this.isRenderFreeTier ? 200 : 100, // Pauses plus longues sur Render
      enableMemoryCleanup: this.isRenderFreeTier
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
      lastUpdate: new Date(),
      environment: this.isRenderFreeTier ? 'render-free' : 'normal',
      timeoutAt: new Date(Date.now() + this.importTimeout)
    };

    this.activeImports.set(importId, importInfo);

    try {
      // Configurer les écouteurs d'événements
      this.setupServiceListeners(importService, importId, user);

      // Lancer l'import avec timeout
      importInfo.status = 'processing';
      this.updateImportInfo(importId, { status: 'processing' });

      // Ajouter un timeout pour prévenir le problème Render
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Import timeout après ${this.isRenderFreeTier ? '25' : '30'} minutes (limite Render)`));
        }, this.importTimeout);
      });

      const result = await Promise.race([
        importService.importLargeExcelFile(file.path, user.id, importId),
        timeoutPromise
      ]);

      // Mettre à jour les informations
      importInfo.status = 'completed';
      importInfo.stats = result.stats;
      importInfo.endTime = new Date();
      importInfo.result = result;
      importInfo.timeoutAt = null;
      this.updateImportInfo(importId, importInfo);

      // Journaliser la réussite
      await journalController.logAction({
        utilisateurId: user.id,
        nomUtilisateur: user.NomUtilisateur,
        actionType: 'COMPLETE_BULK_IMPORT',
        tableName: 'Cartes',
        importBatchID: importId,
        details: `Import massif terminé avec succès sur ${this.isRenderFreeTier ? 'Render gratuit' : 'serveur normal'}: ${result.stats.imported} importés, ${result.stats.updated} mis à jour, ${result.stats.errors} erreurs en ${Math.round(result.duration / 1000)}s`
      });

      console.log(`✅ Import ${importId} terminé avec succès (${Math.round(result.duration / 1000)}s)`);

    } catch (error) {
      console.error(`❌ Erreur import ${importId}:`, error.message);
      
      importInfo.status = 'error';
      importInfo.error = error.message;
      importInfo.endTime = new Date();
      importInfo.timeoutAt = null;
      this.updateImportInfo(importId, importInfo);

      // Journaliser l'erreur
      await journalController.logAction({
        utilisateurId: user.id,
        nomUtilisateur: user.NomUtilisateur,
        actionType: 'ERROR_BULK_IMPORT',
        tableName: 'Cartes',
        importBatchID: importId,
        details: `Erreur import massif sur ${this.isRenderFreeTier ? 'Render gratuit' : 'serveur normal'}: ${error.message}`
      });

    } finally {
      // Nettoyer le fichier temporaire
      await this.cleanupTempFile(file.path);
      
      // Supprimer le service de la mémoire
      importInfo.service = null;
      
      // Marquer comme terminé
      importInfo.lastUpdate = new Date();
      
      // Libérer la mémoire
      if (global.gc && this.isRenderFreeTier) {
        global.gc();
        console.log(`🧹 GC forcé après import ${importId}`);
      }
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
      
      // Log de progression moins fréquent sur Render gratuit
      if (!this.isRenderFreeTier || data.currentBatch % 10 === 0) {
        console.log(`📈 Import ${importId}: ${data.percentage}% (${data.processed}/${data.total})`);
      }
    });

    service.on('batchStart', (data) => {
      if (!this.isRenderFreeTier || data.batchIndex % 5 === 0) {
        console.log(`📦 Import ${importId} - Batch ${data.batchIndex} démarré (${data.size} lignes)`);
      }
    });

    service.on('batchComplete', (data) => {
      // Mettre à jour périodiquement, pas à chaque batch
      if (data.batchIndex % (this.isRenderFreeTier ? 10 : 5) === 0) {
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
   * Obtenir le statut d'un import - OPTIMISÉ POUR RENDER
   */
  getImportStatus(req, res) {
    const { importId } = req.params;
    const importInfo = this.activeImports.get(importId);

    if (!importInfo) {
      return res.status(404).json({
        success: false,
        error: 'Import non trouvé',
        message: 'L\'import a peut-être été terminé ou supprimé',
        advice: 'Les imports sont nettoyés automatiquement après 1 heure'
      });
    }

    // VÉRIFIER SI L'IMPORT APPROCHE DU TIMEOUT RENDER
    const timeRemaining = importInfo.timeoutAt ? importInfo.timeoutAt.getTime() - Date.now() : null;
    const isNearTimeout = timeRemaining && timeRemaining < 5 * 60 * 1000; // Moins de 5 minutes

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
        error: importInfo.error,
        environment: importInfo.environment,
        warnings: []
      },
      system: {
        environment: this.isRenderFreeTier ? 'render-free' : 'normal',
        activeImports: this.getActiveImportCount(),
        maxConcurrent: this.maxConcurrentImports,
        memory: process.memoryUsage()
      }
    };

    // Ajouter des warnings si nécessaire
    if (this.isRenderFreeTier) {
      response.import.warnings.push('⚠️ Render gratuit - limitations actives');
      
      if (isNearTimeout) {
        response.import.warnings.push(`⏰ Timeout dans ${Math.round(timeRemaining / 1000 / 60)} minutes`);
      }
      
      if (importInfo.status === 'processing' && response.import.progress < 10 && response.import.duration > 60000) {
        response.import.warnings.push('🐌 Progression lente - considérez annuler et diviser le fichier');
      }
    }

    res.json(response);
  }

  /**
   * Annuler un import en cours - OPTIMISÉ POUR RENDER
   */
  async cancelImport(req, res) {
    const { importId } = req.params;
    const importInfo = this.activeImports.get(importId);

    if (!importInfo) {
      return res.status(404).json({
        success: false,
        error: 'Import non trouvé',
        message: this.isRenderFreeTier ? 
          'Sur Render gratuit, les imports sont nettoyés rapidement après erreur/timeout' : 
          'L\'import a peut-être été terminé ou supprimé'
      });
    }

    if (!['initializing', 'processing', 'started', 'analyzing'].includes(importInfo.status)) {
      return res.status(400).json({
        success: false,
        error: 'Import non annulable',
        currentStatus: importInfo.status,
        advice: this.isRenderFreeTier ? 
          'Sur Render gratuit, seul un import peut être actif à la fois' : 
          undefined
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
      importInfo.timeoutAt = null;
      
      this.activeImports.set(importId, importInfo);

      // Journaliser l'annulation
      await journalController.logAction({
        utilisateurId: req.user.id,
        nomUtilisateur: req.user.NomUtilisateur,
        actionType: 'CANCEL_BULK_IMPORT',
        tableName: 'Cartes',
        importBatchID: importId,
        details: `Import massif annulé sur ${this.isRenderFreeTier ? 'Render gratuit' : 'serveur normal'}`
      });

      // Libérer la mémoire
      if (this.isRenderFreeTier && global.gc) {
        global.gc();
      }

      res.json({
        success: true,
        message: 'Import annulé avec succès',
        importId,
        cancelledAt: new Date().toISOString(),
        environment: this.isRenderFreeTier ? 'render-free' : 'normal',
        advice: this.isRenderFreeTier ? [
          'Pour éviter les timeouts sur Render gratuit:',
          '1. Divisez les fichiers > 5000 lignes',
          '2. Utilisez des fichiers < 30MB',
          '3. Importez par lots de 1000-2000 lignes'
        ] : []
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
   * Lister tous les imports actifs/récents - OPTIMISÉ
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
        error: imp.error,
        environment: imp.environment,
        isStalled: this.isImportStalled(imp)
      }));

    res.json({
      success: true,
      imports,
      total: imports.length,
      active: imports.filter(i => ['initializing', 'processing', 'started', 'analyzing'].includes(i.status)).length,
      completed: imports.filter(i => i.status === 'completed').length,
      cancelled: imports.filter(i => i.status === 'cancelled').length,
      errored: imports.filter(i => i.status === 'error').length,
      stalled: imports.filter(i => this.isImportStalled(i)).length,
      environment: this.isRenderFreeTier ? 'render-free' : 'normal',
      limits: {
        maxConcurrent: this.maxConcurrentImports,
        maxFileSize: this.isRenderFreeTier ? '30MB' : '50MB',
        timeout: this.isRenderFreeTier ? '25 minutes' : '30 minutes'
      }
    });
  }

  /**
   * Obtenir les statistiques des imports - OPTIMISÉ
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
      memoryUsage: this.calculateMemoryUsage(allImports),
      environment: this.isRenderFreeTier ? 'render-free' : 'normal',
      performance: this.calculatePerformanceMetrics(allImports)
    };

    res.json({
      success: true,
      stats,
      timestamp: new Date().toISOString(),
      recommendations: this.isRenderFreeTier ? this.getRenderRecommendations(stats) : []
    });
  }

  /**
   * Nettoyer les anciens imports - OPTIMISÉ POUR RENDER
   */
  cleanupOldImports() {
    const now = Date.now();
    const cutoffTime = now - (this.isRenderFreeTier ? 30 * 60 * 1000 : 60 * 60 * 1000); // 30 min sur Render, 1h sinon
    
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
    
    // Vérifier les imports qui bloquent (plus de 30 minutes sans progression)
    this.checkForStalledImports();
  }

  /**
   * Vérifier les imports bloqués
   */
  checkForStalledImports() {
    const now = Date.now();
    const stallThreshold = 5 * 60 * 1000; // 5 minutes sans mise à jour
    
    for (const [importId, importInfo] of this.activeImports.entries()) {
      if (['initializing', 'processing', 'started', 'analyzing'].includes(importInfo.status)) {
        const timeSinceUpdate = now - importInfo.lastUpdate.getTime();
        
        if (timeSinceUpdate > stallThreshold) {
          console.warn(`⚠️ Import ${importId} semble bloqué (pas de mise à jour depuis ${Math.round(timeSinceUpdate / 1000 / 60)} minutes)`);
          
          // Marquer comme erreur
          importInfo.status = 'error';
          importInfo.error = `Import bloqué - pas de progression depuis ${Math.round(timeSinceUpdate / 1000 / 60)} minutes`;
          importInfo.endTime = new Date();
          
          this.activeImports.set(importId, importInfo);
        }
      }
    }
  }

  // ==================== MÉTHODES UTILITAIRES OPTIMISÉES ====================

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
    // Estimation basée sur l'expérience : ~50 lignes/sec sur Render gratuit, ~100 sur serveur normal
    const rowsPerSecond = this.isRenderFreeTier ? 50 : 100;
    const estimatedRows = Math.ceil(fileSize / 1000); // Estimation approximative
    const seconds = Math.ceil(estimatedRows / rowsPerSecond);
    
    if (seconds < 60) {
      return `${seconds} secondes`;
    } else if (seconds < 3600) {
      const minutes = Math.ceil(seconds / 60);
      return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    } else {
      const hours = Math.ceil(seconds / 3600);
      return `${hours} heure${hours > 1 ? 's' : ''}`;
    }
  }

  /**
   * Estimer le temps d'attente
   */
  estimateWaitTime(queuePosition) {
    // Estimation basée sur la position dans la file
    const avgImportTime = this.isRenderFreeTier ? 15 : 10; // minutes en moyenne
    const waitMinutes = avgImportTime * (queuePosition - 1);
    
    if (waitMinutes < 1) return 'moins d\'une minute';
    if (waitMinutes < 60) return `${Math.ceil(waitMinutes)} minutes`;
    
    const hours = Math.floor(waitMinutes / 60);
    const minutes = Math.ceil(waitMinutes % 60);
    return `${hours}h${minutes > 0 ? `${minutes}min` : ''}`;
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
   * Calculer les métriques de performance
   */
  calculatePerformanceMetrics(imports) {
    const completedImports = imports.filter(i => i.status === 'completed' && i.stats);
    
    if (completedImports.length === 0) return null;
    
    const totalRows = completedImports.reduce((sum, imp) => sum + (imp.stats.imported || 0) + (imp.stats.updated || 0), 0);
    const totalTime = completedImports.reduce((sum, imp) => sum + (imp.stats.duration || 0), 0);
    
    return {
      rowsPerSecond: totalTime > 0 ? Math.round(totalRows / (totalTime / 1000)) : 0,
      avgRowsPerImport: Math.round(totalRows / completedImports.length),
      successRate: (completedImports.length / imports.length) * 100
    };
  }

  /**
   * Vérifier si un import est bloqué
   */
  isImportStalled(importInfo) {
    if (!['initializing', 'processing', 'started', 'analyzing'].includes(importInfo.status)) {
      return false;
    }
    
    const timeSinceUpdate = Date.now() - importInfo.lastUpdate.getTime();
    return timeSinceUpdate > 5 * 60 * 1000; // 5 minutes sans mise à jour
  }

  /**
   * Obtenir des recommandations pour Render gratuit
   */
  getRenderRecommendations(stats) {
    const recommendations = [];
    
    if (stats.failedImports > stats.successfulImports * 0.5) {
      recommendations.push('🔴 Taux d\'échec élevé - vérifiez la taille des fichiers');
    }
    
    if (stats.memoryUsage.avgMB > 80) {
      recommendations.push('⚠️ Utilisation mémoire élevée - divisez les fichiers');
    }
    
    if (stats.avgProcessingTime > 1200) { // > 20 minutes
      recommendations.push('🐌 Temps de traitement long - réduisez les lots à 1000 lignes');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('✅ Performance acceptable pour Render gratuit');
    }
    
    return recommendations;
  }

  /**
   * Démarrer l'intervalle de nettoyage
   */
  startCleanupInterval() {
    setInterval(() => {
      this.cleanupOldImports();
    }, this.cleanupInterval);
    
    console.log(`🧹 Nettoyage périodique configuré: ${this.cleanupInterval / 1000}s (Render gratuit: ${this.isRenderFreeTier})`);
  }
}

// Exporter une instance singleton
module.exports = new BulkImportController();