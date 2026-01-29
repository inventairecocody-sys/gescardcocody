const { Client } = require('pg');

const auditBackupAccess = async (req, res, next) => {
  const startTime = Date.now();
  const requestId = `backup_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  req.backupRequestId = requestId;
  
  // Journaliser le début de la requête
  const logData = {
    id: requestId,
    user: req.user?.NomUtilisateur || 'anonymous',
    role: req.user?.Role || 'none',
    method: req.method,
    endpoint: req.path,
    ip: req.ip,
    timestamp: new Date().toISOString()
  };
  
  console.log('🔐 Accès backup système:', logData);
  
  // Sauvegarder dans la base de données
  try {
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    });
    
    await client.connect();
    
    await client.query(
      `INSERT INTO journal (
        action, details, utilisateur_id, nom_utilisateur, 
        role, ip_adresse, endpoint, methode_http
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        'BACKUP_ACCESS',
        JSON.stringify(logData),
        req.user?.id || null,
        req.user?.NomUtilisateur || 'system',
        req.user?.Role || 'system',
        req.ip,
        req.path,
        req.method
      ]
    );
    
    await client.end();
  } catch (error) {
    // Ne pas bloquer si l'audit échoue
    console.warn('⚠️ Audit journalisation échouée:', error.message);
  }
  
  // Capturer la réponse
  const originalJson = res.json;
  const originalSend = res.send;
  
  res.json = function(data) {
    const duration = Date.now() - startTime;
    
    // Journaliser la réponse
    console.log('📤 Réponse backup:', {
      id: requestId,
      status: res.statusCode,
      duration: `${duration}ms`,
      success: data?.success || false,
      user: req.user?.NomUtilisateur || 'anonymous'
    });
    
    return originalJson.call(this, data);
  };
  
  res.send = function(data) {
    const duration = Date.now() - startTime;
    
    console.log('📤 Réponse backup (send):', {
      id: requestId,
      status: res.statusCode,
      duration: `${duration}ms`,
      user: req.user?.NomUtilisateur || 'anonymous'
    });
    
    return originalSend.call(this, data);
  };
  
  next();
};

module.exports = auditBackupAccess;