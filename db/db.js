const { Pool } = require('pg');
require('dotenv').config();

// Détecter l'environnement Render gratuit
const isRenderFreeTier = process.env.RENDER && process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

// Configuration optimisée selon l'environnement
const getPoolConfig = () => {
  const baseConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { 
      rejectUnauthorized: false 
    } : false,
    
    // Configuration commune
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
  
  if (isRenderFreeTier) {
    // ⚠️ CONFIGURATION POUR RENDER GRATUIT (512MB RAM)
    console.log('⚙️ Configuration DB optimisée pour Render gratuit');
    return {
      ...baseConfig,
      max: 4,              // ⬇️ Réduit de 20 à 4 (critique pour mémoire)
      min: 1,              // Garder au moins 1 connexion
      allowExitOnIdle: true, // Permettre la fermeture quand inactif
    };
  } else if (isDevelopment) {
    // Développement local
    return {
      ...baseConfig,
      max: 5,
      min: 0,
    };
  } else {
    // Production payante
    return {
      ...baseConfig,
      max: 20,
      min: 2,
    };
  }
};

// Créer le pool avec la configuration adaptée
const pool = new Pool(getPoolConfig());

// 🔧 Gestion mémoire pour gros exports
let activeExportStreams = new Set();

const registerExportStream = (streamId) => {
  activeExportStreams.add(streamId);
  console.log(`📤 Export stream actif: ${streamId} (total: ${activeExportStreams.size})`);
};

const unregisterExportStream = (streamId) => {
  activeExportStreams.delete(streamId);
  console.log(`📥 Export stream terminé: ${streamId} (reste: ${activeExportStreams.size})`);
  
  // Forcer le garbage collection si beaucoup de streams terminés
  if (activeExportStreams.size === 0 && global.gc) {
    console.log('🧹 Nettoyage mémoire forcé');
    global.gc();
  }
};

// Événements du pool
pool.on('connect', (client) => {
  console.log('✅ Nouvelle connexion PostgreSQL établie');
});

pool.on('acquire', (client) => {
  const stats = getPoolStats();
  console.log(`🔗 Client acquis (actifs: ${stats.total - stats.idle}/${stats.total})`);
});

pool.on('remove', (client) => {
  console.log('🗑️ Client retiré du pool');
});

pool.on('error', (err, client) => {
  console.error('❌ Erreur PostgreSQL pool:', err.message);
});

// ⚡ REQUÊTES OPTIMISÉES
const query = async (text, params, options = {}) => {
  const start = Date.now();
  const isExportQuery = text.includes('cartes') && 
                       (text.includes('SELECT') || text.includes('select'));
  
  try {
    // Ajouter des hints d'optimisation pour les exports
    if (isExportQuery && isRenderFreeTier) {
      // Forcer l'utilisation d'index pour éviter les sequential scans
      const optimizedText = text.replace(
        'SELECT * FROM cartes',
        'SELECT * FROM cartes WHERE id IS NOT NULL'
      );
      text = optimizedText;
    }
    
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    // Log plus détaillé pour les exports
    if (duration > 500 || isExportQuery) {
      console.log(`📊 ${isExportQuery ? '📤 EXPORT' : 'Query'} (${duration}ms):`, {
        query: text.substring(0, 150).replace(/\s+/g, ' ') + '...',
        rows: result.rowCount,
        params: params ? `[${params.length} params]` : 'none'
      });
    }
    
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`❌ Erreur query (${duration}ms):`, {
      query: text.substring(0, 100),
      error: error.message,
      code: error.code
    });
    
    // Gestion spécifique pour "out of memory" sur Render
    if (error.message.includes('memory') || error.message.includes('heap')) {
      console.error('⚠️ CRITIQUE: Mémoire insuffisante détectée');
      
      // Réduire le pool temporairement
      if (pool.totalCount > 2) {
        console.log('🔄 Réduction d\'urgence du pool de connexions');
        pool.endIdleClients && pool.endIdleClients();
      }
    }
    
    throw error;
  }
};

// 🔄 VERSION STREAMING POUR LES GROS EXPORTS
const queryStream = async (text, params, batchSize = 1000) => {
  const client = await pool.connect();
  console.log('🌊 Début query streaming avec batch:', batchSize);
  
  let offset = 0;
  let hasMore = true;
  const streamId = `stream_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  registerExportStream(streamId);
  
  const streamIterator = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (!hasMore) {
            unregisterExportStream(streamId);
            client.release();
            return { done: true };
          }
          
          try {
            const batchQuery = `${text} LIMIT ${batchSize} OFFSET ${offset}`;
            const result = await client.query(batchQuery, params);
            
            if (result.rows.length === 0) {
              hasMore = false;
              unregisterExportStream(streamId);
              client.release();
              return { done: true };
            }
            
            offset += batchSize;
            
            // Pause pour éviter la surcharge sur Render gratuit
            if (isRenderFreeTier && offset % 5000 === 0) {
              await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            return {
              done: false,
              value: result.rows
            };
          } catch (error) {
            unregisterExportStream(streamId);
            client.release();
            throw error;
          }
        }
      };
    }
  };
  
  return streamIterator;
};

// Obtenir un client avec gestion d'erreur améliorée
const getClient = async () => {
  try {
    const client = await pool.connect();
    
    // Timeout de sécurité pour Render gratuit (plus court)
    const timeout = isRenderFreeTier ? 30000 : 60000; // 30s vs 60s
    
    const originalRelease = client.release;
    let released = false;
    
    client.release = () => {
      if (!released) {
        released = true;
        originalRelease.apply(client);
      }
    };
    
    setTimeout(() => {
      if (!released) {
        console.error(`⏰ Timeout sécurité: client bloqué depuis ${timeout/1000}s`);
        try {
          client.release();
        } catch (e) {
          // Ignorer les erreurs de double release
        }
      }
    }, timeout);
    
    return client;
  } catch (error) {
    console.error('❌ Erreur getClient:', error.message);
    
    // Attendre et réessayer une fois sur Render gratuit
    if (isRenderFreeTier && error.message.includes('timeout')) {
      console.log('⏳ Réessai après timeout...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      return pool.connect();
    }
    
    throw error;
  }
};

// Diagnostic du pool
const getPoolStats = () => {
  return {
    total: pool.totalCount || 0,
    idle: pool.idleCount || 0,
    waiting: pool.waitingCount || 0,
    environment: isRenderFreeTier ? 'Render Gratuit' : 
                 isDevelopment ? 'Développement' : 'Production'
  };
};

// Nettoyage périodique du pool
setInterval(() => {
  const stats = getPoolStats();
  
  // Log moins fréquent en production
  if (isRenderFreeTier || stats.idle > 5) {
    console.log(`📊 Stats pool: ${JSON.stringify(stats)}`);
  }
  
  // Nettoyage plus agressif sur Render gratuit
  if (isRenderFreeTier && stats.idle > 2) {
    console.log('🧹 Nettoyage pool Render gratuit');
    pool.endIdleClients && pool.endIdleClients();
  }
}, 120000); // Toutes les 2 minutes

// Test de connexion avec réessai
const testConnection = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const result = await query('SELECT NOW() as time, version() as version');
      console.log(`✅ PostgreSQL connecté: ${result.rows[0].version.split(' ')[0]}`);
      console.log(`⏰ Heure DB: ${result.rows[0].time}`);
      return true;
    } catch (error) {
      console.error(`❌ Tentative ${i + 1}/${retries} échouée:`, error.message);
      
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
      }
    }
  }
  
  console.error('❌ Échec de connexion après toutes les tentatives');
  return false;
};

// Tester la connexion au démarrage
setTimeout(() => {
  testConnection();
}, 1000);

module.exports = {
  query,
  queryStream, // ✅ NOUVEAU: pour les exports streaming
  getClient,
  getPoolStats,
  registerExportStream,
  unregisterExportStream,
  pool,
  isRenderFreeTier
};