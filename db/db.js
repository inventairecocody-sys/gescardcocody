const { Pool } = require('pg');
const dotenv = require("dotenv");
dotenv.config();

// Configuration PostgreSQL pour Render
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20,
  // Paramètres supplémentaires pour optimisation
  maxUses: 7500,
  allowExitOnIdle: true
});

// Gestion améliorée des erreurs de connexion
pool.on('connect', () => {
  console.log('🔄 Nouvelle connexion client établie');
});

pool.on('error', (err, client) => {
  console.error('❌ Erreur client PostgreSQL:', err);
});

pool.on('remove', () => {
  console.log('🔌 Client déconnecté du pool');
});

// Test de connexion au démarrage
const testConnection = async () => {
  try {
    const result = await pool.query('SELECT NOW() as current_time, version() as postgres_version');
    console.log('✅ Connexion PostgreSQL Render établie');
    console.log(`📅 Heure serveur: ${result.rows[0].current_time}`);
    console.log(`🐘 Version PostgreSQL: ${result.rows[0].postgres_version.split(',')[0]}`);
  } catch (err) {
    console.error('❌ Erreur de connexion PostgreSQL:', err.message);
    console.error('🔧 Vérifiez votre DATABASE_URL et la configuration SSL');
  }
};

testConnection();

// Fonction utilitaire pour exécuter des requêtes
const query = (text, params) => pool.query(text, params);

// Fonction pour obtenir un client transactionnel
const getClient = async () => {
  const client = await pool.connect();
  const query = client.query.bind(client);
  const release = client.release.bind(client);
  
  // Set a timeout of 5 seconds, after which we will log this client's last query
  const timeout = setTimeout(() => {
    console.error('⚠️  Client utilisé depuis plus de 5 secondes');
    console.error(client.lastQuery);
  }, 5000);
  
  client.release = () => {
    clearTimeout(timeout);
    release();
  };
  
  return client;
};

module.exports = { 
  pool, 
  query, 
  getClient 
};