const { contextBridge, ipcRenderer } = require('electron');

// =============================================
//  EXPOSIÇÃO SEGURA DE APIS PARA O FRONTEND
// =============================================

contextBridge.exposeInMainWorld('electronAPI', {
    // ===== BACKEND =====
    getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
    getBackendToken: () => ipcRenderer.invoke('get-backend-token'),
    
    // =============================================
    //  NOVO: EXPLORADOR DE ARQUIVOS NATIVO
    // =============================================
    
    // ===== SELECIONAR PASTA =====
    // Abre o diálogo nativo para selecionar uma pasta
    selectFolder: () => ipcRenderer.invoke('select-folder'),
    
    // ===== ABRIR PASTA NO EXPLORADOR =====
    // Abre a pasta no explorador de arquivos do sistema
    openInExplorer: (path) => ipcRenderer.invoke('open-in-explorer', path),
    
    // =============================================
    //  FUTURAS FUNÇÕES (JÁ PREPARADAS)
    // =============================================
    
    // ===== SALVAR ARQUIVO =====
    // (Futuro) Abre diálogo para salvar arquivo
    // saveFile: () => ipcRenderer.invoke('save-file'),
    
    // ===== ABRIR ARQUIVO =====
    // (Futuro) Abre diálogo para abrir arquivo
    // openFile: () => ipcRenderer.invoke('open-file'),
});

// =============================================
//  LOG PARA DEBUG
// =============================================
console.log('🔌 Preload carregado - APIs expostas:');
console.log('   ✅ getBackendUrl');
console.log('   ✅ getBackendToken (NOVO)');
console.log('   ✅ selectFolder (NOVO)');
console.log('   ✅ openInExplorer (NOVO)');