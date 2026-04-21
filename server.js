const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Sert tous les fichiers statiques du dossier public/
app.use(express.static(path.join(__dirname, 'public'), {
  // Cache 1 jour pour les assets (icons, manifest)
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// Fallback : toute route inconnue → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`KykySearch server running on port ${PORT}`);
});
