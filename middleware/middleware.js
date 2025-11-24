// middleware/middleware.js
// Middleware global (ex. logger)

function logger(req, res, next) {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
}

module.exports = { logger };