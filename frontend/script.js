// =============================================
//  AEDIFICATOR CODEX - COM EXPLORADOR NATIVO
//  VERSÃO COMPLETA COM TODAS AS MELHORIAS
// =============================================

let BACKEND_URL = 'http://localhost:3001';
let WS_URL = 'ws://localhost:3001';
let BACKEND_TOKEN = '';
let currentModel = 'gemini';
let currentMode = 'cowork';
let isStreaming = false;
let ws = null;
let wsReconnectDelay = 1000;
let pendingStream = null;
let backendReady = false;
let currentProjectPath = '';
let fileStatusMap = {};
let isLinked = false;
let processedFiles = 0;
let totalFilesToProcess = 0;
let agentCounter = 0;
let agentDivIds = {};
let agentMessages = {};
let chatSaveTimer = null;
let pickerCurrentPath = '';
let pickerRoots = [];
let pendingApproval = null;
let autoExecTimer = null;
let autoExecCountdown = null;
let isRunning = false;
let runController = null;
let searchTimer = null;
let editorTabs = [];        // { path, content, loaded, dirty, isImage, imageUrl }
let activeTabPath = null;
let activityItems = [];     // { id, kind, icon, label, file, status, start, end, error, startTs }
let activitySeq = 0;
let actTaskId = null;
let repoInfo = null;

const CHAT_HISTORY_KEY = 'aedificator_chat_history';
const RECENT_PROJECTS_KEY = 'aedificator_recent_projects';
const THEME_KEY = 'aedificator_theme';
const AUTO_EXEC_KEY = 'aedificator_auto_exec';
const OPENCODE_KEY = 'aedificator_use_opencode';

// =============================================
//  UTILIDADES
// =============================================
function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatContent(text) {
    return escapeHtml(text).replace(/\n/g, '<br>');
}

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(36);
}

function getFileIcon(name) {
    const lower = String(name || '').toLowerCase();
    const ext = lower.split('.').pop() || '';
    const icons = {
        'js': '🟨', 'mjs': '🟨', 'cjs': '🟨',
        'jsx': '⚛️', 'tsx': '⚛️', 'ts': '🔷',
        'html': '🌐', 'htm': '🌐',
        'css': '🎨', 'scss': '🎨', 'sass': '🎨', 'less': '🎨',
        'json': '🧾', 'md': '📝', 'txt': '📄', 'log': '📄',
        'png': '🖼️', 'jpg': '🖼️', 'jpeg': '🖼️', 'gif': '🖼️', 'svg': '🖼️', 'webp': '🖼️', 'ico': '🖼️', 'bmp': '🖼️',
        'pdf': '📕', 'doc': '📘', 'docx': '📘',
        'xls': '📗', 'xlsx': '📗', 'csv': '📗',
        'zip': '📦', 'rar': '📦', '7z': '📦', 'tar': '📦', 'gz': '📦',
        'exe': '⚙️', 'msi': '⚙️', 'dll': '🧩',
        'bat': '🖥️', 'cmd': '🖥️', 'sh': '🖥️', 'ps1': '🖥️',
        'py': '🐍', 'java': '☕', 'c': '⚙️', 'cpp': '⚙️', 'h': '⚙️', 'hpp': '⚙️',
        'cs': '🟣', 'php': '🐘', 'rb': '💎', 'go': '🔵', 'rs': '🦀',
        'sql': '🗄️', 'yaml': '📑', 'yml': '📑', 'xml': '📑',
        'env': '🔑', 'lock': '🔒', 'config': '🔧'
    };
    if (lower === '.env') return '🔑';
    if (icons[ext]) return icons[ext];
    return '📄';
}

async function apiFetch(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (BACKEND_TOKEN) headers['Authorization'] = `Bearer ${BACKEND_TOKEN}`;
    return fetch(`${BACKEND_URL}${path}`, { ...options, headers });
}

// =============================================
//  INICIALIZAÇÃO
// =============================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('🚀 Aedificator Codex com Explorador Nativo iniciando...');

    if (window.electronAPI) {
        window.electronAPI.getBackendUrl().then((url) => {
            BACKEND_URL = url;
            WS_URL = url.replace('http', 'ws');
            initBackend();
        });
        window.electronAPI.getBackendToken().then((token) => {
            BACKEND_TOKEN = token || '';
        });
    } else {
        initBackend();
    }

    document.getElementById('modelSelect').addEventListener('change', (e) => {
        currentModel = e.target.value;
        showToast(`🔄 Modelo: ${e.target.options[e.target.selectedIndex].text}`);
    });

    document.getElementById('modeSelect').addEventListener('change', (e) => {
        currentMode = e.target.value;
        const modeText = e.target.options[e.target.selectedIndex].text;
        showToast(`🔄 Modo: ${modeText}`);
    });

    document.getElementById('sendButton').addEventListener('click', sendMessage);
    document.getElementById('chatInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
    document.getElementById('cancelButton').addEventListener('click', cancelTask);

    document.getElementById('configBtn').addEventListener('click', openConfigModal);
    document.getElementById('closeConfigBtn').addEventListener('click', closeConfigModal);
    document.getElementById('saveConfigBtn').addEventListener('click', saveConfig);

    document.getElementById('selectFolderBtn').addEventListener('click', selectFolder);
    document.getElementById('unlinkFolderBtn').addEventListener('click', unlinkFolder);

    document.getElementById('pickerUpBtn').addEventListener('click', pickerGoUp);
    document.getElementById('pickerDriveSelect').addEventListener('change', (e) => {
        if (e.target.value) loadPickerFolder(e.target.value);
    });
    document.getElementById('pickerSelectBtn').addEventListener('click', pickerSelect);
    document.getElementById('pickerCancelBtn').addEventListener('click', closeFolderPicker);

    document.getElementById('recentSelect').addEventListener('change', (e) => {
        if (e.target.value) {
            applySelectedFolder(e.target.value);
            e.target.value = '';
        }
    });

    document.getElementById('themeBtn').addEventListener('click', toggleTheme);
    document.getElementById('backupBtn').addEventListener('click', openBackupModal);
    document.getElementById('backupCloseBtn').addEventListener('click', closeBackupModal);

    document.getElementById('gitBtn').addEventListener('click', openGitModal);
    document.getElementById('gitRefreshBtn').addEventListener('click', loadGitStatus);
    document.getElementById('gitCommitBtn').addEventListener('click', gitCommit);
    document.getElementById('gitCloseBtn').addEventListener('click', () => {
        document.getElementById('gitModal').style.display = 'none';
    });

    document.getElementById('publishVersionBtn').addEventListener('click', openPublishModal);
    document.getElementById('pubRunBtn').addEventListener('click', publishVersion);
    document.getElementById('pubCloseBtn').addEventListener('click', closePublishModal);

    document.getElementById('terminalBtn').addEventListener('click', openTerminal);
    document.getElementById('terminalRunBtn').addEventListener('click', () => {
        runTerminalCommand(document.getElementById('terminalInput').value.trim());
    });
    document.getElementById('terminalInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') runTerminalCommand(e.target.value.trim());
    });
    document.getElementById('terminalCloseBtn').addEventListener('click', closeTerminal);

    document.getElementById('searchInput').addEventListener('input', onSearchInput);
    document.getElementById('searchInput').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.target.value = '';
            if (currentProjectPath) loadFolderStructure(currentProjectPath);
        }
    });

    document.getElementById('clearChatBtn').addEventListener('click', clearChat);
    document.getElementById('exportChatBtn').addEventListener('click', exportChat);
    document.getElementById('clearActivityBtn').addEventListener('click', clearActivity);

    initPanelResizers();

    document.getElementById('fileEditorContent').addEventListener('input', (e) => {
        const tab = editorTabs.find(t => t.path === activeTabPath);
        if (tab && !tab.isImage) {
            tab.content = e.target.value;
            tab.dirty = true;
        }
    });

    document.addEventListener('keydown', handleShortcuts);

    document.getElementById('autoExecCheckbox').addEventListener('change', (e) => {
        autoExecute = e.target.checked;
        try { localStorage.setItem(AUTO_EXEC_KEY, autoExecute ? '1' : '0'); } catch (err) {}
    });

    document.getElementById('approvalExecBtn').addEventListener('click', () => {
        stopAutoExecCountdown();
        executePendingPlan();
    });
    document.getElementById('approvalCancelBtn').addEventListener('click', cancelApproval);

    document.getElementById('fileEditorSaveBtn').addEventListener('click', saveFileEditor);
    document.getElementById('fileEditorCloseBtn').addEventListener('click', closeFileEditor);

    initTheme();
    initAutoExec();
    initOpenCodeToggle();
    populateRecentSelect();
    restoreChatHistory();

    window.addEventListener('beforeunload', () => {
        if (ws) ws.close();
    });
});

// =============================================
//  BACKEND
// =============================================
async function initBackend() {
    try {
        const res = await apiFetch('/api/health');
        if (res.ok) {
            backendReady = true;
            document.getElementById('backendStatus').textContent = '🟢 Conectado';
            document.getElementById('backendStatus').className = 'status-online';
            console.log('✅ Backend conectado!');
            connectWebSocket();
            await checkConfigStatus();
            await loadOpenCodeModels();
            tryLoadLastFolder();
        } else {
            throw new Error('Health check falhou');
        }
    } catch (e) {
        document.getElementById('backendStatus').textContent = '🔴 Desconectado';
        document.getElementById('backendStatus').className = 'status-offline';
        console.log('❌ Backend offline:', e.message);
        showToast('❌ Backend offline');
        setTimeout(initBackend, 5000);
    }
}

async function checkConfigStatus() {
    try {
        const res = await apiFetch('/api/config/status');
        const data = await res.json();
        if (!data.gemini.configured && !data.deepseek.configured && !data.opencode.configured) {
            showToast('⚠️ Configure sua chave API em "Chave"');
        }
    } catch (e) {}
}

async function loadOpenCodeModels() {
    try {
        const res = await apiFetch('/api/models/opencode');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success || !Array.isArray(data.models)) return;
        populateOpenCodeModels(data.models);
    } catch (e) {
        console.error('❌ Erro ao carregar modelos opencode:', e);
    }
}

function populateOpenCodeModels(models) {
    const select = document.getElementById('modelSelect');
    for (const opt of select.querySelectorAll('option[value^="opencode/"]')) {
        opt.remove();
    }
    const group = document.createElement('optgroup');
    group.label = '🟣 opencode (gratuitos)';
    for (const model of models) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = '🟣 opencode · ' + (model.name || model.id);
        group.appendChild(opt);
    }
    select.appendChild(group);
    applyOpenCodeToggle(document.getElementById('ocToggle').checked);
}

// =============================================
//  WEBSOCKET (RECONEXÃO AUTOMÁTICA)
// =============================================
function connectWebSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
        console.log('🔌 WebSocket conectado');
        wsReconnectDelay = 1000;
        if (pendingStream) {
            const msg = pendingStream;
            pendingStream = null;
            ws.send(JSON.stringify(msg));
        }
    };

    ws.onmessage = (event) => {
        try {
            handleWsMessage(JSON.parse(event.data));
        } catch (e) {
            console.error('❌ Erro ao processar mensagem:', e);
        }
    };

    ws.onclose = () => {
        console.log('🔌 WebSocket fechado');
        if (isStreaming) endTask('⟲ Conexão perdida');
        ws = null;
        if (backendReady) {
            setTimeout(connectWebSocket, wsReconnectDelay);
            wsReconnectDelay = Math.min(wsReconnectDelay * 2, 30000);
        }
    };

    ws.onerror = () => {
        // onclose virá em seguida e cuidará da reconexão
    };
}

function sendStreamingMessage(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return;
    }
    pendingStream = msg;
    showToast('🔄 Reconectando ao backend...');
    connectWebSocket();
}

function handleWsMessage(data) {
    if (data.type === 'plan') {
        setProgress(data.total);
        finishAnalysisActivity(true);
        if (data.total > 0) taskActivityProgress(`📋 Plano com ${data.total} alteração(ões)`)
        return;
    }

    if (data.type === 'file-status') {
        for (const file of data.files) {
            setFileStatus(file.file, file.status);
            refreshTabIfOpen(file.file);
            processedFiles++;
            if (data.files.length === 1) taskActivityProgress(`${file.action} ${file.file}`);
            fileActivity(file.file, file.status);
        }
        updateProgressUI();
        return;
    }

    if (data.type === 'chunk') {
        const agent = data.agent || 'Assistente';
        if (!agentMessages[agent]) {
            agentMessages[agent] = '';
            addMessage('agent', '', agent);
        }
        agentMessages[agent] += data.content;
        updateAgentMessage(agent, agentMessages[agent]);
        if (agent === 'Sistema') taskActivityProgress(data.content.replace(/[\n✅❌📄🗑️✏️🆕]/g, ''));
        return;
    }

    if (data.type === 'approval') {
        showApprovalModal(data);
        finishAnalysisActivity(true);
        taskActivityProgress('⏳ Aguardando aprovação do plano (execução)');
        return;
    }

    if (data.type === 'refresh') {
        if (currentProjectPath) loadFolderStructure(currentProjectPath);
        return;
    }

    if (data.type === 'done') {
        endTask('✅ Tarefa concluída!');
        return;
    }

    if (data.type === 'cancelled') {
        endTask('⏹️ Tarefa cancelada');
        return;
    }

    if (data.type === 'error') {
        showToast('❌ ' + data.content);
        endTask('❌ ' + data.content);
    }
}

// =============================================
//  ÚLTIMA PASTA USADA / PROJETOS RECENTES
// =============================================
function tryLoadLastFolder() {
    const lastPath = localStorage.getItem('aedificator_last_path');
    if (lastPath) {
        console.log(`📁 Carregando última pasta: ${lastPath}`);
        currentProjectPath = lastPath;
        document.getElementById('currentPathDisplay').textContent = lastPath;

        apiFetch('/api/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: lastPath })
        }).catch(() => {});

        loadFolderStructure(lastPath);
        setLinkedStatus(true);
        restoreChatHistory();
        detectRepoForProject();
        showToast(`📁 Pasta carregada: ${lastPath}`);
    }
}

function saveLastFolder(path) {
    localStorage.setItem('aedificator_last_path', path);
}

function getRecentProjects() {
    try { return JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY)) || []; } catch (e) { return []; }
}

function addRecentProject(path) {
    const recents = getRecentProjects().filter(r => r.path !== path);
    recents.unshift({ path, name: path.split(/[\\/]/).pop() || path, lastAccess: Date.now() });
    try { localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recents.slice(0, 10))); } catch (e) {}
    populateRecentSelect();
}

function populateRecentSelect() {
    const select = document.getElementById('recentSelect');
    const recents = getRecentProjects();
    select.innerHTML = '';
    if (recents.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '📂 Recentes (vazio)';
        select.appendChild(opt);
        select.disabled = true;
        return;
    }
    select.disabled = false;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '📂 Recentes';
    select.appendChild(placeholder);
    for (const r of recents) {
        const opt = document.createElement('option');
        opt.value = r.path;
        opt.textContent = r.name;
        select.appendChild(opt);
    }
}

// =============================================
//  SELECIONAR PASTA
// =============================================
function selectFolder() {
    openFolderPicker();
}

async function applySelectedFolder(folderPath) {
    currentProjectPath = folderPath;
    document.getElementById('currentPathDisplay').textContent = folderPath;
    saveLastFolder(folderPath);
    addRecentProject(folderPath);

    try {
        await apiFetch('/api/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectPath: folderPath })
        });
        console.log('✅ Backend atualizado com o novo caminho');
    } catch (e) {
        console.error('❌ Erro ao atualizar backend:', e);
    }

    await loadFolderStructure(folderPath);
    setLinkedStatus(true);
    restoreChatHistory();
    await detectRepoForProject();
    showToast(`📁 Pasta selecionada: ${folderPath}`);
}

// =============================================
//  EXPLORADOR DE PASTAS (SELEÇÃO DA RAIZ)
// =============================================
async function openFolderPicker() {
    const modal = document.getElementById('folderPickerModal');
    modal.style.display = 'flex';
    pickerCurrentPath = '';
    document.getElementById('pickerPathDisplay').textContent = '—';
    document.getElementById('pickerUpBtn').disabled = true;

    const driveSelect = document.getElementById('pickerDriveSelect');
    driveSelect.innerHTML = '<option value="">⏳ Unidades...</option>';

    const body = document.getElementById('folderPickerBody');
    body.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">⏳ Carregando unidades...</div>';

    try {
        const res = await apiFetch('/api/explorer/roots', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await res.json();
        pickerRoots = data.success ? data.roots : [];

        driveSelect.innerHTML = '';
        for (const root of pickerRoots) {
            const opt = document.createElement('option');
            opt.value = root.path;
            opt.textContent = root.name;
            driveSelect.appendChild(opt);
        }

        if (pickerRoots.length > 0) {
            pickerCurrentPath = pickerRoots[0].path;
            loadPickerFolder(pickerCurrentPath);
        } else {
            body.innerHTML = '<div style="padding:20px;text-align:center;color:#f85149;">❌ Nenhuma unidade encontrada</div>';
        }
    } catch (e) {
        console.error('❌ Erro ao carregar unidades:', e);
        body.innerHTML = '<div style="padding:20px;text-align:center;color:#f85149;">❌ Backend offline ou erro ao carregar unidades.<br><span style="font-size:11px;color:#8b949e;">Inicie o backend (node backend/server.js) antes de abrir o explorador.</span></div>';
    }
}

async function loadPickerFolder(folderPath) {
    pickerCurrentPath = folderPath;
    document.getElementById('pickerPathDisplay').textContent = folderPath;
    document.getElementById('pickerUpBtn').disabled = !getParentPath(folderPath);

    const body = document.getElementById('folderPickerBody');
    body.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">⏳ Carregando...</div>';

    try {
        const res = await apiFetch('/api/explorer/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: folderPath })
        });
        const data = await res.json();

        if (!data.success) {
            body.innerHTML = `<div style="padding:20px;text-align:center;color:#f85149;">❌ ${escapeHtml(data.error || 'Erro')}</div>`;
            return;
        }

        const files = data.files || [];
        const sorted = files.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name);
        });

        body.innerHTML = '';
        if (sorted.length === 0) {
            body.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">📂 Pasta vazia</div>';
            return;
        }

        for (const item of sorted) {
            const row = document.createElement('div');
            row.className = 'picker-item' + (item.isDirectory ? ' is-dir' : ' is-file');
            row.innerHTML = `
                <span class="icon">${item.isDirectory ? '📂' : getFileIcon(item.name)}</span>
                <span class="name">${escapeHtml(item.name)}</span>
            `;
            if (item.isDirectory) {
                row.addEventListener('click', () => loadPickerFolder(item.path));
            }
            body.appendChild(row);
        }
    } catch (e) {
        console.error('❌ Erro ao carregar pasta:', e);
        body.innerHTML = '<div style="padding:20px;text-align:center;color:#f85149;">❌ Erro ao carregar pasta (backend offline?)</div>';
    }
}

function getParentPath(p) {
    if (!p) return null;
    const cleaned = p.replace(/\\/g, '/');
    if (cleaned === '/' || /^[A-Za-z]:\/$/.test(cleaned)) return null;
    const idx = cleaned.lastIndexOf('/');
    if (idx < 0) return null;
    return cleaned.slice(0, idx);
}

function pickerGoUp() {
    const parent = getParentPath(pickerCurrentPath);
    if (parent) loadPickerFolder(parent);
}

function pickerSelect() {
    if (!pickerCurrentPath) return;
    closeFolderPicker();
    applySelectedFolder(pickerCurrentPath);
}

function closeFolderPicker() {
    document.getElementById('folderPickerModal').style.display = 'none';
}

// =============================================
//  DESVINCULAR PASTA
// =============================================
function unlinkFolder() {
    if (!isLinked) return;

    if (confirm('Deseja desvincular a pasta atual?\n\nIsso limpará o explorador e você poderá selecionar uma nova pasta.')) {
        currentProjectPath = '';
        fileStatusMap = {};
        processedFiles = 0;
        totalFilesToProcess = 0;
        document.getElementById('currentPathDisplay').textContent = 'Nenhuma pasta';
        document.getElementById('explorerBody').innerHTML = `
            <div style="padding:20px;text-align:center;color:#8b949e;font-size:13px;">
                📂 Nenhuma pasta selecionada<br>
                <span style="font-size:11px;color:#484f58;">Clique em "Selecionar Pasta"</span>
            </div>
        `;
        setLinkedStatus(false);
        localStorage.removeItem('aedificator_last_path');
        restoreChatHistory();
        repoInfo = null;
        document.getElementById('publishVersionBtn').disabled = true;
        document.getElementById('publishVersionBtn').title = '🚀 Seleciona uma pasta que é repositório Git (GitHub/GitLab)';
        showToast('🔗 Pasta desvinculada');
    }
}

function setLinkedStatus(linked) {
    isLinked = linked;
    const btn = document.getElementById('unlinkFolderBtn');
    const status = document.getElementById('pathStatus');

    if (linked) {
        btn.disabled = false;
        status.textContent = '🔗 Vinculado';
        status.className = 'path-status linked';
        document.getElementById('searchInput').disabled = false;
    } else {
        btn.disabled = true;
        status.textContent = '🔗 Desvinculado';
        status.className = 'path-status unlinked';
        document.getElementById('searchInput').disabled = true;
        document.getElementById('searchInput').value = '';
    }
}

// =============================================
//  DETECÇÃO AUTOMÁTICA DE REPOSITÓRIO (GitHub/GitLab)
// =============================================
async function detectRepoForProject() {
    const btn = document.getElementById('publishVersionBtn');
    btn.disabled = true;
    if (!currentProjectPath) return;
    try {
        const res = await apiFetch('/api/git/detect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await res.json();
        repoInfo = data;
        if (data.success && data.isRepo && data.provider) {
            btn.disabled = false;
            btn.title = `🚀 Publicar ${data.provider === 'github' ? 'GitHub' : 'GitLab'}: ${data.owner}/${data.repo}`;
            showToast(`🚀 Repositório detectado: ${data.provider} ${data.owner}/${data.repo}`);
        } else {
            btn.title = '🚀 Seleciona uma pasta que é repositório Git (GitHub/GitLab)';
            repoInfo = null;
        }
    } catch (e) {
        repoInfo = null;
    }
}

// =============================================
//  PUBLICAR VERSÃO (git tag + push)
// =============================================
function openPublishModal() {
    document.getElementById('publishModal').style.display = 'flex';
    document.getElementById('pubOutput').style.display = 'none';
    document.getElementById('pubOutput').textContent = '';
    document.getElementById('pubCommitMsg').value = '';
    const runBtn = document.getElementById('pubRunBtn');

    if (repoInfo && repoInfo.isRepo && repoInfo.provider) {
        const providerName = repoInfo.provider === 'github' ? 'GitHub' : 'GitLab';
        document.getElementById('pubRepoInfo').textContent = `🗂️ ${repoInfo.owner}/${repoInfo.repo}`;
        document.getElementById('pubRepoInfo').className = 'pub-badge ' + repoInfo.provider;
        document.getElementById('pubHint').textContent =
            `Repositório ${providerName} (branch ${repoInfo.branch}). ` +
            `Última tag: ${repoInfo.latestTag || 'nenhuma'} → próxima: ${repoInfo.nextTag || 'v1.0.0'}.`;
        runBtn.disabled = false;
    } else {
        document.getElementById('pubRepoInfo').textContent = 'ℹ️ Nenhum repositório GitHub/GitLab detectado.';
        document.getElementById('pubRepoInfo').className = 'pub-badge none';
        document.getElementById('pubHint').textContent =
            'Selecione uma pasta que seja um repositório Git com remote origin apontando para GitHub ou GitLab.';
        runBtn.disabled = true;
    }
}

function closePublishModal() {
    document.getElementById('publishModal').style.display = 'none';
}

async function publishVersion() {
    const runBtn = document.getElementById('pubRunBtn');
    const out = document.getElementById('pubOutput');
    if (runBtn.disabled) return;

    const msg = document.getElementById('pubCommitMsg').value.trim();
    runBtn.disabled = true;
    out.style.display = 'block';
    out.textContent = '🚀 Publicando versão...';

    try {
        const res = await apiFetch('/api/git/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg || undefined })
        });
        const data = await res.json();
        if (data.success) {
            out.textContent += `\n\n✅ Versão ${data.tag} publicada!`;
            if (data.output) out.textContent += `\n${data.output}`;
            showToast(`✅ Versão ${data.tag} publicada!`);
            await detectRepoForProject();
        } else {
            out.textContent += `\n\n❌ ${data.error || 'Falha na publicação'}`;
            showToast('❌ ' + (data.error || 'Falha na publicação'));
        }
    } catch (e) {
        out.textContent += '\n\n❌ ' + e.message;
        showToast('❌ ' + e.message);
    } finally {
        runBtn.disabled = false;
        out.scrollTop = out.scrollHeight;
    }
}

// =============================================
//  CARREGAR ESTRUTURA DE PASTAS
// =============================================
async function loadFolderStructure(folderPath) {
    try {
        console.log(`📤 Enviando requisição para listar: ${folderPath}`);

        const res = await apiFetch('/api/explorer/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: folderPath })
        });
        const data = await res.json();

        console.log(`📥 Resposta:`, data);

        if (data.success) {
            renderExplorer(data.files, '');
            showToast(`📁 ${data.files.length} itens encontrados em ${folderPath}`);
        } else {
            showToast('❌ ' + (data.error || 'Erro ao carregar pastas'));
        }
    } catch (e) {
        console.error('❌ Erro:', e);
        showToast('❌ Erro ao carregar pastas: ' + e.message);
    }
}

// =============================================
//  RENDERIZAR EXPLORADOR
// =============================================
const STATUS_CLASSES = {
    'normal': 'status-normal',
    'modified': 'status-modified',
    'created': 'status-created',
    'editing': 'status-editing',
    'deleted': 'status-deleted'
};

function renderExplorer(files, basePath) {
    const container = document.getElementById('explorerBody');
    container.innerHTML = '';

    if (!files || files.length === 0) {
        container.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;font-size:13px;">📂 Pasta vazia</div>';
        return;
    }

    const sorted = files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
    });

    for (const item of sorted) {
        const div = document.createElement('div');
        const fullPath = item.path || (basePath ? `${basePath}/${item.name}` : item.name);

        if (item.isDirectory) {
            div.className = 'folder-item';
            div.innerHTML = `
                <span class="icon">📂</span>
                <span class="name">${escapeHtml(item.name)}</span>
                <span class="chevron">▶</span>
            `;
            const childrenDiv = document.createElement('div');
            childrenDiv.className = 'children';
            div.appendChild(childrenDiv);

            div.addEventListener('click', async () => {
                const isOpen = childrenDiv.classList.toggle('open');
                div.querySelector('.chevron').classList.toggle('open');
                if (isOpen && childrenDiv.children.length === 0) {
                    const subFiles = await loadSubFolder(fullPath);
                    if (subFiles) {
                        renderSubFolder(childrenDiv, subFiles, fullPath);
                    }
                }
            });

        } else {
            const status = fileStatusMap[fullPath] || 'normal';
            div.className = `file-item ${STATUS_CLASSES[status] || 'status-normal'}`;
            div.dataset.path = fullPath;
            div.innerHTML = `
                <span class="icon">${getFileIcon(item.name)}</span>
                <span class="name">${escapeHtml(item.name)}</span>
                <span class="status-dot"></span>
            `;
            div.addEventListener('click', () => {
                openFile(fullPath);
            });
        }
        container.appendChild(div);
    }
}

async function loadSubFolder(folderPath) {
    try {
        const res = await apiFetch('/api/explorer/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: folderPath })
        });
        const data = await res.json();
        return data.success ? data.files : null;
    } catch (e) {
        return null;
    }
}

function renderSubFolder(container, files, basePath) {
    container.innerHTML = '';
    const sorted = files.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
    });

    for (const item of sorted) {
        const div = document.createElement('div');
        const fullPath = item.path || `${basePath}/${item.name}`;

        if (item.isDirectory) {
            div.className = 'folder-item';
            div.innerHTML = `
                <span class="icon">📂</span>
                <span class="name">${escapeHtml(item.name)}</span>
                <span class="chevron">▶</span>
            `;
            const childrenDiv = document.createElement('div');
            childrenDiv.className = 'children';
            div.appendChild(childrenDiv);

            div.addEventListener('click', async () => {
                const isOpen = childrenDiv.classList.toggle('open');
                div.querySelector('.chevron').classList.toggle('open');
                if (isOpen && childrenDiv.children.length === 0) {
                    const subFiles = await loadSubFolder(fullPath);
                    if (subFiles) {
                        renderSubFolder(childrenDiv, subFiles, fullPath);
                    }
                }
            });

        } else {
            const status = fileStatusMap[fullPath] || 'normal';
            div.className = `file-item ${STATUS_CLASSES[status] || 'status-normal'}`;
            div.dataset.path = fullPath;
            div.innerHTML = `
                <span class="icon">${getFileIcon(item.name)}</span>
                <span class="name">${escapeHtml(item.name)}</span>
                <span class="status-dot"></span>
            `;
            div.addEventListener('click', () => {
                openFile(fullPath);
            });
        }
        container.appendChild(div);
    }
}

// =============================================
//  SALVAR ABA ATIVA (EDITOR)
// =============================================
async function saveFileEditor() {
    const tab = editorTabs.find(t => t.path === activeTabPath);
    if (!tab || tab.isImage) return;
    const content = document.getElementById('fileEditorContent').value;
    const statusEl = document.getElementById('fileEditorStatus');

    try {
        const res = await apiFetch('/api/file/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: tab.path, content })
        });
        const data = await res.json();
        if (data.success) {
            tab.content = content;
            tab.dirty = false;
            statusEl.textContent = '✅ Arquivo salvo!';
            statusEl.className = 'success';
            setFileStatus(tab.path, 'modified');
            showToast('✅ Arquivo salvo: ' + tab.path);
        } else {
            statusEl.textContent = '❌ ' + (data.error || 'Falha ao salvar');
            statusEl.className = 'error';
        }
    } catch (e) {
        statusEl.textContent = '❌ ' + e.message;
        statusEl.className = 'error';
    }
}

// =============================================
//  STATUS DE ARQUIVOS (ATUALIZA O DOM DIRETO)
// =============================================
function setFileStatus(filePath, status) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    fileStatusMap[normalizedPath] = status;

    const cls = STATUS_CLASSES[status] || 'status-normal';
    const selector = `[data-path="${CSS.escape(normalizedPath)}"]`;
    const el = document.querySelector(selector);
    if (el) {
        if (status === 'deleted') {
            el.remove();
        } else {
            el.className = `file-item ${cls}`;
        }
    }
}

// =============================================
//  ATALHOS DE TECLADO
// =============================================
function handleShortcuts(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        selectFolder();
        return;
    }
    if (mod && e.key.toLowerCase() === 's') {
        if (document.getElementById('fileEditorModal').style.display === 'flex') {
            e.preventDefault();
            saveFileEditor();
        }
        return;
    }
    if (mod && e.key === ',') {
        e.preventDefault();
        openConfigModal();
        return;
    }
    if (mod && e.key === 'Enter') {
        e.preventDefault();
        if (document.activeElement === document.getElementById('chatInput')) sendMessage();
        return;
    }
    if (e.key === 'Escape') {
        if (document.getElementById('fileEditorModal').style.display === 'flex') {
            closeFileEditor();
            return;
        }
        if (document.getElementById('folderPickerModal').style.display === 'flex') {
            closeFolderPicker();
            return;
        }
        if (document.getElementById('approvalModal').style.display === 'flex') {
            cancelApproval();
            return;
        }
        if (document.getElementById('backupModal').style.display === 'flex') {
            closeBackupModal();
            return;
        }
        if (document.getElementById('gitModal').style.display === 'flex') {
            document.getElementById('gitModal').style.display = 'none';
            return;
        }
        if (document.getElementById('publishModal').style.display === 'flex') {
            closePublishModal();
            return;
        }
        if (document.getElementById('terminalModal').style.display === 'flex') {
            closeTerminal();
            return;
        }
        if (document.getElementById('configModal').style.display === 'flex') {
            closeConfigModal();
            return;
        }
        const search = document.getElementById('searchInput');
        if (search.value) {
            search.value = '';
            if (currentProjectPath) loadFolderStructure(currentProjectPath);
        }
    }
}

// =============================================
//  BUSCA NO PROJETO
// =============================================
function onSearchInput(e) {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => {
        if (!currentProjectPath) return;
        if (!q) {
            loadFolderStructure(currentProjectPath);
            return;
        }
        doSearch(q);
    }, 400);
}

async function doSearch(query) {
    const body = document.getElementById('explorerBody');
    body.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">🔍 Buscando...</div>';
    try {
        const res = await apiFetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, inContent: true })
        });
        const data = await res.json();
        if (!data.success) {
            body.innerHTML = `<div style="padding:20px;text-align:center;color:#f85149;">❌ ${escapeHtml(data.error || 'Erro')}</div>`;
            return;
        }
        renderSearchResults(data.results, query);
    } catch (e) {
        body.innerHTML = `<div style="padding:20px;text-align:center;color:#f85149;">❌ ${escapeHtml(e.message)}</div>`;
    }
}

function renderSearchResults(results, query) {
    const body = document.getElementById('explorerBody');
    body.innerHTML = '';

    if (!results || results.length === 0) {
        body.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">🔍 Nenhum resultado</div>';
        return;
    }

    const header = document.createElement('div');
    header.className = 'search-result-item';
    header.style.cursor = 'default';
    header.style.opacity = '0.7';
    header.innerHTML = `<span class="search-result-path">${results.length} resultado(s) para "${escapeHtml(query)}"</span>`;
    body.appendChild(header);

    for (const r of results) {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        let html = `<span class="search-result-path">📄 ${escapeHtml(r.path)}</span>`;
        if (r.matches && r.matches.length) {
            for (const m of r.matches.slice(0, 3)) {
                html += `<span class="search-result-line"><span class="search-line-num">${m.line}:</span>${escapeHtml(m.text)}</span>`;
            }
            if (r.matches.length > 3) {
                html += `<span class="search-result-line">... +${r.matches.length - 3} mais</span>`;
            }
        }
        item.innerHTML = html;
        item.addEventListener('click', () => openFile(r.path));
        body.appendChild(item);
    }
}

// =============================================
//  EXECUTAR COMANDOS (TERMINAL)
// =============================================
function openTerminal() {
    if (!currentProjectPath) {
        showToast('📁 Selecione uma pasta primeiro!');
        return;
    }
    document.getElementById('terminalModal').style.display = 'flex';
    const out = document.getElementById('terminalOutput');
    if (!out.textContent.trim()) {
        out.textContent = `📁 Diretório: ${currentProjectPath}\nDigite um comando abaixo.\n\n`;
    }
    document.getElementById('terminalInput').focus();
}

function closeTerminal() {
    document.getElementById('terminalModal').style.display = 'none';
}

function runTerminalCommand(command) {
    if (!command) return;
    if (!currentProjectPath) {
        showToast('📁 Selecione uma pasta primeiro!');
        return;
    }
    if (isStreaming || isRunning) {
        showToast('⏳ Aguarde a tarefa atual terminar');
        return;
    }

    const out = document.getElementById('terminalOutput');
    out.textContent += `$ ${command}\n`;
    out.scrollTop = out.scrollHeight;

    document.getElementById('terminalInput').value = '';
    const runBtn = document.getElementById('terminalRunBtn');
    runBtn.disabled = true;

    isRunning = true;
    document.getElementById('sendButton').disabled = true;
    runController = new AbortController();

    (async () => {
        try {
            const res = await apiFetch('/api/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command }),
                signal: runController.signal
            });
            const data = await res.json();
            if (data.success) {
                const txt = (data.output || '').trim() || '(sem saída)';
                out.textContent += `${txt}\n\n[exit code: ${data.code}]\n\n`;
            } else {
                out.textContent += `❌ ${data.error || 'Erro ao executar'}\n\n`;
            }
        } catch (e) {
            out.textContent += `❌ ${e.name === 'AbortError' ? 'Comando cancelado' : e.message}\n\n`;
        } finally {
            runController = null;
            isRunning = false;
            runBtn.disabled = false;
            document.getElementById('sendButton').disabled = false;
            out.scrollTop = out.scrollHeight;
            document.getElementById('terminalInput').focus();
        }
    })();
}

function addCommandOutput(text) {
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'message agent';
    div.innerHTML = `
        <div class="msg-header">
            <span class="agent-badge">🖥️ Terminal</span>
        </div>
        <div class="cmd-output">${escapeHtml(text)}</div>
    `;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    scheduleSaveChatHistory();
    return div.querySelector('.cmd-output');
}

// =============================================
//  LIMPAR / EXPORTAR CHAT
// =============================================
function clearChat() {
    if (!confirm('Limpar toda a conversa?')) return;
    document.getElementById('messages').innerHTML = '';
    saveChatHistory();
    showToast('🗑️ Conversa limpa');
}

function exportChat() {
    const container = document.getElementById('messages');
    let text = `Aedificator Codex - Conversa\n${new Date().toLocaleString()}\n\n`;
    for (const div of container.children) {
        const role = div.classList.contains('user') ? 'Usuário' : div.classList.contains('agent') ? 'Assistente' : 'Sistema';
        const contentEl = div.querySelector('.msg-content') || div.querySelector('.cmd-output');
        const content = contentEl ? contentEl.textContent : '';
        if (content.trim()) text += `[${role}]\n${content}\n\n`;
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `conversa-${new Date().toISOString().slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    showToast('⬇️ Conversa exportada');
}

// =============================================
//  GIT
// =============================================
async function openGitModal() {
    if (!currentProjectPath) {
        showToast('📁 Selecione uma pasta primeiro!');
        return;
    }
    document.getElementById('gitModal').style.display = 'flex';
    document.getElementById('gitMessageInput').value = '';
    await loadGitStatus();
}

async function loadGitStatus() {
    const out = document.getElementById('gitOutput');
    const commitBtn = document.getElementById('gitCommitBtn');
    const msgInput = document.getElementById('gitMessageInput');
    out.textContent = '⏳ Carregando status...';
    commitBtn.disabled = true;
    msgInput.disabled = true;
    try {
        const res = await apiFetch('/api/git/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await res.json();
        out.textContent = data.success ? data.output : ('❌ ' + (data.error || 'Erro'));
        if (data.success && data.isRepo) {
            commitBtn.disabled = false;
            msgInput.disabled = false;
        }
    } catch (e) {
        out.textContent = '❌ ' + e.message;
    }
}

async function gitCommit() {
    const message = document.getElementById('gitMessageInput').value.trim();
    if (!message) {
        showToast('⚠️ Digite uma mensagem de commit');
        return;
    }
    const btn = document.getElementById('gitCommitBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Commitando...';
    try {
        const res = await apiFetch('/api/git/commit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ Commit realizado!');
            document.getElementById('gitMessageInput').value = '';
            await loadGitStatus();
        } else {
            showToast('❌ ' + (data.error || 'Falha no commit'));
        }
    } catch (e) {
        showToast('❌ ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '✅ Commit';
    }
}

// =============================================
//  EDITOR EM ABAS
// =============================================
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'];

function isImagePath(p) {
    const ext = (String(p).split('.').pop() || '').toLowerCase();
    return IMAGE_EXTS.includes(ext);
}

function openFile(filePath) {
    const existing = editorTabs.find(t => t.path === filePath);
    if (existing) {
        activateTab(filePath);
        return;
    }
    editorTabs.push({ path: filePath, content: '', loaded: false, dirty: false, isImage: isImagePath(filePath), imageUrl: null });
    activateTab(filePath);
    document.getElementById('fileEditorModal').style.display = 'flex';
    loadTabContent(filePath);
}

async function loadTabContent(filePath) {
    const tab = editorTabs.find(t => t.path === filePath);
    if (!tab || tab.loaded) return;
    const statusEl = document.getElementById('fileEditorStatus');
    statusEl.textContent = '⏳ Carregando...';
    statusEl.className = '';

    try {
        if (tab.isImage) {
            const res = await apiFetch('/api/file/image', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: filePath })
            });
            const data = await res.json();
            tab.loaded = true;
            if (data.success) {
                tab.imageUrl = data.dataUrl;
                if (activeTabPath === filePath) renderActiveTab();
                statusEl.textContent = '🖼️ Pré-visualização de imagem';
            } else {
                statusEl.textContent = '❌ ' + (data.error || 'Erro ao carregar imagem');
                statusEl.className = 'error';
            }
            return;
        }

        const res = await apiFetch('/api/file/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath })
        });
        const data = await res.json();
        tab.loaded = true;
        if (data.success) {
            tab.content = data.content;
            if (activeTabPath === filePath) renderActiveTab();
            statusEl.textContent = '✏️ Editável - Salve para aplicar as mudanças';
        } else {
            tab.content = '';
            if (activeTabPath === filePath) renderActiveTab();
            statusEl.textContent = '❌ ' + (data.error || 'Não foi possível ler');
            statusEl.className = 'error';
        }
    } catch (e) {
        tab.loaded = true;
        statusEl.textContent = '❌ Erro: ' + e.message;
        statusEl.className = 'error';
    }
}

function activateTab(filePath) {
    activeTabPath = filePath;
    document.getElementById('fileEditorTitle').textContent = filePath;
    renderTabs();
    renderActiveTab();
}

function renderTabs() {
    const bar = document.getElementById('editorTabs');
    bar.innerHTML = '';
    for (const tab of editorTabs) {
        const el = document.createElement('div');
        el.className = 'editor-tab' + (tab.path === activeTabPath ? ' active' : '');
        el.title = tab.path;
        const name = tab.path.split('/').pop() || tab.path;
        el.innerHTML = `<span class="tab-name">${escapeHtml(name)}</span><button class="tab-close" title="Fechar aba">×</button>`;
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('tab-close')) {
                e.stopPropagation();
                closeTab(tab.path);
                return;
            }
            activateTab(tab.path);
        });
        bar.appendChild(el);
    }
}

function renderActiveTab() {
    const tab = editorTabs.find(t => t.path === activeTabPath);
    if (!tab) return;
    const ta = document.getElementById('fileEditorContent');
    const imgWrap = document.getElementById('fileEditorImageWrap');
    const img = document.getElementById('fileEditorImage');
    const saveBtn = document.getElementById('fileEditorSaveBtn');

    if (tab.isImage) {
        ta.style.display = 'none';
        saveBtn.style.display = 'none';
        if (tab.imageUrl) {
            imgWrap.style.display = 'flex';
            img.src = tab.imageUrl;
        } else {
            imgWrap.style.display = 'none';
            img.src = '';
        }
        return;
    }

    imgWrap.style.display = 'none';
    img.src = '';
    ta.style.display = 'block';
    saveBtn.style.display = 'inline-block';
    ta.value = tab.content;
}

function closeTab(filePath) {
    const idx = editorTabs.findIndex(t => t.path === filePath);
    if (idx < 0) return;
    editorTabs.splice(idx, 1);
    if (activeTabPath === filePath) {
        const next = editorTabs[idx] || editorTabs[idx - 1];
        if (next) {
            activateTab(next.path);
        } else {
            activeTabPath = null;
            document.getElementById('fileEditorModal').style.display = 'none';
        }
    }
    renderTabs();
}

function refreshTabIfOpen(filePath) {
    const tab = editorTabs.find(t => t.path === filePath);
    if (!tab || tab.dirty) return;
    tab.loaded = false;
    loadTabContent(filePath);
}

function closeFileEditor() {
    document.getElementById('fileEditorModal').style.display = 'none';
    document.getElementById('fileEditorContent').value = '';
    document.getElementById('fileEditorImageWrap').style.display = 'none';
}

// =============================================
//  APROVAÇÃO DO PLANO
// =============================================
let autoExecute = true;

function initAutoExec() {
    try {
        autoExecute = localStorage.getItem(AUTO_EXEC_KEY) !== '0';
    } catch (e) {}
    document.getElementById('autoExecCheckbox').checked = autoExecute;
}

function showApprovalModal(data) {
    if (!data.arquivos || data.arquivos.length === 0) {
        showToast('📋 Nada a executar');
        executePendingPlan();
        return;
    }

    pendingApproval = data;
    document.getElementById('approvalResumo').textContent = data.resumo || '';
    const list = document.getElementById('approvalFilesList');
    list.innerHTML = '';

    for (const f of data.arquivos) {
        const row = document.createElement('div');
        row.className = 'approval-file';
        const actionText = f.acao === 'criar' ? '🆕 Criar' : f.acao === 'deletar' ? '🗑️ Deletar' : '✏️ Modificar';
        const actionClass = f.acao === 'criar' ? 'acao-criar' : f.acao === 'deletar' ? 'acao-deletar' : 'acao-modificar';
        row.innerHTML = `
            <span class="approval-acao ${actionClass}">${actionText}</span>
            <span class="approval-caminho">${escapeHtml(f.caminho)}</span>
        `;
        if (f.explicacao) row.title = f.explicacao;
        list.appendChild(row);
    }

    document.getElementById('approvalModal').style.display = 'flex';
    setProgress(data.total);

    if (autoExecute) {
        startAutoExecCountdown();
    } else {
        stopAutoExecCountdown();
    }
}

function startAutoExecCountdown() {
    stopAutoExecCountdown();
    const el = document.getElementById('approvalAutoMsg');
    el.style.display = 'block';
    autoExecCountdown = 5;
    el.textContent = `⚡ Executando automaticamente em ${autoExecCountdown}s...`;
    autoExecTimer = setInterval(() => {
        autoExecCountdown--;
        if (autoExecCountdown <= 0) {
            stopAutoExecCountdown();
            el.style.display = 'none';
            executePendingPlan();
        } else {
            el.textContent = `⚡ Executando automaticamente em ${autoExecCountdown}s...`;
        }
    }, 1000);
}

function stopAutoExecCountdown() {
    if (autoExecTimer) clearInterval(autoExecTimer);
    autoExecTimer = null;
    const el = document.getElementById('approvalAutoMsg');
    if (el) {
        el.style.display = 'none';
        el.textContent = '';
    }
}

function executePendingPlan() {
    if (!pendingApproval) return;
    const planId = pendingApproval.planId;
    const total = pendingApproval.total;
    closeApprovalModal();
    pendingApproval = null;
    setProgress(total);
    sendStreamingMessage({ type: 'execute', planId, token: BACKEND_TOKEN });
}

function cancelApproval() {
    stopAutoExecCountdown();
    closeApprovalModal();
    pendingApproval = null;
    sendStreamingMessage({ type: 'cancel' });
    endTask('⏹️ Plano rejeitado');
}

function closeApprovalModal() {
    document.getElementById('approvalModal').style.display = 'none';
}

// =============================================
//  ENVIO DE MENSAGEM
// =============================================
function sendMessage() {
    const input = document.getElementById('chatInput');
    const message = input.value.trim();
    if (!message || isStreaming || isRunning) return;

    if (message.startsWith('/run ')) {
        const cmd = message.slice(5).trim();
        input.value = '';
        if (!cmd) {
            showToast('⚠️ Uso: /run <comando>');
            return;
        }
        openTerminal();
        document.getElementById('terminalInput').value = cmd;
        runTerminalCommand(cmd);
        return;
    }

    if (!currentProjectPath) {
        showToast('📁 Selecione uma pasta primeiro!');
        return;
    }

    input.value = '';
    addMessage('user', message);
    isStreaming = true;
    document.getElementById('sendButton').disabled = true;
    document.getElementById('cancelButton').style.display = 'inline-block';

    processedFiles = 0;
    totalFilesToProcess = 0;
    agentMessages = {};
    hideProgress();
    closeApprovalModal();

    startTaskActivity('🧠 Processando: ' + (message.length > 48 ? message.slice(0, 48) + '…' : message));
    startAnalysisActivity();

    sendStreamingMessage({
        type: 'stream',
        message: message,
        model: currentModel,
        mode: currentMode,
        projectPath: currentProjectPath,
        token: BACKEND_TOKEN,
        history: collectChatHistory()
    });
}

function collectChatHistory() {
    const container = document.getElementById('messages');
    const items = [];
    for (const div of container.children) {
        const role = div.classList.contains('user') ? 'user' : div.classList.contains('agent') ? 'assistant' : null;
        if (!role) continue;
        const contentEl = div.querySelector('.msg-content');
        const content = contentEl ? contentEl.textContent.trim() : '';
        if (content) items.push({ role, content });
    }
    return items.slice(-15);
}

function endTask(toastMsg) {
    const finalStatus = toastMsg && (toastMsg.includes('cancelada') || toastMsg.includes('cancelled')) ? 'cancelled'
        : toastMsg && (toastMsg.includes('❌') || toastMsg.includes('Erro') || toastMsg.includes('error')) ? 'error'
        : 'success';
    finishAnalysisActivity(finalStatus === 'success');
    setActivityStatus('task', finalStatus, { error: toastMsg && finalStatus === 'error' ? toastMsg : '' });
    if (finalStatus === 'error' || finalStatus === 'cancelled') {
        for (const item of activityItems) {
            if (item.status === 'running') setActivityStatus(item.id, finalStatus);
        }
    }
    if (toastMsg) showToast(toastMsg);
    isStreaming = false;
    document.getElementById('sendButton').disabled = false;
    document.getElementById('cancelButton').style.display = 'none';
    hideProgress();
    stopAutoExecCountdown();
    closeApprovalModal();
    saveChatHistory();
}

function cancelTask() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'cancel' }));
        document.getElementById('cancelButton').style.display = 'none';
        showToast('⏹️ Cancelando...');
    } else {
        showToast('⏹️ Sem conexão com o backend');
    }
}

// =============================================
//  PROGRESSO
// =============================================
function setProgress(total) {
    totalFilesToProcess = total || 0;
    processedFiles = 0;
    const bar = document.getElementById('progressBar');
    if (totalFilesToProcess > 0) {
        bar.style.display = 'flex';
        updateProgressUI();
    } else {
        bar.style.display = 'none';
    }
}

function updateProgressUI() {
    const pct = totalFilesToProcess > 0 ? Math.round((processedFiles / totalFilesToProcess) * 100) : 0;
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressText').textContent = `${processedFiles}/${totalFilesToProcess}`;
}

function hideProgress() {
    document.getElementById('progressBar').style.display = 'none';
    processedFiles = 0;
    totalFilesToProcess = 0;
}

// =============================================
//  PAINEL DE ATIVIDADE DA IA (CENTRO)
// =============================================
function fmtTime(ts) {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDur(ms) {
    if (ms == null) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}

function upsertActivity(id, patch) {
    let item = activityItems.find(a => a.id === id);
    if (!item) {
        item = { id, kind: 'processo', icon: '⚙️', label: '', file: '', status: 'running', start: Date.now(), startTs: Date.now(), end: null, error: '' };
        activityItems.push(item);
    }
    Object.assign(item, patch);
    renderActivity();
    return item;
}

function setActivityStatus(id, status, opts) {
    const item = activityItems.find(a => a.id === id);
    if (!item) return;
    item.status = status;
    item.end = Date.now();
    if (opts && opts.error) item.error = opts.error;
    if (opts && opts.label) item.label = opts.label;
    renderActivity();
}

function clearActivity() {
    activityItems = [];
    actTaskId = null;
    renderActivity();
}

function renderActivity() {
    const list = document.getElementById('activityList');
    if (!list) return;
    if (activityItems.length === 0) {
        list.innerHTML = `<div class="activity-empty">Ainda não há atividade.<br><span class="activity-empty-sub">Envie um comando no chat para acompanhar aqui</span></div>`;
        return;
    }
    list.innerHTML = '';
    for (const item of activityItems) {
        const statusText = item.status === 'running' ? 'Executando' : item.status === 'success' ? 'Concluído' : item.status === 'error' ? 'Erro' : item.status === 'cancelled' ? 'Cancelado' : '—';
        const div = document.createElement('div');
        div.className = `act-item ${item.status}`;
        let html = `
            <div class="act-top">
                <span class="act-icon">${item.icon}</span>
                <span class="act-label">${escapeHtml(item.label || 'Processo')}</span>
                <span class="act-status-pill ${item.status}">${statusText}</span>
            </div>
        `;
        if (item.file) html += `<div class="act-file">${escapeHtml(item.file)}</div>`;
        html += `<div class="act-times">
            <span class="time">▶️ ${fmtTime(item.start)}</span>
            <span class="time">⏹️ ${fmtTime(item.end)}</span>
            ${item.end ? `<span class="act-dur">⏱️ ${fmtDur(item.end - item.startTs)}</span>` : ''}
        </div>`;
        if (item.error) html += `<div class="act-error">❌ ${escapeHtml(item.error)}</div>`;
        div.innerHTML = html;
        list.appendChild(div);
    }
    list.scrollTop = list.scrollHeight;
}

// ===== HOOKS DE ATIVIDADE =====
function startTaskActivity(label) {
    clearActivity();
    upsertActivity('task', { kind: 'task', icon: '🧠', label: label || 'Processando solicitação...', status: 'running', error: '' });
    actTaskId = 'task';
}

function startAnalysisActivity() {
    upsertActivity('analysis', { kind: 'process', icon: '🔍', label: 'Analisando projeto / planejando', status: 'running', error: '' });
}

function finishAnalysisActivity(success) {
    setActivityStatus('analysis', success ? 'success' : 'error');
}

function fileActivity(file, status) {
    const id = `file:${file}`;
    if (status === 'editing') {
        upsertActivity(id, { kind: 'file', icon: '✏️', label: 'Alterando arquivo', file, status: 'running', error: '' });
        return;
    }
    const icon = status === 'created' ? '🆕' : status === 'modified' ? '✅' : status === 'deleted' ? '🗑️' : '📄';
    const label = status === 'created' ? 'Arquivo criado' : status === 'modified' ? 'Arquivo modificado' : status === 'deleted' ? 'Arquivo deletado' : 'Arquivo';
    upsertActivity(id, { kind: 'file', icon, label, file });
    setActivityStatus(id, 'success');
}

function taskActivityProgress(text) {
    const item = activityItems.find(a => a.id === actTaskId);
    if (!item) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    item.label = clean.slice(0, 70);
    renderActivity();
}

// =============================================
//  PAINÉIS REDIMENSIONÁVEIS
// =============================================
const PANEL_MIN_WIDTH = 160;
const PANEL_MAX_WIDTH = 900;

function initPanelResizers() {
    const resizers = document.querySelectorAll('.resizer');
    for (const resizer of resizers) {
        resizer.addEventListener('mousedown', (e) => startResize(e, resizer));
        resizer.addEventListener('touchstart', (e) => startResize(e, resizer), { passive: false });
    }
}

function startResize(e, resizer) {
    e.preventDefault();
    const targetClass = resizer.dataset.target;
    const panel = document.querySelector('.' + targetClass);
    if (!panel) return;
    const isRightSide = targetClass === 'chat-area';
    const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const container = resizer.parentElement;
    const containerWidth = container.getBoundingClientRect().width;
    const activity = document.querySelector('.activity');

    resizer.classList.add('active');
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMouseMove = (ev) => {
        ev.preventDefault();
        const x = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX;
        let newWidth = isRightSide ? startWidth + (startX - x) : startWidth + (x - startX);

        const maxW = isRightSide ? containerWidth - 300 : containerWidth - (activity ? 260 : 300);
        newWidth = Math.max(PANEL_MIN_WIDTH, Math.min(newWidth, maxW));
        newWidth = Math.min(newWidth, PANEL_MAX_WIDTH);
        panel.style.width = newWidth + 'px';
    };

    const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('touchmove', onMouseMove);
        document.removeEventListener('touchend', onMouseUp);
        resizer.classList.remove('active');
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onMouseMove, { passive: false });
    document.addEventListener('touchend', onMouseUp);
}

// =============================================
//  UI
// =============================================
function addMessage(role, content, agentId = null) {
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = `message ${role}`;
    if (role === 'agent' && agentId) {
        agentCounter++;
        const id = `msg-${agentCounter}`;
        agentDivIds[agentId] = id;
        div.id = id;
        div.innerHTML = `
            <div class="msg-header">
                <span class="agent-badge">🤖 ${escapeHtml(agentId)}</span>
            </div>
            <div class="msg-content">${formatContent(content)}</div>
        `;
    } else {
        div.innerHTML = `<div class="msg-content">${formatContent(content)}</div>`;
    }
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    scheduleSaveChatHistory();
}

function updateAgentMessage(agentId, content) {
    const id = agentDivIds[agentId];
    if (!id) return;
    const div = document.getElementById(id);
    if (div) {
        const contentDiv = div.querySelector('.msg-content');
        contentDiv.textContent = content;
        const container = document.getElementById('messages');
        container.scrollTop = container.scrollHeight;
        scheduleSaveChatHistory();
    }
}

// =============================================
//  PERSISTÊNCIA DO CHAT (POR PROJETO)
// =============================================
function getChatHistoryKey() {
    if (!currentProjectPath) return CHAT_HISTORY_KEY;
    return `${CHAT_HISTORY_KEY}_${simpleHash(currentProjectPath)}`;
}

function scheduleSaveChatHistory() {
    clearTimeout(chatSaveTimer);
    chatSaveTimer = setTimeout(saveChatHistory, 500);
}

function saveChatHistory() {
    clearTimeout(chatSaveTimer);
    const container = document.getElementById('messages');
    const items = [];
    for (const div of container.children) {
        const role = div.classList.contains('user') ? 'user' : div.classList.contains('agent') ? 'agent' : 'system';
        const contentDiv = div.querySelector('.msg-content') || div.querySelector('.cmd-output');
        const content = contentDiv ? contentDiv.textContent : '';
        if (role === 'agent') {
            const badge = div.querySelector('.agent-badge');
            const agent = badge ? badge.textContent.replace('🤖 ', '') : 'Assistente';
            items.push({ role, agent, content });
        } else {
            items.push({ role, content });
        }
    }
    try {
        localStorage.setItem(getChatHistoryKey(), JSON.stringify(items.slice(-200)));
    } catch (e) {}
}

function restoreChatHistory() {
    let items = [];
    try {
        items = JSON.parse(localStorage.getItem(getChatHistoryKey())) || [];
    } catch (e) {
        return;
    }
    const container = document.getElementById('messages');
    container.innerHTML = '';
    agentDivIds = {};
    agentCounter = 0;
    for (const item of items) {
        const div = document.createElement('div');
        div.className = `message ${item.role}`;
        if (item.role === 'agent') {
            agentCounter++;
            div.id = `msg-${agentCounter}`;
            div.innerHTML = `
                <div class="msg-header">
                    <span class="agent-badge">🤖 ${escapeHtml(item.agent)}</span>
                </div>
                <div class="msg-content">${formatContent(item.content)}</div>
            `;
        } else {
            div.innerHTML = `<div class="msg-content">${formatContent(item.content)}</div>`;
        }
        container.appendChild(div);
    }
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = 'show';
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.className = '';
    }, 5000);
}

// =============================================
//  CONFIGURAÇÃO
// =============================================
function openConfigModal() {
    document.getElementById('configModal').style.display = 'flex';
    document.getElementById('configStatus').style.display = 'none';
    document.getElementById('geminiKeyInput').value = '';
    document.getElementById('deepseekKeyInput').value = '';
    document.getElementById('opencodeKeyInput').value = '';
}

function closeConfigModal() {
    document.getElementById('configModal').style.display = 'none';
}

async function saveConfig() {
    const geminiKey = document.getElementById('geminiKeyInput').value.trim();
    const deepseekKey = document.getElementById('deepseekKeyInput').value.trim();
    const opencodeKey = document.getElementById('opencodeKeyInput').value.trim();

    if (!geminiKey && !deepseekKey && !opencodeKey) {
        showConfigStatus('⚠️ Insira pelo menos uma chave.', 'error');
        return;
    }

    try {
        const res = await apiFetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ geminiKey, deepseekKey, opencodeKey })
        });
        const data = await res.json();
        if (data.success) {
            showConfigStatus('✅ Chaves salvas!', 'success');
            setTimeout(closeConfigModal, 1500);
        } else {
            showConfigStatus('❌ Erro: ' + data.error, 'error');
        }
    } catch (e) {
        showConfigStatus('❌ Erro: ' + e.message, 'error');
    }
}

function showConfigStatus(msg, type) {
    const el = document.getElementById('configStatus');
    el.textContent = msg;
    el.className = type;
    el.style.display = 'block';
}

// =============================================
//  RESTAURAR BACKUP
// =============================================
async function openBackupModal() {
    if (!currentProjectPath) {
        showToast('📁 Selecione uma pasta primeiro!');
        return;
    }
    const modal = document.getElementById('backupModal');
    modal.style.display = 'flex';
    const list = document.getElementById('backupList');
    list.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">⏳ Carregando backups...</div>';

    try {
        const res = await apiFetch('/api/backup/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await res.json();
        const files = data.success ? data.files : [];

        list.innerHTML = '';
        if (files.length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">📂 Nenhum backup encontrado.<br><span style="font-size:11px;color:#484f58;">Backups são criados automaticamente antes de cada alteração.</span></div>';
            return;
        }

        for (const f of files) {
            const row = document.createElement('div');
            row.className = 'approval-file';
            const btn = document.createElement('button');
            btn.className = 'btn-save backup-restore-btn';
            btn.textContent = '↩️ Restaurar';
            btn.addEventListener('click', () => restoreBackup(f.file));
            row.innerHTML = `
                <span class="approval-caminho" style="flex:1;">${escapeHtml(f.path)}</span>
                <span class="backup-time">${new Date(f.modified).toLocaleString()}</span>
            `;
            row.appendChild(btn);
            list.appendChild(row);
        }
    } catch (e) {
        list.innerHTML = `<div style="padding:20px;text-align:center;color:#f85149;">❌ ${escapeHtml(e.message)}</div>`;
    }
}

async function restoreBackup(file) {
    try {
        const res = await apiFetch('/api/backup/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file })
        });
        const data = await res.json();
        if (data.success) {
            const target = data.path || file;
            showToast('✅ Backup restaurado: ' + target);
            setFileStatus(target, 'modified');
            refreshTabIfOpen(target);
            closeBackupModal();
        } else {
            showToast('❌ ' + (data.error || 'Falha ao restaurar'));
        }
    } catch (e) {
        showToast('❌ ' + e.message);
    }
}

function closeBackupModal() {
    document.getElementById('backupModal').style.display = 'none';
}

// =============================================
//  TOGGLE OPEncode
// =============================================
function initOpenCodeToggle() {
    const toggle = document.getElementById('ocToggle');
    let enabled = true;
    try { enabled = localStorage.getItem(OPENCODE_KEY) !== '0'; } catch (e) {}
    toggle.checked = enabled;
    applyOpenCodeToggle(enabled);

    toggle.addEventListener('change', () => {
        const checked = toggle.checked;
        try { localStorage.setItem(OPENCODE_KEY, checked ? '1' : '0'); } catch (e) {}
        applyOpenCodeToggle(checked);
        showToast(checked ? '🟣 opencode ativado' : '🟣 opencode desativado');
    });
}

function applyOpenCodeToggle(enabled) {
    const wrap = document.getElementById('ocToggleWrap');
    const select = document.getElementById('modelSelect');
    wrap.classList.toggle('off', !enabled);

    for (const opt of select.querySelectorAll('option[value^="opencode"]')) {
        opt.style.display = enabled ? '' : 'none';
    }
    for (const g of select.querySelectorAll('optgroup[label^="🟣 opencode"]')) {
        g.style.display = enabled ? '' : 'none';
    }

    if (!enabled && select.value.startsWith('opencode')) {
        select.value = 'gemini';
        currentModel = 'gemini';
        showToast('🔄 Modelo alterado para Gemini 3.5');
    }
}

// =============================================
//  TEMA CLARO/ESCURO
// =============================================
function initTheme() {
    let theme = 'dark';
    try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
    applyTheme(theme);
}

function applyTheme(theme) {
    const isLight = theme === 'light';
    document.body.classList.toggle('theme-light', isLight);
    document.getElementById('themeBtn').textContent = isLight ? '🌙' : '☀️';
}

function toggleTheme() {
    const isLight = document.body.classList.contains('theme-light');
    applyTheme(isLight ? 'dark' : 'light');
    try { localStorage.setItem(THEME_KEY, isLight ? 'dark' : 'light'); } catch (e) {}
    showToast(isLight ? '🌙 Tema escuro' : '☀️ Tema claro');
}

console.log('🏗️ Aedificator Codex com Explorador Nativo carregado!');
console.log('📁 Para selecionar uma pasta, clique em "Selecionar Pasta"');
console.log('🔗 Para desvincular, clique em "Desvincular"');
