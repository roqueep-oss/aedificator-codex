// Versão do protocolo entre o main process (Electron) e o backend (server.js).
// Fonte única de verdade: main.js e server.js importam deste módulo para nunca
// divergirem. Incremente ao mudar o comportamento do fluxo WS/API — um backend
// antigo rodando na porta seria então morto pelo main e substituído pelo atual.
module.exports = { BACKEND_PROTOCOL_VERSION: '4' };
