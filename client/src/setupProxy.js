const { createProxyMiddleware } = require('http-proxy-middleware');

module.exports = function(app) {
  app.use(
    '/api',
    createProxyMiddleware({
      target: 'http://192.168.5.150:8000', // set this to server address for testing
      changeOrigin: true,
      logLevel: 'debug',
    })
  );
}; 