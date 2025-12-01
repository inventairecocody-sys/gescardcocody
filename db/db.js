const { Pool } = require('pg');
require('dotenv').config();

// Configuration PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { 
    rejectUnauthorized: false 
  } : false,
  
  // ✅ Configuration optimisée pour Render.com
  max: 20, // Nombre maximum de clients dans le pool
  idleTimeoutMillis: 30000, // 30 secondes d'inactivité
  connectionTimeoutMillis: 5000, // 5 secondes max pour établir une connexion
  
  // Garder les connexions actives
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// Événements du pool
pool.on('connect', (client) => {
  console.log('✅ Nouvelle connexion PostgreSQL établie');
});

pool.on('acquire', (client) => {
  console.log('🔗 Client acquis du pool');
});

pool.on('remove', (client) => {
  console.log('🗑️ Client retiré du pool');
});

pool.on('error', (err, client) => {
  console.error('❌ Erreur PostgreSQL pool:', err);
  console.error('❌ Client concerné:', client);
});

// Fonction de requête sécurisée
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    // Log uniquement pour les requêtes longues (>100ms)
    if (duration > 100) {
      console.log(`📊 Query lente (${duration}ms): ${text.substring(0, 200)}...`);
    }
    
    return result;
  } catch (error) {
    console.error(`❌ Erreur query PostgreSQL (${Date.now() - start}ms):`, {
      query: text.substring(0, 200),
      params: params ? JSON.stringify(params).substring(0, 200) : 'none',
      error: error.message,
      code: error.code
    });
    throw error;
  }
};

// Obtenir un client avec gestion d'erreur améliorée
const getClient = async () => {
  try {
    const client = await pool.connect();
    console.log('🔗 Client connecté depuis le pool');
    
    const originalRelease = client.release;
    let released = false;
    
    // Empêcher la double libération
    client.release = () => {
      if (!released) {
        released = true;
        console.log('✅ Client libéré proprement');
        originalRelease.apply(client);
      } else {
        console.warn('⚠️ Tentative de double release ignorée');
      }
    };
    
    // Timeout de sécurité
    setTimeout(() => {
      if (!released) {
        console.error('⏰ Timeout: client bloqué depuis 60s, libération forcée');
        client.release();
      }
    }, 60000);
    
    return client;
  } catch (error) {
    console.error('❌ Erreur lors de l\'obtention du client:', error);
    throw error;
  }
};

// Diagnostic du pool
const getPoolStats = () => {
  return {
    total: pool.totalCount || 0,
    idle: pool.idleCount || 0,
    waiting: pool.waitingCount || 0
  };
};

// Nettoyage périodique du pool
setInterval(() => {
  const stats = getPoolStats();
  console.log(`📊 Stats pool PostgreSQL: ${JSON.stringify(stats)}`);
  
  // Forcer le nettoyage si trop de clients inactifs
  if (stats.idle > 10) {
    console.log('🧹 Nettoyage du pool: trop de clients inactifs');
  }
}, 60000); // Toutes les minutes

// Test de connexion au démarrage
const testConnection = async () => {
  try {
    const result = await query('SELECT NOW() as time, version() as version');
    console.log(`✅ PostgreSQL connecté: ${result.rows[0].version.split(',')[0]}`);
    console.log(`⏰ Heure serveur PostgreSQL: ${result.rows[0].time}`);
    return true;
  } catch (error) {
    console.error('❌ Échec connexion PostgreSQL:', error.message);
    return false;
  }
};

// Tester la connexion immédiatement
testConnection();

module.exports = {
  query,
  getClient,
  getPoolStats,
  pool
};