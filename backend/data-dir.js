// Centraliza o diretório onde o backend persiste dados GRAVÁVEIS (config.json,
// token_usage.json e logs). Em desenvolvimento a pasta padrão é a própria pasta
// do backend. No app empacotado o main.js injeta AED_DATA_DIR apontando para o
// userData do Electron — nunca dentro do app.asar, que é read-only.

const path = require('path');

let cachedDir = null;

function getDataDir() {
    if (!cachedDir) {
        cachedDir = process.env.AED_DATA_DIR
            ? path.resolve(process.env.AED_DATA_DIR)
            : __dirname;
    }
    return cachedDir;
}

// Usado em testes que precisam trocar AED_DATA_DIR no mesmo processo.
function resetDataDir() {
    cachedDir = null;
}

module.exports = { getDataDir, resetDataDir };
