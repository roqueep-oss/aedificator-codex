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

// ===== DIRETÓRIO DE DADOS GRAVÁVEL (config/logs/uso do backend) =====
// No app empacotado o backend NUNCA deve gravar dentro do app.asar (read-only).
// O main.js injeta AED_DATA_DIR no processo do backend apontando para o userData.
// AED_USER_DATA permite redirecionar o userData (usado no smoke test de CI).
if (process.env.AED_USER_DATA) {
    app.setPath('userData', path.resolve(process.env.AED_USER_DATA));
}
const AED_DATA_DIR = app.getPath('userData');

// Modo smoke test: inicia o backend, valida boot + gravação de config e sai.
// Usado pela CI para testar o executável empacotado de verdade.
const SMOKE_TEST = process.env.AED_SMOKE_TEST === '1';
if (SMOKE_TEST) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu');
    app.disableHardwareAcceleration();
}

// No smoke test o app roda sem console anexado; grava diagnóstico em arquivo.
function smokeLog(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    if (!SMOKE_TEST) return;
    try {
        const logFile = path.join(app.getPath('userData'), 'smoke.log');
        fs.appendFileSync(logFile, line + '\n');
    } catch (e) {}
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
const { BACKEND_PROTOCOL_VERSION } = require(path.join(__dirname, 'backend', 'version.js'));

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

    // No app empacotado process.execPath é o próprio executável (que SEMPRE roda
    // a main.js — um spawn com [server.js] relançaria o app e esbarraria na
    // instância única). ELECTRON_RUN_AS_NODE faz o mesmo binário rodar o
    // server.js como um processo Node puro (funciona em dev e em produção).
    backendProcess = spawn(nodePath, [backendPath], {
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            NODE_ENV: 'production',
            PROJECT_ROOT: projectsDir,
            AED_DATA_DIR,
            PORT: BACKEND_PORT.toString(),
            BACKEND_TOKEN,
            BACKEND_SECRET: getOrCreateBackendSecret()
        },
        stdio: 'pipe',
        windowsHide: true
    });

    backendProcess.stdout.on('data', (data) => {
        smokeLog(`[Backend] ${data}`);
    });

    backendProcess.stderr.on('data', (data) => {
        smokeLog(`[Backend Error] ${data}`);
    });

    backendProcess.on('close', (code) => {
        smokeLog(`Backend finalizado com código ${code}`);
    });

    let attempts = 0;
    while (attempts < 15) {
        attempts++;
        const running = await isBackendRunning();
        if (running) {
            smokeLog('✅ Backend pronto!');
            return true;
        }
        await new Promise(r => setTimeout(r, 500));
    }

    smokeLog('❌ Timeout ao iniciar backend');
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
    args.push(`--${platform}`);
    // electron-builder espera flags booleanas (--x64/--ia32/--arm64), não o
    // valor cru "x64". Sem o prefixo, o valor vira argumento posicional inválido.
    if (['x64', 'ia32', 'arm64'].includes(arch)) args.push(`--${arch}`);
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

// =============================================
//  AUTO-UPDATE (electron-updater)
//  Ativo apenas em builds empacotados (e fora do smoke test). Enquanto os
//  instaladores não forem assinados, mantenha `verifyUpdateCodeSignature: false`
//  no package.json; reative quando a assinatura estiver configurada.
// =============================================
// O checkForUpdates() retorna uma Promise que REJEITA quando não há feed de
// atualização válido (ex.: release sem latest.yml). Uma rejeição não tratada
// cairia no process.on('unhandledRejection') e derrubaria o app — o auto-update
// nunca pode matar o aplicativo, então sempre anexamos .catch().
function safeCheckForUpdates(autoUpdater) {
    try {
        const p = autoUpdater.checkForUpdates();
        if (p && typeof p.catch === 'function') {
            p.catch((err) => console.error('[AutoUpdater] verificação de atualização falhou (ignorada):', err && err.message));
        }
    } catch (e) {
        console.error('[AutoUpdater] verificação de atualização falhou (ignorada):', e && e.message);
    }
}

function setupAutoUpdater() {
    if (!app.isPackaged || SMOKE_TEST) return;
    if (process.platform === 'linux') return; // AppImage exige config extra de repositório
    try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.logger = console;
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.on('error', (err) => console.error('[AutoUpdater] erro:', err && err.message));
        autoUpdater.on('update-available', () => console.log('[AutoUpdater] nova versão disponível — baixando...'));
        autoUpdater.on('update-downloaded', async (info) => {
            console.log('[AutoUpdater] atualização baixada, instalando...');
            try {
                const { response } = await dialog.showMessageBox({
                    type: 'info',
                    title: 'Atualização disponível',
                    message: `Aedificator ${info.version} foi baixada.`,
                    detail: 'Reinicie agora para instalar a nova versão.',
                    buttons: ['Reiniciar agora', 'Depois'],
                    defaultId: 0,
                    cancelId: 1
                });
                if (response === 0) autoUpdater.quitAndInstall();
            } catch (e) {
                console.error('[AutoUpdater] erro ao confirmar instalação:', e.message);
            }
        });
        setTimeout(() => { safeCheckForUpdates(autoUpdater); }, 10000);
        setInterval(() => { safeCheckForUpdates(autoUpdater); }, 4 * 60 * 60 * 1000);
        console.log('🔄 Auto-update habilitado.');
    } catch (e) {
        console.error('❌ Não foi possível inicializar auto-update:', e.message);
    }
}

// =============================================
//  SMOKE TEST (usado pela CI no exe empacotado)
// =============================================
async function runSmokeTest(backendOk) {
    const fail = (msg) => {
        smokeLog(`SMOKE_FAIL: ${msg}`);
        try { if (backendProcess) backendProcess.kill(); } catch (e) {}
        app.exit(1);
    };
    if (!backendOk) return fail('backend não iniciou');

    const headers = { 'Authorization': `Bearer ${BACKEND_TOKEN}`, 'Content-Type': 'application/json' };
    try {
        const health = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`, { headers });
        if (health.status !== 200) return fail(`health respondeu ${health.status}`);
        smokeLog('health OK');

        // Frontend e assets empacotados precisam ser servidos de dentro do asar:
        // valida index.html (com token injetado) e os assets críticos (monaco).
        const index = await fetch(`http://127.0.0.1:${BACKEND_PORT}/`);
        const indexHtml = await index.text();
        if (index.status !== 200 || !/<script/i.test(indexHtml)) {
            return fail(`index.html não foi servido corretamente (status ${index.status})`);
        }
        const loader = await fetch(`http://127.0.0.1:${BACKEND_PORT}/node_modules/monaco-editor/min/vs/loader.js`);
        if (loader.status !== 200) return fail(`monaco loader respondeu ${loader.status}`);
        const appJs = await fetch(`http://127.0.0.1:${BACKEND_PORT}/script.js`);
        if (appJs.status !== 200) return fail(`script.js respondeu ${appJs.status}`);
        smokeLog('frontend + monaco servidos OK');
        // Força uma gravação real de config no diretório de dados gravável
        // (regressão do bug em que o app empacotado tentava gravar no asar).
        const cfg = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ deepseekModel: 'deepseek-v4-pro' })
        });
        if (cfg.status !== 200) return fail(`POST /api/config respondeu ${cfg.status}`);
        smokeLog('POST /api/config OK');
        await new Promise((r) => setTimeout(r, 400));
        const configFile = path.join(AED_DATA_DIR, 'config.json');
        if (!fs.existsSync(configFile)) return fail('config.json não foi gravado em AED_DATA_DIR (userData)');

        // Garantia de privacidade: o app empacotado NUNCA pode nascer com as
        // chaves do desenvolvedor. Se algum dia o config.json do dev vazar para
        // o pacote, ele seria decifrado (BACKEND_SECRET viaja no asar) e copiado
        // para o userData — este check falha o build nesse caso.
        try {
            const saved = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
            const vazadas = ['gemini', 'deepseek', 'opencode', 'openai', 'claude']
                .filter((p) => saved[p] && String(saved[p].apiKey || '').length > 0);
            if (vazadas.length > 0) {
                return fail(`config.json empacotado vazou chaves de: ${vazadas.join(', ')} (chaves do desenvolvedor NÃO podem ir para o instalador)`);
            }
            smokeLog('chaves em branco OK (config gerado sem chaves do desenvolvedor)');
        } catch (e) {
            return fail(`falha ao validar config.json gerado: ${e.message}`);
        }

        smokeLog(`SMOKE_OK config.json em: ${configFile}`);
        try { if (backendProcess) backendProcess.kill(); } catch (e) {}
        app.exit(0);
    } catch (e) {
        return fail(e.message);
    }
}

app.whenReady().then(async () => {
    console.log('📱 App pronto!');
    app.setAppUserModelId('com.aedificator.codex.ide');
    const backendOk = await startBackend();
    if (SMOKE_TEST) {
        await runSmokeTest(backendOk);
        return;
    }
    createWindow();
    setupAutoUpdater();
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

// Garante que o backend não fique órfão em saídas que não passam por
// window-all-closed (ex.: auto-update quitAndInstall, app.exit no smoke test).
app.on('before-quit', () => {
    if (backendProcess) {
        try { backendProcess.kill(); } catch (e) {}
        backendProcess = null;
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
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Rejeição não tratada:', reason);
    process.exit(1);
});

console.log('🏗️ Aedificator Codex IDE aguardando eventos...');
console.log('💡 Funcionalidades disponíveis:');
console.log('   - Selecionar pasta (explorador nativo)');
console.log('   - Abrir pasta no explorador do sistema');
console.log('   - Backend automático');
console.log('   - Instância única');