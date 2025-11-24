// db/db.js
const sql = require("mssql");
const dotenv = require("dotenv");
dotenv.config(); // charge les variables d'environnement

// Configuration SQL Server
const config = {
  user: process.env.DB_USER,            // utilisateur SQL
  password: process.env.DB_PASSWORD,    // mot de passe SQL
  server: process.env.DB_SERVER,        // serveur SQL
  database: process.env.DB_DATABASE,    // base de données
  port: process.env.DB_PORT || 1433,    // port SQL (par défaut 1433)
  options: {
    encrypt: true,                      // si connexion encryptée
    trustServerCertificate: true,       // autorise certificat auto-signé
  },
};

// Création d'un pool de connexion
const poolPromise = new sql.ConnectionPool(config)
  .connect()
  .then((pool) => {
    console.log("✅ Connexion SQL Server réussie");
    return pool;
  })
  .catch((err) => {
    console.error("❌ Erreur SQL Server", err);
    throw err;
  });

// 🟢 Corrigé : on exporte aussi l'objet `sql`
module.exports = { sql, poolPromise };