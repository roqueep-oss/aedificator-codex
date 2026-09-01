// =============================================
//  MULTI-AGENTE — agentes paralelos com estado isolado
// =============================================
/* eslint-disable no-global-assign -- o propósito deste arquivo é trocar os bindings globais (declarados com `let` no top-level do script.js) quando o usuário alterna de aba. `window.X = ...` NÃO troca bindings `let`; a atribuição direta é a única forma em scripts clássicos. */
/* global sendStreamingMessage, endTask, WS_URL, handleWsMessage, isStreaming, agentMessages, agentDivIds, agentCounter, pendingApproval, BACKEND_URL, BACKEND_TOKEN */
(function() {
    function AgentSession(id, label) {
        this.id = id;
        this.label = label;
        this.ws = null;
        this.streaming = false;
        this.agentMessages = {};
        this.agentDivIds = {};
        this.agentCounter = 0;
        this.pendingApproval = null;
        this.messagesHtml = '';
        this.taskActive = false;
    }

    var sessions = {};
    var activeId = '0';
    var _streamingMessageFn = null;
    var _endTaskFn = null;

    window.getAgentSession = function() { return sessions[activeId]; };

    function syncState() {
        var s = sessions[activeId];
        if (!s) return;
        if (!_streamingMessageFn) _streamingMessageFn = sendStreamingMessage;
        if (!_endTaskFn) _endTaskFn = endTask;
        if (s.id === '0') {
            // Sessão principal: usa as funções e o socket originais do script.js.
            sendStreamingMessage = _streamingMessageFn;
            endTask = _endTaskFn;
        } else {
            // Sessões filhas: enviam pelo socket próprio e trocam o estado.
            // ATENÇÃO: `window.X = ...` NÃO troca bindings `let` declarados no
            // top-level do script.js (eles vivem no escopo lexical global, não
            // no objeto window). A atribuição direta (sem `window.`) é que troca
            // — é por isso que antes as abas compartilhavam estado por engano.
            sendStreamingMessage = s.streamingMessageProxy.bind(s);
            endTask = s.endTaskProxy.bind(s);
        }
        isStreaming = s.streaming;
        agentMessages = s.agentMessages;
        agentDivIds = s.agentDivIds;
        agentCounter = s.agentCounter;
        pendingApproval = s.pendingApproval;
    }

    function restoreGlobals() {
        if (_streamingMessageFn) sendStreamingMessage = _streamingMessageFn;
        if (_endTaskFn) endTask = _endTaskFn;
    }

    AgentSession.prototype.streamingMessageProxy = function(msg) {
        var s = this;
        if (!s) return;
        if (msg.type === 'execute' || msg.type === 'stream') s.taskActive = true;
        if (msg && typeof msg === 'object' && !msg.token && typeof BACKEND_TOKEN !== 'undefined') msg.token = BACKEND_TOKEN;
        if (!s.ws || s.ws.readyState !== WebSocket.OPEN) {
            s.ws = new WebSocket(WS_URL);
            s.ws.onopen = function() { s.ws.send(JSON.stringify(msg)); };
            s.ws.onmessage = function(e) { handleSessionMessage(s, e); };
            s.ws.onclose = function() { handleSessionClose(s); };
            return;
        }
        s.ws.send(JSON.stringify(msg));
    };

    AgentSession.prototype.endTaskProxy = function(toastMsg) {
        if (_endTaskFn) _endTaskFn(toastMsg);
        saveState();
    };

    // Handler único de mensagens de uma sessão: troca para o contexto da sessão,
    // processa a mensagem e restaura o contexto anterior com segurança.
    function handleSessionMessage(s, e) {
        try {
            if (activeId !== s.id) saveState();
            var prev = activeId;
            activeId = s.id; syncState();
            handleWsMessage(JSON.parse(e.data));
            // Persiste o que handleWsMessage modificou (pendingApproval,
            // agentMessages, isStreaming, etc.) na sessão s ANTES de voltar.
            // Sem isto, o syncState final sobrescrevia o pendingApproval do
            // approval com o valor antigo → clicar em "Executar" não fazia nada.
            saveState();
            activeId = prev; syncState();
            if (activeId === s.id) restoreGlobals();
        } catch (err) {
            if (activeId === s.id) restoreGlobals();
        }
    }

    // Roteia as mensagens do socket base (connectWebSocket) para a sessão
    // ATIVA — a que o usuário está vendo. Sem isto, o ws base chamava
    // handleWsMessage sem trocar o contexto, corrompendo o estado da sessão.
    window.__agentRouter = function(rawData) {
        var s = sessions[activeId];
        if (s) handleSessionMessage(s, { data: rawData });
    };

    // Se a conexão cai no meio de uma tarefa, a UI não pode ficar presa em
    // "Enviando.../Executando" esperando um 'done' que nunca chegará.
    function handleSessionClose(s) {
        var wasTaskActive = s.taskActive || s.streaming;
        if (s.streaming) s.streaming = false;
        s.taskActive = false;
        s.ws = null;
        if (wasTaskActive && activeId === s.id && _endTaskFn) {
            _endTaskFn('⏹️ Conexão perdida — tarefa cancelada');
        }
    }

    function saveState() {
        var s = sessions[activeId];
        if (!s) return;
        s.streaming = isStreaming;
        s.agentMessages = agentMessages;
        s.agentDivIds = agentDivIds;
        s.agentCounter = agentCounter;
        s.pendingApproval = pendingApproval;
        s.messagesHtml = document.getElementById('messages').innerHTML;
    }

    function initMultiAgent() {
        var chatArea = document.querySelector('.chat-area');
        if (!chatArea) { setTimeout(initMultiAgent, 200); return; }

        var tabBar = document.createElement('div');
        tabBar.id = 'agentTabs';
        tabBar.style.cssText = 'display:flex;align-items:center;background:#0d1117;border-bottom:1px solid #21262d;padding:2px 4px;gap:2px;flex-shrink:0;';

        var addBtn = document.createElement('button');
        addBtn.textContent = '+ Agente';
        addBtn.title = 'Novo agente paralelo (mesmo projeto)';
        addBtn.style.cssText = 'background:#1f6feb;border:none;border-radius:4px;color:#fff;cursor:pointer;font-size:11px;padding:3px 8px;margin:2px;';
        addBtn.onclick = spawnAgent;
        tabBar.appendChild(addBtn);

        var existingMessages = document.getElementById('messages');
        var refNode = existingMessages || chatArea.querySelector('.input-area');
        chatArea.insertBefore(tabBar, refNode);

        sessions['0'] = new AgentSession('0', 'Agente 1');
        addTab('0', 'Agente 1');
        syncState();
    }

    function spawnAgent() {
        var ids = Object.keys(sessions).map(Number);
        var nextId = String(Math.max.apply(null, ids) + 1);
        saveState();
        var s = new AgentSession(nextId, 'Agente ' + (parseInt(nextId) + 1));
        sessions[nextId] = s;
        addTab(nextId, 'Agente ' + (parseInt(nextId) + 1));
        // Socket criado sob demanda no primeiro envio (streamingMessageProxy),
        // não aqui — evita abrir WebSocket ocioso para cada aba criada.
        switchAgent(nextId);
    }

    function addTab(id, label) {
        var tabBar = document.getElementById('agentTabs');
        if (!tabBar) return;
        var tab = document.createElement('div');
        tab.dataset.agent = id;
        tab.innerHTML = '\uD83E\uDD16 ' + label;
        tab.style.cssText = 'padding:6px 12px;background:#0d1117;border:1px solid #21262d;border-bottom:none;border-radius:6px 6px 0 0;color:#8b949e;cursor:pointer;font-size:12px;white-space:nowrap;';
        tab.onclick = function() { switchAgent(id); };
        if (id !== '0') {
            var close = document.createElement('span');
            close.innerHTML = ' \u00D7';
            close.style.cssText = 'color:#f85149;margin-left:4px;font-weight:bold;';
            close.onclick = function(e) { e.stopPropagation(); closeAgent(id); };
            tab.appendChild(close);
        }
        tabBar.appendChild(tab);
    }

    function switchAgent(id) {
        saveState();
        var s = sessions[id];
        if (s && s.messagesHtml !== undefined) {
            var el = document.getElementById('messages');
            if (el) el.innerHTML = s.messagesHtml;
        }
        var tabs = document.querySelectorAll('#agentTabs [data-agent]');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].style.background = '#0d1117';
            tabs[i].style.color = '#8b949e';
            tabs[i].style.borderColor = '#21262d';
        }
        var activeTab = document.querySelector('#agentTabs [data-agent="' + id + '"]');
        if (activeTab) { activeTab.style.background = '#161b22'; activeTab.style.color = '#e6edf3'; activeTab.style.borderColor = '#30363d'; }
        activeId = id;
        syncState();
    }

    function closeAgent(id) {
        if (id === '0') return;
        var s = sessions[id];
        if (s && s.ws) s.ws.close();
        var tab = document.querySelector('#agentTabs [data-agent="' + id + '"]');
        if (tab) tab.remove();
        delete sessions[id];
        if (activeId === id) switchAgent('0');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() { setTimeout(initMultiAgent, 500); });
    } else {
        setTimeout(initMultiAgent, 500);
    }
})();

// ----- BROWSER STATUS -----
(function() {
    setTimeout(function() {
        if (typeof BACKEND_URL === 'undefined') return;
        var h = { 'Content-Type': 'application/json' };
        if (typeof BACKEND_TOKEN !== 'undefined' && BACKEND_TOKEN) h['Authorization'] = 'Bearer ' + BACKEND_TOKEN;
        fetch(BACKEND_URL + '/api/browser/status', { headers: h })
            .then(function(r) { return r.json(); })
            .then(function(d) { console.log('\uD83C\uDF10 Browser:', d.connected ? 'Playwright OK' : 'n\u00E3o dispon\u00EDvel'); })
            .catch(function() {});
    }, 1500);
})();
