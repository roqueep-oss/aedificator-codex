const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');

console.log('🏗️ Aedificator Codex IDE iniciando...');
console.log('📂 Diretório:', __dirname);

// ===== CONTROLE DE INSTÂNCIA ÚNICA =====
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    console.log('⚠️ App já está rodando!');
    app.quit();
    process.exit(0);
}

// ===== VARIÁVEIS =====
let mainWindow = null;
let backendProcess = null;
const BACKEND_PORT = 3001;

// ===== TOKEN DE AUTENTICAÇÃO LOCAL DO BACKEND =====
const BACKEND_TOKEN = crypto.randomBytes(32).toString('hex');

// ===== SEGREDO PARA CRIPTOGRAFAR CHAVES API =====
function getOrCreateBackendSecret() {
    // Lê do .env primeiro (já configurado)
    try {
        const envPath = path.join(__dirname, 'backend', '.env');
        if (fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf-8');
            const match = envContent.match(/BACKEND_SECRET\s*=\s*(.+)/);
            if (match && match[1].trim()) return match[1].trim();
        }
    } catch (e) {}

    // Fallback: gera novo
    const secretPath = path.join(app.getPath('userData'), '.backend-secret');
    try {
        if (fs.existsSync(secretPath)) {
            return fs.readFileSync(secretPath, 'utf-8').trim();
        }
    } catch (e) {}
    const secret = crypto.randomBytes(32).toString('hex');
    try {
        fs.mkdirSync(app.getPath('userData'), { recursive: true });
        fs.writeFileSync(secretPath, secret, { encoding: 'utf-8', mode: 0o600 });
    } catch (e) {}
    return secret;
}

// Versão do protocolo esperada do backend (deve bater com
// BACKEND_PROTOCOL_VERSION em backend/server.js). Um backend desatualizado
// rodando na porta seria reutilizado pelo isBackendRunning e continuaria com
// bugs já corrigidos no código atual.
const BACKEND_PROTOCOL_VERSION = '4';

// ===== FUNÇÃO PARA VERIFICAR SE O BACKEND ESTÁ RODANDO =====
function isBackendRunning() {
    return new Promise((resolve) => {
        const client = new net.Socket();
        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            client.destroy();
            resolve(result);
        };
        const timer = setTimeout(() => finish(false), 1000);
        client.connect(BACKEND_PORT, '127.0.0.1', () => finish(true));
        client.on('error', () => finish(false));
    });
}

// Verifica se o backend em execução é da versão atual. Se for antigo, mata
// apenas o processo que roda server.js na porta (evita matar processo alheio).
async function isBackendCurrent() {
    try {
        const res = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`, {
            headers: { 'Authorization': `Bearer ${BACKEND_TOKEN}` }
        });
        const data = await res.json();
        return data.version === BACKEND_PROTOCOL_VERSION;
    } catch (e) {
        return false;
    }
}

function getProcessCommandLine(pid) {
    return new Promise((resolve) => {
        try {
            const wmic = require('child_process').execSync(`wmic process where processid=${pid} get commandline /value`, { encoding: 'utf-8', windowsHide: true });
            if (wmic) return resolve(String(wmic));
        } catch (e) {}
        // Fallback para Windows 11 24H2+ onde o WMIC foi removido
        try {
            const ps = require('child_process').execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object -ExpandProperty CommandLine"`, { encoding: 'utf-8', windowsHide: true });
            return resolve(String(ps));
        } catch (e) { resolve(''); }
    });
}

function killProcessOnPort(port) {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        const cmd = process.platform === 'win32'
            ? `netstat -ano -p tcp | findstr :${port} | findstr LISTENING`
            : `lsof -ti:${port} 2>/dev/null || true`;
        exec(cmd, (err, stdout) => {
            const pidLine = String(stdout || '').trim().split(/\r?\n/)[0];
            const pidMatch = pidLine.match(/(\d+)\s*$/);
            if (!pidMatch) return resolve(false);
            const pid = pidMatch[1];
            if (process.platform === 'win32') {
                // Só mata se a linha do netstat pertencer a um node/server.js
                const { execSync } = require('child_process');
                getProcessCommandLine(pid).then((cmdline) => {
                    if (!/server\.js/i.test(cmdline)) return resolve(false);
                    try {
                        execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
                        resolve(true);
                    } catch (e) { resolve(false); }
                });
            } else {
                try { process.kill(pid, 'SIGKILL'); return resolve(true); } catch (e) { return resolve(false); }
            }
        });
    });
}

// ===== FUNÇÃO PARA INICIAR O BACKEND =====
async function startBackend() {
    console.log('🚀 Iniciando backend...');

    const running = await isBackendRunning();
    if (running) {
        const current = await isBackendCurrent();
        if (current) {
            console.log('✅ Backend já está rodando (versão atual)!');
            return true;
        }
        console.log('⚠️ Backend antigo detectado na porta — reiniciando para aplicar correções...');
        const killed = await killProcessOnPort(BACKEND_PORT);
        if (killed) {
            // aguarda a porta liberar
            for (let i = 0; i < 10; i++) {
                if (!(await isBackendRunning())) break;
                await new Promise(r => setTimeout(r, 300));
            }
        } else {
            console.error('❌ Não foi possível encerrar o backend antigo automaticamente. Feche-o manualmente e abra o app de novo.');
            return false;
        }
    }

    const backendPath = path.join(__dirname, 'backend', 'server.js');
    const nodePath = process.execPath;

    if (!fs.existsSync(backendPath)) {
        console.error('❌ Backend não encontrado:', backendPath);
        return false;
    }

    const projectsDir = path.join(app.getPath('userData'), 'projects');
    if (!fs.existsSync(projectsDir)) {
        fs.mkdirSync(projectsDir, { recursive: true });
    }

    backendProcess = spawn(nodePath, [backendPath], {
        env: {
            ...process.env,
            NODE_ENV: 'production',
            PROJECT_ROOT: projectsDir,
            PORT: BACKEND_PORT.toString(),
            BACKEND_TOKEN,
            BACKEND_SECRET: getOrCreateBackendSecret()
        },
        stdio: 'pipe',
        windowsHide: true
    });

    backendProcess.stdout.on('data', (data) => {
        console.log(`[Backend] ${data}`);
    });

    backendProcess.stderr.on('data', (data) => {
        console.error(`[Backend Error] ${data}`);
    });

    backendProcess.on('close', (code) => {
        console.log(`Backend finalizado com código ${code}`);
    });

    let attempts = 0;
    while (attempts < 15) {
        attempts++;
        const running = await isBackendRunning();
        if (running) {
            console.log('✅ Backend pronto!');
            return true;
        }
        await new Promise(r => setTimeout(r, 500));
    }

    console.error('❌ Timeout ao iniciar backend');
    return false;
}

// ===== FUNÇÃO PARA CRIAR A JANELA =====
function createWindow() {
    if (mainWindow !== null) {
        mainWindow.focus();
        return;
    }

    console.log('🪟 Criando janela principal...');

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1024,
        minHeight: 768,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'build', 'icon.ico'),
        show: false,
        title: 'Aedificator Codex IDE',
        backgroundColor: '#0d1117'
    });

    console.log('✅ Janela criada!');

    // Menu
    const isProduction = app.isPackaged;
    const menuTemplate = [
        {
            label: 'Arquivo',
            submenu: [
                { role: 'quit', label: 'Sair' }
            ]
        },
        {
            label: 'Ajuda',
            submenu: [
                ...(isProduction ? [] : [{
                    label: 'Abrir DevTools',
                    click: () => {
                        if (mainWindow) mainWindow.webContents.openDevTools();
                    }
                }]),
                {
                    label: 'Documentação',
                    click: () => shell.openExternal('https://github.com/roqueep-oss/aedificator-codex')
                },
                { role: 'about', label: 'Sobre' }
            ]
        }
    ];

    if (!isProduction) {
        menuTemplate.splice(1, 0, {
            label: 'Exibir',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { role: 'togglefullscreen' }
            ]
        });
    }

    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);

    // Carrega o frontend via HTTP do backend (evita file:// cross-origin e Monaco paths)
    const frontendUrl = `http://127.0.0.1:${BACKEND_PORT}`;
    console.log('📂 Carregando:', frontendUrl);

    mainWindow.loadURL(frontendUrl)
        .then(() => {
            console.log('✅ Página carregada!');
        })
        .catch((err) => {
            console.error('❌ Erro ao carregar:', err.message);
        });

    mainWindow.once('ready-to-show', () => {
        console.log('✅ Janela pronta para mostrar!');
        mainWindow.show();
        mainWindow.focus();
    });

    mainWindow.on('closed', () => {
        console.log('🪟 Janela fechada');
        mainWindow = null;
        if (backendProcess) {
            backendProcess.kill();
            backendProcess = null;
        }
    });
}

// =============================================
//  EMPACOTAMENTO (BUILD DA APLICAÇÃO)
// =============================================

let buildProcess = null;

function resolveBuilderPath() {
    const candidates = [
        path.join(__dirname, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js'),
        path.join(__dirname, 'node_modules', 'electron-builder', 'cli.js'),
        path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder')
    ];
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch (e) {}
    }
    return null;
}

ipcMain.handle('build-app', async (event, options = {}) => {
    if (buildProcess) {
        return { success: false, error: 'Já existe um build em andamento. Aguarde ou cancele.' };
    }

    const platform = options.platform || 'win';
    const arch = options.arch || 'x64';
    const format = options.format || 'nsis';
    const builder = resolveBuilderPath();

    if (!builder) {
        return { success: false, error: 'electron-builder não encontrado. Execute "npm install" antes de compilar.' };
    }

    const send = (line) => {
        try {
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('build-output', line);
            }
        } catch (e) {}
    };
    send(`🚀 Iniciando build: ${platform}/${arch} (${format})...\n`);

    const isJs = builder.endsWith('.js');
    const args = [];
    if (isJs) {
        args.push(builder);
    } else {
        args.push('electron-builder');
    }
    args.push(`--${platform}`, arch);
    if (format !== 'nsis') {
        args.push(`-c.${platform}.target=${format}`);
    }

    const nodeBin = process.env.npm_node_execpath || 'node';
    const spawnOptions = {
        cwd: __dirname,
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
        windowsHide: true
    };

    return new Promise((resolve) => {
        let output = '';
        let child = null;
        try {
            child = isJs
                ? spawn(nodeBin, args, spawnOptions)
                : spawn(builder, ['electron-builder', ...args.slice(1)], { ...spawnOptions, shell: process.platform === 'win32' });
        } catch (e) {
            resolve({ success: false, error: e.message });
            return;
        }

        buildProcess = child;
        child.stdout.on('data', (d) => {
            const text = d.toString();
            output += text;
            send(text);
        });
        child.stderr.on('data', (d) => {
            const text = d.toString();
            output += text;
            send(text);
        });
        child.on('close', (code) => {
            buildProcess = null;
            send(code === 0 ? '\n✅ Build concluído!\n' : `\n❌ Build falhou (código ${code}).\n`);
            resolve({ success: code === 0, code, output: output.slice(-4000) });
        });
        child.on('error', (err) => {
            buildProcess = null;
            send(`❌ Erro ao iniciar build: ${err.message}\n`);
            resolve({ success: false, error: err.message });
        });
    });
});

ipcMain.handle('build-cancel', () => {
    if (buildProcess) {
        try {
            buildProcess.kill();
            buildProcess = null;
            return { success: true, cancelled: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
    return { success: true, cancelled: false };
});

// =============================================
//  IPC HANDLERS (COMUNICAÇÃO FRONTEND-BACKEND)
// =============================================

// ===== URL DO BACKEND =====
ipcMain.handle('get-backend-url', () => {
    return `http://localhost:${BACKEND_PORT}`;
});

// ===== TOKEN DE AUTENTICAÇÃO =====
ipcMain.handle('get-backend-token', () => {
    return BACKEND_TOKEN;
});

// =============================================
//  NOVO: EXPLORADOR DE ARQUIVOS NATIVO
// =============================================

// ===== SELECIONAR PASTA COM DIÁLOGO NATIVO =====
ipcMain.handle('select-folder', async () => {
    console.log('📁 Abrindo seletor de pasta...');
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Selecione a pasta do projeto',
        buttonLabel: 'Selecionar Pasta',
        defaultPath: app.getPath('documents')
    });
    
    if (!result.canceled && result.filePaths.length > 0) {
        const selectedPath = result.filePaths[0];
        console.log(`📁 Pasta selecionada: ${selectedPath}`);
        return selectedPath;
    }
    console.log('📁 Seletor de pasta cancelado');
    return null;
});

// ===== ABRIR PASTA NO EXPLORADOR DO SISTEMA =====
ipcMain.handle('open-in-explorer', (event, folderPath) => {
    if (folderPath && fs.existsSync(folderPath)) {
        console.log(`📂 Abrindo no explorador: ${folderPath}`);
        shell.openPath(folderPath);
        return true;
    }
    console.log(`❌ Pasta não encontrada: ${folderPath}`);
    return false;
});

// =============================================
//  EVENTOS DO APP
// =============================================

app.whenReady().then(async () => {
    console.log('📱 App pronto!');
    await startBackend();
    createWindow();
});

app.on('second-instance', () => {
    if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

app.on('window-all-closed', () => {
    if (backendProcess) {
        backendProcess.kill();
        backendProcess = null;
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    } else if (mainWindow) {
        mainWindow.focus();
    }
});

process.on('uncaughtException', (error) => {
    console.error('❌ Erro não tratado:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Rejeição não tratada:', reason);
});

console.log('🏗️ Aedificator Codex IDE aguardando eventos...');
console.log('💡 Funcionalidades disponíveis:');
console.log('   - Selecionar pasta (explorador nativo)');
console.log('   - Abrir pasta no explorador do sistema');
console.log('   - Backend automático');
console.log('   - Instância única');