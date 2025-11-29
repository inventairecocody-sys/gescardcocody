/**
 * Middleware d'authentification pour l'API externe
 * Utilise un token API simple plutôt que JWT
 */

const API_CONFIG = {
  allowedTokens: ["CARTES_API_2025_SECRET_TOKEN_NOV"], // ⚠️ À changer
  maxRequestsPerMinute: 100,
  rateLimitWindow: 60000 // 1 minute en millisecondes
};

// Stockage simple pour le rate limiting
const requestCounts = new Map();

exports.authenticateAPI = (req, res, next) => {
  const token = req.headers['x-api-token'] || req.query.api_token;
  
  console.log('🔐 Tentative d\'accès API externe:', {
    ip: req.ip,
    method: req.method,
    url: req.url,
    tokenPresent: !!token
  });

  // Vérifier la présence du token
  if (!token) {
    console.log('❌ Accès API refusé: token manquant');
    return res.status(401).json({
      success: false,
      error: 'Token API manquant',
      message: 'Utilisez le header X-API-Token ou le paramètre api_token'
    });
  }

  // Vérifier la validité du token
  if (!API_CONFIG.allowedTokens.includes(token)) {
    console.log('❌ Accès API refusé: token invalide');
    return res.status(403).json({
      success: false,
      error: 'Token API invalide'
    });
  }

  // Rate limiting simple
  const clientIP = req.ip;
  const now = Date.now();
  const windowStart = now - API_CONFIG.rateLimitWindow;

  // Nettoyer les anciennes requêtes
  if (requestCounts.has(clientIP)) {
    const requests = requestCounts.get(clientIP).filter(time => time > windowStart);
    if (requests.length === 0) {
      requestCounts.delete(clientIP);
    } else {
      requestCounts.set(clientIP, requests);
    }
  }

  // Vérifier la limite
  const clientRequests = requestCounts.get(clientIP) || [];
  if (clientRequests.length >= API_CONFIG.maxRequestsPerMinute) {
    console.log('❌ Rate limit dépassé pour:', clientIP);
    return res.status(429).json({
      success: false,
      error: 'Trop de requêtes',
      message: `Limite de ${API_CONFIG.maxRequestsPerMinute} requêtes par minute dépassée`
    });
  }

  // Ajouter la requête actuelle
  clientRequests.push(now);
  requestCounts.set(clientIP, clientRequests);

  console.log('✅ Accès API autorisé - Requêtes cette minute:', clientRequests.length);
  
  // Ajouter des informations de contexte à la requête
  req.apiClient = {
    authenticated: true,
    clientType: 'external_api',
    ip: clientIP,
    timestamp: new Date().toISOString()
  };

  next();
};

/**
 * Middleware pour journaliser les accès API
 */
exports.logAPIAccess = (req, res, next) => {
  const startTime = Date.now();
  
  // Surcharger res.json pour capturer la réponse
  const originalJson = res.json;
  res.json = function(data) {
    const duration = Date.now() - startTime;
    
    console.log('📊 Accès API externe:', {
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
      clientIP: req.ip,
      timestamp: new Date().toISOString()
    });
    
    return originalJson.call(this, data);
  };
  
  next();
};