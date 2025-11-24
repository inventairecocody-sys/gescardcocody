const { poolPromise, sql } = require('../db/db');

exports.getAllLogs = async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .query('SELECT * FROM Log ORDER BY DateHeure DESC');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

exports.createLog = async (req, res) => {
    try {
        const { Utilisateur, Action } = req.body;
        const pool = await poolPromise;
        await pool.request()
            .input('Utilisateur', sql.NVarChar, Utilisateur)
            .input('Action', sql.NVarChar, Action)
            .query('INSERT INTO Log (Utilisateur, Action, DateHeure) VALUES (@Utilisateur, @Action, GETDATE())');
        res.json({ message: 'Log ajouté !' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};