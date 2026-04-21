const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

const TARGET = 'https://kykysearch.netlify.app';

app.use('/', createProxyMiddleware({
  target: TARGET,
  changeOrigin: true,
  // Réécrire les headers pour que Netlify accepte la requête
  on: {
    proxyReq: (proxyReq) => {
      proxyReq.setHeader('host', 'kykysearch.netlify.app');
    },
    proxyRes: (proxyRes) => {
      // Supprimer les headers qui bloqueraient le rendu côté client
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
    },
    error: (err, req, res) => {
      console.error('Proxy error:', err.message);
      res.status(502).send('Site temporairement indisponible.');
    }
  }
}));

app.listen(PORT, () => {
  console.log(`Reverse proxy → ${TARGET} sur le port ${PORT}`);
});
