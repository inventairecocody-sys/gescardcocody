// db/db.js - VERSION POSTGRESQL RAILWAY
const { Pool } = require('pg');
const dotenv = require("dotenv");
dotenv.config();

// Configuration PostgreSQL pour Railway
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 20
});

// Test de connexion au démarrage
pool.query('SELECT NOW()')
  .then(() => console.log('✅ Connexion PostgreSQL Railway établie'))
  .catch(err => console.error('❌ Erreur PostgreSQL:', err));

// Fonction utilitaire pour exécuter des requêtes
const query = (text, params) => pool.query(text, params);

module.exports = { pool, query };