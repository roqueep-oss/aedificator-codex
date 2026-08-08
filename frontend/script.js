// =============================================
//  AEDIFICATOR CODEX - COM EXPLORADOR NATIVO
//  VERSÃO COMPLETA COM TODAS AS MELHORIAS
// =============================================

let BACKEND_URL = 'http://localhost:3001';
let WS_URL = 'ws://localhost:3001';
let BACKEND_TOKEN = '';
let currentModel = 'gemini';
let currentMode = 'agent';
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
let runStreamed = false;
let searchTimer = null;
let editorTabs = [];        // { path, content, loaded, dirty, isImage, imageUrl }
let activeTabPath = null;
let activityItems = [];     // { id, kind, icon, label, file, status, start, end, error, startTs }
let activitySeq = 0;
let actTaskId = null;
let repoInfo = null;

let monacoEditor = null;
let monacoReady = false;
let monacoModels = {};

let monacoSplitEditor = null;
let editorTabsRight = [];
let activeTabRight = null;
let splitActive = false;

let debugActive = false;
let debugBreakpoints = [];
let debugDecorations = [];
let debugPausedLine = null;

const LANG_MAP = {
    'js':'javascript','mjs':'javascript','cjs':'javascript',
    'jsx':'javascript','ts':'typescript','tsx':'typescript',
    'html':'html','htm':'html',
    'css':'css','scss':'scss','less':'less',
    'json':'json','md':'markdown',
    'py':'python','rb':'ruby','php':'php',
    'java':'java','cs':'csharp','go':'go','rs':'rust',
    'sql':'sql','xml':'xml','yaml':'yaml','yml':'yaml',
    'sh':'shell','bat':'bat','ps1':'powershell',
    'c':'c','cpp':'cpp','h':'c','hpp':'cpp',
    'svg':'xml','lock':'json','env':'plaintext',
};
function getMonacoLanguage(filePath) {
    const ext = (String(filePath).split('.').pop() || '').toLowerCase();
    return LANG_MAP[ext] || 'plaintext';
}
function getEditorContent() {
    if (monacoEditor && monacoEditor.getModel()) return monacoEditor.getValue();
    return document.getElementById('fileEditorContent').value;
}
function setEditorContent(v) {
    if (monacoEditor && monacoEditor.getModel()) monacoEditor.setValue(v || '');
    else document.getElementById('fileEditorContent').value = v || '';
}
function hideMonaco() {
    const c = document.getElementById('monacoContainer'); if(c) c.style.display='none';
    const t = document.getElementById('fileEditorContent'); if(t) t.style.display='block';
}
function showMonaco() {
    const c = document.getElementById('monacoContainer'); if(c) c.style.display='flex';
    const t = document.getElementById('fileEditorContent'); if(t) t.style.display='none';
}

const CHAT_HISTORY_KEY = 'aedificator_chat_history';
const RECENT_PROJECTS_KEY = 'aedificator_recent_projects';
const THEME_KEY = 'aedificator_theme';
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

function copyMsgContent(btn) {
    const msg = btn.closest('.message');
    if (!msg) return;
    const contentEl = msg.querySelector('.msg-content');
    const text = contentEl ? contentEl.textContent.trim() : '';
    if (!text) return;
    if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
            btn.textContent = '✅';
            setTimeout(() => { btn.textContent = '📋'; }, 1500);
        }).catch(() => {});
    } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = '✅';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
    }
}

function safeOn(id, event, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
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

// =============================================
//  MONACO EDITOR - inicialização
// =============================================
function initMonacoEditor() {
    try {
        if (typeof require !== 'function') return;
        require(['vs/editor/editor.main'], function () {
            monacoReady = true;
            const container = document.getElementById('monacoContainer');
            if (!container) return;
            const isLight = document.body.classList.contains('theme-light');
            let fs = 13, ts = 4, ww = false, mm = true;
            try { fs = parseInt(localStorage.getItem('editor_fontSize'))||13; ts = parseInt(localStorage.getItem('editor_tabSize'))||4; ww = localStorage.getItem('editor_wordWrap')==='1'; mm = localStorage.getItem('editor_minimap')!=='0'; } catch(e){}
            monacoEditor = monaco.editor.create(container, {
                value: '',
                language: 'plaintext',
                theme: isLight ? 'vs' : 'vs-dark',
                automaticLayout: true,
                fontSize: fs,
                fontFamily: "'Consolas', 'Courier New', monospace",
                lineHeight: 1.5,
                tabSize: ts,
                minimap: { enabled: mm, scale: 1, showSlider: 'mouseover' },
                scrollBeyondLastLine: false,
                wordWrap: ww ? 'on' : 'off',
                renderWhitespace: 'selection',
                bracketPairColorization: { enabled: true },
                folding: true,
                glyphMargin: true,
                lineNumbers: 'on',
                renderLineHighlight: 'line',
                cursorBlinking: 'smooth',
                smoothScrolling: true,
                matchBrackets: 'always',
                autoClosingBrackets: 'always',
                autoClosingQuotes: 'always',
                suggest: { showWords: true },
                quickSuggestions: { other: true, comments: false, strings: false },
                multiCursorModifier: 'alt',
                matchOnWordStartOnly: false,
                acceptSuggestionOnEnter: 'on',
                cursorSmoothCaretAnimation: 'on',
                'semanticHighlighting.enabled': true,
                padding: { top: 8 },
                guides: { indentation: true, bracketPairs: true },
                stickyScroll: { enabled: true },
                breadcrumbs: { enabled: true },
            });

            monacoEditor.onDidChangeModelContent(() => {
                const tab = editorTabs.find(t => t.path === activeTabPath);
                if (tab && !tab.isImage) { tab.dirty = true; maybeAutoSave(); }
                runDiagnostics();
            });

            monacoEditor.onDidChangeCursorPosition((e) => {
                const el = document.getElementById('cursorPos');
                if (el) el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
            });

            monacoEditor.onMouseDown((e) => {
                if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && e.target.detail && e.target.detail.line) {
                    toggleDebugBreakpoint(e.target.detail.line);
                }
            });

            monacoEditor.addAction({
                id: 'ai-explain', label: '💡 Explicar código', contextMenuGroupId: 'ai',
                run: (ed) => {
                    const sel = ed.getModel().getValueInRange(ed.getSelection()) || ed.getValue().substring(0, 2000);
                    document.getElementById('chatInput').value = 'Explique este código:\n```\n' + sel + '\n```';
                    document.getElementById('chatInput').focus();
                }
            });
            monacoEditor.addAction({
                id: 'ai-fix', label: '🔧 Corrigir código', contextMenuGroupId: 'ai',
                run: (ed) => {
                    const sel = ed.getModel().getValueInRange(ed.getSelection()) || ed.getValue().substring(0, 2000);
                    document.getElementById('chatInput').value = 'Corrija este código:\n```\n' + sel + '\n```';
                    document.getElementById('chatInput').focus();
                }
            });
            monacoEditor.addAction({
                id: 'ai-refactor', label: '🔄 Refatorar', contextMenuGroupId: 'ai',
                run: (ed) => {
                    const sel = ed.getModel().getValueInRange(ed.getSelection()) || ed.getValue().substring(0, 2000);
                    document.getElementById('chatInput').value = 'Refatore este código:\n```\n' + sel + '\n```';
                    document.getElementById('chatInput').focus();
                }
            });

            // Ctrl+D: multi-cursor select next occurrence
            monacoEditor.addAction({
                id: 'editor.action.addSelectionToNextFindMatch',
                label: 'Add Selection To Next Find Match',
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyD],
                run: function(ed) {
                    var sel = ed.getSelection();
                    if (!sel || sel.isEmpty()) {
                        var word = ed.getModel().getWordAtPosition(sel.getStartPosition());
                        if (word) ed.setSelection(new monaco.Range(sel.startLineNumber, word.startColumn, sel.endLineNumber, word.endColumn));
                        else return;
                    }
                    var text = ed.getModel().getValueInRange(ed.getSelection());
                    if (!text) return;
                    var pos = ed.getPosition();
                    var fullText = ed.getModel().getValue();
                    var offset = ed.getModel().getOffsetAt(pos);
                    var idx = fullText.indexOf(text, offset);
                    if (idx === -1) {
                        offset = 0;
                        idx = fullText.indexOf(text, 0);
                    }
                    if (idx >= 0) {
                        var startPos = ed.getModel().getPositionAt(idx);
                        var endPos = ed.getModel().getPositionAt(idx + text.length);
                        var range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
                        ed.setSelections(ed.getSelections().concat([new monaco.Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn)]));
                        ed.revealPositionInCenter({ lineNumber: endPos.lineNumber, column: endPos.column });
                    }
                }
            });

            monaco.languages.registerCompletionItemProvider(['javascript', 'typescript', 'javascriptreact', 'typescriptreact'], {
                provideCompletionItems: function (model, position) {
                    return provideAedCompletionItems(model, position);
                },
                triggerCharacters: ['.', '"', "'", '`', '@']
            });

            monaco.languages.registerCompletionItemProvider(['python'], {
                provideCompletionItems: function (model, position) {
                    return providePythonCompletions(model, position);
                },
                triggerCharacters: ['.', '"', "'"]
            });

            monaco.languages.registerCompletionItemProvider(['go'], {
                provideCompletionItems: function (model, position) {
                    return provideGoCompletions(model, position);
                },
                triggerCharacters: ['.', '"', "'"]
            });

            monaco.languages.registerHoverProvider(['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'python', 'go'], {
                provideHover: function (model, position) {
                    return provideAedHover(model, position);
                }
            });

            monaco.languages.registerDefinitionProvider(['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'python', 'go'], {
                provideDefinition: function (model, position) {
                    return provideAedDefinition(model, position);
                }
            });

            monaco.languages.registerReferenceProvider(['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'python', 'go'], {
                provideReferences: function (model, position, context) {
                    return provideAedReferences(model, position, context);
                }
            });

            monaco.languages.registerCodeLensProvider(['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'python', 'go'], {
                provideCodeLenses: function (model) {
                    return provideAedReferenceCodeLenses(model);
                },
                resolveCodeLens: function (model, codeLens) {
                    return resolveReferenceCodeLens(model, codeLens);
                }
            });

            monaco.languages.registerRenameProvider(['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'python', 'go'], {
                provideRenameEdits: function (model, position, newName) {
                    return provideAedRenameEdits(model, position, newName);
                },
                resolveRenameLocation: function (model, position) {
                    return provideAedRenameLocation(model, position);
                }
            });

            window._aedGutterDeco = [];
            window._aedGutterTimer = null;
            scheduleAedGutterDecorations();
            setTimeout(loadKeybindingsOnStart, 500);

            if (activeTabPath && document.getElementById('fileEditorModal').style.display === 'flex') {
                renderActiveTab();
            }
        });
    } catch (e) { console.error('Monaco init error:', e); }
}

function switchMonacoModel(filePath) {
    if (!monacoEditor || !monacoReady) { hideMonaco(); return; }
    const tab = editorTabs.find(t => t.path === filePath);
    if (!tab || tab.isImage) { hideMonaco(); return; }

    const lang = getMonacoLanguage(filePath);
    if (!monacoModels[filePath]) {
        const uri = monaco.Uri.parse('file:///' + filePath.replace(/\\/g, '/'));
        const model = monaco.editor.createModel(tab.content || '', lang, uri);
        monacoModels[filePath] = model;
    }
    monacoEditor.setModel(monacoModels[filePath]);
    document.getElementById('editorLang').textContent = lang.charAt(0).toUpperCase() + lang.slice(1);
    showMonaco();
    runDiagnostics();
    refreshOutline();
    renderDebugBreakpoints();
}

function disposeMonacoModel(filePath) {
    if (monacoModels[filePath]) {
        monacoModels[filePath].dispose();
        delete monacoModels[filePath];
    }
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
    console.log('🚀 Aedificator Codex IDE com Explorador Nativo iniciando...');

    initStatusBar();

    try { initDragDrop(); } catch(e) { console.error('initDragDrop:', e); }
    try { initMenuBar(); } catch(e) { console.error('initMenuBar:', e); }
    try { initMonacoEditor(); } catch(e) { console.error('initMonacoEditor:', e); }

    // Context menu no editor (fallback quando Monaco não está ativo)
    const textarea = document.getElementById('fileEditorContent');
    if (textarea) {
        textarea.addEventListener('contextmenu', (e) => {
            if (monacoReady) return;
            e.preventDefault();
            const sel = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
            const menu = document.createElement('div'); menu.id='editorCtxMenu';
            menu.style.cssText=`position:fixed;left:${e.clientX}px;top:${e.clientY}px;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:4px 0;z-index:6000;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.5);`;
            menu.innerHTML='<div style="padding:6px 16px;cursor:pointer;font-size:12px;color:#e6edf3;" id="aiExplain">💡 Explicar código</div><div style="padding:6px 16px;cursor:pointer;font-size:12px;color:#e6edf3;" id="aiFix">🔧 Corrigir código</div><div style="padding:6px 16px;cursor:pointer;font-size:12px;color:#e6edf3;" id="aiRefactor">🔄 Refatorar</div>';
            document.body.appendChild(menu);
            const remove=()=>menu.remove(); const code=sel||textarea.value.substring(0,2000);
            menu.querySelector('#aiExplain').addEventListener('click',()=>{remove();document.getElementById('chatInput').value='Explique este código:\n```\n'+code+'\n```';document.getElementById('chatInput').focus();});
            menu.querySelector('#aiFix').addEventListener('click',()=>{remove();document.getElementById('chatInput').value='Corrija este código:\n```\n'+code+'\n```';document.getElementById('chatInput').focus();});
            menu.querySelector('#aiRefactor').addEventListener('click',()=>{remove();document.getElementById('chatInput').value='Refatore este código:\n```\n'+code+'\n```';document.getElementById('chatInput').focus();});
            setTimeout(()=>document.addEventListener('click',remove,{once:true}),100);
        });
    }

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

    var modelSelect = document.getElementById('modelSelect');
    var providerSelect = document.getElementById('providerSelect');

    providerSelect.addEventListener('change', function(e) {
        updateModelOptions(e.target.value);
        currentModel = modelSelect.value;
        refreshUsage();
    });

    modelSelect.addEventListener('change', function(e) {
        currentModel = e.target.value;
        refreshUsage();
        showToast('Modelo: ' + e.target.options[e.target.selectedIndex].text);
    });

    // Inicializa com Gemini
    updateModelOptions('gemini');
    currentModel = modelSelect.value;

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

    safeOn('configBtn', 'click', openConfigModal);
    safeOn('closeConfigBtn', 'click', closeConfigModal);
    safeOn('saveConfigBtn', 'click', saveConfig);

    safeOn('selectFolderBtn', 'click', selectFolder);
    safeOn('unlinkFolderBtn', 'click', unlinkFolder);

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

    safeOn('themeBtn', 'click', toggleTheme);
    safeOn('backupBtn', 'click', openBackupModal);
    safeOn('snapshotBtn', 'click', openSnapshotModal);
    safeOn('backupCloseBtn', 'click', closeBackupModal);
    safeOn('snapshotCloseBtn', 'click', closeSnapshotModal);

    safeOn('gitBtn', 'click', openGitModal);
    safeOn('gitRefreshBtn', 'click', loadGitStatus);
    document.getElementById('gitCommitBtn').addEventListener('click', gitCommit);
    document.getElementById('gitCloseBtn').addEventListener('click', () => {
        document.getElementById('gitModal').style.display = 'none';
    });
    safeOn('gitMergeBtn', 'click', gitMerge);
    safeOn('gitStashBtn', 'click', () => gitStash('push'));
    safeOn('gitStashPopBtn', 'click', () => gitStash('pop'));

    safeOn('publishHeaderBtn', 'click', openPublishModal);
    safeOn('pubRunBtn', 'click', publishVersion);
    safeOn('pubCloseBtn', 'click', closePublishModal);

    safeOn('terminalBtn', 'click', openTerminal);
    safeOn('buildBtn', 'click', openBuildModal);
    document.getElementById('buildHeaderBtn').addEventListener('click', openBuildModal);
    document.getElementById('browserHeaderBtn').addEventListener('click', toggleLivePreview);
    document.getElementById('testHeaderBtn').addEventListener('click', openTestRunner);
    document.getElementById('buildStartBtn').addEventListener('click', startBuild);
    document.getElementById('buildCancelBtn').addEventListener('click', cancelBuild);
    document.getElementById('terminalRunBtn').addEventListener('click', () => {
        runTerminalCommand(document.getElementById('terminalInput').value.trim());
    });
    document.getElementById('terminalInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') runTerminalCommand(e.target.value.trim());
    });
    document.getElementById('terminalCloseBtn').addEventListener('click', closeTerminal);

    var bcb = document.getElementById('browserCloseBtn');
    if (bcb) bcb.addEventListener('click', function(e) { e.preventDefault(); closeBrowser(); });
    var bgb = document.getElementById('browserGoBtn');
    if (bgb) bgb.addEventListener('click', function(e) { e.preventDefault(); browserNavigate(); });
    var brb = document.getElementById('browserRefreshBtn');
    if (brb) brb.addEventListener('click', function(e) { e.preventDefault(); browserRefresh(); });
    var bmb = document.getElementById('browserMaxBtn');
    if (bmb) bmb.addEventListener('click', function(e) { e.preventDefault(); browserMaximize(); });

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
        if (monacoReady) return;
        const tab = editorTabs.find(t => t.path === activeTabPath);
        if (tab && !tab.isImage) {
            tab.content = e.target.value;
            tab.dirty = true;
        }
    });

    document.addEventListener('keydown', handleShortcuts);

    document.getElementById('approvalExecBtn').addEventListener('click', () => {
        stopAutoExecCountdown();
        executePendingPlan();
    });
    document.getElementById('approvalCancelBtn').addEventListener('click', cancelApproval);

    document.getElementById('fileEditorSaveBtn').addEventListener('click', saveFileEditor);
    document.getElementById('fileEditorBlameBtn').addEventListener('click', showGitBlame);
    document.getElementById('fileEditorPreviewBtn').addEventListener('click', toggleMarkdownPreview);
    document.getElementById('fileEditorCloseBtn').addEventListener('click', closeFileEditor);
    document.getElementById('fileEditorAnalyzeBtn').addEventListener('click', analyzeCurrentFile);
    document.getElementById('fileEditorOutlineBtn').addEventListener('click', toggleOutline);
    document.getElementById('fileEditorSplitBtn').addEventListener('click', toggleSplitEditor);
    document.getElementById('diffCloseBtn').addEventListener('click', closeDiffModal);
    document.getElementById('testRunBtn').addEventListener('click', runTests);
    safeOn('testDiscoverBtn', 'click', discoverTests);
    document.getElementById('testCloseBtn').addEventListener('click', closeTestRunner);
    document.getElementById('testConfigBtn').addEventListener('click', saveTestCmd);

    initTheme();
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
            const statusEl = document.getElementById('backendStatus');
            if (statusEl) { statusEl.textContent = '🟢 Conectado'; statusEl.className = 'status-online'; }
            console.log('✅ Backend conectado!');
            connectWebSocket();
            await checkConfigStatus();
            await loadOpenCodeModels();
            tryLoadLastFolder();
        } else {
            throw new Error('Health check falhou');
        }
    } catch (e) {
        const statusEl = document.getElementById('backendStatus');
        if (statusEl) { statusEl.textContent = '🔴 Desconectado'; statusEl.className = 'status-offline'; }
        console.log('❌ Backend offline:', e.message);
        showToast('❌ Backend offline');
        setTimeout(initBackend, 5000);
    }
}

async function checkConfigStatus() {
    try {
        const res = await apiFetch('/api/config/status');
        const data = await res.json();
        const select = document.getElementById('providerSelect');
        const options = select.querySelectorAll('option');
        options.forEach(function(opt) {
            var v = opt.value;
            if (v === 'opencode') { opt.style.display = ''; return; }
            if (v === 'gemini' && !data.gemini.configured) { opt.style.display = 'none'; return; }
            if (v === 'deepseek' && !data.deepseek.configured) { opt.style.display = 'none'; return; }
            if (v === 'openai' && !data.openai.configured) { opt.style.display = 'none'; return; }
            if (v === 'claude' && !data.claude.configured) { opt.style.display = 'none'; return; }
            opt.style.display = '';
        });
        if (!data.gemini.configured && !data.deepseek.configured && !data.opencode.configured) {
            showToast('⚠️ Configure sua chave API em "Chave"');
        }
        refreshUsage();
    } catch (e) {}
}

async function refreshUsage() {
    try {
        var p = document.getElementById('providerSelect').value;
        if (p === 'opencode') { document.getElementById('usageDisplay').textContent = ''; return; }
        var m = document.getElementById('modelSelect').value;
        var res = await fetch('/api/usage?provider=' + p + '&model=' + encodeURIComponent(m));
        var data = await res.json();
        if (data.provider) {
            document.getElementById('usageDisplay').textContent = 'R$ ' + data.cost.brl.toFixed(2).replace('.', ',');
            document.getElementById('usageDisplay').title = (data.tokens.input + data.tokens.output + (data.tokens.cache || 0)).toLocaleString() + ' tokens | ' + data.tokens.input.toLocaleString() + ' in / ' + data.tokens.output.toLocaleString() + ' out | modelo: ' + (data.model || p);
        }
    } catch (e) {}
}

async function openPricingModal() {
    var panel = document.getElementById('pricingPanel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    if (panel.style.display === 'none') return;
    try {
        var res = await fetch('/api/pricing');
        var d = await res.json();
        var prov = document.getElementById('providerSelect').value;
        var model = document.getElementById('modelSelect').value;
        document.getElementById('pInlineUsd').textContent = d.usdBrl.toFixed(2).replace('.', ',');
        var pp = (d.prices[prov] && d.prices[prov].models && d.prices[prov].models[model]) || (d.prices[prov] && d.prices[prov]['__default']) || {};
        document.getElementById('pDeepInput').value = (d.prices.deepseek && d.prices.deepseek.models && d.prices.deepseek.models[model] ? d.prices.deepseek.models[model].input : (d.prices.deepseek && d.prices.deepseek['__default'] ? d.prices.deepseek['__default'].input : 0));
        document.getElementById('pDeepOutput').value = (d.prices.deepseek && d.prices.deepseek.models && d.prices.deepseek.models[model] ? d.prices.deepseek.models[model].output : (d.prices.deepseek && d.prices.deepseek['__default'] ? d.prices.deepseek['__default'].output : 0));
        document.getElementById('pDeepCache').value = (d.prices.deepseek && d.prices.deepseek.models && d.prices.deepseek.models[model] ? (d.prices.deepseek.models[model].cache || 0) : (d.prices.deepseek && d.prices.deepseek['__default'] ? (d.prices.deepseek['__default'].cache || 0) : 0));
        document.getElementById('pGemInput').value = (d.prices.gemini && d.prices.gemini.models && d.prices.gemini.models[model] ? d.prices.gemini.models[model].input : (d.prices.gemini && d.prices.gemini['__default'] ? d.prices.gemini['__default'].input : 0));
        document.getElementById('pGemOutput').value = (d.prices.gemini && d.prices.gemini.models && d.prices.gemini.models[model] ? d.prices.gemini.models[model].output : (d.prices.gemini && d.prices.gemini['__default'] ? d.prices.gemini['__default'].output : 0));
        document.getElementById('pOaiInput').value = (d.prices.openai && d.prices.openai.models && d.prices.openai.models[model] ? d.prices.openai.models[model].input : (d.prices.openai && d.prices.openai['__default'] ? d.prices.openai['__default'].input : 0));
        document.getElementById('pOaiOutput').value = (d.prices.openai && d.prices.openai.models && d.prices.openai.models[model] ? d.prices.openai.models[model].output : (d.prices.openai && d.prices.openai['__default'] ? d.prices.openai['__default'].output : 0));
        document.getElementById('pClInput').value = (d.prices.claude && d.prices.claude.models && d.prices.claude.models[model] ? d.prices.claude.models[model].input : (d.prices.claude && d.prices.claude['__default'] ? d.prices.claude['__default'].input : 0));
        document.getElementById('pClOutput').value = (d.prices.claude && d.prices.claude.models && d.prices.claude.models[model] ? d.prices.claude.models[model].output : (d.prices.claude && d.prices.claude['__default'] ? d.prices.claude['__default'].output : 0));
    } catch (e) {}
}

async function savePricing() {
    try {
        var prov = document.getElementById('providerSelect').value;
        var model = document.getElementById('modelSelect').value;
        var body = {
            prices: {
                deepseek: { models: {}, '__default': { input: parseFloat(document.getElementById('pDeepInput').value) || 0, output: parseFloat(document.getElementById('pDeepOutput').value) || 0, cache: parseFloat(document.getElementById('pDeepCache').value) || 0 } },
                gemini: { models: {}, '__default': { input: parseFloat(document.getElementById('pGemInput').value) || 0, output: parseFloat(document.getElementById('pGemOutput').value) || 0 } },
                openai: { models: {}, '__default': { input: parseFloat(document.getElementById('pOaiInput').value) || 0, output: parseFloat(document.getElementById('pOaiOutput').value) || 0 } },
                claude: { models: {}, '__default': { input: parseFloat(document.getElementById('pClInput').value) || 0, output: parseFloat(document.getElementById('pClOutput').value) || 0 } }
            }
        };
        body.prices[prov].models[model] = {
            input: prov === 'deepseek' ? (parseFloat(document.getElementById('pDeepInput').value) || 0) : prov === 'gemini' ? (parseFloat(document.getElementById('pGemInput').value) || 0) : prov === 'openai' ? (parseFloat(document.getElementById('pOaiInput').value) || 0) : (parseFloat(document.getElementById('pClInput').value) || 0),
            output: prov === 'deepseek' ? (parseFloat(document.getElementById('pDeepOutput').value) || 0) : prov === 'gemini' ? (parseFloat(document.getElementById('pGemOutput').value) || 0) : prov === 'openai' ? (parseFloat(document.getElementById('pOaiOutput').value) || 0) : (parseFloat(document.getElementById('pClOutput').value) || 0)
        };
        if (prov === 'deepseek') body.prices[prov].models[model].cache = parseFloat(document.getElementById('pDeepCache').value) || 0;
        var res = await fetch('/api/pricing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        var d = await res.json();
        if (d.success) {
            document.getElementById('pricingPanel').style.display = 'none';
            refreshUsage();
        }
    } catch (e) {}
}

document.getElementById('savePricingInlineBtn').addEventListener('click', savePricing);

async function loadOpenCodeModels() {
    try {
        // Carrega todos os modelos de uma vez
        const res = await apiFetch('/api/models/opencode-all');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.success || !Array.isArray(data.models) || !data.models.length) return;

        // Separa free vs Go
        const freeModels = data.models.filter(m => m.free);
        const goModels = data.models.filter(m => !m.free);
        populateOpenCodeModels(freeModels, goModels);
    } catch (e) {
        console.error('❌ Erro ao carregar modelos opencode:', e);
    }
}

function populateOpenCodeModels(freeModels, goModels) {
    // Armazena modelos globalmente para o provider select
    window._ocModels = { free: freeModels || [], go: goModels || [] };
    var allModels = [];
    for (var i = 0; i < freeModels.length; i++) allModels.push(freeModels[i]);
    for (var j = 0; j < goModels.length; j++) allModels.push(goModels[j]);
    PROVIDER_MODELS.opencode = allModels.map(function(m) {
        return { value: m.id, label: (m.provider ? m.provider + ' · ' : '') + (m.name || m.id) };
    });
    // Rebuild se opencode estiver selecionado
    if (document.getElementById('providerSelect').value === 'opencode') {
        updateModelOptions('opencode');
    }
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
        updatePipeline('plan', 'done', (data.total || 0) + ' arquivo(s)');
        if (data.total > 0) taskActivityProgress(`📋 Plano com ${data.total} alteração(ões)`)
        return;
    }

    if (data.type === 'file-status') {
        updatePipeline('execute', 'active', '')
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

    if (data.type === 'activity-event') {
        if (data.ev === 'tool_start') {
            terminalAdd('tool', data.label || data.tool, { icon: data.icon, id: data.id });
        } else if (data.ev === 'tool_end') {
            terminalFinishTool(data.id, data.isError ? 'error' : 'success');
        }
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
        if (agent === 'Sistema') {
            taskActivityProgress(data.content.replace(/\n|✅|❌|📄|🗑️|✏️|🆕/g, ''));
            if (!/^🔧|📖|✏️|⚡|📋|🔍|🌐|🤖|📦|🧪/.test(data.content.trim())) {
                terminalAdd('thought', data.content.trim());
            }
        } else if (agent === 'Assistente') {
            var last = terminalLines.length > 0 ? terminalLines[terminalLines.length - 1] : null;
            if (last && last.type === 'output') {
                last.text += data.content;
                last.time = Date.now();
                renderTerminal();
            } else {
                terminalAdd('output', data.content);
            }
        }
        return;
    }

    if (data.type === 'approval') {
        updatePipeline('plan', 'done', (data.total || 0) + ' item(ns)');
        if (showApprovalModal(data)) {
            finishAnalysisActivity(true);
            taskActivityProgress('⏳ Aguardando aprovação do plano (execução)');
        } else {
            endTask('📋 Nada a executar');
        }
        return;
    }

    if (data.type === 'refresh') {
        if (currentProjectPath) loadFolderStructure(currentProjectPath);
        return;
    }

    if (data.type === 'build-output') {
        const el = document.getElementById('buildOutput');
        if (el) {
            el.textContent += data.line || '';
            el.scrollTop = el.scrollHeight;
        }
        return;
    }

    if (data.type === 'build-status') {
        const startBtn = document.getElementById('buildStartBtn');
        const cancelBtn = document.getElementById('buildCancelBtn');
        if (startBtn) startBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = true;
        if (data.status === 'done') {
            showToast('✅ Build concluído!');
        } else if (data.status === 'cancelled') {
            showToast('⏹️ Build cancelado.');
        } else if (data.status === 'error') {
            showToast('❌ Build falhou.');
        }
        return;
    }

        if (data.type === 'run-output') {
            const el = document.getElementById('terminalOutput');
            if (el && isRunning) {
                runStreamed = true;
                const line = data.line || '';
                el.textContent += line;
                updateTerminalOutput(line);
                el.scrollTop = el.scrollHeight;
            }
            return;
        }

    if (data.type === 'debug-started') {
        debugActive = true;
        updateDebugUI();
        showDebugPanel();
        showToast('🔍 Debug iniciado: ' + (data.file || ''));
        return;
    }

    if (data.type === 'debug-ended') {
        debugActive = false;
        debugPausedLine = null;
        clearDebugDecorations();
        updateDebugUI();
        showToast('⏹️ Debug encerrado');
        return;
    }

    if (data.type === 'debug-paused') {
        debugPausedLine = data.line;
        const filename = data.filename || '';
        if (filename && activeTabPath && activeTabPath.replace(/\\/g,'/') !== filename.replace(/\\/g,'/') && !filename.startsWith('file://')) {
            openFile(filename);
        }
        setTimeout(() => highlightDebugLine(data.line), 100);
        updateDebugPanels(data);
        updateDebugUI();
        return;
    }

    if (data.type === 'debug-output') {
        const el = document.getElementById('debugConsole');
        if (el) { el.textContent += data.text || ''; el.scrollTop = el.scrollHeight; }
        return;
    }

    if (data.type === 'diagnostics') {
        var errors = data.errors || [];
        updateBottomProblems(errors);
        if (errors.length) {
            var errCount = errors.filter(function(e) { return e.severity === 'error'; }).length;
            var warnCount = errors.filter(function(e) { return e.severity === 'warning'; }).length;
            var msg = [];
            if (errCount) msg.push(errCount + ' erro(s)');
            if (warnCount) msg.push(warnCount + ' aviso(s)');
            if (msg.length) showToast('\u26A0\uFE0F Diagnostics: ' + msg.join(', '));
        }
        return;
    }

    if (data.type === 'rollback') {
        showToast('\u267B\uFE0F ' + (data.message || 'Alteracoes revertidas devido a erros'));
        if (currentProjectPath) loadFolderStructure(currentProjectPath);
        return;
    }

    if (data.type === 'test-status') {
        updatePipeline('test', 'done', (data.results ? (data.results.pass || 0) + ' passaram' : ''));
        showToast('\uD83E\uDDEA ' + (data.message || 'Testes executados'));
        var outEl = document.getElementById('bottomOutputContent');
        if (outEl && data.results) {
            var out = '=== Resultado dos Testes ===\n';
            out += 'Total: ' + (data.results.total || 0) + ' | Passaram: ' + (data.results.pass || 0) + ' | Falharam: ' + (data.results.fail || 0) + '\n';
            if (data.results.details) {
                for (var i = 0; i < data.results.details.length; i++) {
                    var d = data.results.details[i];
                    out += (d.status === 'pass' ? '  \u2713 ' : '  \u2717 ') + d.name + '\n';
                }
            }
            outEl.textContent = out;
        }
        return;
    }

    if (data.type === 'test-failed') {
        var outEl = document.getElementById('bottomOutputContent');
        if (outEl) outEl.textContent = data.message || 'Testes falharam';
        toggleBottomPanel('output');
        return;
    }

    if (data.type === 'auto-commit') {
        updatePipeline('commit', 'done');
        showToast('\uD83D\uDCC4 ' + (data.message || 'Commit automatico realizado'));
        sidebarGitRefresh();
        return;
    }

    if (data.type === 'file-changed') {
        if (data.file && activeTabPath) {
            var changedFile = data.file.replace(/\\/g, '/');
            var currentFile = (activeTabPath || '').replace(/\\/g, '/');
            if (changedFile === currentFile.replace(currentProjectPath.replace(/\\/g, '/') + '/', '')) {
                showToast('\uD83D\uDCC4 Arquivo modificado externamente. Recarregue para ver mudancas.');
            }
        }
        return;
    }

    if (data.type === 'remote-output') {
        var out = document.getElementById('bottomTerminalOutput');
        if (out) { out.textContent += data.text || ''; out.scrollTop = out.scrollHeight; }
        return;
    }

    if (data.type === 'deploy-done') {
        showToast('\uD83D\uDE80 ' + (data.message || 'Deploy concluido'));
        return;
    }

    if (data.type === 'done') {
        showReportCard(data);
        endTask('✅ Tarefa concluída!');
        updateUndoRedoButtons();
        attachedFiles = [];
        renderAttachments();
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
    console.log('selectFolder chamado');
    openFolderPicker();
}

async function applySelectedFolder(folderPath) {
    console.log('applySelectedFolder:', folderPath);
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
    if (!modal) return;
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
            driveSelect.value = pickerCurrentPath;
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
        const pubBtn = document.getElementById('publishVersionBtn'); if (pubBtn) { pubBtn.disabled = true; pubBtn.title = 'Seleciona uma pasta que é repositório Git (GitHub/GitLab)'; }
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
    if (!btn) return;
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
            window._lastFolderStructure = data.files;
            try { refreshAcFiles(); } catch (e) {}
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

    if (gitOnlyFilter && window._gitChangedFiles) {
        files = files.filter(f => {
            if (!f.isDirectory) {
                const p = (f.path || `${basePath}/${f.name}`).replace(/\\/g, '/').replace(/^\/+/, '');
                return window._gitChangedFiles.has(p);
            }
            return true;
        });
    }

    renderSubFolder(container, files.slice(), '');
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

async function renderSubFolder(container, files, basePath) {
    if (gitOnlyFilter && window._gitChangedFiles) {
        files = files.filter(f => {
            if (!f.isDirectory) {
                const p = (f.path || `${basePath}/${f.name}`).replace(/\\/g, '/').replace(/^\/+/, '');
                return window._gitChangedFiles.has(p);
            }
            return true;
        });
    }
    const sorted = files.slice().sort((a, b) => {
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
                <span class="chevron">▶</span>
                <span class="icon">📂</span>
                <span class="name">${escapeHtml(item.name)}</span>
            `;
            const childrenDiv = document.createElement('div');
            childrenDiv.className = 'children';
            div.appendChild(childrenDiv);

            div.addEventListener('click', async (e) => {
                e.stopPropagation();
                const isOpen = childrenDiv.classList.toggle('open');
                div.querySelector('.chevron').classList.toggle('open', isOpen);
                if (isOpen && childrenDiv.children.length === 0) {
                    const subFiles = await loadSubFolder(fullPath);
                    if (subFiles) {
                        renderSubFolder(childrenDiv, subFiles, fullPath);
    }
}

// =============================================
//  NOVO PROJETO
// =============================================
function newProject() {

    var nome = prompt('Digite o nome do novo projeto:', 'meu-app');
    if (!nome) return;
    nome = nome.trim();
    if (!nome) return;

    var pasta = prompt('Pasta onde criar o projeto (ex: C:\\Projetos):', currentProjectPath || '');
    if (!pasta) return;
    pasta = pasta.trim();
    if (!pasta) return;

    pasta = pasta.replace(/\\/g, '/').replace(/\/+$/, '');
    var caminhoCompleto = pasta + '/' + nome;

    showToast('⏳ Criando projeto...');

    var xhr = new XMLHttpRequest();
    xhr.open('POST', BACKEND_URL + '/api/project/create', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (BACKEND_TOKEN) xhr.setRequestHeader('Authorization', 'Bearer ' + BACKEND_TOKEN);

    xhr.onload = function() {
        if (xhr.status >= 200 && xhr.status < 300) {
            try {
                var data = JSON.parse(xhr.responseText);
                if (data.success) {
                    showToast('✅ Projeto criado: ' + nome);
                    applySelectedFolder(data.path);
                } else {
                    showToast('❌ ' + (data.error || 'Erro ao criar'));
                }
            } catch(e) {
                showToast('❌ Erro ao processar resposta');
            }
        } else {
            showToast('❌ Erro HTTP ' + xhr.status);
        }
    };

    xhr.onerror = function() {
        showToast('❌ Erro de conexão com o backend');
    };

    xhr.send(JSON.stringify({ path: caminhoCompleto }));
}

async function createNewProject() { newProject(); }
function browseNewProjectParent() { newProject(); }
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
            div.addEventListener('click', (e) => {
                e.stopPropagation();
                openFile(fullPath);
            });
            div.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                showFileContextMenu(e, fullPath, item.name);
            });
        }
        container.appendChild(div);
    }
}

function showFileContextMenu(e, filePath, fileName) {
    const old = document.getElementById('fileCtxMenu');
    if (old) old.remove();

    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const isJS = ['js','mjs','cjs','ts','tsx','jsx'].includes(ext);
    const isMarkdown = ext === 'md';
    const isImage = IMAGE_EXTS.includes(ext);
    const isHTML = ['html','htm'].includes(ext);

    const items = [
        { label: '📂 Abrir', action: () => openFile(filePath) },
        { label: '↔️ Abrir à direita', action: () => { openSplitEditor(); setTimeout(() => { if(editorTabsRight.find(t=>t.path===filePath)){activateTabRight(filePath);}else{editorTabsRight.push({path:filePath,content:'',loaded:false,dirty:false});activateTabRight(filePath);} }, 300); } },
        { label: '✏️ Renomear', action: () => renameFilePrompt(filePath, fileName) },
        { label: '🗑️ Deletar', action: () => deleteFilePrompt(filePath, fileName), danger: true },
        { separator: true },
        { label: '📋 Copiar caminho', action: () => { navigator.clipboard.writeText(filePath).then(() => showToast('📋 Caminho copiado')); } },
    ];

    if (isJS) {
        items.push({ label: '🔍 Debug (Depurar)', action: () => { openFile(filePath); setTimeout(debugStart, 500); } });
    }
    if (isHTML) {
        items.push({ label: '🌐 Abrir no navegador', action: () => openInBrowser(filePath) });
    }
    if (isMarkdown) {
        items.push({ label: '👁️ Preview Markdown', action: () => { openFile(filePath); setTimeout(toggleMarkdownPreview, 300); } });
    }
    if (isImage) {
        items.push({ label: '🖼️ Ver imagem', action: () => openFile(filePath) });
    }

    const menu = document.createElement('div');
    menu.id = 'fileCtxMenu';
    menu.style.cssText = `position:fixed;left:${Math.min(e.clientX, window.innerWidth - 220)}px;top:${e.clientY}px;background:#161b22;border:1px solid #30363d;border-radius:6px;padding:4px 0;z-index:7000;min-width:200px;box-shadow:0 8px 24px rgba(0,0,0,0.5);`;

    let html = '';
    for (const item of items) {
        if (item.separator) {
            html += '<div style="border-top:1px solid #30363d;margin:4px 0;"></div>';
        } else {
            const color = item.danger ? '#f85149' : '#e6edf3';
            html += `<div class="file-ctx-item" style="padding:6px 16px;cursor:pointer;font-size:12px;color:${color};" data-action="${item.label}">${item.label}</div>`;
        }
    }
    menu.innerHTML = html;
    document.body.appendChild(menu);

    menu.querySelectorAll('.file-ctx-item').forEach(el => {
        el.addEventListener('mouseenter', () => { el.style.background = '#1f6feb'; });
        el.addEventListener('mouseleave', () => { el.style.background = 'none'; });
        el.addEventListener('click', () => {
            const idx = Array.from(menu.querySelectorAll('.file-ctx-item')).indexOf(el);
            let realIdx = 0;
            for (let i = 0; i < items.length; i++) {
                if (items[i].separator) continue;
                if (realIdx === idx) { items[i].action(); break; }
                realIdx++;
            }
            menu.remove();
        });
    });

    setTimeout(() => {
        const handler = (ev) => {
            if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', handler); }
        };
        document.addEventListener('click', handler);
    }, 100);
}

async function renameFilePrompt(filePath, name) {
    const newName = prompt('Renomear ' + name + ' para:', name);
    if (!newName || newName === name) return;
    try {
        const base = filePath.substring(0, filePath.lastIndexOf('/') + 1);
        const newPath = base + newName;
        const res = await apiFetch('/api/file/rename', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, newPath })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ Renomeado para ' + newName);
            if (currentProjectPath) loadFolderStructure(currentProjectPath);
        } else {
            showToast('❌ ' + (data.error || 'Falha ao renomear'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
}

async function deleteFilePrompt(filePath, name) {
    if (!confirm('Tem certeza que deseja deletar "' + name + '"?\n\nEsta ação não pode ser desfeita.')) return;
    try {
        const res = await apiFetch('/api/file/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath })
        });
        const data = await res.json();
        if (data.success) {
            showToast('🗑️ Deletado: ' + name);
            if (currentProjectPath) loadFolderStructure(currentProjectPath);
            setFileStatus(filePath, 'deleted');
            const tab = editorTabs.find(t => t.path === filePath);
            if (tab) closeTab(filePath);
        } else {
            showToast('❌ ' + (data.error || 'Falha ao deletar'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
}

// =============================================
//  SALVAR ABA ATIVA (EDITOR)
// =============================================
async function saveFileEditor() {
    const tab = editorTabs.find(t => t.path === activeTabPath);
    if (!tab || tab.isImage) return;
    let content = getEditorContent();
    const statusEl = document.getElementById('fileEditorStatus');

    try {
        const fmtEnabled = localStorage.getItem('formatOnSave') === '1';
        if (fmtEnabled && monacoReady && monacoEditor) {
            try { await monacoEditor.getAction('editor.action.formatDocument').run(); } catch (e) {}
            content = getEditorContent();
        }
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

let autoSaveTimer = null;
function maybeAutoSave() {
    if (localStorage.getItem('autoSave') !== '1') return;
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => {
        const tab = editorTabs.find(t => t.path === activeTabPath);
        if (tab && tab.dirty && currentProjectPath) {
            saveFileEditor();
        }
    }, 1500);
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
    if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        quickOpenFile();
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
    if (e.key === 'F5') {
        e.preventDefault();
        debugStart();
        return;
    }
    if (e.key === 'Escape') {
        if (monacoReady && document.activeElement && document.getElementById('monacoContainer').contains(document.activeElement)) {
            return;
        }
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
        if (document.getElementById('snapshotModal').style.display === 'flex') {
            closeSnapshotModal();
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
//  QUICK OPEN (Ctrl+P)
// =============================================
function quickOpenFile() {
    if (!currentProjectPath) { showToast('📁 Selecione um projeto'); return; }
    let overlay = document.getElementById('quickOpenOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'quickOpenOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:7000;display:flex;align-items:flex-start;justify-content:center;padding-top:15vh;';
        overlay.innerHTML = `<div style="background:#161b22;border:1px solid #30363d;border-radius:8px;width:500px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,0.6);overflow:hidden;">
            <input id="quickOpenInput" type="text" placeholder="🔍 Nome do arquivo..." style="width:100%;padding:12px 16px;background:transparent;color:#e6edf3;border:none;font-size:15px;outline:none;font-family:Consolas,monospace;">
            <div id="quickOpenResults" style="max-height:300px;overflow-y:auto;border-top:1px solid #30363d;"></div>
        </div>`;
        document.body.appendChild(overlay);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) closeQuickOpen(); });
    } else {
        overlay.style.display = 'flex';
    }
    const input = overlay.querySelector('#quickOpenInput');
    const results = overlay.querySelector('#quickOpenResults');
    results.innerHTML = '<div style="padding:12px 16px;color:#8b949e;font-size:12px;">Digite para filtrar...</div>';
    input.value = '';
    input.focus();

    let quickOpenTimer = null;
    input.oninput = () => {
        clearTimeout(quickOpenTimer);
        quickOpenTimer = setTimeout(() => fetchQuickOpenResults(input.value.trim(), results), 150);
    };
    input.onkeydown = (e) => {
        if (e.key === 'Escape') { closeQuickOpen(); return; }
        if (e.key === 'Enter') {
            const sel = results.querySelector('.quick-open-item.selected');
            if (sel) { closeQuickOpen(); openFile(sel.dataset.path); }
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const items = results.querySelectorAll('.quick-open-item');
            const sel = results.querySelector('.quick-open-item.selected');
            const idx = sel ? Array.from(items).indexOf(sel) : -1;
            const next = items[idx + 1];
            if (next) {
                if (sel) sel.classList.remove('selected');
                next.classList.add('selected');
                next.scrollIntoView({ block: 'nearest' });
            }
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            const items = results.querySelectorAll('.quick-open-item');
            const sel = results.querySelector('.quick-open-item.selected');
            const idx = sel ? Array.from(items).indexOf(sel) : 1;
            const prev = items[idx - 1];
            if (prev) {
                if (sel) sel.classList.remove('selected');
                prev.classList.add('selected');
                prev.scrollIntoView({ block: 'nearest' });
            }
        }
    };
    input.oninput();
}

function closeQuickOpen() {
    const overlay = document.getElementById('quickOpenOverlay');
    if (overlay) overlay.style.display = 'none';
}

async function fetchQuickOpenResults(query, resultsEl) {
    if (!currentProjectPath) return;
    try {
        const res = await apiFetch('/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query || '*', inContent: false })
        });
        const data = await res.json();
        if (!data.success || !data.results || !data.results.length) {
            resultsEl.innerHTML = '<div style="padding:12px 16px;color:#8b949e;font-size:12px;">Nenhum arquivo encontrado</div>';
            return;
        }
        resultsEl.innerHTML = '';
        for (const r of data.results.slice(0, 30)) {
            const item = document.createElement('div');
            item.className = 'quick-open-item';
            item.dataset.path = r.path;
            const name = r.path.split('/').pop();
            const dir = r.path.substring(0, r.path.lastIndexOf('/'));
            item.innerHTML = `<span style="color:#e6edf3;">${escapeHtml(name)}</span><span style="color:#8b949e;font-size:11px;margin-left:8px;">${escapeHtml(dir)}</span>`;
            item.style.cssText = 'padding:8px 16px;cursor:pointer;display:flex;align-items:center;font-size:13px;';
            item.addEventListener('mouseenter', () => {
                resultsEl.querySelectorAll('.quick-open-item').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
            });
            item.addEventListener('click', () => { closeQuickOpen(); openFile(r.path); });
            resultsEl.appendChild(item);
        }
    } catch (e) {
        resultsEl.innerHTML = `<div style="padding:12px 16px;color:#f85149;font-size:12px;">❌ ${escapeHtml(e.message)}</div>`;
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
    startShellSession();
}

async function startShellSession() {
    try {
        await apiFetch('/api/shell/start', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    } catch (e) {}
}

function closeTerminal() {
    document.getElementById('terminalModal').style.display = 'none';
    try { apiFetch('/api/shell/stop', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); } catch (e) {}
}

// =============================================
//  EMPACOTAR / BUILD DA APLICAÇÃO
// =============================================

function openBuildModal() {
    const dd = document.getElementById('buildDropdown');
    if (!dd) return;
    if (dd.style.display !== 'none') {
        dd.style.display = 'none';
        return;
    }
    const btn = document.getElementById('buildBtn');
    if (btn) {
        const rect = btn.getBoundingClientRect();
        dd.style.left = Math.max(8, rect.right - 300) + 'px';
        dd.style.top = (rect.bottom + 6) + 'px';
        dd.style.transform = '';
    } else {
        dd.style.left = '50%';
        dd.style.top = '80px';
        dd.style.transform = 'translateX(-50%)';
    }
    dd.style.display = 'block';
    const out = document.getElementById('buildOutput');
    if (out) out.textContent = 'Clique em "Iniciar Build".';
}

document.addEventListener('click', (e) => {
    const dd = document.getElementById('buildDropdown');
    if (!dd) return;
    if (dd.style.display === 'none') return;
    if (dd.contains(e.target)) return;
    if (e.target.id === 'buildBtn' || e.target.id === 'buildHeaderBtn') return;
    dd.style.display = 'none';
});

async function startBuild() {
    const platform = document.getElementById('buildPlatformSelect').value;
    const arch = document.getElementById('buildArchSelect').value;
    const format = document.getElementById('buildFormatSelect').value;
    document.getElementById('buildOutput').textContent = '';
    document.getElementById('buildStartBtn').disabled = true;
    document.getElementById('buildCancelBtn').disabled = false;
    try {
        const res = await apiFetch('/api/build', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ platform, arch, format })
        });
        const data = await res.json();
        if (!data.success) {
            const el = document.getElementById('buildOutput');
            el.textContent += `❌ ${data.error || 'Falha ao iniciar build'}\n`;
            document.getElementById('buildStartBtn').disabled = false;
            document.getElementById('buildCancelBtn').disabled = true;
        }
    } catch (e) {
        const el = document.getElementById('buildOutput');
        el.textContent += `❌ ${e.message}\n`;
        document.getElementById('buildStartBtn').disabled = false;
        document.getElementById('buildCancelBtn').disabled = true;
    }
}

async function cancelBuild() {
    try {
        const res = await apiFetch('/api/build/cancel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await res.json();
        if (data.cancelled) {
            const el = document.getElementById('buildOutput');
            el.textContent += '\n⏹️ Build cancelado.\n';
        }
    } catch (e) {
        const el = document.getElementById('buildOutput');
        el.textContent += `❌ ${e.message}\n`;
    }
    document.getElementById('buildStartBtn').disabled = false;
    document.getElementById('buildCancelBtn').disabled = true;
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
    runStreamed = false;
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
                if (runStreamed) {
                    out.textContent += `\n[exit code: ${data.code}]\n\n`;
                } else {
                    const txt = (data.output || '').trim() || '(sem saída)';
                    out.textContent += `${txt}\n\n[exit code: ${data.code}]\n\n`;
                }
            } else {
                out.textContent += `❌ ${data.error || 'Erro ao executar'}\n\n`;
            }
        } catch (e) {
            out.textContent += `❌ ${e.name === 'AbortError' ? 'Comando cancelado' : e.message}\n\n`;
        } finally {
            runController = null;
            isRunning = false;
            runStreamed = false;
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
//  LIMPAR / EXPORTAR / SHARE / UNDO / REDO CHAT
// =============================================
function clearChat() {
    if (!confirm('Limpar toda a conversa?')) return;
    document.getElementById('messages').innerHTML = '';
    saveChatHistory();
    showToast('🗑️ Conversa limpa');
}

function exportChat() {
    const container = document.getElementById('messages');
    let text = `Aedificator Codex IDE - Conversa\n${new Date().toLocaleString()}\n\n`;
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

async function shareChat() {
    const container = document.getElementById('messages');
    const messages = [];
    for (const div of container.children) {
        const role = div.classList.contains('user') ? 'user' : div.classList.contains('agent') ? 'agent' : 'system';
        const contentEl = div.querySelector('.msg-content') || div.querySelector('.cmd-output');
        const content = contentEl ? contentEl.textContent.trim() : '';
        if (content) messages.push({ role, content: content.slice(0, 2000) });
    }
    if (!messages.length) { showToast('⚠️ Nada para compartilhar'); return; }
    try {
        const resp = await fetch(BACKEND_URL + '/api/share', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, token: BACKEND_TOKEN })
        });
        const data = await resp.json();
        if (data.url) {
            await navigator.clipboard.writeText(data.url);
            showToast('🔗 Link copiado! ' + data.url);
            addMessage('system', '🔗 Conversa compartilhada: [' + data.url + '](' + data.url + ')');
        }
    } catch (e) { showToast('❌ Erro ao compartilhar'); }
}

async function undoLastChange() {
    try {
        const resp = await fetch(BACKEND_URL + '/api/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: BACKEND_TOKEN }) });
        const data = await resp.json();
        showToast(data.message || (data.success ? '↩ Desfeito' : 'Nada para desfazer'));
        updateUndoRedoButtons();
    } catch (e) { showToast('❌ Erro ao desfazer'); }
}

async function redoLastChange() {
    try {
        const resp = await fetch(BACKEND_URL + '/api/redo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: BACKEND_TOKEN }) });
        const data = await resp.json();
        showToast(data.message || (data.success ? '↪ Refeito' : 'Nada para refazer'));
        updateUndoRedoButtons();
    } catch (e) { showToast('❌ Erro ao refazer'); }
}

async function updateUndoRedoButtons() {
    try {
        const resp = await fetch(BACKEND_URL + '/api/undo/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await resp.json();
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = !data.canUndo;
        if (redoBtn) redoBtn.disabled = !data.canRedo;
        if (undoBtn) undoBtn.title = data.canUndo ? 'Desfazer última alteração (' + data.undoCount + ' disponíveis)' : 'Nada para desfazer';
        if (redoBtn) redoBtn.title = data.canRedo ? 'Refazer (' + data.redoCount + ' disponíveis)' : 'Nada para refazer';
    } catch (e) {}
}

// =============================================
//  PLAN / BUILD MODE TOGGLE (TAB)
// =============================================
let isPlanMode = false;

function togglePlanMode() {
    isPlanMode = !isPlanMode;
    const toggle = document.getElementById('planModeToggle');
    const indicator = document.getElementById('modeIndicator');
    const label = document.getElementById('modeLabel');
    const modeSelect = document.getElementById('modeSelect');
    const input = document.getElementById('chatInput');

    if (isPlanMode) {
        toggle.classList.add('plan-mode');
        toggle.classList.remove('build-mode');
        indicator.textContent = '📋';
        label.textContent = 'Plan';
        if (modeSelect) modeSelect.value = 'clarify';
        if (input) input.placeholder = 'Descreva o que deseja fazer... (Modo Planejar: IA não altera arquivos)';
    } else {
        toggle.classList.add('build-mode');
        toggle.classList.remove('plan-mode');
        indicator.textContent = '🔨';
        label.textContent = 'Build';
        if (modeSelect) modeSelect.value = 'agent';
        if (input) input.placeholder = 'Digite seu comando... (@ para referenciar arquivos)';
    }
    savePlanModeState();
}

function savePlanModeState() {
    try { localStorage.setItem('aedificator_plan_mode', isPlanMode ? '1' : '0'); } catch (e) {}
}

let reviewMode = false;
const REVIEW_KEY = 'aedificator_review_mode';

function toggleReviewMode() {
    reviewMode = !reviewMode;
    try { localStorage.setItem(REVIEW_KEY, reviewMode ? '1' : '0'); } catch (e) {}
    updateReviewToggle();
}

function updateReviewToggle() {
    var btn = document.getElementById('reviewToggleBtn');
    if (!btn) return;
    btn.textContent = reviewMode ? '🔒 Revisar' : '🚀 Direto';
    btn.title = reviewMode ? 'Revisar alterações antes de aplicar' : 'Executar direto sem aprovação';
}

function initReviewMode() {
    try { reviewMode = localStorage.getItem(REVIEW_KEY) === '1'; } catch (e) {}
    updateReviewToggle();
}

function restorePlanModeState() {
    try {
        const saved = localStorage.getItem('aedificator_plan_mode');
        if (saved === '1' && !isPlanMode) togglePlanMode();
    } catch (e) {}
}

document.addEventListener('keydown', function(e) {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        const input = document.getElementById('chatInput');
        if (document.activeElement === input) {
            e.preventDefault();
            togglePlanMode();
        }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (document.activeElement === document.getElementById('chatInput')) {
            e.preventDefault();
            undoLastChange();
        }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        if (document.activeElement === document.getElementById('chatInput')) {
            e.preventDefault();
            redoLastChange();
        }
    }
});

// =============================================
//  @ AUTOCOMPLETE (FUZZY FILE SEARCH)
// =============================================
let acFiles = [];
let acSelectedIndex = -1;
let acMatchStart = -1;

function initAutocomplete() {
    const input = document.getElementById('chatInput');
    const dropdown = document.getElementById('autocompleteDropdown');
    if (!input || !dropdown) return;

    input.addEventListener('input', function() {
        const val = input.value;
        const cursorPos = input.selectionStart;
        const beforeCursor = val.substring(0, cursorPos);
        const atIndex = beforeCursor.lastIndexOf('@');

        if (atIndex >= 0 && (atIndex === 0 || beforeCursor[atIndex - 1] === ' ')) {
            const query = beforeCursor.substring(atIndex + 1).toLowerCase();
            acMatchStart = atIndex;
            filterAndShowAutocomplete(query);
        } else {
            dropdown.classList.remove('active');
            acSelectedIndex = -1;
        }
    });

    input.addEventListener('keydown', function(e) {
        if (!dropdown.classList.contains('active')) return;
        const items = dropdown.querySelectorAll('.autocomplete-item');
        if (e.key === 'ArrowDown') { e.preventDefault(); acSelectedIndex = Math.min(acSelectedIndex + 1, items.length - 1); updateAcSelection(items); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); acSelectedIndex = Math.max(acSelectedIndex - 1, 0); updateAcSelection(items); }
        else if (e.key === 'Enter' && acSelectedIndex >= 0) { e.preventDefault(); selectAcItem(items[acSelectedIndex]); }
        else if (e.key === 'Escape') { dropdown.classList.remove('active'); acSelectedIndex = -1; }
    });

    document.addEventListener('click', function(e) {
        if (!dropdown.contains(e.target) && e.target !== input) {
            dropdown.classList.remove('active');
            acSelectedIndex = -1;
        }
    });

    if (currentProjectPath) refreshAcFiles();
}

function refreshAcFiles() {
    // Preenche a lista de arquivos a partir da estrutura de pastas carregada
    acFiles = [];
    function walk(items, prefix) {
        for (const item of items || []) {
            const p = prefix ? prefix + '/' + item.name : item.name;
            if (item.isDirectory) {
                if (!item.name.startsWith('.') && item.name !== 'node_modules') walk(item.children || [], p);
            } else {
                acFiles.push({ name: item.name, path: p, icon: fileIcon(item.name) });
            }
        }
    }
    walk(window._lastFolderStructure || [], '');
}

function fileIcon(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    const map = { js:'📜', ts:'📘', jsx:'⚛️', tsx:'⚛️', py:'🐍', go:'🔵', rs:'🦀', java:'☕', cs:'🟣', rb:'💎', php:'🐘', kt:'🟠',
        swift:'🦅', dart:'🎯', scala:'🔴', lua:'🌙', html:'🌐', css:'🎨', json:'📋', md:'📝', sql:'🗄️', sh:'💻', yml:'⚙️', yaml:'⚙️',
        toml:'⚙️', xml:'📰', svg:'🖼️', png:'🖼️', jpg:'🖼️', gif:'🖼️', ico:'🖼️', txt:'📄', gitignore:'🔧', env:'🔐' };
    return map[ext] || '📄';
}

function filterAndShowAutocomplete(query) {
    const dropdown = document.getElementById('autocompleteDropdown');
    if (!dropdown) return;

    let matches;
    if (!query) {
        matches = acFiles.slice(0, 10);
    } else {
        const q = query.toLowerCase();
        matches = acFiles
            .map(f => ({ file: f, score: fuzzyScore(q, f.name.toLowerCase()) + fuzzyScore(q, f.path.toLowerCase()) * 0.3 }))
            .filter(m => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10)
            .map(m => m.file);
    }

    if (!matches.length) { dropdown.classList.remove('active'); acSelectedIndex = -1; return; }

    dropdown.innerHTML = '';
    for (const f of matches) {
        const item = document.createElement('div');
        item.className = 'autocomplete-item';
        const dir = f.path.includes('/') ? f.path.substring(0, f.path.lastIndexOf('/')) : '';
        item.innerHTML = `<span class="ac-icon">${f.icon}</span>${f.name}<span class="ac-path">${dir}</span>`;
        item.addEventListener('click', () => selectAcItem(f));
        dropdown.appendChild(item);
    }
    dropdown.classList.add('active');
    acSelectedIndex = 0;
    updateAcSelection(dropdown.querySelectorAll('.autocomplete-item'));
}

function updateAcSelection(items) {
    for (let i = 0; i < items.length; i++) {
        items[i].classList.toggle('selected', i === acSelectedIndex);
    }
}

function selectAcItem(file) {
    const input = document.getElementById('chatInput');
    const dropdown = document.getElementById('autocompleteDropdown');
    if (!input) return;
    const beforeAt = input.value.substring(0, acMatchStart);
    const afterQuery = input.value.substring(input.selectionStart);
    input.value = beforeAt + '@' + file.path + ' ' + afterQuery;
    input.focus();
    input.selectionStart = input.selectionEnd = beforeAt.length + file.path.length + 2;
    dropdown.classList.remove('active');
    acSelectedIndex = -1;
}

function fuzzyScore(query, text) {
    let score = 0;
    let qi = 0;
    let prevMatch = -1;
    for (let i = 0; i < text.length && qi < query.length; i++) {
        if (text[i] === query[qi]) {
            score += prevMatch >= 0 && i === prevMatch + 1 ? 3 : 1;
            if (i === 0 || text[i - 1] === '/' || text[i - 1] === '_' || text[i - 1] === '.') score += 2;
            prevMatch = i;
            qi++;
        }
    }
    return qi === query.length ? score : 0;
}

// =============================================
//  DRAG & DROP IMAGES / FILES
// =============================================
let attachedFiles = [];

function initDragDrop() {
    const chatArea = document.getElementById('chatArea');
    const dropOverlay = document.getElementById('dropOverlay');
    if (!chatArea || !dropOverlay) return;

    chatArea.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dropOverlay.classList.add('active');
    });

    chatArea.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (!chatArea.contains(e.relatedTarget)) dropOverlay.classList.remove('active');
    });

    dropOverlay.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); });

    dropOverlay.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dropOverlay.classList.remove('active');
        handleDroppedFiles(e.dataTransfer.files);
    });

    chatArea.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        dropOverlay.classList.remove('active');
        handleDroppedFiles(e.dataTransfer.files);
    });
}

function handleDroppedFiles(files) {
    for (const file of files) {
        if (file.type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = function(ev) {
                attachedFiles.push({ name: file.name, dataUrl: ev.target.result, type: 'image' });
                renderAttachments();
            };
            reader.readAsDataURL(file);
        } else {
            attachedFiles.push({ name: file.name, path: file.path || file.name, type: 'file' });
            renderAttachments();
        }
    }
    showToast(`📎 ${files.length} anexo(s) adicionado(s)`);
}

function renderAttachments() {
    let container = document.getElementById('attachmentPreview');
    if (!container) {
        container = document.createElement('div');
        container.className = 'attachment-preview';
        container.id = 'attachmentPreview';
        const inputArea = document.querySelector('.chat-area .input-area');
        if (inputArea) inputArea.parentNode.insertBefore(container, inputArea);
    }
    container.innerHTML = '';
    for (let i = 0; i < attachedFiles.length; i++) {
        const file = attachedFiles[i];
        const chip = document.createElement('span');
        chip.className = 'attachment-chip';
        chip.innerHTML = `${file.type === 'image' ? '🖼️' : '📄'} ${file.name} <span class="remove-attach" data-idx="${i}">×</span>`;
        chip.querySelector('.remove-attach').addEventListener('click', function(e) {
            e.stopPropagation();
            attachedFiles.splice(i, 1);
            renderAttachments();
        });
        container.appendChild(chip);
    }
    if (!attachedFiles.length && container.parentNode) container.remove();
}

function buildAttachmentPrompt(userMessage) {
    if (!attachedFiles.length) return userMessage;
    let prompt = userMessage + '\n\n[Arquivos anexados:';
    for (const f of attachedFiles) {
        if (f.type === 'image') {
            prompt += `\n- Imagem: ${f.name}`;
        } else {
            prompt += `\n- Arquivo: ${f.path || f.name}`;
        }
    }
    prompt += ']';
    return prompt;
}

// =============================================
//  RICH REPORT CARD
// =============================================
function showReportCard(data) {
    const container = document.getElementById('messages');
    const div = document.createElement('div');
    div.className = 'message system';

    const summary = data.summary || 'Alterações aplicadas';
    const files = data.modifiedFiles || [];
    const diagnostics = window._lastDiagnosticsErrors || [];
    const errCount = diagnostics.filter(e => e.severity === 'error').length;
    const warnCount = diagnostics.filter(e => e.severity === 'warning' || e.severity === 'info').length;
    const okFiles = files.filter(f => !diagnostics.some(d => d.file === f && d.severity === 'error'));
    const errFiles = files.filter(f => diagnostics.some(d => d.file === f && d.severity === 'error'));

    let html = '<div class="report-card">';
    html += '<div class="report-title">✅ ' + escapeHtml(summary) + '</div>';
    html += '<div class="report-stats">';
    html += '<div class="report-stat ok">📄 ' + files.length + ' arquivo(s)</div>';
    html += '<div class="report-stat ok">✅ ' + okFiles.length + ' OK</div>';
    if (errCount) html += '<div class="report-stat err">❌ ' + errCount + ' erro(s)</div>';
    if (warnCount) html += '<div class="report-stat warn">⚠️ ' + warnCount + ' warning(s)</div>';
    html += '</div>';

    if (files.length) {
        html += '<div class="report-files">';
        for (const f of files) {
            const isErr = errFiles.includes(f);
            const action = data.actions ? (data.actions[f] || 'modificado') : 'modificado';
            html += '<div class="report-file">' + (isErr ? '❌' : '✅') + ' <span class="rf-action ' + action + '">' + action.toUpperCase() + '</span> ' + escapeHtml(f) + '</div>';
        }
        html += '</div>';
    }

    html += '<div class="report-actions">';
    html += '<button class="report-btn accept" onclick="this.closest(\'.message\').querySelector(\'.report-actions\').innerHTML=\'✔ Concluído\'">✔ OK</button>';
    html += '<button class="report-btn refine" data-command="' + escapeHtml(data.command || '') + '" data-files="' + escapeHtml(JSON.stringify(files)) + '">🔄 Refinar</button>';
    html += '<button class="report-btn undo" onclick="undoLastChange();this.closest(\'.message\').querySelector(\'.report-actions\').innerHTML=\'↩ Desfeito\'">↩ Desfazer</button>';
    html += '</div></div>';

    div.innerHTML = html;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    div.querySelector('.report-btn.refine').addEventListener('click', function() {
        const command = this.dataset.command || '';
        const fileList = JSON.parse(this.dataset.files || '[]');
        const input = document.getElementById('chatInput');
        const prefix = 'Refine o seguinte (contexto do último resultado):\n' +
            'Tarefa: ' + (command || 'última alteração') + '\n' +
            (fileList.length ? 'Arquivos afetados: ' + fileList.join(', ') + '\n' : '') +
            (errCount ? errCount + ' erro(s) de diagnóstico\n' : '') +
            '━━━━━━━━━━━━━━━━\n' +
            'Ajuste: ';
        input.value = prefix;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        if (isPlanMode && !command) togglePlanMode();
    });

    scheduleSaveChatHistory();
}

// =============================================
//  INIT ALL NEW FEATURES
// =============================================
function initNewFeatures() {
    initAutocomplete();
    initDragDrop();
    initExplorerDragDrop();
    restorePlanModeState();
    initReviewMode();
    setTimeout(updateUndoRedoButtons, 2000);
    setInterval(updateUndoRedoButtons, 15000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(initNewFeatures, 1500); });
} else {
    setTimeout(initNewFeatures, 1500);
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

async function gitMerge() {
    const branch = document.getElementById('gitMergeBranch').value.trim();
    if (!branch) { showToast('Informe a branch para merge'); return; }
    try {
        const res = await apiFetch('/api/git/merge', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ branch })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ Merge realizado: ' + branch);
            loadGitStatus();
        } else {
            showToast('❌ ' + (data.error || data.output || 'Falha no merge'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
}

async function gitStash(action) {
    try {
        const res = await apiFetch('/api/git/stash', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action })
        });
        const data = await res.json();
        if (data.success) {
            showToast(action === 'pop' ? '📤 Stash aplicado' : '📦 Alterações guardadas no stash');
            loadGitStatus();
        } else {
            showToast('❌ ' + (data.error || data.output || 'Falha'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
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
        hideMonaco();
        ta.style.display = 'block';
        if (imgWrap) imgWrap.style.display = 'flex';
        saveBtn.style.display = 'none';
        if (tab.imageUrl) {
            img.src = tab.imageUrl;
        } else {
            imgWrap.style.display = 'none';
            img.src = '';
        }
        return;
    }

    if (imgWrap) imgWrap.style.display = 'none';
    img.src = '';
    saveBtn.style.display = 'inline-block';

    if (monacoReady && !tab.isImage) {
        switchMonacoModel(tab.path);
    } else {
        ta.style.display = 'block';
        hideMonaco();
        ta.value = tab.content;
    }
}

function closeTab(filePath) {
    const idx = editorTabs.findIndex(t => t.path === filePath);
    if (idx < 0) return;
    disposeMonacoModel(filePath);
    editorTabs.splice(idx, 1);
    if (activeTabPath === filePath) {
        const next = editorTabs[idx] || editorTabs[idx - 1];
        if (next) {
            activateTab(next.path);
        } else {
            activeTabPath = null;
            document.getElementById('fileEditorModal').style.display = 'none';
            hideMonaco();
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
    if (monacoEditor) {
        const model = monacoEditor.getModel();
        if (model) monacoEditor.setModel(null);
    }
    setEditorContent('');
    document.getElementById('fileEditorImageWrap').style.display = 'none';
    hideMonaco();
    if (splitActive) closeSplitEditor();
}

// =============================================
//  SPLIT EDITOR (2 painéis)
// =============================================
function toggleSplitEditor() {
    if (splitActive) {
        closeSplitEditor();
    } else {
        openSplitEditor();
    }
}

function openSplitEditor() {
    const body = document.getElementById('editorBody');
    const right = document.getElementById('editorSplitRight');
    const modal = document.getElementById('fileEditorModal');
    if (!body || !right || !modal) return;
    if (splitActive) return;

    splitActive = true;
    body.classList.add('split-active');
    modal.classList.add('split-active');
    right.style.display = 'flex';
    document.getElementById('fileEditorSplitBtn').textContent = '❌ Unsplit';
    showToast('↔️ Editor dividido');

    if (monacoReady) {
        initMonacoSplit();
    }
}

function closeSplitEditor() {
    if (!splitActive) return;
    splitActive = false;
    if (monacoSplitEditor) {
        monacoSplitEditor.dispose();
        monacoSplitEditor = null;
    }
    activeTabRight = null;
    editorTabsRight = [];
    const body = document.getElementById('editorBody');
    const right = document.getElementById('editorSplitRight');
    const modal = document.getElementById('fileEditorModal');
    if (body) body.classList.remove('split-active');
    if (modal) modal.classList.remove('split-active');
    if (right) right.style.display = 'none';
    document.getElementById('fileEditorSplitBtn').textContent = '↔️ Split';
    document.getElementById('editorSplitTabs').innerHTML = '';
}

function initMonacoSplit() {
    if (monacoSplitEditor) return;
    const container = document.getElementById('monacoSplitContainer');
    if (!container) return;
    const isLight = document.body.classList.contains('theme-light');
    monacoSplitEditor = monaco.editor.create(container, {
        value: '',
        language: 'plaintext',
        theme: isLight ? 'vs' : 'vs-dark',
        automaticLayout: true,
        fontSize: monacoEditor ? monacoEditor.getOption(monaco.editor.EditorOption.fontSize) : 13,
        fontFamily: "'Consolas', 'Courier New', monospace",
        lineHeight: 1.5,
        tabSize: monacoEditor ? monacoEditor.getOption(monaco.editor.EditorOption.tabSize) : 4,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        readOnly: true,
        lineNumbers: 'on',
    });
}

function openFileRight(filePath) {
    if (!splitActive) {
        openFile(filePath);
        return;
    }
    const existing = editorTabsRight.find(t => t.path === filePath);
    if (existing) { activateTabRight(filePath); return; }
    editorTabsRight.push({ path: filePath, content: '', loaded: false, dirty: false });
    activateTabRight(filePath);
}

async function loadTabRight(filePath) {
    const tab = editorTabsRight.find(t => t.path === filePath);
    if (!tab || tab.loaded) return;
    try {
        const res = await apiFetch('/api/file/read', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: filePath })
        });
        const data = await res.json();
        tab.loaded = true;
        if (data.success) {
            tab.content = data.content;
            if (activeTabRight === filePath) renderTabRight();
        }
    } catch (e) {}
}

function activateTabRight(filePath) {
    activeTabRight = filePath;
    renderSplitTabs();
    renderTabRight();
}

function renderSplitTabs() {
    const bar = document.getElementById('editorSplitTabs');
    bar.innerHTML = '';
    for (const tab of editorTabsRight) {
        const el = document.createElement('div');
        el.className = 'editor-split-tab' + (tab.path === activeTabRight ? ' active' : '');
        el.innerHTML = escapeHtml(tab.path.split('/').pop()) + '<span class="split-tab-close">×</span>';
        el.addEventListener('click', (e) => {
            if (e.target.classList.contains('split-tab-close')) {
                e.stopPropagation();
                closeTabRight(tab.path);
                return;
            }
            activateTabRight(tab.path);
        });
        bar.appendChild(el);
    }
}

function closeTabRight(filePath) {
    const idx = editorTabsRight.findIndex(t => t.path === filePath);
    if (idx < 0) return;
    editorTabsRight.splice(idx, 1);
    if (activeTabRight === filePath) {
        const next = editorTabsRight[idx] || editorTabsRight[idx - 1];
        if (next) { activateTabRight(next.path); }
        else {
            activeTabRight = null;
            closeSplitEditor();
        }
    }
    renderSplitTabs();
}

function renderTabRight() {
    if (!monacoSplitEditor) return;
    const tab = editorTabsRight.find(t => t.path === activeTabRight);
    if (!tab) { monacoSplitEditor.setValue(''); return; }
    loadTabRight(tab.path);
    const lang = getMonacoLanguage(tab.path);
    monaco.editor.setModelLanguage(monacoSplitEditor.getModel(), lang);
    monacoSplitEditor.setValue(tab.content);
}

// =============================================
//  OUTLINE (árvore de símbolos)
// =============================================
function toggleOutline() {
    const panel = document.getElementById('outlinePanel');
    if (!panel) return;
    if (panel.style.display === 'none' || !panel.style.display) {
        panel.style.display = 'block';
        refreshOutline();
    } else {
        panel.style.display = 'none';
    }
}

function refreshOutline() {
    const panel = document.getElementById('outlinePanel');
    if (!panel || panel.style.display === 'none') return;
    if (!monacoEditor || !monacoEditor.getModel()) {
        panel.innerHTML = '<div style="padding:8px;color:#8b949e;">Abra um arquivo no editor</div>';
        return;
    }
    monaco.languages.registerDocumentSymbolProvider('*', {
        provideDocumentSymbols: function(model) {
            return new Promise((resolve) => {
                const symbols = [];
                const text = model.getValue();
                const lines = text.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    const classMatch = line.match(/class\s+(\w+)/);
                    const funcMatch = line.match(/(?:function\s+(\w+)|(\w+)\s*=\s*(?:function|\([^)]*\)\s*=>|async\s*\(|async\s+\w+\s*=>))/);
                    const methodMatch = line.match(/^\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
                    const varMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/);

                    if (classMatch) {
                        symbols.push({
                            name: classMatch[1],
                            kind: monaco.languages.SymbolKind.Class,
                            range: new monaco.Range(i+1, 1, i+1, 1),
                            selectionRange: new monaco.Range(i+1, 1, i+1, line.length),
                            containerName: ''
                        });
                    } else if (funcMatch) {
                        symbols.push({
                            name: funcMatch[1] || funcMatch[2],
                            kind: monaco.languages.SymbolKind.Function,
                            range: new monaco.Range(i+1, 1, i+1, 1),
                            selectionRange: new monaco.Range(i+1, 1, i+1, line.length),
                            containerName: ''
                        });
                    } else if (methodMatch && methodMatch[1] !== 'if' && methodMatch[1] !== 'for' && methodMatch[1] !== 'while' && methodMatch[1] !== 'switch') {
                        symbols.push({
                            name: methodMatch[1],
                            kind: monaco.languages.SymbolKind.Method,
                            range: new monaco.Range(i+1, 1, i+1, 1),
                            selectionRange: new monaco.Range(i+1, 1, i+1, line.length),
                            containerName: ''
                        });
                    } else if (varMatch && !line.includes('(')) {
                        symbols.push({
                            name: varMatch[1],
                            kind: monaco.languages.SymbolKind.Variable,
                            range: new monaco.Range(i+1, 1, i+1, 1),
                            selectionRange: new monaco.Range(i+1, 1, i+1, line.length),
                            containerName: ''
                        });
                    }
                }
                resolve(symbols);
            });
        }
    });

    monaco.languages.registerDocumentSymbolProvider('*', {
        provideDocumentSymbols: function(m) {
            return refreshOutlineSymbols(m);
        }
    });

    setTimeout(() => {
        const symbols = extractOutlineSymbols(monacoEditor.getValue());
        renderOutlinePanel(symbols);
    }, 100);
}

function refreshOutlineSymbols(model) {
    const text = model ? model.getValue() : '';
    const symbols = extractOutlineSymbols(text);
    return symbols.map(s => {
        const range = new monaco.Range(s.line, 1, s.line, 1);
        const kindMap = { 'class': monaco.languages.SymbolKind.Class, 'function': monaco.languages.SymbolKind.Function, 'method': monaco.languages.SymbolKind.Method, 'variable': monaco.languages.SymbolKind.Variable };
        return { name: s.name, kind: kindMap[s.kind] || monaco.languages.SymbolKind.Property, range: range, selectionRange: range };
    });
}

function extractOutlineSymbols(text) {
    const symbols = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const classMatch = line.match(/class\s+(\w+)/);
        const funcMatch = line.match(/(?:function\s+(\w+)|(\w+)\s*=\s*(?:function|\([^)]*\)\s*=>|async\s*\(|async\s+\w+\s*=>))/);
        const methodMatch = line.match(/^\s*(?:static\s+)?(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/);
        const varMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=/);
        if (classMatch) symbols.push({ name: classMatch[1], kind: 'class', line: i+1 });
        else if (funcMatch) symbols.push({ name: funcMatch[1] || funcMatch[2], kind: 'function', line: i+1 });
        else if (methodMatch && !['if','for','while','switch','return','throw','new'].includes(methodMatch[1]))
            symbols.push({ name: methodMatch[1], kind: 'method', line: i+1 });
        else if (varMatch && !line.includes('('))
            symbols.push({ name: varMatch[1], kind: 'variable', line: i+1 });
    }
    return symbols;
}

function renderOutlinePanel(symbols) {
    const panel = document.getElementById('outlinePanel');
    if (!panel || panel.style.display === 'none') return;
    if (!symbols.length) {
        panel.innerHTML = '<div style="padding:8px;color:#8b949e;">Nenhum símbolo encontrado</div>';
        return;
    }
    panel.innerHTML = symbols.map(s => {
        const icon = { class: '◈', function: 'ƒ', method: '▸', variable: '•' }[s.kind] || '•';
        return `<div class="outline-item outline-${s.kind}" onclick="monacoEditor.revealLineInCenter(${s.line});monacoEditor.setPosition({lineNumber:${s.line},column:1});monacoEditor.focus();">${icon} ${escapeHtml(s.name)} <span style="color:#8b949e;">:${s.line}</span></div>`;
    }).join('');
}

// =============================================
//  DIAGNOSTICS (erros inline no editor)
// =============================================
let diagnosticsDebounce = null;

function runDiagnostics() {
    clearTimeout(diagnosticsDebounce);
    diagnosticsDebounce = setTimeout(() => _runDiagnostics(), 800);
}

async function _runDiagnostics() {
    if (!monacoEditor || !monacoEditor.getModel() || !activeTabPath || !monacoReady) return;
    const code = monacoEditor.getValue();
    if (!code.trim()) return;

    try {
        const res = await apiFetch('/api/analyzer/validate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, file: activeTabPath })
        });
        const data = await res.json();
        const markers = [];
        if (data.errors) {
            for (const err of data.errors) {
                markers.push({
                    severity: err.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                    message: err.message || 'Error',
                    startLineNumber: parseInt(err.line) || 1,
                    startColumn: parseInt(err.column) || 1,
                    endLineNumber: parseInt(err.line) || 1,
                    endColumn: 100,
                });
            }
        }
        monaco.editor.removeAllMarkers();
        if (markers.length) {
            monaco.editor.setModelMarkers(monacoEditor.getModel(), 'analyzer', markers);
        }
    } catch (e) {}
}

// =============================================
//  DIFF EDITOR LADO A LADO
// =============================================
function gitShowDiffSideBySide(original, modified, title) {
    const existing = document.getElementById('diffSideModal');
    if (existing) { existing.remove(); }

    const modal = document.createElement('div');
    modal.id = 'diffSideModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:5500;';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.innerHTML = `<div class="modal-content" style="width:95vw;max-width:1200px;height:88vh;display:flex;flex-direction:column;">
        <h2 id="diffSideTitle">📊 ${title || 'Git Diff'}</h2>
        <div id="diffSideEditor" style="flex:1;border:1px solid #30363d;border-radius:8px;overflow:hidden;"></div>
        <div class="modal-actions" style="margin-top:8px;">
            <button class="btn-close-modal" onclick="document.getElementById('diffSideModal').remove()">❌ Fechar</button>
        </div>
    </div>`;
    document.body.appendChild(modal);

    if (monacoReady) {
        const diffEditor = monaco.editor.createDiffEditor(document.getElementById('diffSideEditor'), {
            automaticLayout: true,
            readOnly: true,
            renderSideBySide: true,
            fontSize: 13,
            theme: document.body.classList.contains('theme-light') ? 'vs' : 'vs-dark',
        });
        const originalModel = monaco.editor.createModel(original || '', 'plaintext');
        const modifiedModel = monaco.editor.createModel(modified || '', 'plaintext');
        diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    } else {
        document.getElementById('diffSideEditor').innerHTML = '<pre style="padding:16px;color:#c9d1d9;font-family:Consolas,monospace;font-size:12px;">' + escapeHtml(original || '') + '\n\n── MODIFICADO ──\n\n' + escapeHtml(modified || '') + '</pre>';
    }
}

// =============================================
//  DEBUGGER UI
// =============================================
function showDebugPanel() {
    let panel = document.getElementById('debugPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id = 'debugPanel';
        panel.style.cssText = 'margin-top:8px;display:flex;gap:8px;min-height:140px;max-height:250px;font-size:11px;font-family:Consolas,monospace;';
        const modalContent = document.querySelector('#fileEditorModal .modal-content');
        const actionsEl = modalContent.querySelector('.modal-actions');
        actionsEl.parentNode.insertBefore(panel, actionsEl);
    }
    panel.style.display = 'flex';
    if (!panel.querySelector('#debugVars')) {
        panel.innerHTML = `
            <div style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;display:flex;flex-direction:column;overflow:hidden;">
                <div style="padding:4px 8px;background:#21262d;color:#58a6ff;font-weight:600;font-size:11px;">📦 Variáveis</div>
                <div id="debugVars" style="flex:1;overflow-y:auto;padding:4px 8px;color:#c9d1d9;word-break:break-all;"></div>
            </div>
            <div style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;display:flex;flex-direction:column;overflow:hidden;">
                <div style="padding:4px 8px;background:#21262d;color:#58a6ff;font-weight:600;font-size:11px;">📞 Call Stack</div>
                <div id="debugStack" style="flex:1;overflow-y:auto;padding:4px 8px;color:#c9d1d9;"></div>
            </div>
            <div style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;display:flex;flex-direction:column;overflow:hidden;">
                <div style="padding:4px 8px;background:#21262d;color:#58a6ff;font-weight:600;font-size:11px;">👁️ Watch</div>
                <div style="display:flex;gap:4px;padding:4px;">
                    <input id="debugWatchInput" type="text" placeholder="expressão..." style="flex:1;padding:2px 6px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:3px;font-size:11px;font-family:Consolas,monospace;">
                    <button id="debugWatchBtn" style="padding:2px 6px;background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:3px;cursor:pointer;font-size:11px;">▶</button>
                </div>
                <div id="debugWatch" style="flex:1;overflow-y:auto;padding:4px 8px;color:#c9d1d9;"></div>
            </div>
            <div style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;display:flex;flex-direction:column;overflow:hidden;">
                <div style="padding:4px 8px;background:#21262d;color:#58a6ff;font-weight:600;font-size:11px;">🖥️ Console</div>
                <pre id="debugConsole" style="flex:1;overflow-y:auto;padding:4px 8px;color:#c9d1d9;white-space:pre-wrap;word-break:break-all;margin:0;font-family:Consolas,monospace;"></pre>
            </div>`;
        document.getElementById('debugWatchBtn').addEventListener('click', () => {
            const expr = document.getElementById('debugWatchInput').value.trim();
            if (expr) evaluateDebugExpr(expr);
        });
        document.getElementById('debugWatchInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') { const expr = e.target.value.trim(); if (expr) evaluateDebugExpr(expr); }
        });
    }
}

function updateDebugPanels(data) {
    const vars = document.getElementById('debugVars');
    if (vars && data.variables && data.variables.scopes) {
        let html = '';
        for (const scope of data.variables.scopes) {
            html += `<div style="color:#d29922;margin-top:4px;">▸ ${escapeHtml(scope.name)}</div>`;
            for (const prop of (scope.properties || [])) {
                html += `<div style="padding:1px 0 1px 12px;"><span style="color:#79c0ff;">${escapeHtml(prop.name)}</span>: <span style="color:#a5d6ff;">${escapeHtml(prop.value)}</span></div>`;
            }
        }
        vars.innerHTML = html || '<div style="color:#8b949e;">—</div>';
    }
    const reasonMap = { 'step': '⏭️ Step', 'breakpoint': '🔴 Breakpoint', 'exception': '💥 Exception', 'pause': '⏸️ Pause' };
    const reason = reasonMap[data.reason] || data.reason;
    const stack = document.getElementById('debugStack');
    if (stack) stack.innerHTML = `<div style="color:#f85149;">${reason}</div><div style="color:#c9d1d9;margin-top:4px;">📄 ${escapeHtml((data.filename||'').split('/').pop())}:${data.line}</div>`;
    const console = document.getElementById('debugConsole');
    if (console && !console.textContent) console.textContent = '';
}

async function evaluateDebugExpr(expr) {
    try {
        const res = await apiFetch('/api/debug/evaluate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expression: expr })
        });
        const data = await res.json();
        const watch = document.getElementById('debugWatch');
        if (watch) watch.innerHTML += `<div style="padding:2px 0;"><span style="color:#79c0ff;">${escapeHtml(expr)}</span> = <span style="color:#a5d6ff;">${escapeHtml(data.value || data.error || 'undefined')}</span></div>`;
        document.getElementById('debugWatchInput').value = '';
    } catch (e) {
        const watch = document.getElementById('debugWatch');
        if (watch) watch.innerHTML += `<div style="color:#f85149;">❌ ${escapeHtml(e.message)}</div>`;
    }
}

function clearDebugDecorations() {
    if (monacoEditor && debugDecorations.length) {
        monacoEditor.deltaDecorations(debugDecorations, []);
        debugDecorations = [];
    }
    debugPausedLine = null;
}

function highlightDebugLine(line) {
    if (!monacoEditor || !monacoReady) return;
    clearDebugDecorations();
    if (!line) return;
    debugDecorations = monacoEditor.deltaDecorations([], [{
        range: new monaco.Range(line, 1, line, 1),
        options: {
            isWholeLine: true,
            className: 'debug-current-line',
            glyphMarginClassName: 'debug-current-glyph',
            linesDecorationsClassName: 'debug-current-line-decoration'
        }
    }]);
    monacoEditor.revealLineInCenter(line);
    monacoEditor.setPosition({ lineNumber: line, column: 1 });
}

function toggleDebugBreakpoint(line) {
    const path = activeTabPath;
    if (!path) return;
    const exists = debugBreakpoints.findIndex(b => b.path === path && b.line === line);
    if (exists >= 0) {
        debugBreakpoints.splice(exists, 1);
    } else {
        debugBreakpoints.push({ path, line });
    }
    renderDebugBreakpoints();
}

function renderDebugBreakpoints() {
    if (!monacoEditor || !monacoReady) return;
    const path = activeTabPath;
    if (!path) return;
    const bps = debugBreakpoints.filter(b => b.path === path);
    debugDecorations = monacoEditor.deltaDecorations(debugDecorations, bps.map(b => ({
        range: new monaco.Range(b.line, 1, b.line, 1),
        options: {
            isWholeLine: false,
            glyphMarginClassName: 'debug-breakpoint',
            glyphMarginHoverMessage: { value: 'Breakpoint na linha ' + b.line }
        }
    })));
}

function updateDebugUI() {
    let toolbar = document.getElementById('debugToolbar');
    if (debugActive) {
        if (!toolbar) {
            toolbar = document.createElement('div');
            toolbar.id = 'debugToolbar';
            toolbar.style.cssText = 'display:flex;gap:4px;align-items:center;padding:2px 0;';
            const header = document.querySelector('#fileEditorModal .editor-header');
            header.appendChild(toolbar);
        }
        toolbar.innerHTML = `
            <button class="btn-toolbar" id="debugResumeBtn" style="font-size:10px;padding:2px 6px;">▶ Continuar</button>
            <button class="btn-toolbar" id="debugStepBtn" style="font-size:10px;padding:2px 6px;">⤵ Step Over</button>
            <button class="btn-toolbar" id="debugStepIntoBtn" style="font-size:10px;padding:2px 6px;">↓ Step Into</button>
            <button class="btn-toolbar" id="debugStepOutBtn" style="font-size:10px;padding:2px 6px;">↑ Step Out</button>
            <button class="btn-toolbar" id="debugStopBtn" style="font-size:10px;padding:2px 6px;color:#f85149;">⏹ Parar</button>
            <span style="color:#3fb950;font-size:11px;margin-left:8px;">🔴 Debug ativo</span>`;
        document.getElementById('debugResumeBtn').addEventListener('click', debugResume);
        document.getElementById('debugStepBtn').addEventListener('click', debugStep);
        document.getElementById('debugStepIntoBtn').addEventListener('click', debugStepInto);
        document.getElementById('debugStepOutBtn').addEventListener('click', debugStepOut);
        document.getElementById('debugStopBtn').addEventListener('click', debugStop);

        if (monacoEditor && monacoReady) {
            monacoEditor.onMouseDown(e => {
                if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) {
                    toggleDebugBreakpoint(e.target.position.lineNumber);
                }
            });
        }
    } else {
        if (toolbar) toolbar.remove();
        const panel = document.getElementById('debugPanel');
        if (panel) panel.style.display = 'none';
    }
}

async function debugStart() {
    if (!activeTabPath) { showToast('Abra um arquivo JS/TS primeiro'); return; }
    const ext = (activeTabPath.split('.').pop()||'').toLowerCase();
    if (!['js','mjs','cjs','ts','tsx'].includes(ext)) { showToast('Debug só funciona com arquivos .js/.ts'); return; }
    try {
        const res = await apiFetch('/api/debug/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: activeTabPath, breakpoints: debugBreakpoints.filter(b => b.path === activeTabPath).map(b => ({ line: b.line })) })
        });
        const data = await res.json();
        if (!data.success) showToast('❌ ' + (data.error || 'Falha ao iniciar debug'));
    } catch (e) { showToast('❌ ' + e.message); }
}

async function debugStop() {
    try { await apiFetch('/api/debug/stop', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); } catch (e) {}
}

async function debugResume() { try { await apiFetch('/api/debug/resume', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); } catch (e) {} }
async function debugStep() { try { await apiFetch('/api/debug/step', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); } catch (e) {} }
async function debugStepInto() { try { await apiFetch('/api/debug/stepInto', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); } catch (e) {} }
async function debugStepOut() { try { await apiFetch('/api/debug/stepOut', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } }); } catch (e) {} }

// =============================================
//  APROVAÇÃO DO PLANO
// =============================================
function showApprovalModal(data) {
    const hasSugestoes = data.sugestoes && Array.isArray(data.sugestoes) && data.sugestoes.length > 0;
    const hasArquivos = data.arquivos && data.arquivos.length > 0;

    if (!hasArquivos && !hasSugestoes) {
        showToast('📋 Nada a executar');
        return false;
    }

    pendingApproval = data;
    document.getElementById('approvalResumo').textContent = data.resumo || '';
    const list = document.getElementById('approvalFilesList');
    list.innerHTML = '';

    if (hasSugestoes) {
        const agentName = 'Assistente - Escolha uma opção';
        const container = document.getElementById('messages');
        const div = document.createElement('div');
        div.className = 'message agent';
        const btnId = 'sugBtns_' + Date.now();
        let btnHtml = '';
        for (const s of data.sugestoes) {
            const impactLabel = s.impacto === 'alto' ? '🔴' : s.impacto === 'médio' ? '🟡' : '🟢';
            if (s.id === 'custom') {
                btnHtml += `<div class="sugestao-custom-wrap" style="margin:4px 0;">
                    <button class="sugestao-btn sugestao-custom-btn" data-sid="${escapeHtml(s.id)}" data-planid="${escapeHtml(data.planId)}" style="display:block;width:100%;text-align:left;padding:8px 12px;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;cursor:pointer;font-size:13px;">${impactLabel} <b>${escapeHtml(s.titulo)}</b><br><span style="font-size:11px;color:#8b949e;">${escapeHtml(s.descricao)}</span></button>
                    <input type="text" class="sugestao-custom-input" placeholder="Descreva exatamente o que deseja..." style="display:none;width:100%;margin-top:4px;padding:6px 8px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#e6edf3;font-size:12px;box-sizing:border-box;">
                    <button class="sugestao-custom-send" style="display:none;margin-top:4px;padding:4px 12px;background:#1f6feb;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:12px;">Enviar</button>
                </div>`;
            } else {
                btnHtml += `<button class="sugestao-btn" data-sid="${escapeHtml(s.id)}" data-planid="${escapeHtml(data.planId)}" style="display:block;width:100%;text-align:left;padding:8px 12px;margin:4px 0;background:#21262d;border:1px solid #30363d;border-radius:6px;color:#e6edf3;cursor:pointer;font-size:13px;">${impactLabel} <b>${escapeHtml(s.titulo)}</b><br><span style="font-size:11px;color:#8b949e;">${escapeHtml(s.descricao)}</span></button>`;
            }
        }
        div.innerHTML = `<div class="msg-avatar">🤖</div><div class="msg-body"><div class="msg-content">📋 ${escapeHtml(data.resumo || '')}</div><div id="${btnId}" style="margin-top:8px;">${btnHtml}</div></div><div style="text-align:right;margin-top:4px;"><button class="msg-copy-btn" title="Copiar" onclick="copyMsgContent(this)">📋 Copiar</button></div>`;
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;

        setTimeout(() => {
            const btns = document.getElementById(btnId);
            if (!btns) return;
            btns.querySelectorAll('.sugestao-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    if (this.classList.contains('sugestao-custom-btn')) {
                        const wrap = this.closest('.sugestao-custom-wrap');
                        const input = wrap.querySelector('.sugestao-custom-input');
                        const send = wrap.querySelector('.sugestao-custom-send');
                        this.style.display = 'none';
                        input.style.display = 'block';
                        send.style.display = 'inline-block';
                        input.focus();
                        send.addEventListener('click', function execCustom() {
                            const val = input.value.trim();
                            if (!val) return;
                            send.removeEventListener('click', execCustom);
                            doExecuteSuggestion(data, this.dataset.planid || data.planId, this.dataset.sid, val);
                        }.bind(this));
                        input.addEventListener('keypress', function execCustomEnter(e) {
                            if (e.key !== 'Enter') return;
                            const val = input.value.trim();
                            if (!val) return;
                            input.removeEventListener('keypress', execCustomEnter);
                            doExecuteSuggestion(data, this.dataset.planid || data.planId, this.dataset.sid, val);
                        }.bind(this));
                        return;
                    }
                    doExecuteSuggestion(data, this.dataset.planid || data.planId, this.dataset.sid, null);
                });
            });
        }, 100);

        const doExecuteSuggestion = function(data, pid, sid, customRequest) {
            pendingApproval = data;
            pendingApproval.planId = pid;
            stopAutoExecCountdown();
            closeApprovalModal();
            isStreaming = true;
            document.getElementById('sendButton').disabled = true;
            document.getElementById('cancelButton').style.display = 'inline-block';
            const topFill = document.getElementById('progressBarFill');
            const topBar = document.getElementById('progressBarContainer');
            const progressFill = document.getElementById('progressFill');
            const progressBar = document.getElementById('progressBar');
            if (topFill) { topFill.classList.add('indeterminate'); topFill.style.width = ''; }
            if (topBar) topBar.style.display = 'block';
            if (progressFill) progressFill.classList.add('indeterminate');
            if (progressBar) { progressBar.style.display = 'flex'; progressBar.querySelector('.progress-text').textContent = 'Implementando...'; }
            const payload = { type: 'execute', planId: pid, token: BACKEND_TOKEN, selecionadas: [sid] };
            if (customRequest) payload.customRequest = customRequest;
            sendStreamingMessage(payload);
            pendingApproval = null;
            const allBtns = document.querySelectorAll('.sugestao-btn');
            allBtns.forEach(b => { b.disabled = true; b.style.opacity = '0.5'; b.style.pointerEvents = 'none'; });
        }

        for (const s of data.sugestoes) {
            const row = document.createElement('div');
            row.className = 'approval-file';
            const isCustom = s.id === 'custom';
            row.innerHTML = `
                <label class="approval-check" style="display:flex;align-items:center;gap:6px;">
                    <input type="checkbox" class="sugestao-checkbox" data-id="${escapeHtml(s.id)}">
                    <b>${escapeHtml(s.titulo)}</b>
                    <span style="font-size:11px;color:#8b949e;margin-left:4px;">${s.impacto === 'alto' ? '🔴 alto' : s.impacto === 'médio' ? '🟡 médio' : '🟢 baixo'}</span>
                </label>
                <div style="margin:2px 0 4px 30px;font-size:12px;color:#8b949e;">${escapeHtml(s.descricao)}</div>
                ${isCustom ? '<input type="text" class="custom-request-input" placeholder="Descreva exatamente o que deseja..." style="display:none;width:calc(100% - 36px);margin:4px 0 4px 30px;padding:6px 8px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#e6edf3;font-size:12px;">' : ''}
                ${(s.arquivos || []).map(a => `<div style="margin:1px 0 1px 30px;font-size:11px;color:#6e7681;">📄 ${escapeHtml(a.caminho)} (${escapeHtml(a.acao || 'modificar')})</div>`).join('')}
            `;
            if (isCustom) {
                const cb = row.querySelector('.sugestao-checkbox');
                const input = row.querySelector('.custom-request-input');
                cb.addEventListener('change', function() {
                    input.style.display = cb.checked ? 'block' : 'none';
                    if (cb.checked) input.focus();
                });
            }
            list.appendChild(row);
        }
    } else {
        for (let i = 0; i < data.arquivos.length; i++) {
            const f = data.arquivos[i];
            const row = document.createElement('div');
            row.className = 'approval-file';
            const actionText = f.acao === 'criar' ? '🆕 Criar' : f.acao === 'deletar' ? '🗑️ Deletar' : '✏️ Modificar';
            const actionClass = f.acao === 'criar' ? 'acao-criar' : f.acao === 'deletar' ? 'acao-deletar' : 'acao-modificar';
            const hasContent = f.conteudo && f.conteudo.length > 0;
            const fileId = 'af_' + i;
            row.dataset.fileIdx = i;

            let headerHtml = '<div class="approval-file-header">';
            headerHtml += '<input type="checkbox" class="approval-file-toggle" checked data-idx="' + i + '" title="Incluir/excluir este arquivo">';
            headerHtml += '<span class="approval-acao ' + actionClass + '">' + actionText + '</span>';
            headerHtml += '<span class="approval-caminho">' + escapeHtml(f.caminho) + '</span>';
            if (hasContent) {
                headerHtml += '<span style="font-size:10px;color:#484f58;margin-left:auto;">' + (f.conteudo || '').length + ' bytes</span>';
                headerHtml += '<span class="approval-file-chevron">▶</span>';
            }
            headerHtml += '</div>';

            let editorHtml = '';
            if (hasContent) {
                editorHtml = '<div class="approval-file-editor">';
                editorHtml += '<textarea class="approval-content-editor" id="' + fileId + '" spellcheck="false">' + escapeHtml(f.conteudo || '') + '</textarea>';
                editorHtml += '</div>';
            }

            row.innerHTML = headerHtml + editorHtml;
            if (hasContent) {
                const header = row.querySelector('.approval-file-header');
                header.addEventListener('click', function(e) {
                    if (e.target.classList.contains('approval-file-toggle')) return;
                    row.classList.toggle('active');
                });
            }
            if (f.explicacao) row.title = f.explicacao;
            list.appendChild(row);
        }
    }

    document.getElementById('approvalModal').style.display = 'flex';
    setProgress(data.total);

    stopAutoExecCountdown();
    return true;
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
    const payload = { type: 'execute', planId, token: BACKEND_TOKEN };
    if (pendingApproval.sugestoes) {
        const checkboxes = document.querySelectorAll('.sugestao-checkbox:checked');
        payload.selecionadas = Array.from(checkboxes).map(cb => cb.dataset.id);
        const customInput = document.querySelector('.custom-request-input');
        if (customInput && customInput.style.display !== 'none' && customInput.value.trim()) {
            payload.customRequest = customInput.value.trim();
        }
    } else if (pendingApproval.arquivos) {
        const toggles = document.getElementById('approvalFilesList').querySelectorAll('.approval-file-toggle');
        const includeIdxs = new Set();
        toggles.forEach(cb => { if (cb.checked) includeIdxs.add(parseInt(cb.dataset.idx)); });
        payload.arquivos = pendingApproval.arquivos.filter((f, i) => includeIdxs.has(i)).map((f, i) => {
            const editor = document.getElementById('af_' + i);
            return {
                caminho: f.caminho,
                acao: f.acao,
                explicacao: f.explicacao || '',
                conteudo: editor ? editor.value : (f.conteudo || '')
            };
        });
    }
    const noteInput = document.getElementById('approvalNoteInput');
    if (noteInput && noteInput.value.trim()) {
        payload.nota = noteInput.value.trim();
    }
    closeApprovalModal();
    pendingApproval = null;
    setProgress(total);
    sendStreamingMessage(payload);
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
    let message = input.value.trim();
    if (!message || isStreaming || isRunning) return;

    if (attachedFiles.length) {
        message = buildAttachmentPrompt(message);
    }

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

    const effectiveMode = isPlanMode ? 'clarify' : currentMode;

    const topFill = document.getElementById('progressBarFill');
    const topBar = document.getElementById('progressBarContainer');
    if (topFill) { topFill.classList.add('indeterminate'); topFill.style.width = ''; }
    if (topBar) topBar.style.display = 'block';
    const progressFill = document.getElementById('progressFill');
    const progressBar = document.getElementById('progressBar');
    if (progressFill) progressFill.classList.add('indeterminate');
    if (progressBar) { progressBar.style.display = 'flex'; progressBar.querySelector('.progress-text').textContent = 'Analisando...'; }

    var provider = document.getElementById('providerSelect').value;
    var modelName = (currentModel || '').replace(/^(opencode|opencode-go)\//, '');
    startTaskActivity((modelName || provider) + ' · ' + (message.length > 48 ? message.slice(0, 48) + '…' : message));
    startAnalysisActivity();

    sendStreamingMessage({
        type: 'stream',
        message: message,
        model: currentModel,
        provider: provider,
        mode: effectiveMode,
        projectPath: currentProjectPath,
        token: BACKEND_TOKEN,
        history: collectChatHistory(),
        reviewMode: reviewMode
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
    updatePipeline('done', finalStatus === 'success' ? 'done' : finalStatus === 'cancelled' ? 'cancelled' : 'error');
    if (terminalBlockStart > 0) {
        var totalMs = Date.now() - terminalBlockStart;
        var totalStr = totalMs < 1000 ? Math.round(totalMs) + 'ms' : (totalMs / 1000).toFixed(1) + 's';
        terminalAdd('block-end', (toastMsg || 'Concluído').replace(/^✅\s*/, '') + ' · ' + totalStr);
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
    const topBar = document.getElementById('progressBarContainer');
    const topFill = document.getElementById('progressBarFill');
    const progressFill = document.getElementById('progressFill');
    if (topFill) topFill.classList.remove('indeterminate');
    if (progressFill) progressFill.classList.remove('indeterminate');
    if (bar) bar.style.display = totalFilesToProcess >= 0 ? 'flex' : 'none';
    if (topBar) topBar.style.display = 'block';
    updateProgressUI();
}

function updateProgressUI() {
    const pct = totalFilesToProcess > 0 ? Math.round((processedFiles / totalFilesToProcess) * 100) : 0;
    const fill = document.getElementById('progressFill');
    const text = document.getElementById('progressText');
    const topFill = document.getElementById('progressBarFill');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `${processedFiles}/${totalFilesToProcess}`;
    if (topFill) topFill.style.width = pct + '%';
}

function hideProgress() {
    const bar = document.getElementById('progressBar');
    const topBar = document.getElementById('progressBarContainer');
    const topFill = document.getElementById('progressBarFill');
    const progressFill = document.getElementById('progressFill');
    if (bar) bar.style.display = 'none';
    if (topBar) topBar.style.display = 'none';
    if (topFill) { topFill.classList.remove('indeterminate'); topFill.style.width = '0%'; }
    if (progressFill) { progressFill.classList.remove('indeterminate'); progressFill.style.width = '0%'; }
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
    clearTerminal();
    clearPipeline();
}

function switchCenterTab(tab) {
    const activityList = document.getElementById('activityList');
    const workflowView = document.getElementById('workflowView');
    const terminalView = document.getElementById('terminalView');
    const tabActivity = document.getElementById('tabActivityBtn');
    const tabWorkflow = document.getElementById('tabWorkflowBtn');
    const tabTerminal = document.getElementById('tabTerminalBtn');
    const clearBtn = document.getElementById('clearActivityBtn');
    const title = document.getElementById('activityTitle');

    [tabActivity, tabWorkflow, tabTerminal].forEach(b => { if (b) b.classList.remove('active'); });
    if (activityList) activityList.style.display = 'none';
    if (workflowView) workflowView.classList.remove('active');
    if (terminalView) terminalView.classList.remove('active');

    if (tab === 'workflow') {
        if (workflowView) workflowView.classList.add('active');
        if (tabWorkflow) tabWorkflow.classList.add('active');
        if (clearBtn) clearBtn.style.display = 'none';
        if (title) title.textContent = '🔄 Pipeline';
    } else if (tab === 'terminal') {
        if (terminalView) terminalView.classList.add('active');
        if (tabTerminal) tabTerminal.classList.add('active');
        if (clearBtn) clearBtn.style.display = 'none';
        if (title) title.textContent = '💻 Terminal da IA';
    } else {
        if (activityList) activityList.style.display = '';
        if (tabActivity) tabActivity.classList.add('active');
        if (clearBtn) clearBtn.style.display = '';
        if (title) title.textContent = '⚙️ Atividade da IA';
    }
}

let pipelineState = null;
const PIPELINE_STAGES = [
    { id: 'analyze', icon: '🔍', label: 'Analisando projeto', ok: 'Análise concluída' },
    { id: 'plan', icon: '📋', label: 'Gerando plano', ok: 'Plano pronto' },
    { id: 'execute', icon: '🔧', label: 'Executando alterações', ok: 'Alterações aplicadas' },
    { id: 'test', icon: '🧪', label: 'Executando testes', ok: 'Testes concluídos' },
    { id: 'commit', icon: '📦', label: 'Commit automático', ok: 'Commit realizado' },
    { id: 'done', icon: '✅', label: 'Concluído', ok: 'Tarefa finalizada' }
];

function initPipeline() {
    pipelineState = PIPELINE_STAGES.map(s => ({ ...s, status: 'pending', detail: '' }));
    renderPipeline();
}

function updatePipeline(stageId, status, detail) {
    if (!pipelineState) initPipeline();
    const stage = pipelineState.find(s => s.id === stageId);
    if (!stage) return;
    stage.status = status;
    if (detail) stage.detail = detail;
    if (status === 'active') {
        for (const s of pipelineState) {
            if (s.id !== stageId && s.status === 'active') s.status = 'done';
        }
    }
    renderPipeline();
}

function renderPipeline() {
    const el = document.getElementById('wfPipeline');
    if (!el) return;
    if (!pipelineState) { el.innerHTML = '<div style="padding:16px;color:#484f58;text-align:center;font-size:12px;">Envie um comando no chat para ver o pipeline</div>'; return; }
    let html = '';
    for (const s of pipelineState) {
        const cls = s.status === 'active' ? 'active' : s.status === 'done' ? 'done' : s.status === 'error' ? 'error' : '';
        const icon = s.status === 'done' ? '✅' : s.status === 'error' ? '❌' : s.status === 'active' ? s.icon : '○';
        html += `<div class="wf-stage ${cls}"><span class="wf-stage-icon">${icon}</span><span class="wf-stage-label">${s.label}</span>${s.detail ? '<span class="wf-stage-detail">' + s.detail + '</span>' : ''}</div>`;
    }
    el.innerHTML = html;
}

function clearPipeline() {
    pipelineState = null;
    renderPipeline();
}

let terminalLines = [];
let terminalBlockStart = 0;
let terminalToolStarts = {};

function terminalAdd(type, text, meta) {
    if (!meta) meta = {};
    const now = Date.now();
    const line = { type, text, time: now, icon: meta.icon || '', detail: meta.detail || '', id: meta.id || '' };
    if (type === 'tool') line.icon = meta.icon || '🔧';
    if (type === 'thought') line.icon = '💭';
    if (type === 'output') line.icon = '';
    if (type === 'error') line.icon = '❌';
    if (type === 'block-start') { line.icon = '▣'; terminalBlockStart = now; }
    if (type === 'block-end') line.icon = '▣';
    terminalLines.push(line);
    renderTerminal();
}

function terminalFinishTool(id, status) {
    var line = null;
    for (var i = terminalLines.length - 1; i >= 0; i--) {
        if (terminalLines[i].id === id) { line = terminalLines[i]; break; }
    }
    if (line) {
        line.type = status === 'error' ? 'error' : 'tool';
        if (status === 'error') line.icon = '❌';
    }
    renderTerminal();
}

function renderTerminal() {
    var el = document.getElementById('terminalOutput');
    if (!el) return;
    if (terminalLines.length === 0) {
        el.innerHTML = '<div class="term-empty">💻 Terminal da IA — envie um comando no chat<br><span style="font-size:10px;">O trabalho da IA aparece aqui em tempo real</span></div>';
        return;
    }
    var html = '';
    for (var i = 0; i < terminalLines.length; i++) {
        var l = terminalLines[i];
        var cls = l.type === 'thought' ? 'thought' : l.type === 'tool' ? 'tool' : l.type === 'output' ? 'output' : l.type === 'error' ? 'error' : l.type === 'block-start' ? 'block-start' : l.type === 'block-end' ? 'block-end' : '';
        var timeStr = '';
        if (l.time && i > 0) {
            var prev = terminalLines[i - 1];
            var diff = l.time - prev.time;
            if (diff > 50) timeStr = diff < 1000 ? Math.round(diff) + 'ms' : (diff / 1000).toFixed(1) + 's';
            else if (diff < -1000) timeStr = '';
        }
        var hasDetail = l.detail && l.detail.length > 0;
        var detailAttr = hasDetail ? ' onclick="this.classList.toggle(\'expanded\')" style="cursor:pointer;"' : '';
        html += '<div class="term-line ' + cls + '"' + detailAttr + '>';
        if (l.icon) html += '<span class="term-icon">' + l.icon + '</span>';
        html += '<span class="term-body">' + (l.text || '') + '</span>';
        if (timeStr) html += '<span class="term-time">' + timeStr + '</span>';
        html += '</div>';
        if (hasDetail) html += '<div class="term-detail">' + l.detail + '</div>';
    }
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
}

function clearTerminal() {
    terminalLines = [];
    terminalBlockStart = 0;
    terminalToolStarts = {};
    renderTerminal();
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
    initPipeline();
    updatePipeline('analyze', 'active');
    clearTerminal();
    terminalAdd('block-start', label);
    upsertActivity('task', { kind: 'task', icon: '🧠', label: 'Processando: ' + (label || ''), status: 'running', error: '' });
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
    let panel;
    if (targetClass === 'sidebarPanel') {
        panel = document.querySelector('.sidebar-panel.active');
    } else {
        panel = document.querySelector('.' + targetClass);
    }
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
            <div class="msg-content">${renderChatContent(content)}</div>
            <div style="text-align:right;margin-top:4px;"><button class="msg-copy-btn" title="Copiar" onclick="copyMsgContent(this)">📋 Copiar</button></div>
        `;
    } else {
        div.innerHTML = `<div class="msg-content">${renderChatContent(content)}</div><div style="text-align:right;margin-top:4px;"><button class="msg-copy-btn" title="Copiar" onclick="copyMsgContent(this)">📋 Copiar</button></div>`;
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
        contentDiv.innerHTML = renderChatContent(content);
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

    // Load existing keys from backend (mostra placeholder, não o valor)
    apiFetch('/api/config/get').then(function(r) { return r.json(); }).then(function(data) {
        if (data.success) {
            if (data.gemini) document.getElementById('geminiKeyInput').placeholder = '••• (já configurada)';
            if (data.deepseek) document.getElementById('deepseekKeyInput').placeholder = '••• (já configurada)';
            if (data.opencode) document.getElementById('opencodeKeyInput').placeholder = '••• (já configurada)';
            if (data.openai) document.getElementById('openaiKeyInput').placeholder = '••• (já configurada)';
            if (data.claude) document.getElementById('claudeKeyInput').placeholder = '••• (já configurada)';
            document.getElementById('configAutoCommit').checked = data.autoCommit !== false;
        }
    }).catch(function() {});

    // Limpa os valores (nunca expõe a chave real)
    document.getElementById('geminiKeyInput').value = '';
    document.getElementById('deepseekKeyInput').value = '';
    document.getElementById('opencodeKeyInput').value = '';
    document.getElementById('openaiKeyInput').value = '';
    document.getElementById('claudeKeyInput').value = '';

    try {
        document.getElementById('configFontSize').value = localStorage.getItem('editor_fontSize') || '13';
        document.getElementById('configTabSize').value = localStorage.getItem('editor_tabSize') || '4';
        document.getElementById('configWordWrap').checked = localStorage.getItem('editor_wordWrap') === '1';
        document.getElementById('configMinimap').checked = localStorage.getItem('editor_minimap') !== '0';
        document.getElementById('configFormatOnSave').checked = localStorage.getItem('formatOnSave') === '1';
        document.getElementById('configAutoSave').checked = localStorage.getItem('autoSave') === '1';
    } catch(e) {}

    document.querySelectorAll('.config-tab').forEach(btn => btn.classList.remove('active'));
    document.querySelector('.config-tab[data-tab="api"]').classList.add('active');
    document.getElementById('configPanelApi').style.display = 'block';
    document.getElementById('configPanelEditor').style.display = 'none';
    document.getElementById('configPanelGeral').style.display = 'none';

    document.querySelectorAll('.config-tab').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('.config-tab').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            document.getElementById('configPanelApi').style.display = tab === 'api' ? 'block' : 'none';
            document.getElementById('configPanelEditor').style.display = tab === 'editor' ? 'block' : 'none';
            document.getElementById('configPanelGeral').style.display = tab === 'geral' ? 'block' : 'none';
        };
    });
}

function closeConfigModal() {
    document.getElementById('configModal').style.display = 'none';
}

async function saveConfig() {
    const geminiKey = document.getElementById('geminiKeyInput').value.trim();
    const deepseekKey = document.getElementById('deepseekKeyInput').value.trim();
    const opencodeKey = document.getElementById('opencodeKeyInput').value.trim();
    const openaiKey = document.getElementById('openaiKeyInput').value.trim();
    const claudeKey = document.getElementById('claudeKeyInput').value.trim();

    const fontSize = document.getElementById('configFontSize').value;
    const tabSize = document.getElementById('configTabSize').value;
    const wordWrap = document.getElementById('configWordWrap').checked;

    try {
        localStorage.setItem('editor_fontSize', fontSize);
        localStorage.setItem('editor_tabSize', tabSize);
        localStorage.setItem('editor_wordWrap', wordWrap ? '1' : '0');
        localStorage.setItem('editor_minimap', document.getElementById('configMinimap').checked ? '1' : '0');
        localStorage.setItem('formatOnSave', document.getElementById('configFormatOnSave').checked ? '1' : '0');
        localStorage.setItem('autoSave', document.getElementById('configAutoSave').checked ? '1' : '0');
    } catch(e) {}

    if (monacoEditor) {
        monacoEditor.updateOptions({
            fontSize: parseInt(fontSize) || 13,
            tabSize: parseInt(tabSize) || 4,
            wordWrap: wordWrap ? 'on' : 'off',
            minimap: { enabled: document.getElementById('configMinimap').checked }
        });
    }

    if (!geminiKey && !deepseekKey && !opencodeKey) {
        showConfigStatus('✅ Configurações salvas!', 'success');
        setTimeout(closeConfigModal, 1500);
        return;
    }

    try {
        const res = await apiFetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ geminiKey, deepseekKey, opencodeKey, openaiKey, claudeKey, autoCommit: document.getElementById('configAutoCommit').checked })
        });
        const data = await res.json();
        if (data.success) {
            showConfigStatus('✅ Chaves e configurações salvas!', 'success');
            checkConfigStatus();
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
//  SNAPSHOTS ROTULADOS (versões da pasta)
// =============================================
async function openSnapshotModal() {
    if (!currentProjectPath) {
        showToast('📁 Selecione uma pasta primeiro!');
        return;
    }
    const modal = document.getElementById('snapshotModal');
    modal.style.display = 'flex';
    document.getElementById('snapshotNameInput').value = '';
    await loadSnapshots();

    const createBtn = document.getElementById('snapshotCreateBtn');
    createBtn.onclick = async () => {
        const nameInput = document.getElementById('snapshotNameInput');
        const name = nameInput.value.trim();
        if (!name) { showToast('📝 Dê um nome ao snapshot'); return; }
        createBtn.disabled = true;
        try {
            const res = await apiFetch('/api/snapshot/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await res.json();
            if (data.success) {
                showToast('✅ ' + data.message);
                nameInput.value = '';
                await loadSnapshots();
            } else {
                showToast('❌ ' + (data.error || 'Falha ao criar'));
            }
        } catch (e) {
            showToast('❌ ' + e.message);
        } finally {
            createBtn.disabled = false;
        }
    };
}

async function loadSnapshots() {
    const list = document.getElementById('snapshotList');
    list.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">⏳ Carregando snapshots...</div>';
    try {
        const res = await apiFetch('/api/snapshot/list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        const data = await res.json();
        const snapshots = data.success ? data.snapshots : [];
        list.innerHTML = '';
        if (snapshots.length === 0) {
            list.innerHTML = '<div style="padding:20px;text-align:center;color:#8b949e;">📸 Nenhum snapshot ainda.<br><span style="font-size:11px;color:#484f58;">Dê um nome acima e clique em "Criar".</span></div>';
            return;
        }
        for (const s of snapshots) {
            const card = await snapshotCard(s);
            list.appendChild(card);
        }
    } catch (e) {
        list.innerHTML = `<div style="padding:20px;text-align:center;color:#f85149;">❌ ${escapeHtml(e.message)}</div>`;
    }
}

async function snapshotCard(s) {
    const card = document.createElement('div');
    card.className = 'snapshot-card';
    const date = s.createdAt ? new Date(s.createdAt).toLocaleString('pt-BR') : '';
    const note = s.note ? `<div class="snapshot-card-note">${escapeHtml(s.note)}</div>` : '';
    card.innerHTML = `
        <div class="snapshot-card-info">
            <div class="snapshot-card-name">📸 ${escapeHtml(s.name)}</div>
            ${note}
            <div class="snapshot-card-meta">${date} · ${s.files} arquivos</div>
        </div>
        <div class="snapshot-card-actions">
            <button class="snapshot-mini-btn" data-act="diff">🔍 Diff</button>
            <button class="snapshot-mini-btn" data-act="restore">↩️ Restaurar</button>
        </div>
    `;
    card.querySelector('[data-act="diff"]').addEventListener('click', () => snapshotDiff(s.name));
    card.querySelector('[data-act="restore"]').addEventListener('click', () => snapshotRestore(s.name));
    return card;
}

async function snapshotDiff(name) {
    try {
        const res = await apiFetch('/api/snapshot/diff', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (!data.success) { showToast('❌ ' + (data.error || 'Falha no diff')); return; }
        const c = data.changes || {};
        const mods = c.modified || [], created = c.created || [], deleted = c.deleted || [];
        const parts = [];
        if (mods.length) parts.push(`✏️ Modificados: ${mods.length}`);
        if (created.length) parts.push(`🆕 Criados: ${created.length}`);
        if (deleted.length) parts.push(`🗑️ Deletados: ${deleted.length}`);
        parts.push(`✅ Inalterados: ${c.unchanged || 0}`);
        const sample = ['modificado', 'criado', 'deletado'].find(k => c[k] && c[k].length);
        let detail = '';
        if (sample && c[sample] && c[sample].length) {
            detail = '\n\n' + c[sample].slice(0, 8).map(f => '· ' + f).join('\n');
        }
        showToast(`📸 "${data.name || name}": ` + parts.join(' · ') + detail);
    } catch (e) {
        showToast('❌ ' + e.message);
    }
}

async function snapshotRestore(name) {
    if (!confirm(`Restaurar o snapshot "${name}"? Os arquivos voltarão ao estado salvo.`)) return;
    try {
        const res = await apiFetch('/api/snapshot/restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ ' + data.message);
        } else {
            showToast('❌ ' + (data.error || 'Falha ao restaurar'));
        }
    } catch (e) {
        showToast('❌ ' + e.message);
    }
}

function closeSnapshotModal() {
    document.getElementById('snapshotModal').style.display = 'none';
}

// =============================================
//  TOGGLE OPEncode
// =============================================
// =============================================
//  MODEL OPTIONS POR PROVIDER
// =============================================
var PROVIDER_MODELS = {
    gemini: [
        { value: 'gemini-3.5', label: 'Gemini 3.5 Flash' },
        { value: 'gemini-3.1', label: 'Gemini 3.1 Pro' },
        { value: 'gemini-3-flash', label: 'Gemini 3 Flash' },
        { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' }
    ],
    deepseek: [
        { value: 'deepseek-v3', label: 'DeepSeek V3' },
        { value: 'deepseek-r1', label: 'DeepSeek R1' }
    ],
    openai: [
        { value: 'gpt-4o', label: 'GPT-4o' },
        { value: 'gpt-4.1', label: 'GPT-4.1' },
        { value: 'gpt-5', label: 'GPT-5' },
        { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }
    ],
    claude: [
        { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
        { value: 'claude-opus-5', label: 'Claude Opus 5' },
        { value: 'claude-fable-5', label: 'Claude Fable 5' },
        { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
    ],
    opencode: [] // Populado dinamicamente
};

function updateModelOptions(provider) {
    var select = document.getElementById('modelSelect');
    select.innerHTML = '';
    var models = PROVIDER_MODELS[provider] || [];
    if (provider === 'opencode') {
        var ocGroup = document.getElementById('ocFreeGroup');
        if (ocGroup && ocGroup.children.length) {
            for (var i = 0; i < ocGroup.children.length; i++) {
                var opt = ocGroup.children[i];
                select.appendChild(new Option(opt.textContent, opt.value));
            }
            var goGroup = document.getElementById('ocGoGroup');
            if (goGroup && goGroup.children.length) {
                for (var j = 0; j < goGroup.children.length; j++) {
                    select.appendChild(new Option(goGroup.children[j].textContent, goGroup.children[j].value));
                }
            }
        } else if (PROVIDER_MODELS.opencode && PROVIDER_MODELS.opencode.length) {
            for (var k2 = 0; k2 < PROVIDER_MODELS.opencode.length; k2++) {
                var m = PROVIDER_MODELS.opencode[k2];
                select.appendChild(new Option(m.label, m.value));
            }
        } else {
            select.appendChild(new Option('Carregando modelos...', 'opencode'));
            loadOpenCodeModels().then(function() {
                if (document.getElementById('providerSelect').value === 'opencode') {
                    updateModelOptions('opencode');
                }
            });
            return;
        }
    } else {
        for (var k = 0; k < models.length; k++) {
            select.appendChild(new Option(models[k].label, models[k].value));
        }
    }
    // Força seleção do primeiro modelo
    if (select.options.length) select.selectedIndex = 0;
}

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
    var wrap = document.getElementById('ocToggleWrap');
    var select = document.getElementById('modelSelect');
    if (wrap) wrap.classList.toggle('off', !enabled);

    var ocOpts = select.querySelectorAll('option[value^="opencode/"]');
    for (var i = 0; i < ocOpts.length; i++) {
        ocOpts[i].disabled = !enabled;
    }
    var ocGroups = select.querySelectorAll('#ocFreeGroup, #ocGoGroup');
    for (var j = 0; j < ocGroups.length; j++) {
        ocGroups[j].disabled = !enabled;
        ocGroups[j].style.opacity = enabled ? '1' : '0.5';
    }

    // Keep the static "opencode" option always enabled as fallback
    var staticOc = select.querySelector('option[value="opencode"]:not([value="opencode/"])');
    if (staticOc) staticOc.disabled = false;

    if (!enabled && select.value.startsWith('opencode/')) {
        select.value = 'opencode';
        currentModel = 'opencode';
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
    const newTheme = isLight ? 'dark' : 'light';
    applyTheme(newTheme);
    try { localStorage.setItem(THEME_KEY, newTheme); } catch (e) {}
    if (monacoEditor) monaco.editor.setTheme(newTheme === 'light' ? 'vs' : 'vs-dark');
    showToast(isLight ? '🌙 Tema escuro' : '☀️ Tema claro');
}

// =============================================
//  GIT BLAME
// =============================================
async function showGitBlame() {
    if (!activeTabPath) { showToast('Abra um arquivo primeiro'); return; }
    if (!currentProjectPath) { showToast('📁 Selecione um projeto'); return; }
    const modal = document.getElementById('fileEditorModal');
    if (!modal) return;
    let panel = document.getElementById('blamePanel');
    if (panel && panel.classList.contains('visible')) {
        panel.classList.remove('visible'); return;
    }
    if (!panel) {
        panel = document.createElement('div'); panel.className = 'blame-panel visible'; panel.id = 'blamePanel';
        const editorWrap = modal.querySelector('.editor-image-wrap');
        editorWrap.parentNode.insertBefore(panel, editorWrap.nextSibling);
    } else { panel.classList.add('visible'); }
    panel.innerHTML = '<div style="padding:8px;color:#8b949e;">⏳ Carregando git blame...</div>';
    try {
        const res = await apiFetch('/api/git/blame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: activeTabPath }) });
        const data = await res.json();
        panel.innerHTML = '';
        if (!data.success || !data.lines || !data.lines.length) { panel.innerHTML = '<div style="padding:8px;color:#8b949e;">⚠️ Sem informações de blame — precisa ser um repositório git</div>'; return; }
        for (const l of data.lines) {
            const item = document.createElement('div'); item.className = 'blame-item';
            item.title = `Commit: ${l.hash}\nAutor: ${l.author}\nData: ${l.date}`;
            item.innerHTML = `<span class="blame-line">${l.line}</span><span class="blame-hash">${(l.hash||'').substring(0,8)}</span><span class="blame-author">${escapeHtml(l.author)}</span><span class="blame-date">${escapeHtml(l.date)}</span><span class="blame-content">${escapeHtml(l.content)}</span>`;
            panel.appendChild(item);
        }
    } catch (e) { panel.innerHTML = '<div style="padding:8px;color:#f85149;">❌ ' + escapeHtml(e.message) + '</div>'; }
}

// =============================================
//  MARKDOWN PREVIEW + CHAT
// =============================================
function renderChatContent(text) {
    if (!text) return '';
    if (!text.includes('```') && !text.includes('**') && !text.includes('#') && !text.includes('- '))
        return escapeHtml(text).replace(/\n/g, '<br>');
    let html = '';
    const parts = text.split(/(```[\s\S]*?```)/g);
    for (const part of parts) {
        if (part.startsWith('```')) {
            const code = part.replace(/```\w*\n?/, '').replace(/```$/, '');
            html += '<pre><code>' + escapeHtml(code) + '</code></pre>';
        } else {
            let p = escapeHtml(part);
            p = p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            p = p.replace(/\*(.+?)\*/g, '<em>$1</em>');
            p = p.replace(/`([^`]+)`/g, '<code>$1</code>');
            p = p.replace(/^### (.+)$/gm, '<h4>$1</h4>');
            p = p.replace(/^## (.+)$/gm, '<h3>$1</h3>');
            p = p.replace(/^# (.+)$/gm, '<h2>$1</h2>');
            p = p.replace(/^- (.+)$/gm, '<li>$1</li>');
            p = p.replace(/\n/g, '<br>');
            html += p;
        }
    }
    return html;
}

let mdPreviewVisible = false, mdPreviewPanel = null;

function toggleMarkdownPreview() {
    if (!activeTabPath) { showToast('Abra um arquivo primeiro'); return; }
    const modal = document.getElementById('fileEditorModal');
    if (!modal) return;
    if (!mdPreviewPanel) {
        mdPreviewPanel = document.createElement('div');
        mdPreviewPanel.className = 'markdown-preview-panel';
        mdPreviewPanel.id = 'markdownPreviewPanel';
        const actions = modal.querySelector('.modal-actions');
        actions.parentNode.insertBefore(mdPreviewPanel, actions);
    }
    mdPreviewVisible = !mdPreviewVisible;
    if (mdPreviewVisible) {
        mdPreviewPanel.classList.add('visible');
        const content = getEditorContent();
        loadMarked().then(() => {
            if (typeof marked !== 'undefined') { marked.setOptions({ breaks: true, gfm: true }); mdPreviewPanel.innerHTML = marked.parse(content || 'Arquivo vazio'); }
            else mdPreviewPanel.innerHTML = '<pre>' + escapeHtml(content) + '</pre>';
        });
    } else { mdPreviewPanel.classList.remove('visible'); }
}

function loadMarked() {
    return new Promise((resolve) => {
        if (typeof marked !== 'undefined') return resolve(marked);
        const s = document.createElement('script');
        s.src = 'node_modules/marked/marked.min.js';
        s.onload = () => resolve(typeof marked !== 'undefined' ? marked : null);
        s.onerror = () => resolve(null);
        document.head.appendChild(s);
    });
}

// =============================================
//  STATUS BAR
// =============================================
function initStatusBar() {
    const footer = document.querySelector('.footer');
    if (!footer) return;
    footer.innerHTML = `
        <span id="appVersion">Aedificator Codex IDE v1.1.0</span>
        <span class="footer-sep">|</span>
        <span id="cursorPos">Ln 1, Col 1</span>
        <span class="footer-sep">|</span>
        <span id="editorLang">Plain Text</span>
        <span class="footer-sep">|</span>
        <span>UTF-8</span>
        <span style="flex:1;"></span>
        <button class="btn-toolbar" id="footerBlameBtn" title="Git Blame" style="font-size:10px;padding:2px 8px;">👤</button>
        <span class="footer-sep">|</span>
        <span id="backendStatus" class="status-offline">🔴 Desconectado</span>`;
    document.getElementById('footerBlameBtn').addEventListener('click', showGitBlame);
}

// =============================================
//  DIFF EDITOR (texto)
// =============================================
async function gitShowDiff() {
    document.getElementById('diffModal').style.display = 'flex';
    document.getElementById('diffEditorTitle').textContent = '📊 Git Diff';
    const out = document.getElementById('diffOutput');
    out.textContent = '⏳ Carregando...';
    try {
        const res = await apiFetch('/api/git/diff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        const parts = [];
        if (data.stat && data.stat.trim()) parts.push('📊 ' + data.stat.trim());
        if (data.output && data.output.trim()) parts.push('── Não staged ──\n' + data.output);
        if (data.staged && data.staged.trim()) parts.push('── Staged ──\n' + data.staged);
        const diffText = parts.length ? parts.join('\n\n') : '✅ Nenhuma alteração.';

        out.textContent = diffText;
        if (monacoReady && data.output && data.output.trim()) {
            const orig = data.output.split('\n').filter(l => l.startsWith('-')).map(l => l.substring(1)).join('\n');
            const mod = data.output.split('\n').filter(l => l.startsWith('+')).map(l => l.substring(1)).join('\n');
            document.getElementById('diffOutput').insertAdjacentHTML('afterend',
                '<div style="margin-top:8px;"><button class="btn-toolbar" id="diffSideBtn" style="font-size:11px;">↔️ Ver lado a lado</button></div>');
            document.getElementById('diffSideBtn').addEventListener('click', () => {
                gitShowDiffSideBySide(orig || '', mod || '', 'Git Diff');
            });
        }
    } catch (e) { out.textContent = '❌ ' + e.message; }
}

function closeDiffModal() { document.getElementById('diffModal').style.display = 'none'; }

// =============================================
//  TEST RUNNER
// =============================================
let testCmdSaved = 'node --test';
function openTestRunner() { if (!currentProjectPath) { showToast('📁 Selecione um projeto'); return; } document.getElementById('testRunnerModal').style.display='flex'; loadTestCmd(); }
function closeTestRunner() { document.getElementById('testRunnerModal').style.display='none'; }
async function discoverTests() {
    const el = document.getElementById('testDiscovered');
    el.innerHTML = '⏳ Buscando...';
    try {
        const res = await apiFetch('/api/test/discover', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
        const data = await res.json();
        if (!data.tests || !data.tests.length) { el.innerHTML = '⚠️ Nenhum teste encontrado'; return; }
        el.innerHTML = data.tests.slice(0, 20).map((t, i) => {
            const name = t.split('/').pop();
            return `<div style="cursor:pointer;padding:1px 4px;" onclick="openFile('${escapeHtml(t)}')" title="${escapeHtml(t)}">📄 ${i+1}. ${escapeHtml(name)}</div>`;
        }).join('');
        document.getElementById('testCmdInput').value = 'node --test ' + data.tests.slice(0, 5).map(t => '"' + t + '"').join(' ');
        if (data.tests.length > 20) el.innerHTML += `<div style="color:#8b949e;">... +${data.tests.length - 20} mais</div>`;
    } catch (e) { el.innerHTML = '❌ ' + escapeHtml(e.message); }
}
function loadTestCmd() { try { testCmdSaved = localStorage.getItem('aedificator_test_command')||'node --test'; } catch(e){} document.getElementById('testCmdInput').value=testCmdSaved; document.getElementById('testOutput').textContent='— saída —'; document.getElementById('testSummary').innerHTML=''; document.getElementById('testSummary').className='test-summary'; document.getElementById('testResultList').innerHTML=''; document.getElementById('testDiscovered').innerHTML=''; }
async function runTests() {
    const cmd = document.getElementById('testCmdInput').value.trim()||'node --test';
    const summary=document.getElementById('testSummary'), output=document.getElementById('testOutput'), list=document.getElementById('testResultList');
    summary.innerHTML='⏳ Executando...'; summary.className='test-summary running';
    output.textContent='⏳ '+cmd+'\n'; list.innerHTML=''; document.getElementById('testRunBtn').disabled=true;
    try {
        const res = await apiFetch('/api/test/run', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({command:cmd}) });
        const data=await res.json(); output.textContent=data.output||'(sem saída)';
        const r=data.results||{total:0,pass:0,fail:0,details:[],suites:[]};
        summary.innerHTML=r.total===0?'⚠️ Nenhum teste':r.fail===0?('✅ '+r.pass+' passaram'):('❌ '+r.pass+' ok, '+r.fail+' falhas');
        summary.className='test-summary '+(r.fail>0?'failure':r.total>0?'success':'running');
        list.innerHTML='';
        for (const d of (r.details||[])) {
            const item=document.createElement('div'); item.className='test-detail-item '+d.status;
            item.innerHTML=`<span>${d.status==='pass'?'✅':'❌'}</span><span class="test-detail-name">${escapeHtml(d.name)}</span><span class="test-detail-duration">${d.duration?d.duration+'ms':''}</span>`;
            if(d.status==='fail'&&d.file){ item.style.cursor='pointer'; item.addEventListener('click',()=>{ openFile(d.file); }); }
            list.appendChild(item);
            if(d.error){ const ed=document.createElement('div'); ed.className='test-error-block'; ed.textContent=d.error.trim(); list.appendChild(ed); }
        }
    } catch(e) { summary.innerHTML='❌ '+e.message; summary.className='test-summary failure'; }
    document.getElementById('testRunBtn').disabled=false;
}
function saveTestCmd() { const cmd=document.getElementById('testCmdInput').value.trim(); if(!cmd)return; testCmdSaved=cmd; try{localStorage.setItem('aedificator_test_command',cmd);}catch(e){} showToast('✅ Salvo'); }

// =============================================
//  ANALYZER
// =============================================
async function analyzeCurrentFile() {
    if (!activeTabPath) { showToast('Abra um arquivo'); return; }
    const code = getEditorContent();
    if (!code.trim()) { showToast('Arquivo vazio'); return; }
    showAnalyzerModal('⏳ Analisando...', []);
    try {
        const res = await apiFetch('/api/analyzer/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code, file:activeTabPath}) });
        const data = await res.json();
        const status = data.valid ? '✅ Código válido!' : ('⚠️ '+data.errors.length+' problemas (confiança: '+(data.suggestionCount||0)+'%)');
        showAnalyzerModal(status, data.errors||[], data.fixes||[]);
    } catch(e) { showAnalyzerModal('❌ '+e.message, []); }
}
function showAnalyzerModal(status, errors, fixes) {
    const ex=document.getElementById('analyzerDetail'); if(ex)ex.remove();
    const modal=document.createElement('div'); modal.id='analyzerDetail';
    modal.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:5000;';
    modal.addEventListener('click',(e)=>{if(e.target===modal)modal.remove();});
    let html=`<div class="modal-content" style="max-width:650px;max-height:80vh;overflow:auto;"><h2>🔍 Analisador</h2><div style="margin:8px 0;font-size:14px;font-weight:600;">${status}</div>`;
    if(fixes&&fixes.length){ html+='<div style="margin:8px 0;padding:8px 12px;background:#1f6feb22;border:1px solid #1f6feb44;border-radius:4px;font-size:12px;"><strong>💡 Sugestões:</strong><br>'; for(const f of fixes)html+='• '+escapeHtml(f)+'<br>'; html+='</div>'; }
    if(errors.length>0){ html+='<div style="max-height:400px;overflow:auto;margin-top:8px;">'; for(const err of errors){ const c=err.severity==='error'?'#f85149':'#d29922'; html+=`<div style="padding:4px 8px;margin:2px 0;background:#161b22;border-left:3px solid ${c};font-size:12px;font-family:Consolas,monospace;"><span style="color:#58a6ff;">Ln ${err.line}</span><span style="margin-left:8px;">${escapeHtml(err.message)}</span></div>`; } html+='</div>'; }
    html+='<div class="modal-actions" style="margin-top:12px;"><button onclick="this.closest(\'#analyzerDetail\').remove()">❌ Fechar</button></div></div>';
    modal.innerHTML=html; document.body.appendChild(modal);
}

// =============================================
//  DRAG & DROP
// =============================================
function initExplorerDragDrop() {
    const explorer = document.getElementById('explorerBody'); if (!explorer) return;
    explorer.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); explorer.classList.add('drag-over'); });
    explorer.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); explorer.classList.remove('drag-over'); });
    explorer.addEventListener('drop', async (e) => {
        e.preventDefault(); e.stopPropagation(); explorer.classList.remove('drag-over');
        if (!currentProjectPath) { showToast('📁 Selecione um projeto'); return; }
        const files = e.dataTransfer.files; if (!files||!files.length) return;
        for (const file of files) {
            try {
                const reader = new FileReader();
                const content = await new Promise((resolve, reject) => { reader.onload=()=>resolve(reader.result.split(',')[1]); reader.onerror=reject; reader.readAsDataURL(file); });
                await apiFetch('/api/file/upload', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:file.name,content,encoding:'base64',targetDir:currentProjectPath}) });
            } catch(err) {}
        }
        showToast('📥 Arquivos importados'); loadFolderStructure(currentProjectPath);
    });
    const style = document.createElement('style');
    style.textContent = '.explorer-body.drag-over{background:#1f6feb11;border:2px dashed #58a6ff!important;border-radius:6px;}body.theme-light .explorer-body.drag-over{background:#ddf4ff;border-color:#0969da!important;}';
    document.head.appendChild(style);
}

// =============================================
//  LIVE PREVIEW + AGENTS.md + REFINAMENTO
// =============================================
function toggleLivePreview() {
    const panel = document.getElementById('browserPanel');
    if (!panel) return;
    if (panel.classList.contains('show')) { closeBrowser(); }
    else { openBrowserPanel('index.html'); }
}
window._toggleLivePreview = toggleLivePreview;

function openBrowserPanel(filePath) {
    const panel = document.getElementById('browserPanel');
    if (!panel) return;
    panel.classList.remove('maximized');
    panel.style.removeProperty('display');
    panel.style.left = '';
    panel.style.top = '';
    panel.style.width = '';
    panel.style.height = '';
    const iframe = document.getElementById('browserIframe');
    const rel = filePath || 'index.html';
    if (iframe) iframe.src = BACKEND_URL + '/project/' + rel;
    document.getElementById('browserUrlInput').value = rel;
    panel.classList.add('show');
}

function closeBrowser() {
    const p = document.getElementById('browserPanel');
    if (!p) return;
    p.classList.remove('show', 'maximized');
    p.style.setProperty('display', 'none', 'important');
}

function browserMaximize() {
    const p = document.getElementById('browserPanel');
    if (!p) return;
    if (p.classList.contains('maximized')) {
        p.classList.remove('maximized');
        p.style.left = '';
        p.style.top = '';
        p.style.width = '';
        p.style.height = '';
    } else {
        p.classList.add('maximized');
    }
}

function browserNavigate() {
    const u = document.getElementById('browserUrlInput');
    const f = document.getElementById('browserIframe');
    if (!u || !f) return;
    let url = u.value.trim();
    if (!url) return;
    if (!url.includes('://')) url = BACKEND_URL + '/project/' + url;
    f.src = url;
    showToast('▶ Navegando: ' + url);
}

function browserRefresh() {
    const f = document.getElementById('browserIframe');
    if (f) { f.src = f.src; showToast('🔄 Atualizado'); }
}

function browserStartDrag(e) {
    if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
    const panel = document.getElementById('browserPanel');
    if (!panel || panel.classList.contains('maximized')) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const rect = panel.getBoundingClientRect();
    const sl = rect.left, st = rect.top;
    function mv(ev) {
        panel.style.left = Math.max(0, Math.min(window.innerWidth - 100, sl + ev.clientX - sx)) + 'px';
        panel.style.top = Math.max(0, Math.min(window.innerHeight - 60, st + ev.clientY - sy)) + 'px';
        panel.style.width = ''; panel.style.height = '';
    }
    function up() { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); }
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
}

function openInBrowser(filePath) {
    const rel = filePath.replace(/\\/g, '/').replace(currentProjectPath.replace(/\\/g, '/'), '').replace(/^\//, '');
    openBrowserPanel(rel);
}
const _origSaveFileEditor = saveFileEditor;
saveFileEditor = async function() {
    const result = await _origSaveFileEditor();
    if (result) {
        const panel = document.getElementById('browserPanel');
        if (panel && panel.classList.contains('show')) {
            const iframe = document.getElementById('browserIframe');
            if (iframe) iframe.src = iframe.src;
        }
    }
    return result;
};

function openRulesModal() {
    if (!currentProjectPath) { showToast('📁 Selecione um projeto'); return; }
    const existing = document.getElementById('rulesModal');
    if (existing) { existing.style.display = 'flex'; loadRules(); return; }
    const modal = document.createElement('div'); modal.id = 'rulesModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:5000;';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.innerHTML = `<div class="modal-content" style="width:650px;max-width:90vw;"><h2>📋 Regras do Projeto (.aedificator-agents.md)</h2><p class="modal-desc">Defina convenções de código. A IA seguirá estas regras.</p><textarea id="rulesEditor" style="width:100%;height:350px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:10px;font-family:Consolas,monospace;font-size:12px;resize:vertical;"></textarea><div class="modal-actions" style="margin-top:10px;"><button class="btn-save" id="rulesSaveBtn">💾 Salvar</button><button class="btn-close-modal" onclick="this.closest('#rulesModal').remove()">❌ Fechar</button></div></div>`;
    document.body.appendChild(modal);
    document.getElementById('rulesSaveBtn').addEventListener('click', saveRules);
    loadRules();
}
async function loadRules() {
    try { const res = await apiFetch('/api/project/rules'); const data=await res.json(); const e=document.getElementById('rulesEditor'); if(e)e.value=data.content||''; } catch(e){}
}
async function saveRules() {
    const content=document.getElementById('rulesEditor').value;
    try { await apiFetch('/api/project/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})}); showToast('✅ Regras salvas'); document.getElementById('rulesModal').remove(); } catch(e){showToast('❌ '+e.message);}
}

// Refinamento multi-turno + diagnostics tracking
const _origHandleWsMessage = handleWsMessage;
handleWsMessage = function(data) {
    if (data.type === 'diagnostics') {
        window._lastDiagnosticsErrors = data.errors || [];
        var btn = document.getElementById('fixErrorsBtn');
        if (btn) btn.style.display = data.errors && data.errors.length ? 'inline-block' : 'none';
    }
    if (data.type === 'done') {
        _origHandleWsMessage(data);
        return;
    }
    _origHandleWsMessage(data);
};

// Preview diff na aprovação
const _origShowApproval = showApprovalModal;
showApprovalModal = function(data) {
    const result = _origShowApproval(data);
    const hasSugestoes = data.sugestoes && Array.isArray(data.sugestoes) && data.sugestoes.length > 0;
    if (data.arquivos && data.arquivos.length > 0) {
        // Multi-file diff preview na aprovação
        var previewHtml = '';
        for (var i = 0; i < data.arquivos.length; i++) {
            var f = data.arquivos[i];
            if (f.conteudo) {
                var icon = f.acao === 'criar' ? '\uD83C\uDD95' : f.acao === 'deletar' ? '\uD83D\uDDD1\uFE0F' : '\u270F\uFE0F';
                previewHtml += '<div class="approval-preview-file" style="margin-top:8px;padding:4px 8px;background:#0d1117;border-radius:4px;cursor:pointer;font-family:Consolas,monospace;font-size:11px;" data-file="' + escapeHtml(f.caminho) + '" data-content="' + escapeHtml(f.conteudo || '') + '" data-acao="' + escapeHtml(f.acao || '') + '">' +
                    icon + ' <b>' + escapeHtml(f.caminho.split(/[\\/]/).pop()) + '</b> — ' + (f.acao || 'modificar') + ' — clique para preview</div>';
            }
        }
        if (previewHtml) {
            var resumoEl = document.getElementById('approvalResumo');
            var existingPreview = document.getElementById('approvalDiffPreview');
            if (existingPreview) existingPreview.remove();
            var div = document.createElement('div');
            div.id = 'approvalDiffPreview';
            div.innerHTML = previewHtml;
            resumoEl.parentNode.insertBefore(div, resumoEl.nextSibling);
            div.querySelectorAll('.approval-preview-file').forEach(function(el) {
                el.addEventListener('click', function() {
                    var filePath = el.dataset.file;
                    var content = el.dataset.content;
                    var acao = el.dataset.acao;
                    var fullPath = currentProjectPath ? currentProjectPath.replace(/\\/g, '/') + '/' + filePath.replace(/\\/g, '/') : filePath;
                    if (acao === 'criar') {
                        var modal = document.getElementById('diffModal');
                        modal.style.display = 'flex';
                        document.getElementById('diffEditorTitle').textContent = '\uD83D\uDCC4 Novo: ' + (filePath.split('/').pop() || filePath);
                        document.getElementById('diffOutput').textContent = content;
                    } else {
                        showDiffPreview(fullPath, content || '');
                    }
                });
            });
        }
    } else if (hasSugestoes) {
        const previewFiles = [];
        for (const s of data.sugestoes) {
            for (const a of (s.arquivos || [])) {
                if (a.conteudo) previewFiles.push({ ...a, sugestaoId: s.id, sugestaoTitulo: s.titulo });
            }
        }
        if (previewFiles.length > 0) {
            var previewHtml = '';
            for (const f of previewFiles) {
                var icon = f.acao === 'criar' ? '\uD83C\uDD95' : f.acao === 'deletar' ? '\uD83D\uDDD1\uFE0F' : '\u270F\uFE0F';
                previewHtml += '<div class="approval-preview-file" style="margin-top:8px;padding:4px 8px;background:#0d1117;border-radius:4px;cursor:pointer;font-family:Consolas,monospace;font-size:11px;" data-file="' + escapeHtml(f.caminho) + '" data-content="' + escapeHtml(f.conteudo || '') + '" data-acao="' + escapeHtml(f.acao || '') + '">' +
                    icon + ' <b>' + escapeHtml(f.caminho.split(/[\\/]/).pop()) + '</b> — ' + (f.acao || 'modificar') + ' [' + escapeHtml(f.sugestaoTitulo) + '] — clique para preview</div>';
            }
            var resumoEl = document.getElementById('approvalResumo');
            var existingPreview = document.getElementById('approvalDiffPreview');
            if (existingPreview) existingPreview.remove();
            var div = document.createElement('div');
            div.id = 'approvalDiffPreview';
            div.innerHTML = previewHtml;
            resumoEl.parentNode.insertBefore(div, resumoEl.nextSibling);
            div.querySelectorAll('.approval-preview-file').forEach(function(el) {
                el.addEventListener('click', function() {
                    var filePath = el.dataset.file;
                    var content = el.dataset.content;
                    var acao = el.dataset.acao;
                    var fullPath = currentProjectPath ? currentProjectPath.replace(/\\/g, '/') + '/' + filePath.replace(/\\/g, '/') : filePath;
                    if (acao === 'criar') {
                        var modal = document.getElementById('diffModal');
                        modal.style.display = 'flex';
                        document.getElementById('diffEditorTitle').textContent = '\uD83D\uDCC4 Novo: ' + (filePath.split('/').pop() || filePath);
                        document.getElementById('diffOutput').textContent = content;
                    } else {
                        showDiffPreview(fullPath, content || '');
                    }
                });
            });
        }
    }
    return result;
};
function showDiffPreview(filePath, newContent) {
    const modal = document.getElementById('diffModal');
    modal.style.display = 'flex';
    document.getElementById('diffEditorTitle').textContent = '📊 Preview: '+(filePath.split('/').pop()||filePath);
    const out = document.getElementById('diffOutput');
    apiFetch('/api/file/diff-preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:filePath,conteudo:newContent})})
        .then(r=>r.json()).then(data=>{
            const original = data.original||'';
            const lines = [];
            const oLines = original.split('\n'), mLines = (data.modified||newContent||'').split('\n');
            const max = Math.max(oLines.length, mLines.length);
            for (let i=0;i<max;i++) {
                const o = i<oLines.length?oLines[i]:'', m = i<mLines.length?mLines[i]:'';
                if (o===m) lines.push('  '+(i+1)+'| '+o);
                else { if(i<oLines.length) lines.push('- '+(i+1)+'| '+o); if(i<mLines.length) lines.push('+ '+(i+1)+'| '+m); }
            }
            out.textContent=lines.join('\n')||'Sem alterações';
        }).catch(e=>out.textContent='❌ '+e.message);
}

function showDiffModal(originalContent, modifiedContent, title) {
    const modal = document.getElementById('diffModal');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('diffEditorTitle').textContent = '📊 ' + (title || 'Diff');
    const out = document.getElementById('diffOutput');
    const lines = [];
    const oLines = (originalContent || '').split('\n');
    const mLines = (modifiedContent || '').split('\n');
    const max = Math.max(oLines.length, mLines.length);
    for (let i = 0; i < max; i++) {
        const o = i < oLines.length ? oLines[i] : '';
        const m = i < mLines.length ? mLines[i] : '';
        if (o === m) lines.push('  ' + (i + 1) + '| ' + o);
        else { if (i < oLines.length) lines.push('- ' + (i + 1) + '| ' + o); if (i < mLines.length) lines.push('+ ' + (i + 1) + '| ' + m); }
    }
    out.textContent = lines.join('\n') || 'Sem alterações';
}

// Botão regras no header
setTimeout(() => {
    const header = document.querySelector('.header .controls');
    if (header) {
        const btn = document.createElement('button'); btn.className='btn-theme'; btn.id='rulesBtn'; btn.title='Regras do projeto'; btn.textContent='📋';
        btn.addEventListener('click', openRulesModal);
        const themeBtn = document.getElementById('themeBtn');
        if (themeBtn && themeBtn.nextSibling) {
            header.insertBefore(btn, themeBtn.nextSibling);
        } else {
            header.appendChild(btn);
        }
    }
}, 400);

// =============================================
//  DIFF EDITOR — Comparar dois arquivos
// =============================================
function openDiffFileSelector() {
    const existing = document.getElementById('diffFileModal');
    if (existing) { existing.style.display = 'flex'; return; }
    const files = [];
    function collect(folderEl, prefix) {
        for (const child of Array.from(folderEl.children)) {
            if (child.dataset.path && !child.dataset.folder) {
                files.push({ name: (prefix + (prefix ? '/' : '') + child.dataset.name), path: child.dataset.path });
            }
            if (child.dataset.folder && child.querySelector('.sub-folder')) {
                collect(child.querySelector('.sub-folder'), prefix + (prefix ? '/' : '') + child.dataset.name);
            }
        }
    }
    const explorerBody = document.getElementById('explorerBody');
    if (explorerBody) collect(explorerBody, '');
    const options = files.map(f => `<option value="${f.path.replace(/"/g, '&quot;')}">${f.name}</option>`).join('');

    const modal = document.createElement('div');
    modal.id = 'diffFileModal';
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:3000;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    modal.innerHTML = `<div class="modal-content" style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:600px;width:90%;display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;"><h2 style="color:#e6edf3;margin:0;">📊 Comparar Arquivos (Diff)</h2><button class="btn-close-modal" onclick="document.getElementById('diffFileModal').remove()">❌ Fechar</button></div>
        <p class="modal-desc">Selecione dois arquivos do projeto para comparar lado a lado.</p>
        <label style="color:#c9d1d9;font-size:12px;">Arquivo original (esquerda):</label>
        <select id="diffOriginal" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:6px 10px;border-radius:6px;font-size:12px;max-height:200px;">${options}</select>
        <label style="color:#c9d1d9;font-size:12px;">Arquivo modificado (direita):</label>
        <select id="diffModified" style="background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:6px 10px;border-radius:6px;font-size:12px;max-height:200px;">${options}</select>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button class="btn-save" onclick="compareSelectedFiles()">🔍 Comparar</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
}

async function compareSelectedFiles() {
    const origEl = document.getElementById('diffOriginal');
    const modEl = document.getElementById('diffModified');
    if (!origEl || !modEl) return;
    const origPath = origEl.value;
    const modPath = modEl.value;
    if (!origPath || !modPath) { showToast('Selecione ambos os arquivos'); return; }
    try {
        const r1 = await apiFetch('/api/file/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: origPath }) });
        const d1 = await r1.json();
        const r2 = await apiFetch('/api/file/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: modPath }) });
        const d2 = await r2.json();
        showDiffModal(d1.content || '', d2.content || '', origPath.split('/').pop() + ' ↔ ' + modPath.split('/').pop());
    } catch (e) { showToast('❌ ' + e.message); }
}

// =============================================
//  BUSCA AVANÇADA EM ARQUIVOS
// =============================================
function openSearchInFiles() {
    const existing = document.getElementById('searchFilesModal');
    if (existing) { existing.style.display = 'flex'; return; }
    const modal = document.createElement('div');
    modal.id = 'searchFilesModal';
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:3000;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    modal.innerHTML = `<div class="modal-content" style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:750px;width:90%;max-height:85vh;display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;"><h2 style="color:#e6edf3;margin:0;">🔍 Busca Avançada em Arquivos</h2><button class="btn-close-modal" onclick="document.getElementById('searchFilesModal').remove()">❌ Fechar</button></div>
        <div style="display:flex;gap:8px;">
            <input id="searchFilesInput" type="text" placeholder="Termo de busca (regex suportado)" style="flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:6px 10px;border-radius:6px;font-size:12px;font-family:Consolas;" onkeydown="if(event.key==='Enter')runSearchInFiles()">
            <button class="btn-save" onclick="runSearchInFiles()">🔍 Buscar</button>
        </div>
        <div style="display:flex;gap:12px;font-size:11px;color:#8b949e;">
            <label><input type="checkbox" id="searchCaseSensitive"> Maiúsc./minúsc.</label>
            <label><input type="checkbox" id="searchRegex" checked> Regex</label>
            <label><input type="checkbox" id="searchInContent" checked> No conteúdo</label>
            <span id="searchStats" style="margin-left:auto;"></span>
        </div>
        <div id="searchFilesResults" style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;overflow-y:auto;padding:8px;font-size:11px;font-family:Consolas,monospace;color:#c9d1d9;min-height:200px;white-space:pre-wrap;"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
            <button class="btn-close-modal" onclick="applyReplaceInSearch()">🔄 Substituir...</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    setTimeout(() => document.getElementById('searchFilesInput').focus(), 100);
}

async function runSearchInFiles() {
    const q = document.getElementById('searchFilesInput').value;
    if (!q) return;
    const results = document.getElementById('searchFilesResults');
    const stats = document.getElementById('searchStats');
    results.textContent = '⏳ Buscando...';
    try {
        const res = await apiFetch('/api/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: q,
                inContent: document.getElementById('searchInContent').checked,
                caseSensitive: document.getElementById('searchCaseSensitive').checked,
                useRegex: document.getElementById('searchRegex').checked
            })
        });
        const data = await res.json();
        if (!data.success) { results.textContent = '❌ Erro na busca'; return; }
        const items = data.results || [];
        let out = '';
        let totalMatches = 0;
        for (const item of items) {
            out += `\n📄 ${item.path}${item.matches.length ? ' (' + item.matches.length + ' ocorrências)' : ''}\n`;
            for (const m of item.matches) {
                out += `   L${String(m.line).padStart(4)} │ ${m.text}\n`;
                totalMatches++;
            }
        }
        if (!out) out = 'Nenhum resultado encontrado.';
        results.textContent = out;
        stats.textContent = items.length + ' arquivos, ' + totalMatches + ' ocorrências';
    } catch (e) { results.textContent = '❌ ' + e.message; }
}

async function applyReplaceInSearch() {
    const q = document.getElementById('searchFilesInput').value;
    if (!q) { showToast('Digite o termo de busca primeiro'); return; }
    const replace = prompt('Substituir por:', '');
    if (replace === null) return;
    try {
        const res = await apiFetch('/api/replace', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                search: q,
                replace: replace,
                caseSensitive: document.getElementById('searchCaseSensitive').checked,
                useRegex: document.getElementById('searchRegex').checked
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ Substituído em ' + (data.affectedFiles || 0) + ' arquivos');
            runSearchInFiles();
        } else {
            showToast('❌ ' + (data.error || 'Falha'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
}

// =============================================
//  FIND/REPLACE COM PREVIEW
// =============================================
function openFindReplacePreview() {
    const existing = document.getElementById('findReplaceModal');
    if (existing) { existing.style.display = 'flex'; return; }
    const modal = document.createElement('div');
    modal.id = 'findReplaceModal';
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:3000;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    modal.innerHTML = '<div class="modal-content" style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:800px;width:90%;max-height:85vh;display:flex;flex-direction:column;gap:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;"><h2 style="color:#e6edf3;margin:0;">🔄 Buscar e Substituir</h2><button class="btn-close-modal" onclick="document.getElementById(\'findReplaceModal\').remove()">X</button></div>' +
        '<div style="display:flex;gap:8px;">' +
            '<input id="frSearchInput" type="text" placeholder="Buscar..." style="flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:6px 10px;border-radius:6px;font-size:12px;font-family:Consolas;">' +
            '<input id="frReplaceInput" type="text" placeholder="Substituir por..." style="flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:6px 10px;border-radius:6px;font-size:12px;font-family:Consolas;">' +
            '<button class="btn-save" onclick="runFindReplacePreview()">Visualizar</button></div>' +
        '<div style="display:flex;gap:12px;font-size:11px;color:#8b949e;">' +
            '<label><input type="checkbox" id="frCaseSensitive"> Maiusc./minusc.</label>' +
            '<label><input type="checkbox" id="frRegex"> Regex</label>' +
            '<span id="frStats" style="margin-left:auto;"></span></div>' +
        '<div id="frPreviewResults" style="flex:1;background:#0d1117;border:1px solid #30363d;border-radius:6px;overflow-y:auto;padding:8px;font-size:11px;font-family:Consolas,monospace;color:#c9d1d9;min-height:200px;white-space:pre-wrap;">Digite os termos e clique em Visualizar.</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
            '<button class="btn-save" id="frApplyBtn" onclick="applyFindReplacePreview()" disabled>✅ Aplicar todas as substituicoes</button>' +
            '<button class="btn-save" id="frApplyFileBtn" onclick="applyFindReplacePreview(true)" disabled>📄 Aplicar no arquivo atual</button></div>' +
        '</div>';
    document.body.appendChild(modal);
    setTimeout(function() { document.getElementById('frSearchInput').focus(); }, 100);
}

window._frPreviewData = null;

async function runFindReplacePreview() {
    var search = document.getElementById('frSearchInput').value;
    var replace = document.getElementById('frReplaceInput').value;
    if (!search) return;
    var results = document.getElementById('frPreviewResults');
    var stats = document.getElementById('frStats');
    results.textContent = 'Buscando...';
    try {
        var res = await apiFetch('/api/replace/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                search: search,
                replace: replace,
                caseSensitive: document.getElementById('frCaseSensitive').checked,
                useRegex: document.getElementById('frRegex').checked
            })
        });
        var data = await res.json();
        if (!data.success) { results.textContent = 'Erro: ' + (data.error || 'Falha'); return; }
        var items = data.results || [];
        var totalChanges = 0;
        var out = '';
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            out += '\n' + item.file + ' (' + item.changes + ' alteracoes)\n' + ('-'.repeat(60)) + '\n';
            if (item.preview) {
                var lines = item.preview.split('\n');
                for (var j = 0; j < Math.min(lines.length, 100); j++) out += lines[j] + '\n';
                if (lines.length > 100) out += '... +' + (lines.length - 100) + ' linhas\n';
            }
            totalChanges += item.changes;
        }
        if (!out) out = 'Nenhuma ocorrencia encontrada.';
        results.textContent = out;
        stats.textContent = items.length + ' arquivos, ' + totalChanges + ' substituicoes';
        window._frPreviewData = { search: search, replace: replace, caseSensitive: document.getElementById('frCaseSensitive').checked, useRegex: document.getElementById('frRegex').checked };
        document.getElementById('frApplyBtn').disabled = totalChanges === 0;
        document.getElementById('frApplyFileBtn').disabled = totalChanges === 0;
    } catch (e) { results.textContent = 'Erro: ' + e.message; }
}

async function applyFindReplacePreview(fileOnly) {
    if (!window._frPreviewData) return;
    var p = window._frPreviewData;
    try {
        var res = await apiFetch('/api/replace', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                search: p.search,
                replace: p.replace,
                caseSensitive: p.caseSensitive,
                useRegex: p.useRegex,
                fileOnly: fileOnly ? activeTabPath : null
            })
        });
        var data = await res.json();
        if (data.success) {
            showToast('Substituido em ' + (data.affectedFiles || 0) + ' arquivos');
            if (fileOnly && document.getElementById('fileEditorModal').style.display === 'flex') {
                openFile(activeTabPath);
            }
        } else { showToast(data.error || 'Falha'); }
    } catch (e) { showToast(e.message); }
}

console.log('🏗️ Aedificator Codex IDE com Explorador Nativo carregado!');
console.log('📁 Para selecionar uma pasta, clique em "Selecionar Pasta"');
console.log('🔗 Para desvincular, clique em "Desvincular"');

// =============================================
//  MENU BAR
// =============================================
const MENU_ITEMS = {
    file: [
        { label: 'Selecionar Pasta...', action: 'selectFolder', shortcut: 'Ctrl+O', desc: 'Escolher a pasta raiz do projeto' },
        { label: 'Novo Projeto...', action: 'newProject', shortcut: '', desc: 'Criar uma nova pasta de projeto' },
        { label: 'Desvincular Pasta', action: 'unlinkFolder', shortcut: '', desc: 'Fechar o projeto atual' },
        { separator: true },
        { label: 'Salvar Arquivo', action: 'saveFileEditor', shortcut: 'Ctrl+S', desc: 'Salvar o arquivo aberto no editor' },
        { label: 'Fechar Editor', action: 'closeFileEditor', shortcut: 'Escape', desc: 'Fechar o editor de código' },
    ],
    edit: [
        { label: 'Buscar nos Arquivos', action: 'findInFiles', shortcut: 'Ctrl+Shift+F', desc: 'Buscar texto em todos os arquivos do projeto' },
        { label: 'Busca Avançada...', action: 'openSearchInFiles', shortcut: 'Ctrl+Shift+H', desc: 'Busca com regex, case-sensitive e substituição' },
        { label: 'Substituir com Preview...', action: 'openFindReplacePreview', shortcut: '', desc: 'Substituir texto com diff antes de aplicar' },
        { separator: true },
        { label: 'Copiar (explorer)', action: 'copyFile', shortcut: '', desc: 'Copiar arquivo no explorador' },
        { label: 'Colar (explorer)', action: 'pasteFile', shortcut: '', desc: 'Colar arquivo no explorador' },
        { label: 'Renomear (explorer)', action: 'renameFile', shortcut: 'F2', desc: 'Renomear arquivo/pasta selecionado' },
        { separator: true },
        { label: 'Snippets de Código', action: 'openSnippets', shortcut: '', desc: 'Gerenciar e inserir trechos de código' },
    ],
    view: [
        { label: 'Terminal', action: 'openTerminal', shortcut: 'Ctrl+B', desc: 'Terminal integrado com shell persistente' },
        { label: 'Navegador Integrado', action: 'toggleBrowser', shortcut: '', desc: 'Abrir/fechar navegador em janela flutuante' },
        { label: 'Live Preview HTML', action: 'toggleLivePreview', shortcut: '', desc: 'Pré-visualizar HTML ao salvar' },
        { separator: true },
        { label: 'Source Control (só alterados)', action: 'toggleGitOnly', shortcut: '', desc: 'Filtrar explorador: apenas arquivos com alterações git' },
        { label: 'Dividir Editor (Split)', action: 'toggleSplitEditor', shortcut: '', desc: 'Abrir 2 painéis de código lado a lado' },
        { label: 'Outline (Símbolos)', action: 'toggleOutline', shortcut: '', desc: 'Mostrar árvore de funções, classes e métodos' },
        { separator: true },
        { label: 'Tema Claro/Escuro', action: 'toggleTheme', shortcut: '', desc: 'Alternar entre tema claro e escuro' },
    ],
    tools: [
        { label: 'Git', action: 'openGitModal', shortcut: '', desc: 'Status, commit, push, pull, branches, merge, stash' },
        { label: 'Diff Visual', action: 'gitShowDiff', shortcut: '', desc: 'Ver alterações (texto ou lado a lado)' },
        { label: 'Diff Arquivos...', action: 'openDiffFiles', shortcut: '', desc: 'Comparar dois arquivos lado a lado' },
        { label: 'Git Blame', action: 'showGitBlame', shortcut: '', desc: 'Ver autor de cada linha (com editor aberto)' },
        { separator: true },
        { label: 'Test Runner', action: 'openTestRunner', shortcut: '', desc: 'Executar testes com auto-discovery de arquivos' },
        { label: 'Analisador de Código', action: 'analyzeCurrentFile', shortcut: '', desc: 'Validar sintaxe do arquivo atual' },
        { separator: true },
        { label: 'Build (Empacotar)', action: 'openBuildModal', shortcut: '', desc: 'Gerar instalável para Windows/Mac/Linux' },
        { label: 'Publicar Versão', action: 'openPublishModal', shortcut: '', desc: 'Bump de versão semântica + tag + push' },
        { separator: true },
        { label: 'Debug Node.js', action: 'debugStart', shortcut: 'F5', desc: 'Depurar JS/TS com breakpoints, watch e console' },
        { label: 'Debug Chrome/Edge', action: 'debugChrome', shortcut: '', desc: 'Depurar no navegador via DevTools Protocol' },
        { label: 'Debug Python', action: 'debugPython', shortcut: '', desc: 'Depurar .py com debugpy + breakpoints' },
        { label: 'Debug Go', action: 'debugGo', shortcut: '', desc: 'Depurar .go com dlv' },
        { separator: true },
        { label: 'Docker', action: 'openDockerModal', shortcut: '', desc: 'Gerenciar containers: build, run, stop, logs' },
    ],
    config: [
        { label: 'Chaves API', action: 'openConfigModal', shortcut: 'Ctrl+,', desc: 'Google, DeepSeek, OpenAI, Anthropic, opencode + editor' },
        { label: 'Regras do Projeto', action: 'openRulesModal', shortcut: '', desc: 'Editar .aedificator-agents.md (convenções IA)' },
        { separator: true },
        { label: 'Exportar Configs', action: 'exportSettings', shortcut: '', desc: 'Salvar como .aedificator-settings.json' },
        { label: 'Importar Configs', action: 'importSettings', shortcut: '', desc: 'Restaurar do .aedificator-settings.json' },
        { label: 'Atalhos Customizados', action: 'openKeybindingsModal', shortcut: '', desc: 'Editar .aedificator-keybindings.json' },
    ],
    utils: [
        { label: 'Snapshots', action: 'openSnapshotModal', shortcut: '', desc: 'Criar e restaurar snapshots do projeto' },
        { label: 'Backup / Restaurar', action: 'openBackupModal', shortcut: '', desc: 'Backups automáticos com 10 versões' },
    ],
    help: [
        { label: 'Manual de Funções', action: 'openHelpModal', shortcut: 'F1', desc: 'Abrir este manual' },
        { separator: true },
        { label: 'Regras do Projeto (.aedificator-agents.md)', action: 'openRulesModal', shortcut: '', desc: 'Editar regras que a IA segue' },
        { separator: true },
        { label: 'Sobre Aedificator Codex IDE', action: 'showAbout', shortcut: '', desc: 'Versão e créditos' },
    ]
};

function initMenuBar() {
    const bar = document.getElementById('menuBar');
    if (!bar) return;

    // Remove any existing dropdowns
    bar.querySelectorAll('.menu-dropdown').forEach(d => d.remove());

    // Create dropdowns for each menu item
    bar.querySelectorAll('.menu-item').forEach(item => {
        const menuKey = item.dataset.menu;
        const items = MENU_ITEMS[menuKey];
        if (!items) return;

        const dropdown = document.createElement('div');
        dropdown.className = 'menu-dropdown';
        dropdown.id = 'menuDropdown-' + menuKey;

        for (const mi of items) {
            if (mi.separator) {
                dropdown.appendChild(document.createElement('div')).className = 'menu-separator';
                continue;
            }
            const dItem = document.createElement('div');
            dItem.className = 'menu-dropdown-item';
            dItem.innerHTML = `<span>${mi.label}</span>${mi.shortcut ? '<span class="shortcut">'+mi.shortcut+'</span>' : ''}`;
            dItem.addEventListener('click', (e) => {
                e.stopPropagation();
                closeAllMenus();
                executeMenuAction(mi.action);
            });
            dropdown.appendChild(dItem);
        }

        item.appendChild(dropdown);

        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.contains('visible');
            closeAllMenus();
            if (!isOpen) {
                dropdown.classList.add('visible');
                item.classList.add('open');
            }
        });

        item.addEventListener('mouseenter', () => {
            const anyOpen = bar.querySelector('.menu-dropdown.visible');
            if (anyOpen) {
                closeAllMenus();
                dropdown.classList.add('visible');
                item.classList.add('open');
            }
        });
    });

    // Close menus when clicking outside
    document.addEventListener('click', closeAllMenus);
}

function closeAllMenus() {
    document.querySelectorAll('.menu-dropdown.visible').forEach(d => d.classList.remove('visible'));
    document.querySelectorAll('.menu-item.open').forEach(m => m.classList.remove('open'));
}

// Escape global fecha qualquer modal aberto
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modals = ['configModal','backupModal','snapshotModal','gitModal','publishModal','approvalModal',
        'diffModal','testRunnerModal','terminalModal','folderPickerModal'];
    for (const id of modals) {
        const el = document.getElementById(id);
        if (el && el.style.display === 'flex') { el.style.display = 'none'; return; }
    }
});

function executeMenuAction(action) {
    switch (action) {
        case 'selectFolder': selectFolder(); break;
        case 'newProject': createNewProject(); break;
        case 'unlinkFolder': unlinkFolder(); break;
        case 'saveFileEditor': saveFileEditor(); break;
        case 'closeFileEditor': closeFileEditor(); break;
        case 'findInFiles': document.getElementById('searchInput')?.focus(); break;
        case 'openSearchInFiles': openSearchInFiles(); break;
        case 'openFindReplacePreview': openFindReplacePreview(); break;
        case 'openFindReplace': if (typeof openFindReplace==='function') openFindReplace(); else showToast('Use Ctrl+Shift+H para buscar e substituir'); break;
        case 'copyFile': showToast('📋 Clique direito no arquivo no explorador para copiar'); break;
        case 'pasteFile': showToast('📋 Clique direito no explorador para colar'); break;
        case 'renameFile': showToast('✏️ Clique direito no arquivo ou pressione F2 para renomear'); break;
        case 'openSnippets': openSnippets(); break;
        case 'openTerminal': openTerminal(); break;
        case 'toggleBrowser': toggleLivePreview(); break;
        case 'toggleLivePreview': toggleLivePreview(); break;
        case 'toggleSplitEditor': toggleSplitEditor(); break;
        case 'toggleOutline': toggleOutline(); break;
        case 'toggleTheme': toggleTheme(); break;
        case 'openGitModal': openGitModal(); break;
        case 'gitShowDiff': gitShowDiff(); break;
        case 'openDiffFiles': openDiffFileSelector(); break;
        case 'showGitBlame': if (document.getElementById('fileEditorModal').style.display==='flex') showGitBlame(); else showToast('Abra um arquivo primeiro'); break;
        case 'openTestRunner': openTestRunner(); break;
        case 'analyzeCurrentFile': if (document.getElementById('fileEditorModal').style.display==='flex') analyzeCurrentFile(); else showToast('Abra um arquivo primeiro'); break;
        case 'openBuildModal': if (typeof openBuildModal==='function') openBuildModal(); else showToast('📦 Use npm run build:win'); break;
        case 'openPublishModal': if (typeof openPublishModal==='function') openPublishModal(); else showToast('🚀 Use npm run publish:github'); break;
        case 'debugStart': debugStart(); break;
        case 'debugChrome': debugChromeStart(); break;
        case 'debugPython': debugPythonStart(); break;
        case 'debugGo': debugGoStart(); break;
        case 'openDockerModal': openDockerModal(); break;
        case 'toggleGitOnly': toggleGitOnly(); break;
        case 'exportSettings': exportSettingsToFile(); break;
        case 'importSettings': importSettingsFromFile(); break;
        case 'openKeybindingsModal': openKeybindingsModal(); break;
        case 'openSnapshotModal': if (typeof openSnapshotModal==='function') openSnapshotModal(); else showToast('📸 Snapshots no menu Ferramentas'); break;
        case 'openBackupModal': if (typeof openBackupModal==='function') openBackupModal(); else showToast('↩️ Backups automáticos ativos'); break;
        case 'openConfigModal': openConfigModal(); break;
        case 'openRulesModal': openRulesModal(); break;
        case 'openHelpModal': if (typeof openHelpModal==='function') openHelpModal(); else showToast('📖 Pressione F1 para ajuda'); break;
        case 'showAbout': alert('Aedificator Codex IDE v1.1.0\nDesenvolvimento com agentes de IA orquestrados\n\n© 2026 Aedificator Codex IDE'); break;
    }
}

function openHelpModal() {
    const existing = document.getElementById('helpModal');
    if (existing) { existing.style.display = 'flex'; return; }
    const modal = document.createElement('div');
    modal.id = 'helpModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:7000;';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    function menuToHtml(menuName) {
        const items = MENU_ITEMS[menuName] || [];
        const rows = items.map(item => {
            if (item.separator) return '<tr><td colspan="2" style="border-top:1px solid #30363d;"></td></tr>';
            const shortcut = item.shortcut ? ` <span style="color:#8b949e;">(${item.shortcut})</span>` : '';
            const desc = item.desc ? `<br><span style="color:#8b949e;font-size:11px;">${item.desc}</span>` : '';
            return `<tr><td style="padding:4px 8px;vertical-align:top;">` +
                `<span style="color:#79c0ff;">${item.label}</span>${shortcut}${desc}</td></tr>`;
        }).join('');
        return `<table style="width:100%;border-collapse:collapse;margin-bottom:8px;">${rows}</table>`;
    }

    modal.innerHTML = `<div class="modal-content" style="width:650px;max-width:90vw;max-height:85vh;overflow-y:auto;">
        <h2>📖 Manual de Funções — Aedificator Codex IDE v1.1.0</h2>
        <div style="font-size:12px;color:#c9d1d9;line-height:1.6;">

            <h3 style="color:#58a6ff;">⌨️ Atalhos Globais</h3>
            <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+O</td><td>Selecionar pasta do projeto</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+S</td><td>Salvar arquivo no editor</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+P</td><td>Abrir arquivo rápido (Quick Open)</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+,</td><td>Configurações (API Keys, Editor)</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+Enter</td><td>Enviar comando no chat</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">F1</td><td>Este manual</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">F5</td><td>Iniciar debug do arquivo atual</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Escape</td><td>Fechar modais (editor, terminal, etc.)</td></tr>
            </table>

            <h3 style="color:#58a6ff;">📝 Editor Monaco</h3>
            <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+F</td><td>Buscar no arquivo</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+H</td><td>Substituir no arquivo</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">F12</td><td>Ir para definição</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">F2</td><td>Renomear símbolo</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+/</td><td>Comentar/descomentar linha</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Alt+↑/↓</td><td>Mover linha</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Ctrl+Shift+F</td><td>Buscar nos arquivos do projeto</td></tr>
            </table>

            <h3 style="color:#58a6ff;">↔️ Split Editor</h3>
            <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
            <tr><td style="padding:2px 8px;color:#79c0ff;">Botão ↔️ Split</td><td>Dividir editor em 2 painéis lado a lado</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Clique direito → Abrir à direita</td><td>Abrir arquivo no painel direito</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">🗂️ Outline</td><td>Árvore de símbolos (classes, funções, métodos)</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">🔴 Diagnostics</td><td>Erros e avisos sublinhados em tempo real</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">📊 Diff lado a lado</td><td>Comparar alterações git visualmente</td></tr>
            </table>

            <h3 style="color:#58a6ff;">📂 Menu Arquivo</h3>
            ${menuToHtml('file')}

            <h3 style="color:#58a6ff;">✏️ Menu Editar</h3>
            ${menuToHtml('edit')}

            <h3 style="color:#58a6ff;">👁️ Menu Exibir</h3>
            ${menuToHtml('view')}

            <h3 style="color:#58a6ff;">🔧 Menu Ferramentas</h3>
            ${menuToHtml('tools')}

            <h3 style="color:#58a6ff;">🖱️ Explorador de Arquivos</h3>
            <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
            <tr><td style="padding:2px 8px;color:#79c0ff;">Clique</td><td>Abrir arquivo no editor</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Clique direito</td><td>Abrir, Renomear, Deletar, Copiar caminho, Debug, Navegador</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Arrastar arquivos</td><td>Importar para o projeto</td></tr>
            </table>

            <h3 style="color:#58a6ff;">🌐 Navegador Integrado</h3>
            <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
            <tr><td style="padding:2px 8px;color:#79c0ff;">Botão 🌐</td><td>Abrir/fechar navegador (janela flutuante)</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Arrastar barra</td><td>Mover janela</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Canto inferior</td><td>Redimensionar</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">🗖 / duplo clique</td><td>Maximizar/restaurar</td></tr>
            </table>

            <h3 style="color:#58a6ff;">🤖 Chat de IA</h3>
            <table style="width:100%;border-collapse:collapse;margin-bottom:12px;">
            <tr><td style="padding:2px 8px;color:#79c0ff;">/run comando</td><td>Executar comando no terminal</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Seletor de modelo</td><td>Gemini / DeepSeek / opencode</td></tr>
            <tr><td style="padding:2px 8px;color:#79c0ff;">Seletor de modo</td><td>Equipe / Esclarecer / Código / Arquitetura</td></tr>
            </table>

        </div>
        <div class="modal-actions"><button class="btn-close-modal" onclick="document.getElementById('helpModal').remove()">❌ Fechar</button></div>
    </div>`;
    document.body.appendChild(modal);
}

// =============================================
//  SNIPPETS MANAGER
// =============================================
const DEFAULT_SNIPPETS = [
    { name: 'clg', prefix: 'clg', language: 'javascript', body: 'console.log($1);' },
    { name: 'afn', prefix: 'afn', language: 'javascript', body: 'const ${1:name} = ($2) => {\n\t$0\n};' },
    { name: 'ife', prefix: 'ife', language: 'javascript', body: 'if (${1:condition}) {\n\t$0\n}' },
    { name: 'for', prefix: 'for', language: 'javascript', body: 'for (let ${1:i}=0; ${1:i}<${2:len}; ${1:i}++) {\n\t$0\n}' },
    { name: 'html5', prefix: 'html5', language: 'html', body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n\t<meta charset="UTF-8">\n\t<meta name="viewport" content="width=device-width, initial-scale=1.0">\n\t<title>$1</title>\n</head>\n<body>\n\t$0\n</body>\n</html>' },
    { name: 'flex', prefix: 'flex', language: 'css', body: 'display: flex;\njustify-content: center;\nalign-items: center;' },
];

function loadSnippets() {
    try {
        const saved = localStorage.getItem('aedificator_snippets');
        return saved ? JSON.parse(saved) : [...DEFAULT_SNIPPETS];
    } catch(e) { return [...DEFAULT_SNIPPETS]; }
}

function saveSnippets(snippets) {
    try { localStorage.setItem('aedificator_snippets', JSON.stringify(snippets)); } catch(e) {}
}

function openSnippets() {
    const existing = document.getElementById('snippetsModal');
    if (existing) { existing.style.display = 'flex'; renderSnippetsList(); return; }
    const modal = document.createElement('div');
    modal.id = 'snippetsModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.8);display:flex;align-items:center;justify-content:center;z-index:5000;';
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.innerHTML = `<div class="modal-content" style="width:600px;max-width:90vw;max-height:80vh;display:flex;flex-direction:column;">
        <h2>📋 Snippets de Código</h2>
        <p class="modal-desc">Gerencie seus snippets. Clique para inserir no editor.</p>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
            <input id="snippetName" placeholder="Nome/Prefix" style="flex:1;padding:4px 8px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;font-size:12px;">
            <input id="snippetLang" placeholder="Linguagem" style="width:100px;padding:4px 8px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;font-size:12px;">
            <button class="btn-toolbar" id="snippetAddBtn" style="font-size:11px;">➕ Adicionar</button>
        </div>
        <textarea id="snippetBody" placeholder="Corpo do snippet..." style="width:100%;height:100px;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:8px;font-family:Consolas,monospace;font-size:12px;resize:vertical;"></textarea>
        <div id="snippetsList" style="flex:1;overflow-y:auto;margin-top:8px;"></div>
        <div class="modal-actions" style="margin-top:8px;">
            <button class="btn-close-modal" onclick="this.closest('#snippetsModal').remove()">❌ Fechar</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
    document.getElementById('snippetAddBtn').addEventListener('click', addSnippet);
    renderSnippetsList();
}

function renderSnippetsList() {
    const list = document.getElementById('snippetsList');
    if (!list) return;
    const snippets = loadSnippets();
    list.innerHTML = '';
    for (let i = 0; i < snippets.length; i++) {
        const s = snippets[i];
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;padding:6px 8px;margin:2px 0;background:#0d1117;border:1px solid #30363d;border-radius:4px;cursor:pointer;font-size:12px;';
        item.innerHTML = `<span style="color:#58a6ff;font-weight:600;min-width:80px;">${escapeHtml(s.prefix)}</span><span style="color:#8b949e;min-width:70px;">[${escapeHtml(s.language)}]</span><span style="flex:1;color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(s.body.replace(/\n/g,' ').substring(0,60))}</span><button class="delete-snippet-btn" data-idx="${i}" style="background:none;border:none;color:#f85149;cursor:pointer;font-size:14px;">✕</button>`;
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-snippet-btn')) return;
            insertSnippet(s);
        });
        list.appendChild(item);
    }
    document.querySelectorAll('.delete-snippet-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = parseInt(btn.dataset.idx);
            const snippets = loadSnippets();
            snippets.splice(idx, 1);
            saveSnippets(snippets);
            renderSnippetsList();
        });
    });
}

function addSnippet() {
    const name = document.getElementById('snippetName').value.trim();
    const lang = document.getElementById('snippetLang').value.trim() || 'javascript';
    const body = document.getElementById('snippetBody').value.trim();
    if (!name || !body) { showToast('Preencha nome e corpo'); return; }
    const snippets = loadSnippets();
    const existing = snippets.findIndex(s => s.prefix === name);
    if (existing >= 0) {
        snippets[existing].body = body;
        snippets[existing].language = lang;
    } else {
        snippets.push({ name, prefix: name, language: lang, body });
    }
    saveSnippets(snippets);
    document.getElementById('snippetName').value = '';
    document.getElementById('snippetLang').value = '';
    document.getElementById('snippetBody').value = '';
    renderSnippetsList();
    showToast('✅ Snippet salvo!');
}

function insertSnippet(snippet) {
    if (monacoEditor && monacoEditor.getModel()) {
        const pos = monacoEditor.getPosition();
        monacoEditor.executeEdits('snippet', [{ range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column), text: snippet.body }]);
    } else {
        const ta = document.getElementById('fileEditorContent');
        if (ta && document.getElementById('fileEditorModal').style.display === 'flex') {
            const start = ta.selectionStart;
            ta.value = ta.value.substring(0, start) + snippet.body + ta.value.substring(ta.selectionEnd);
            ta.focus();
        } else {
            showToast('📋 Abra um arquivo primeiro');
        }
    }
}

// =============================================
//  INTELLISENSE PROVIDERS (LSP-like via analyzer)
// =============================================
let _aedCompletionCache = null;
let _aedCompletionCacheTs = 0;

async function provideAedCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    const suggestions = [];
    const prefix = word.word.toLowerCase();
    const seen = new Set();
    try {
        const now = Date.now();
        if (!_aedCompletionCache || now - _aedCompletionCacheTs > 30000) {
            const res = await apiFetch('/api/analyzer/completions', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prefix: word.word, file: activeTabPath })
            });
            const data = await res.json();
            if (data.success) {
                _aedCompletionCache = data.completions || [];
                _aedCompletionCacheTs = now;
            } else {
                _aedCompletionCache = [];
            }
        }
        const filtered = _aedCompletionCache.filter(c => c.label && c.label.toLowerCase().startsWith(prefix));
        for (const item of filtered) {
            if (seen.has(item.label)) continue;
            seen.add(item.label);
            suggestions.push({
                label: item.label,
                kind: monaco.languages.CompletionItemKind[item.kind === 'function' ? 'Function' : item.kind === 'class' ? 'Class' : item.kind === 'variable' ? 'Variable' : 'Property'],
                detail: item.detail || '',
                insertText: item.insertText || item.label,
                insertTextRules: item.insertTextRules ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                range: range
            });
        }
    } catch (e) {}

    // Word-based completions from all open tabs
    if (prefix.length >= 2) {
        for (const tab of editorTabs) {
            if (!tab.content || tab.isImage) continue;
            const words = tab.content.match(/[a-zA-Z_$][a-zA-Z0-9_$]{2,}/g);
            if (!words) continue;
            for (const w of words) {
                if (w.length < 3 || w.length > 40) continue;
                if (!w.toLowerCase().startsWith(prefix)) continue;
                if (seen.has(w)) continue;
                seen.add(w);
                suggestions.push({
                    label: w,
                    kind: monaco.languages.CompletionItemKind.Text,
                    detail: 'palavra em ' + (tab.path.split(/[\\/]/).pop() || 'arquivos abertos'),
                    range: range
                });
                if (suggestions.length >= 200) break;
            }
            if (suggestions.length >= 200) break;
        }
    }

    return { suggestions: suggestions.slice(0, 200) };
}

// Python autocomplete using backend symbols
let _pyCompletionCache = null;
let _pyCompletionCacheTs = 0;
async function providePythonCompletions(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    const suggestions = [];
    const seen = new Set();
    const prefix = word.word.toLowerCase();
    try {
        const now = Date.now();
        if (!_pyCompletionCache || now - _pyCompletionCacheTs > 30000) {
            const res = await apiFetch('/api/analyzer/python-symbols', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: activeTabPath })
            });
            const data = await res.json();
            if (data.success) {
                _pyCompletionCache = data.symbols || [];
                _pyCompletionCacheTs = now;
            } else { _pyCompletionCache = []; }
        }
        for (const sym of _pyCompletionCache) {
            if (!sym.name || sym.name.length < 2) continue;
            if (!sym.name.toLowerCase().startsWith(prefix)) continue;
            if (seen.has(sym.name)) continue;
            seen.add(sym.name);
            var detail = sym.kind;
            if (sym.params && sym.params.length) detail += '(' + sym.params.map(function(p) { return p.name; }).join(', ') + ')';
            suggestions.push({
                label: sym.name,
                kind: monaco.languages.CompletionItemKind[sym.kind === 'function' ? 'Function' : sym.kind === 'class' ? 'Class' : 'Variable'],
                detail: detail || '',
                range: range
            });
        }
    } catch (e) {}

    // Python builtins
    var pyBuiltins = ['print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple', 'type', 'isinstance', 'enumerate', 'zip', 'map', 'filter', 'open', 'with', 'import', 'from', 'def', 'class', 'return', 'yield', 'raise', 'try', 'except', 'finally', 'if', 'elif', 'else', 'for', 'while', 'break', 'continue', 'pass', 'assert', 'lambda', 'None', 'True', 'False', 'self', 'super', '__init__', '__str__', '__repr__', '__name__'];
    for (var i = 0; i < pyBuiltins.length; i++) {
        if (pyBuiltins[i].toLowerCase().startsWith(prefix) && !seen.has(pyBuiltins[i])) {
            seen.add(pyBuiltins[i]);
            suggestions.push({ label: pyBuiltins[i], kind: monaco.languages.CompletionItemKind.Keyword, detail: 'Python builtin', range: range });
        }
    }

    return { suggestions: suggestions.slice(0, 200) };
}

// Go autocomplete using backend symbols
let _goCompletionCache = null;
let _goCompletionCacheTs = 0;
async function provideGoCompletions(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    const suggestions = [];
    const seen = new Set();
    const prefix = word.word.toLowerCase();
    try {
        const now = Date.now();
        if (!_goCompletionCache || now - _goCompletionCacheTs > 30000) {
            const res = await apiFetch('/api/analyzer/go-symbols', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: activeTabPath })
            });
            const data = await res.json();
            if (data.success) {
                _goCompletionCache = data.symbols || [];
                _goCompletionCacheTs = now;
            } else { _goCompletionCache = []; }
        }
        for (const sym of _goCompletionCache) {
            if (!sym.name || sym.name.length < 2) continue;
            if (!sym.name.toLowerCase().startsWith(prefix)) continue;
            if (seen.has(sym.name)) continue;
            seen.add(sym.name);
            suggestions.push({
                label: sym.name,
                kind: monaco.languages.CompletionItemKind[sym.kind === 'function' ? 'Function' : sym.kind === 'class' ? 'Class' : 'Variable'],
                detail: sym.kind || '',
                range: range
            });
        }
    } catch (e) {}

    var goBuiltins = ['func', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'switch', 'case', 'default', 'break', 'continue', 'go', 'defer', 'select', 'fallthrough', 'nil', 'true', 'false', 'iota', 'string', 'int', 'int64', 'float64', 'bool', 'byte', 'rune', 'error', 'len', 'cap', 'make', 'new', 'append', 'copy', 'delete', 'close', 'panic', 'recover', 'print', 'println', 'fmt', 'context', 'http', 'json', 'os', 'io', 'sync'];
    for (var i = 0; i < goBuiltins.length; i++) {
        if (goBuiltins[i].toLowerCase().startsWith(prefix) && !seen.has(goBuiltins[i])) {
            seen.add(goBuiltins[i]);
            suggestions.push({ label: goBuiltins[i], kind: monaco.languages.CompletionItemKind.Keyword, detail: 'Go keyword', range: range });
        }
    }

    return { suggestions: suggestions.slice(0, 200) };
}

async function provideAedHover(model, position) {
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    try {
        const res = await apiFetch('/api/analyzer/definition', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: activeTabPath, wordUnderCursor: word.word })
        });
        const data = await res.json();
        if (!data.success || !data.locations.length) return null;
        const loc = data.locations[0];
        return {
            contents: [{ value: `**${loc.name}** — ${loc.kind}  \nDefinido em \`${loc.file}\`` }],
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
        };
    } catch (e) { return null; }
}

async function provideAedDefinition(model, position) {
    const word = model.getWordAtPosition(position);
    if (!word) return [];
    try {
        const res = await apiFetch('/api/analyzer/definition', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: activeTabPath, wordUnderCursor: word.word })
        });
        const data = await res.json();
        if (!data.success || !data.locations.length) return [];
        return data.locations.map(loc => ({
            uri: monaco.Uri.file(loc.file),
            range: new monaco.Range(loc.line, 1, loc.line, 1)
        }));
    } catch (e) { return []; }
}

async function provideAedReferences(model, position, context) {
    const word = model.getWordAtPosition(position);
    if (!word) return [];
    try {
        const res = await apiFetch('/api/analyzer/references', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: activeTabPath, wordUnderCursor: word.word })
        });
        const data = await res.json();
        if (!data.success || !data.locations.length) return [];
        return data.locations.map(loc => ({
            uri: monaco.Uri.file(loc.file),
            range: new monaco.Range(loc.line, 1, loc.line, 1)
        }));
    } catch (e) { return []; }
}

// =============================================
//  GIT GUTTER DECORATIONS (diff inline)
// =============================================
function scheduleAedGutterDecorations() {
    window._aedGutterTimer = setInterval(() => {
        if (!monacoEditor || !monacoEditor.getModel() || !activeTabPath || !currentProjectPath) return;
        aedApplyGutterDecorations();
    }, 3000);
}

let _aedLastGutterFile = null;
let _aedLastGutterContent = null;

async function aedApplyGutterDecorations() {
    if (!currentProjectPath || !activeTabPath) return;
    const currentContent = monacoEditor.getValue();
    if (_aedLastGutterFile === activeTabPath && _aedLastGutterContent === currentContent) return;
    _aedLastGutterFile = activeTabPath;
    _aedLastGutterContent = currentContent;

    try {
        const res = await apiFetch('/api/file/diff-preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: activeTabPath, conteudo: currentContent })
        });
        const data = await res.json();
        if (!data.success) return;
        const original = data.original || '';
        const lines = currentContent.split('\n');

        const added = [], modified = [], removed = [];
        if (original) {
            const origLines = original.split('\n');
            const maxLen = Math.max(lines.length, origLines.length);
            for (let i = 0; i < maxLen; i++) {
                if (i >= origLines.length && i < lines.length) {
                    added.push(i + 1);
                } else if (i >= lines.length && i < origLines.length) {
                    removed.push(i + 1);
                } else if (i < lines.length && i < origLines.length && lines[i] !== origLines[i]) {
                    modified.push(i + 1);
                }
            }
        }

        const deco = [];
        for (const ln of added) {
            deco.push({
                range: new monaco.Range(ln, 1, ln, 1),
                options: { isWholeLine: true, linesDecorationsClassName: 'aed-gutter-added', className: 'aed-line-added' }
            });
        }
        for (const ln of modified) {
            deco.push({
                range: new monaco.Range(ln, 1, ln, 1),
                options: { isWholeLine: true, linesDecorationsClassName: 'aed-gutter-modified', className: 'aed-line-modified' }
            });
        }
        for (const ln of removed) {
            deco.push({
                range: new monaco.Range(ln, 1, ln, 1),
                options: { isWholeLine: true, linesDecorationsClassName: 'aed-gutter-removed', className: 'aed-line-removed' }
            });
        }
        window._aedGutterDeco = monacoEditor.deltaDecorations(window._aedGutterDeco, deco);
    } catch (e) {}
}

// =============================================
//  GIT BLAME CODELENS
// =============================================
let _aedBlameCache = null;
let _aedBlameCacheTs = 0;
let _aedBlameFile = null;

async function provideGitBlameCodeLenses(model) {
    if (!currentProjectPath || !activeTabPath) return { lenses: [], dispose: () => {} };
    try {
        const now = Date.now();
        if (_aedBlameFile !== activeTabPath || !_aedBlameCache || now - _aedBlameCacheTs > 15000) {
            const res = await apiFetch('/api/git/blame', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file: activeTabPath })
            });
            const data = await res.json();
            if (data.success && data.lines && data.lines.length) {
                _aedBlameCache = data.lines;
                _aedBlameCacheTs = now;
                _aedBlameFile = activeTabPath;
            } else {
                return { lenses: [], dispose: () => {} };
            }
        }
        if (!_aedBlameCache || !_aedBlameCache.length) return { lenses: [], dispose: () => {} };
        const lenses = [];
        let lastBlame = null;
        let blockStart = 1;
        for (const b of _aedBlameCache) {
            if (lastBlame && b.author === lastBlame.author && b.date === lastBlame.date) continue;
            if (lastBlame && b.line > 1) {
                lenses.push({
                    range: { startLineNumber: blockStart, startColumn: 1, endLineNumber: lastBlame.line, endColumn: 1 },
                    id: 'blame_' + blockStart
                });
            }
            lastBlame = b;
            blockStart = b.line;
        }
        if (lastBlame) {
            lenses.push({
                range: { startLineNumber: blockStart, startColumn: 1, endLineNumber: _aedBlameCache[_aedBlameCache.length - 1].line, endColumn: 1 },
                id: 'blame_' + blockStart
            });
        }
        return { lenses, dispose: () => {} };
    } catch (e) {
        return { lenses: [], dispose: () => {} };
    }
}

function resolveGitBlameCodeLens(codeLens) {
    if (!_aedBlameCache) return codeLens;
    const firstLine = codeLens.range.startLineNumber;
    const blame = _aedBlameCache.find(b => b.line === firstLine);
    if (blame && blame.author) {
        codeLens.command = {
            id: 'noop',
            title: `${blame.author} · ${blame.date} · ${blame.hash.substring(0, 7)}` + (blame.content ? ' · ' + blame.content.substring(0, 40) : '')
        };
    }
    return codeLens;
}

// =============================================
//  TERMINAL COM MÚLTIPLAS SESSÕES
// =============================================
let terminalSessions = [{ id: 'default', name: 'bash', output: '' }];
let activeTerminalSessionId = 'default';

function switchTerminalTab(sessionId) {
    activeTerminalSessionId = sessionId;
    const session = terminalSessions.find(s => s.id === sessionId) || terminalSessions[0];
    const out = document.getElementById('terminalOutput');
    if (out) { out.textContent = session.output || ''; out.scrollTop = out.scrollHeight; }
    document.querySelectorAll('.terminal-tab').forEach(t => t.classList.toggle('active', t.dataset.sessionId === sessionId));
}

function newTerminalSession() {
    const id = 'term_' + Date.now();
    const name = 'Term ' + (terminalSessions.length + 1);
    terminalSessions.push({ id, name, output: `📁 Diretório: ${currentProjectPath || '---'}\nNova sessão iniciada.\n\n` });
    const tabsEl = document.getElementById('terminalTabs');
    if (tabsEl) {
        const tab = document.createElement('span');
        tab.className = 'terminal-tab';
        tab.dataset.sessionId = id;
        tab.textContent = name;
        tab.onclick = () => switchTerminalTab(id);
        tabsEl.insertBefore(tab, document.getElementById('terminalNewTabBtn'));
    }
    switchTerminalTab(id);
    if (terminalSessions.length === 1) {
        terminalSessions[0].name = 'Term 1';
        const firstTab = document.querySelector('.terminal-tab[data-session-id="default"]');
        if (firstTab) firstTab.textContent = 'Term 1';
    }
}

function closeTerminalSession(sessionId) {
    if (terminalSessions.length <= 1) return;
    terminalSessions = terminalSessions.filter(s => s.id !== sessionId);
    const tabEl = document.querySelector(`.terminal-tab[data-session-id="${sessionId}"]`);
    if (tabEl) tabEl.remove();
    if (activeTerminalSessionId === sessionId) {
        const first = terminalSessions[0];
        activeTerminalSessionId = first.id;
        switchTerminalTab(first.id);
    }
}

function updateTerminalOutput(text) {
    const session = terminalSessions.find(s => s.id === activeTerminalSessionId);
    if (session) session.output += text;
}

// =============================================
//  MULTI-ROOT WORKSPACE
// =============================================
let workspaceFolders = [];
if (currentProjectPath) workspaceFolders = [currentProjectPath];

function addWorkspaceFolder(folderPath) {
    if (!folderPath) return;
    const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!workspaceFolders.includes(normalized)) {
        workspaceFolders.push(normalized);
        showToast('📁 Pasta adicionada ao workspace: ' + normalized.split('/').pop());
    }
}

function removeWorkspaceFolder(folderPath) {
    workspaceFolders = workspaceFolders.filter(f => f !== folderPath.replace(/\\/g, '/').replace(/\/+$/, ''));
    showToast('🗑️ Pasta removida do workspace');
}

function getWorkspaceFolders() {
    return workspaceFolders.length ? workspaceFolders : (currentProjectPath ? [currentProjectPath] : []);
}

// =============================================
//  RENAME PROVIDER (F2)
// =============================================
async function provideAedRenameEdits(model, position, newName) {
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    try {
        const res = await apiFetch('/api/analyzer/references', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: activeTabPath, wordUnderCursor: word.word })
        });
        const data = await res.json();
        if (!data.success || !data.locations.length) return null;
        const edits = [];
        for (const loc of data.locations) {
            edits.push({
                resource: monaco.Uri.file(loc.file),
                edits: [{ range: new monaco.Range(loc.line, 1, loc.line, 1), text: newName }]
            });
        }
        return { edits };
    } catch (e) { return null; }
}

function provideAedRenameLocation(model, position) {
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        text: word.word
    };
}

// =============================================
//  REFERENCE CODELENS
// =============================================
async function provideAedReferenceCodeLenses(model) {
    if (!currentProjectPath || !activeTabPath) return { lenses: [], dispose: () => {} };
    const text = model.getValue();
    const lines = text.split('\n');
    const lenses = [];
    const exportedSymbols = [];
    const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g;
    const classRegex = /(?:export\s+)?class\s+(\w+)/g;
    let m;
    while ((m = funcRegex.exec(text)) !== null) {
        exportedSymbols.push({ name: m[1], line: text.substring(0, m.index).split('\n').length });
    }
    while ((m = classRegex.exec(text)) !== null) {
        exportedSymbols.push({ name: m[1], line: text.substring(0, m.index).split('\n').length });
    }
    for (const sym of exportedSymbols) {
        lenses.push({
            range: { startLineNumber: sym.line, startColumn: 1, endLineNumber: sym.line, endColumn: 1 },
            id: 'refs_' + sym.line
        });
    }
    return { lenses, dispose: () => {} };
}

async function resolveReferenceCodeLens(model, codeLens) {
    const symLine = codeLens.range.startLineNumber;
    const text = model.getValue();
    const lines = text.split('\n');
    const line = lines[symLine - 1] || '';
    let symbolName = '';
    const fm = line.match(/function\s+(\w+)/) || line.match(/class\s+(\w+)/);
    if (fm) symbolName = fm[1];
    if (!symbolName) {
        codeLens.command = { id: 'noop', title: '0 references' };
        return codeLens;
    }
    try {
        const res = await apiFetch('/api/analyzer/references', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: activeTabPath, wordUnderCursor: symbolName })
        });
        const data = await res.json();
        const count = (data.locations || []).length;
        codeLens.command = {
            id: 'editor.action.peekReferences',
            title: count + ' reference' + (count !== 1 ? 's' : ''),
            arguments: [monaco.Uri.file(activeTabPath), { lineNumber: symLine, column: 1 }, [{ uri: monaco.Uri.file(activeTabPath), range: new monaco.Range(symLine, 1, symLine, 1) }]]
        };
    } catch (e) {
        codeLens.command = { id: 'noop', title: '0 references' };
    }
    return codeLens;
}

// =============================================
//  DEBUG CHROME / PYTHON / GO
// =============================================
async function debugChromeStart() {
    try {
        const url = prompt('URL para debug (ex: http://localhost:3000):', 'http://localhost:3000');
        const res = await apiFetch('/api/debug/chrome', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        if (data.success) {
            showToast('🌐 Debug Chrome/Edge iniciado! Painel de debug ativo.');
            document.getElementById('debugPanel').style.display = 'block';
        } else {
            showToast('❌ ' + (data.error || 'Falha ao iniciar debug no browser'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
}

async function debugPythonStart() {
    if (!activeTabPath) { showToast('📁 Abra um arquivo .py primeiro'); return; }
    try {
        const res = await apiFetch('/api/debug/python', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: activeTabPath, breakpoints: [] })
        });
        const data = await res.json();
        if (data.success) {
            showToast('🐍 Debug Python iniciado! Painel de debug ativo.');
            document.getElementById('debugPanel').style.display = 'block';
        } else {
            showToast('❌ ' + (data.error || 'Falha. Execute: pip install debugpy'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
}

async function debugGoStart() {
    if (!activeTabPath) { showToast('📁 Abra um arquivo .go primeiro'); return; }
    try {
        const res = await apiFetch('/api/debug/go', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: activeTabPath, breakpoints: [] })
        });
        const data = await res.json();
        if (data.success) {
            showToast('🔵 Debug Go iniciado! Painel de debug ativo.');
            document.getElementById('debugPanel').style.display = 'block';
        } else {
            showToast('❌ ' + (data.error || 'Falha. Execute: go install github.com/go-delve/delve/cmd/dlv@latest'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
}

// =============================================
//  DOCKER MODAL
// =============================================
function openDockerModal() {
    const existing = document.getElementById('dockerModal');
    if (existing) { existing.style.display = 'flex'; return; }
    const modal = document.createElement('div');
    modal.id = 'dockerModal';
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:3000;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    modal.innerHTML = '<div class="modal-content" style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:700px;width:90%;max-height:85vh;display:flex;flex-direction:column;gap:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;"><h2 style="color:#e6edf3;margin:0;">🐳 Docker</h2><button class="btn-close-modal" onclick="document.getElementById(\'dockerModal\').remove()">❌ Fechar</button></div>' +
        '<p class="modal-desc">Comandos: docker build, run, stop, rm, ps, logs</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn-save" onclick="dockerQuick(\'docker ps\')">▶️ ps</button><button class="btn-save" onclick="dockerQuick(\'docker images\')">▶️ images</button><button class="btn-save" onclick="dockerQuick(\'docker-compose up -d\')">▶️ compose up</button><button class="btn-save" onclick="dockerQuick(\'docker-compose down\')">▶️ compose down</button></div>' +
        '<pre id="dockerOutput" style="background:#0d1117;color:#c9d1d9;padding:8px;border-radius:6px;max-height:40vh;overflow-y:auto;font-size:11px;font-family:Consolas,monospace;white-space:pre-wrap;min-height:100px;">🔍 Verificando Docker...</pre>' +
        '<div style="display:flex;gap:8px;"><input id="dockerCmdInput" type="text" placeholder="docker build -t app ." style="flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:6px 10px;border-radius:6px;font-size:12px;font-family:Consolas;"><button class="btn-save" onclick="dockerRun()">▶️ Executar</button></div>' +
        '</div>';
    document.body.appendChild(modal);
    dockerRefreshStatus();
}

async function dockerRefreshStatus() {
    const out = document.getElementById('dockerOutput');
    if (!out) return;
    try {
        const res = await apiFetch('/api/docker/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (data.installed) {
            out.textContent = '✅ Docker instalado e rodando.\n\nContainers ativos:\n' + (data.containers.length ? data.containers.map(c => '  • ' + c).join('\n') : '  (nenhum)');
        } else {
            out.textContent = '⚠️ Docker não instalado ou não rodando.\n\nBaixe em: https://docker.com';
        }
    } catch (e) { out.textContent = '❌ Erro: ' + e.message; }
}

function dockerQuick(cmd) { document.getElementById('dockerCmdInput').value = cmd; dockerRun(); }
async function dockerRun() {
    const cmd = document.getElementById('dockerCmdInput').value.trim();
    if (!cmd) return;
    const out = document.getElementById('dockerOutput');
    out.textContent = '⏳ ' + cmd + '\n';
    try {
        const res = await apiFetch('/api/docker/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
        });
        const data = await res.json();
        out.textContent = data.output || '(sem saída)';
    } catch (e) { out.textContent = '❌ ' + e.message; }
}

// =============================================
//  SETTINGS EXPORT / IMPORT
// =============================================
async function exportSettingsToFile() {
    if (!currentProjectPath) { showToast('📁 Selecione um projeto primeiro'); return; }
    const settings = {
        editor: {
            fontSize: localStorage.getItem('editor_fontSize') || '13',
            tabSize: localStorage.getItem('editor_tabSize') || '4',
            wordWrap: localStorage.getItem('editor_wordWrap') || '0',
            minimap: localStorage.getItem('editor_minimap') || '1',
            formatOnSave: localStorage.getItem('formatOnSave') || '0',
            autoSave: localStorage.getItem('autoSave') || '0'
        },
        theme: localStorage.getItem('theme') || 'dark',
        backendUrl: localStorage.getItem('backendUrl') || 'http://localhost:3001'
    };
    try {
        const res = await apiFetch('/api/settings/export', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings })
        });
        const data = await res.json();
        if (data.success) showToast('✅ Configs exportadas: ' + data.file);
        else showToast('❌ ' + (data.error || 'Falha'));
    } catch (e) { showToast('❌ ' + e.message); }
}

async function importSettingsFromFile() {
    if (!currentProjectPath) { showToast('📁 Selecione um projeto primeiro'); return; }
    try {
        const res = await apiFetch('/api/settings/import', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        });
        const data = await res.json();
        if (data.success && data.settings) {
            const s = data.settings;
            if (s.editor) {
                for (const [k, v] of Object.entries(s.editor)) {
                    try { localStorage.setItem('editor_' + k, String(v)); } catch (e) {}
                }
            }
            if (s.theme) try { localStorage.setItem('theme', s.theme); document.body.classList.toggle('theme-light', s.theme === 'light'); } catch (e) {}
            if (s.backendUrl) try { localStorage.setItem('backendUrl', s.backendUrl); } catch (e) {}
            showToast('✅ Configs importadas de .aedificator-settings.json');
        } else {
            showToast('❌ ' + (data.error || 'Nenhum arquivo de config encontrado'));
        }
    } catch (e) { showToast('❌ ' + e.message); }
}

// =============================================
//  KEYBINDINGS EDITOR
// =============================================
async function openKeybindingsModal() {
    if (!currentProjectPath) { showToast('📁 Selecione um projeto primeiro'); return; }
    let bindings = [];
    try {
        const res = await apiFetch('/api/keybindings/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        bindings = data.bindings || [];
    } catch (e) {}
    const existing = document.getElementById('keybindingsModal');
    if (existing) { existing.remove(); }
    const bindingsJson = JSON.stringify(bindings.length ? bindings : [{ "key": "ctrl+shift+k", "command": "editor.action.deleteLines", "when": "editorFocus" }], null, 2);
    const modal = document.createElement('div');
    modal.id = 'keybindingsModal';
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:3000;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    modal.innerHTML = '<div class="modal-content" style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;max-width:750px;width:90%;max-height:85vh;display:flex;flex-direction:column;gap:12px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;"><h2 style="color:#e6edf3;margin:0;">⌨️ Atalhos Customizados (.aedificator-keybindings.json)</h2><button class="btn-close-modal" onclick="document.getElementById(\'keybindingsModal\').remove()">❌ Fechar</button></div>' +
        '<textarea id="keybindingsEditor" style="flex:1;background:#0d1117;color:#c9d1d9;border:1px solid #30363d;padding:8px;border-radius:6px;font-size:12px;font-family:Consolas,monospace;min-height:300px;">' + bindingsJson.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</textarea>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;"><button class="btn-save" onclick="saveKeybindings()">💾 Salvar</button></div>' +
        '<details style="margin-top:8px;"><summary style="color:#8b949e;cursor:pointer;font-size:11px;">Exemplos de atalhos do Monaco</summary><pre style="color:#8b949e;font-size:10px;">{ "key": "ctrl+k ctrl+f", "command": "editor.action.formatSelection" }\n{ "key": "ctrl+shift+space", "command": "editor.action.triggerParameterHints" }\n{ "key": "f12", "command": "editor.action.goToDeclaration" }\n{ "key": "shift+f12", "command": "editor.action.referenceSearch.trigger" }</pre></details>' +
        '</div>';
    document.body.appendChild(modal);
}

async function saveKeybindings() {
    const ta = document.getElementById('keybindingsEditor');
    if (!ta) return;
    try {
        const bindings = JSON.parse(ta.value);
        const res = await apiFetch('/api/keybindings/save', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bindings })
        });
        const data = await res.json();
        if (data.success) {
            showToast('✅ Atalhos salvos em .aedificator-keybindings.json');
            loadCustomKeybindings(bindings);
            document.getElementById('keybindingsModal').remove();
        } else {
            showToast('❌ ' + (data.error || 'Falha ao salvar'));
        }
    } catch (e) { showToast('❌ JSON inválido: ' + e.message); }
}

function loadKeybindingsOnStart() {
    if (!currentProjectPath) return;
    apiFetch('/api/keybindings/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(r => r.json())
        .then(data => { if (data.success && data.bindings && data.bindings.length) loadCustomKeybindings(data.bindings); })
        .catch(() => {});
}

function parseKeybinding(keyStr) {
    const parts = keyStr.split('+');
    let mod = 0;
    for (const p of parts) {
        if (p === 'ctrl') mod |= monaco.KeyMod.CtrlCmd;
        else if (p === 'alt') mod |= monaco.KeyMod.Alt;
        else if (p === 'shift') mod |= monaco.KeyMod.Shift;
    }
    const key = parts[parts.length - 1].toUpperCase();
    return mod | (monaco.KeyCode['Key' + key] || monaco.KeyCode[key] || 0);
}

function loadCustomKeybindings(bindings) {
    if (!monacoReady || !monacoEditor || !Array.isArray(bindings)) return;
    for (const kb of bindings) {
        if (kb.key && kb.command) {
            try {
                var chords = kb.key.split(' ').map(function(k) { return parseKeybinding(k); });
                monacoEditor.addAction({
                    id: 'custom_' + kb.command.replace(/\./g, '_'),
                    label: 'Custom: ' + kb.key,
                    keybindings: [monaco.KeyMod.chord.apply(null, chords)],
                    run: function() {
                        if (kb.command.startsWith('editor.action.')) {
                            var action = monacoEditor.getAction(kb.command);
                            if (action) action.run();
                        }
                    }
                });
            } catch (e) {}
        }
    }
}

// =============================================
//  SOURCE CONTROL TOGGLE (explorador filtrar git)
// =============================================
let gitOnlyFilter = false;
async function toggleGitOnly() {
    gitOnlyFilter = !gitOnlyFilter;
    if (!currentProjectPath) { gitOnlyFilter = false; showToast('📁 Selecione um projeto primeiro'); return; }
    if (gitOnlyFilter) {
        try {
            const res = await apiFetch('/api/git/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const data = await res.json();
            if (data.success && data.changes) {
                const changedFiles = new Set();
                for (const c of data.changes) {
                    if (c.file) changedFiles.add(c.file.replace(/\\/g, '/'));
                }
                if (changedFiles.size === 0) {
                    showToast('✅ Nenhum arquivo alterado (working tree limpa)');
                    gitOnlyFilter = false;
                    return;
                }
                window._gitChangedFiles = changedFiles;
                showToast('📊 Mostrando apenas ' + changedFiles.size + ' arquivo(s) alterado(s)');
                loadFolderStructure(currentProjectPath);
            } else {
                gitOnlyFilter = false;
                showToast('⚠️ Repositório git não detectado');
            }
        } catch (e) {
            gitOnlyFilter = false;
            showToast('❌ ' + e.message);
        }
    } else {
        window._gitChangedFiles = null;
        showToast('📁 Mostrando todos os arquivos');
        loadFolderStructure(currentProjectPath);
    }
}

// =============================================
//  ACTIVITY BAR + SIDEBAR PANELS
// =============================================
let activeActivityPanel = null;

function switchActivityBar(panelName) {
    var panels = document.querySelectorAll('.sidebar-panel');
    var icons = document.querySelectorAll('.activitybar-icon');
    var targetIcon = document.querySelector('.activitybar-icon[data-panel="' + panelName + '"]');
    var activeIcon = document.querySelector('.activitybar-icon.active');

    if (activeIcon && activeIcon.dataset.panel === panelName && activeActivityPanel === panelName) {
        panels.forEach(function(p) { p.style.display = 'none'; });
        activeIcon.classList.remove('active');
        activeActivityPanel = null;
        return;
    }

    panels.forEach(function(p) { p.style.display = 'none'; });
    var panel = document.querySelector('.sidebar-panel[data-panel="' + panelName + '"]');
    if (panel) { panel.style.display = 'flex'; activeActivityPanel = panelName; }

    icons.forEach(function(i) { i.classList.remove('active'); });
    if (targetIcon) targetIcon.classList.add('active');

    if (panelName === 'git') sidebarGitRefresh();
    if (panelName === 'docker') sidebarDockerRefresh();
    if (panelName === 'search') { document.getElementById('sidebarSearchInput').focus(); }
}

// =============================================
//  BOTTOM PANEL
// =============================================
let bottomPanelOpen = false;
let activeBottomTab = null;

function toggleBottomPanel(tabName) {
    var panel = document.getElementById('bottomPanel');
    if (!panel) return;
    if (!bottomPanelOpen) {
        panel.classList.add('open');
        bottomPanelOpen = true;
        activeBottomTab = tabName;
        switchBottomTab(tabName);
        if (tabName === 'terminal') { var inp = document.getElementById('bottomTerminalInput'); if (inp) inp.focus(); }
        return;
    }
    if (activeBottomTab === tabName) {
        panel.classList.remove('open');
        bottomPanelOpen = false;
        activeBottomTab = null;
        document.querySelectorAll('.bottom-tab').forEach(function(t) { t.classList.remove('active'); });
        return;
    }
    activeBottomTab = tabName;
    switchBottomTab(tabName);
}

function switchBottomTab(tabName) {
    document.querySelectorAll('.bottom-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === tabName);
    });
    document.querySelectorAll('.bottom-pane').forEach(function(p) {
        p.classList.toggle('active', p.dataset.tab === tabName);
    });
}

function bottomTerminalSend() {
    var inp = document.getElementById('bottomTerminalInput');
    var out = document.getElementById('bottomTerminalOutput');
    if (!inp || !out) return;
    var cmd = inp.value.trim();
    if (!cmd) return;
    inp.value = '';

    var isRemote = false;
    var actualCmd = cmd;
    if (cmd.startsWith('#remote ')) { isRemote = true; actualCmd = cmd.slice(8).trim(); }
    else if (cmd.startsWith('#r ')) { isRemote = true; actualCmd = cmd.slice(3).trim(); }

    out.textContent += '\n' + (isRemote ? '[REMOTO] ' : '') + '> ' + actualCmd + '\n';
    out.scrollTop = out.scrollHeight;
    if (cmd.toLowerCase() === 'clear') { out.textContent = ''; return; }
    if (!backendReady) { out.textContent += 'Backend offline\n'; out.scrollTop = out.scrollHeight; return; }

    var endpoint = isRemote ? '/api/remote/shell' : '/api/shell/send';
    apiFetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: actualCmd })
    }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.cwd) { var sp = document.getElementById('statusProject'); if (sp) sp.textContent = data.cwd.split(/[\\/]/).pop() || data.cwd; }
        if (data.output) { out.textContent += data.output; out.scrollTop = out.scrollHeight; }
        if (data.error) { out.textContent += 'ERRO: ' + data.error + '\n'; out.scrollTop = out.scrollHeight; }
    }).catch(function(e) { out.textContent += e.message + '\n'; out.scrollTop = out.scrollHeight; });
}

function updateBottomProblems(errorsList) {
    var content = document.getElementById('bottomProblemsContent');
    var countEl = document.getElementById('statusErrors');
    if (!content) return;
    if (!errorsList || !errorsList.length) {
        content.innerHTML = '<div style="padding:12px;color:#8b949e;font-size:12px;">Nenhum problema detectado.</div>';
        if (countEl) countEl.textContent = '0 x';
        return;
    }
    var errCount = 0, warnCount = 0, html = '';
    for (var i = 0; i < errorsList.length; i++) {
        var e = errorsList[i];
        var icon = e.severity === 'error' ? 'X' : '!';
        var color = e.severity === 'error' ? '#f85149' : '#d29922';
        if (e.severity === 'error') errCount++; else warnCount++;
        html += '<div style="padding:2px 12px;cursor:pointer;font-size:12px;font-family:Consolas,monospace;border-bottom:1px solid #21262d;" data-file="' + escapeHtml(e.file || '') + '">' +
            '<span style="color:' + color + ';margin-right:8px;">' + icon + '</span>' +
            '<span style="color:#8b949e;">' + escapeHtml((e.file || '').split(/[\\/]/).pop()) + ':' + (e.line || '') + '</span>' +
            '<span style="color:#c9d1d9;margin-left:8px;">' + escapeHtml(e.message || '') + '</span></div>';
    }
    content.innerHTML = html;
    var summary = [];
    if (errCount) summary.push(errCount + ' x');
    if (warnCount) summary.push(warnCount + ' !');
    if (countEl) countEl.textContent = summary.join(' ') || '0 x';
    content.querySelectorAll('[data-file]').forEach(function(el) {
        el.addEventListener('click', function() { openFile(el.dataset.file); });
    });
}

// =============================================
//  SIDEBAR SEARCH
// =============================================
function runSidebarSearch() {
    var input = document.getElementById('sidebarSearchInput');
    var results = document.getElementById('sidebarSearchResults');
    if (!input || !results) return;
    var q = input.value.trim();
    if (!q) { results.innerHTML = '<div style="padding:12px;color:#8b949e;">Digite para buscar nos arquivos</div>'; return; }
    results.innerHTML = '<div style="padding:12px;color:#8b949e;">Buscando...</div>';
    apiFetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: q, inContent: true }) })
        .then(function(r) { return r.json(); }).then(function(data) {
            if (!data.success || !data.results || !data.results.length) {
                results.innerHTML = '<div style="padding:12px;color:#8b949e;">Nenhum resultado para "' + escapeHtml(q) + '"</div>'; return;
            }
            var html = '';
            for (var i = 0; i < data.results.length; i++) {
                var r = data.results[i];
                html += '<div class="sidebar-search-item" data-path="' + escapeHtml(r.path) + '" style="padding:4px 12px;cursor:pointer;border-bottom:1px solid #21262d;">' +
                    '<div style="color:#58a6ff;font-size:12px;">' + escapeHtml(r.name) + '</div>';
                if (r.matches) for (var j = 0; j < Math.min(r.matches.length, 3); j++) {
                    html += '<div style="color:#c9d1d9;font-size:11px;padding:1px 0 1px 12px;"><span style="color:#8b949e;">' + r.matches[j].line + ':</span> ' + escapeHtml((r.matches[j].text || '').substring(0, 100)) + '</div>';
                }
                html += '</div>';
            }
            results.innerHTML = html;
            results.querySelectorAll('.sidebar-search-item').forEach(function(el) { el.addEventListener('click', function() { openFile(el.dataset.path); }); });
        }).catch(function(e) { results.innerHTML = '<div style="padding:12px;color:#f85149;">' + escapeHtml(e.message) + '</div>'; });
}

// =============================================
//  SIDEBAR GIT
// =============================================
function sidebarGitRefresh() {
    var filesEl = document.getElementById('sidebarGitFiles');
    var badgeEl = document.querySelector('.activitybar-icon[data-panel="git"] .badge');
    if (!filesEl) return;
    filesEl.innerHTML = '<div style="padding:12px;color:#8b949e;font-size:12px;">Carregando status...</div>';
    apiFetch('/api/git/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function(r) { return r.json(); }).then(function(data) {
            if (!data.success || !data.isRepo) {
                filesEl.innerHTML = '<div style="padding:12px;color:#8b949e;">Repositorio git nao detectado</div>';
                if (badgeEl) badgeEl.style.display = 'none'; return;
            }
            var changes = data.changes || [];
            if (!changes.length) {
                filesEl.innerHTML = '<div style="padding:12px;color:#8b949e;">Nenhuma alteracao (working tree limpa)</div>';
                if (badgeEl) badgeEl.style.display = 'none';
            } else {
                if (badgeEl) { badgeEl.textContent = changes.length; badgeEl.style.display = 'inline-block'; }
                var html = '';
                for (var i = 0; i < changes.length; i++) {
                    var c = changes[i];
                    var color = c.status === 'M' ? '#d29922' : c.status === 'A' ? '#3fb950' : c.status === 'D' ? '#f85149' : '#8b949e';
                    html += '<div class="sidebar-git-file" style="padding:2px 12px;font-size:12px;font-family:Consolas,monospace;">' +
                        '<span style="color:' + color + ';font-weight:600;width:20px;flex-shrink:0;">' + (c.status || '?') + '</span>' +
                        '<span style="color:#c9d1d9;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(c.file || '') + '</span></div>';
                }
                filesEl.innerHTML = html;
            }
            var branchEl = document.getElementById('statusGitBranch');
            if (branchEl && data.branch) branchEl.innerHTML = '&utrif; ' + data.branch;
        }).catch(function(e) { filesEl.innerHTML = '<div style="padding:12px;color:#f85149;">' + escapeHtml(e.message) + '</div>'; });
}

function sidebarGitCommit() {
    var msgEl = document.getElementById('sidebarGitMessage');
    if (!msgEl) return;
    var msg = msgEl.value.trim();
    if (!msg) { showToast('Digite uma mensagem de commit'); return; }
    apiFetch('/api/git/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) })
        .then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) { showToast('Commit realizado!'); msgEl.value = ''; sidebarGitRefresh(); }
            else showToast(data.error || 'Falha no commit');
        }).catch(function(e) { showToast(e.message); });
}

function sidebarGitPush() {
    apiFetch('/api/git/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) { showToast('Push realizado!'); sidebarGitRefresh(); }
            else showToast(data.error || 'Falha no push');
        }).catch(function(e) { showToast(e.message); });
}

function sidebarGitPull() {
    apiFetch('/api/git/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function(r) { return r.json(); }).then(function(data) {
            if (data.success) { showToast('Pull realizado!'); sidebarGitRefresh(); }
            else showToast(data.error || 'Falha no pull');
        }).catch(function(e) { showToast(e.message); });
}

function sidebarGitDiff() { gitShowDiff(); }

// =============================================
//  SIDEBAR DOCKER
// =============================================
function sidebarDockerRefresh() {
    var out = document.getElementById('sidebarDockerOutput');
    if (!out) return;
    out.textContent = 'Verificando Docker...';
    apiFetch('/api/docker/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function(r) { return r.json(); }).then(function(data) {
            if (data.installed) {
                var lines = ['Docker instalado e rodando.\nContainers ativos:'];
                if (data.containers && data.containers.length) for (var i = 0; i < data.containers.length; i++) lines.push('  - ' + data.containers[i]);
                else lines.push('  (nenhum)');
                out.textContent = lines.join('\n');
            } else { out.textContent = 'Docker nao instalado ou nao rodando.\nBaixe em: https://docker.com'; }
        }).catch(function(e) { out.textContent = e.message; });
}

function sidebarDockerCmd(cmd) {
    var out = document.getElementById('sidebarDockerOutput');
    if (!out || !cmd) return;
    out.textContent = cmd + '\n';
    apiFetch('/api/docker/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command: cmd }) })
        .then(function(r) { return r.json(); }).then(function(data) { out.textContent = data.output || '(sem saida)'; })
        .catch(function(e) { out.textContent = e.message; });
}

function sidebarSshConnect() {
    var host = document.getElementById('sshHost').value.trim() || 'root@localhost';
    var port = document.getElementById('sshPort').value.trim() || '22';
    var key = document.getElementById('sshKey').value.trim();
    var statusEl = document.getElementById('sshStatus');
    var out = document.getElementById('sidebarSshOutput');
    statusEl.textContent = 'Conectando...';
    statusEl.style.color = '#d29922';
    apiFetch('/api/remote/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host, port: parseInt(port) || 22, keyFile: key || undefined })
    }).then(function(r) { return r.json(); }).then(function(data) {
        if (data.success) { statusEl.textContent = 'Conectado: ' + host; statusEl.style.color = '#3fb950'; out.textContent = 'Conexao SSH estabelecida.\n' + (data.files ? data.files.join('\n') : ''); }
        else { statusEl.textContent = 'Erro: ' + (data.error || 'falha'); statusEl.style.color = '#f85149'; }
    }).catch(function(e) { statusEl.textContent = 'Erro: ' + e.message; statusEl.style.color = '#f85149'; });
}

function sidebarSshDisconnect() {
    var statusEl = document.getElementById('sshStatus');
    apiFetch('/api/remote/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function() { statusEl.textContent = 'Desconectado'; statusEl.style.color = '#8b949e'; })
        .catch(function() { statusEl.textContent = 'Desconectado'; statusEl.style.color = '#8b949e'; });
}

function sidebarSshExec() {
    var cmd = document.getElementById('sshCmd').value.trim();
    var out = document.getElementById('sidebarSshOutput');
    if (!cmd) return;
    out.textContent = '$ ' + cmd + '\n';
    apiFetch('/api/remote/exec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd })
    }).then(function(r) { return r.json(); }).then(function(data) {
        out.textContent = '$ ' + cmd + '\n' + (data.output || '(sem saida)');
    }).catch(function(e) { out.textContent = '$ ' + cmd + '\nErro: ' + e.message; });
    document.getElementById('sshCmd').value = '';
}

// =============================================
//  COMMAND PALETTE
// =============================================
let cpSelectedIdx = -1;

function initCommandPalette() {
    var palette = document.getElementById('commandPalette');
    var input = document.getElementById('commandPaletteInput');
    var results = document.getElementById('commandPaletteResults');
    if (!palette || !input || !results) return;

    document.addEventListener('keydown', function(e) {
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
            e.preventDefault(); togglePalette();
        }
        if (e.key === 'Escape' && (palette.style.display === 'flex' || palette.style.display === 'block')) {
            palette.style.display = 'none';
        }
    });

    input.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { palette.style.display = 'none'; return; }
        if (e.key === 'Enter') {
            var items = results.querySelectorAll('.cp-item:not([style*="display:none"])');
            if (items.length && cpSelectedIdx >= 0 && cpSelectedIdx < items.length) {
                palette.style.display = 'none';
                executeMenuAction(items[cpSelectedIdx].dataset.action);
            }
            return;
        }
        if (e.key === 'ArrowDown') { e.preventDefault(); cpSelectedIdx++; navigatePalette(results); }
        if (e.key === 'ArrowUp') { e.preventDefault(); if (cpSelectedIdx > 0) cpSelectedIdx--; navigatePalette(results); }
    });

    input.addEventListener('input', function() { filterPalette(input.value.trim().toLowerCase()); });

    palette.addEventListener('click', function(e) { if (e.target === palette) palette.style.display = 'none'; });

    function togglePalette() {
        if (palette.style.display === 'flex' || palette.style.display === 'block') { palette.style.display = 'none'; return; }
        palette.style.display = 'flex'; input.value = ''; cpSelectedIdx = 0;
        populateCommandPalette(); filterPalette(''); input.focus();
    }
}

function populateCommandPalette() {
    var results = document.getElementById('commandPaletteResults');
    if (!results) return;
    var html = '';
    var cats = ['file', 'edit', 'view', 'tools', 'config', 'utils', 'help'];
    var names = { file: 'Arquivo', edit: 'Editar', view: 'Exibir', tools: 'Ferramentas', config: 'Configuracoes', utils: 'Utilitarios', help: 'Ajuda' };
    for (var c = 0; c < cats.length; c++) {
        var items = MENU_ITEMS[cats[c]] || [];
        var hasItems = false;
        for (var i = 0; i < items.length; i++) {
            if (items[i].separator) continue;
            hasItems = true;
            html += '<div class="cp-item" data-action="' + items[i].action + '" data-label="' + escapeHtml((names[cats[c]] + ' ' + items[i].label).toLowerCase()) + '" style="padding:6px 16px;font-size:13px;color:#c9d1d9;cursor:pointer;display:flex;justify-content:space-between;">' +
                '<span>' + escapeHtml(items[i].label) + '</span>' +
                (items[i].shortcut ? '<span style="color:#8b949e;font-size:11px;">' + escapeHtml(items[i].shortcut) + '</span>' : '') + '</div>';
        }
        if (hasItems) html = '<div class="cp-category" style="padding:4px 16px;color:#8b949e;font-size:10px;text-transform:uppercase;">' + names[cats[c]] + '</div>' + html;
    }
    results.innerHTML = html;
    results.querySelectorAll('.cp-item').forEach(function(el, idx) {
        el.addEventListener('mouseenter', function() { cpSelectedIdx = idx; navigatePalette(results); });
        el.addEventListener('click', function() {
            document.getElementById('commandPalette').style.display = 'none';
            executeMenuAction(el.dataset.action);
        });
    });
}

function filterPalette(q) {
    var results = document.getElementById('commandPaletteResults');
    if (!results) return;
    var anyVisible = false;
    results.querySelectorAll('.cp-item').forEach(function(el) {
        var visible = !q || el.dataset.label.indexOf(q) >= 0;
        el.style.display = visible ? 'flex' : 'none';
        if (visible) anyVisible = true;
    });
    results.querySelectorAll('.cp-category').forEach(function(cat) {
        var next = cat;
        while (next && next.nextElementSibling) {
            next = next.nextElementSibling;
            if (next.classList.contains('cp-item') && next.style.display !== 'none') { cat.style.display = ''; return; }
            if (next.classList.contains('cp-category')) { cat.style.display = 'none'; return; }
        }
        cat.style.display = 'none';
    });
    cpSelectedIdx = 0; navigatePalette(results);
}

function navigatePalette(results) {
    if (!results) return;
    results.querySelectorAll('.cp-item').forEach(function(el) { el.style.background = ''; });
    var visible = Array.from(results.querySelectorAll('.cp-item')).filter(function(el) { return el.style.display !== 'none'; });
    if (!visible.length) { cpSelectedIdx = -1; return; }
    if (cpSelectedIdx >= visible.length) cpSelectedIdx = visible.length - 1;
    if (cpSelectedIdx < 0) cpSelectedIdx = 0;
    visible[cpSelectedIdx].style.background = '#1f6feb';
    visible[cpSelectedIdx].style.color = '#fff';
    visible[cpSelectedIdx].scrollIntoView({ block: 'nearest' });
}

// =============================================
//  STATUS BAR
// =============================================
function updateStatusBar() {
    var sel = document.getElementById('statusCursor');
    var langEl = document.getElementById('statusLang');
    var backendEl = document.getElementById('statusBackend');
    var projectEl = document.getElementById('statusProject');

    if (langEl && activeTabPath) {
        var ext = (activeTabPath.split('.').pop() || '').toLowerCase();
        langEl.textContent = ext ? ext.charAt(0).toUpperCase() + ext.slice(1) : 'Plain Text';
    }
    if (backendEl) {
        backendEl.style.color = backendReady ? '#3fb950' : '#f85149';
        backendEl.textContent = backendReady ? 'Conectado' : 'Desconectado';
    }
    if (projectEl) {
        if (currentProjectPath) {
            var parts = currentProjectPath.replace(/\\/g, '/').split('/');
            projectEl.textContent = parts[parts.length - 1] || currentProjectPath;
        } else { projectEl.textContent = '-'; }
    }

    if (currentProjectPath) {
        apiFetch('/api/git/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(function(r) { return r.json(); }).then(function(data) {
                var branchEl = document.getElementById('statusGitBranch');
                if (branchEl && data.branch) branchEl.innerHTML = '&utrif; ' + data.branch;
            }).catch(function() {});
    }
}

// =============================================
//  ACTIVITY BAR + BOTTOM PANEL INIT
// =============================================
function initActivityBar() {
    document.querySelectorAll('.activitybar-icon').forEach(function(icon) {
        icon.addEventListener('click', function() {
            if (icon.dataset.panel) switchActivityBar(icon.dataset.panel);
        });
    });
}

function initBottomPanel() {
    document.querySelectorAll('.bottom-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
            if (tab.dataset.tab) toggleBottomPanel(tab.dataset.tab);
        });
    });
    var closeBtn = document.getElementById('bottomPanelToggle');
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            document.getElementById('bottomPanel').classList.remove('open');
            bottomPanelOpen = false; activeBottomTab = null;
        });
    }
}

// Override openTerminal to use bottom panel
var _origOpenTerminal = openTerminal;
openTerminal = function() {
    toggleBottomPanel('terminal');
    var inp = document.getElementById('bottomTerminalInput');
    if (inp) setTimeout(function() { inp.focus(); }, 150);
};

// Keyboard shortcut: Ctrl+B for terminal
document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleBottomPanel('terminal');
    }
});

// =============================================
//  OPEnCODE MODEL BROWSER — modal para escolher modelo
// =============================================
function openOpenCodeModelBrowser() {
    var existing = document.getElementById('ocModelBrowser');
    if (existing) { existing.style.display = 'flex'; return; }

    var models = PROVIDER_MODELS.opencode || [];
    if (!models.length && window._ocModels) {
        var all = [];
        for (var i = 0; i < window._ocModels.free.length; i++) all.push(window._ocModels.free[i]);
        for (var j = 0; j < window._ocModels.go.length; j++) all.push(window._ocModels.go[j]);
        models = all.map(function(m) {
            return { value: m.id, label: (m.provider ? m.provider + ' · ' : '') + (m.name || m.id) };
        });
    }

    if (!models.length) {
        showToast('Modelos opencode nao carregados. Verifique a chave API.');
        return;
    }

    var html = '';
    var currentProvider = '';
    var isWide = models.length > 20;

    for (var i = 0; i < models.length; i++) {
        var m = models[i];
        // Extrai provider do label se possivel (Go models tem "Go · nome" no label)
        var label = m.label.replace(/^[🟣💎]\s*/, '');
        var provider = '';
        var parts = label.split(' · ');
        if (parts.length > 1) { provider = parts[0]; label = parts.slice(1).join(' · '); }

        if (isWide) {
            html += '<div class="oc-model-item" data-value="' + escapeHtml(m.value) + '" data-label="' + escapeHtml(label) + '" style="padding:6px 12px;cursor:pointer;display:flex;align-items:center;gap:8px;border-bottom:1px solid #21262d;font-size:12px;">' +
                '<span style="color:#8b949e;font-size:10px;width:70px;text-align:right;flex-shrink:0;">' + escapeHtml(provider) + '</span>' +
                '<span style="color:#e6edf3;flex:1;">' + escapeHtml(label) + '</span></div>';
        } else {
            if (provider && provider !== currentProvider) {
                currentProvider = provider;
                html += '<div style="padding:6px 12px;color:#8b949e;font-size:10px;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #30363d;">' + escapeHtml(provider) + '</div>';
            }
            html += '<div class="oc-model-item" data-value="' + escapeHtml(m.value) + '" style="padding:6px 12px;cursor:pointer;font-size:13px;color:#e6edf3;border-bottom:1px solid #21262d;">' +
                escapeHtml(label) + '</div>';
        }
    }

    var modal = document.createElement('div');
    modal.id = 'ocModelBrowser';
    modal.style.cssText = 'display:flex;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:5000;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    modal.innerHTML = '<div class="modal-content" style="background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;max-width:' + (isWide ? '600' : '420') + 'px;width:90%;max-height:80vh;display:flex;flex-direction:column;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
            '<h2 style="color:#e6edf3;margin:0;font-size:16px;">🟣 Escolha o modelo opencode</h2>' +
            '<button class="btn-close-modal" onclick="document.getElementById(\'ocModelBrowser\').remove()">X</button></div>' +
        '<div style="flex:1;overflow-y:auto;background:#0d1117;border:1px solid #30363d;border-radius:8px;">' + html + '</div>' +
        '<p style="color:#8b949e;font-size:10px;margin-top:8px;">' + models.length + ' modelos disponiveis | Selecione um para usar com opencode</p>' +
        '</div>';
    document.body.appendChild(modal);

    modal.querySelectorAll('.oc-model-item').forEach(function(el) {
        el.addEventListener('click', function() {
            var val = el.dataset.value;
            var label = el.dataset.label || el.textContent;
            currentModel = val;
            // Atualiza o model select
            var sel = document.getElementById('modelSelect');
            for (var i = 0; i < sel.options.length; i++) {
                if (sel.options[i].value === val) { sel.selectedIndex = i; break; }
            }
            showToast('opencode: ' + label);
            modal.remove();
        });
        el.addEventListener('mouseenter', function() { el.style.background = '#1f6feb'; el.style.color = '#fff'; });
        el.addEventListener('mouseleave', function() { el.style.background = ''; el.style.color = ''; });
    });

    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
}
window._lastDiagnosticsErrors = [];

function fixErrorsWithAI() {
    var errors = window._lastDiagnosticsErrors || [];
    if (!errors.length) {
        var problems = document.getElementById('bottomProblemsContent');
        if (problems) {
            var lines = [];
            problems.querySelectorAll('[data-file]').forEach(function(el) {
                var f = el.dataset.file;
                var txt = el.textContent.trim();
                if (txt) lines.push(f + ': ' + txt);
            });
            if (lines.length) errors = lines.map(function(l) { return { message: l, file: '' }; });
        }
    }
    if (!errors.length) { showToast('Nenhum erro para corrigir'); return; }

    // Show button when there are errors
    document.getElementById('fixErrorsBtn').style.display = 'none';

    var msg = 'Corrija os seguintes erros encontrados no projeto:\n\n';
    for (var i = 0; i < Math.min(errors.length, 15); i++) {
        var e = errors[i];
        msg += '- [' + (e.file || 'arquivo').replace(/\\/g, '/').split('/').pop() + ':' + (e.line || '') + '] ' + e.message + '\n';
    }
    if (errors.length > 15) msg += '... +' + (errors.length - 15) + ' erros adicionais';
    msg += '\nCorrija todos esses problemas nos arquivos correspondentes.';

    document.getElementById('chatInput').value = msg;
    // Garante que o botão de envio está habilitado
    isStreaming = false;
    isRunning = false;
    document.getElementById('sendButton').disabled = false;
    sendMessage();
}

// Hook into diagnostics to track last errors for the fix button
var _origUpdateBottomProblems = updateBottomProblems;
updateBottomProblems = function(errorsList) {
    window._lastDiagnosticsErrors = errorsList || [];
    var btn = document.getElementById('fixErrorsBtn');
    if (btn) btn.style.display = errorsList && errorsList.length ? 'inline-block' : 'none';
    return _origUpdateBottomProblems(errorsList);
};

// Init on load
setTimeout(function() {
    initActivityBar();
    initBottomPanel();
    initCommandPalette();
    updateStatusBar();
}, 600);
