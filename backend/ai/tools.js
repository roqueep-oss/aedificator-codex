'use strict';
// =============================================
//  FERRAMENTAS DO AGENTE: schemas + helpers + declarações + execução.
//  As declarações que dependem de estado (mcpManager, complexidade) recebem
//  esses valores por parâmetro. A execução (executeAgentTool) recebe as
//  dependências do servidor via setToolContext(), quebrando o acoplamento.
// =============================================

const fs = require('fs');
const path = require('path');
const analyzer = require('../analyzer');
const runner = require('../runner');
const debuggerRunner = require('../debugger');
const remote = require('../remote');
const { executeBrowserTool } = require('../browser-client');

let _ctx = null;
function setToolContext(ctx) { _ctx = ctx; }

const TOOL_SCHEMAS = {
    read_file: {
        name: 'read_file',
        description: 'Lê o conteúdo completo de um arquivo do projeto. Retorna o conteúdo com diagnóstico de erros para arquivos de código.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo a partir da raiz do projeto' } },
            required: ['caminho']
        }
    },
    write_file: {
        name: 'write_file',
        description: 'Cria ou sobrescreve um arquivo com o conteúdo completo. O diretório pai é criado automaticamente se não existir. Use para criar novos arquivos ou substituir arquivos existentes inteiros.',
        parameters: {
            type: 'object',
            properties: {
                caminho: { type: 'string', description: 'Caminho relativo do arquivo a ser criado/modificado' },
                conteudo: { type: 'string', description: 'Conteúdo COMPLETO do arquivo' }
            },
            required: ['caminho', 'conteudo']
        }
    },
    delete_file: {
        name: 'delete_file',
        description: 'Remove um arquivo do projeto permanentemente.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo a ser removido' } },
            required: ['caminho']
        }
    },
    list_files: {
        name: 'list_files',
        description: 'Lista arquivos e pastas de um diretório do projeto.',
        parameters: {
            type: 'object',
            properties: { diretorio: { type: 'string', description: 'Caminho relativo do diretório. Omita ou use "" para a raiz.' } },
            required: []
        }
    },
    search_code: {
        name: 'search_code',
        description: 'Busca por um padrão (regex) nos arquivos do projeto. Use para encontrar funções, classes, imports ou padrões de código.',
        parameters: {
            type: 'object',
            properties: {
                padrao: { type: 'string', description: 'Padrão regex para buscar no código' },
                diretorio: { type: 'string', description: 'Diretório onde buscar (opcional, padrão: raiz do projeto)' }
            },
            required: ['padrao']
        }
    },
    exec_command: {
        name: 'exec_command',
        description: 'Executa um comando shell no diretório do projeto. Use para rodar testes, builds, lint, npm/pip install, git commands não cobertos por outras tools, ou scripts de verificação.',
        parameters: {
            type: 'object',
            properties: { comando: { type: 'string', description: 'Comando shell completo a ser executado' } },
            required: ['comando']
        }
    },
    search_replace: {
        name: 'search_replace',
        description: 'Busca e substitui texto em arquivos do projeto. Mais eficiente que write_file para mudanças pontuais.',
        parameters: {
            type: 'object',
            properties: {
                padrao: { type: 'string', description: 'Texto exato a ser encontrado e substituído' },
                substituto: { type: 'string', description: 'Novo texto que substituirá o padrão' },
                caminho: { type: 'string', description: 'Arquivo ou diretório onde aplicar (opcional, padrão: todo o projeto)' }
            },
            required: ['padrao', 'substituto']
        }
    },
    apply_patch: {
        name: 'apply_patch',
        description: 'Substitui um trecho de um arquivo por outro. O old_string é casado de forma tolerante a diferenças de espaços/indentação. Use para edições cirúrgicas; copie o trecho exato do arquivo.',
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Caminho relativo do arquivo a editar' },
                old_string: { type: 'string', description: 'Trecho EXATO a ser substituído (copiado do arquivo)' },
                new_string: { type: 'string', description: 'Novo conteúdo que substituirá old_string' }
            },
            required: ['file_path', 'old_string', 'new_string']
        }
    },
    file_rename: {
        name: 'file_rename',
        description: 'Renomeia ou move um arquivo/pasta do projeto.',
        parameters: {
            type: 'object',
            properties: {
                origem: { type: 'string', description: 'Caminho relativo atual do arquivo/pasta' },
                destino: { type: 'string', description: 'Novo caminho relativo' }
            },
            required: ['origem', 'destino']
        }
    },
    file_mkdir: {
        name: 'file_mkdir',
        description: 'Cria um diretório (e diretórios pais se necessário).',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do diretório a ser criado' } },
            required: ['caminho']
        }
    },
    analyzer_validate: {
        name: 'analyzer_validate',
        description: 'Valida um arquivo de código e retorna erros e avisos de sintaxe/lint.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo a ser validado' } },
            required: ['caminho']
        }
    },
    analyzer_symbols: {
        name: 'analyzer_symbols',
        description: 'Extrai símbolos (funções, classes, variáveis, imports) de um arquivo de código.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo' } },
            required: ['caminho']
        }
    },
    test_run: {
        name: 'test_run',
        description: 'Executa os testes do projeto (jest, pytest, go test, cargo test) e retorna o resultado.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    undo: {
        name: 'undo',
        description: 'Desfaz a última alteração de arquivo feita pelo agente. Use se cometeu um erro.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    redo: {
        name: 'redo',
        description: 'Refaz a última alteração desfeita pelo undo.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    generate_tests: {
        name: 'generate_tests',
        description: 'Gera testes unitários para um arquivo de código existente e executa os testes.',
        parameters: {
            type: 'object',
            properties: { caminho: { type: 'string', description: 'Caminho relativo do arquivo para gerar testes' } },
            required: ['caminho']
        }
    },
    browser_navigate: {
        name: 'browser_navigate',
        description: 'Navega o browser Playwright para uma URL. Use para testar frontend web.',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'URL completa para navegar (ex: http://localhost:3000)' } },
            required: ['url']
        }
    },
    browser_screenshot: {
        name: 'browser_screenshot',
        description: 'Tira um screenshot da página atual do browser.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    browser_click: {
        name: 'browser_click',
        description: 'Clica em um elemento CSS na página do browser.',
        parameters: {
            type: 'object',
            properties: { selector: { type: 'string', description: 'Seletor CSS do elemento a clicar' } },
            required: ['selector']
        }
    },
    browser_type: {
        name: 'browser_type',
        description: 'Digita texto em um campo input/textarea na página do browser.',
        parameters: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Seletor CSS do campo input/textarea' },
                text: { type: 'string', description: 'Texto a ser digitado' }
            },
            required: ['selector', 'text']
        }
    },
    browser_evaluate: {
        name: 'browser_evaluate',
        description: 'Executa JavaScript na página do browser e retorna o resultado.',
        parameters: {
            type: 'object',
            properties: { js: { type: 'string', description: 'Código JavaScript a ser executado na página' } },
            required: ['js']
        }
    },
    browser_console: {
        name: 'browser_console',
        description: 'Lê os logs do console do browser atual.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    browser_content: {
        name: 'browser_content',
        description: 'Obtém o conteúdo HTML completo da página atual do browser.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_publish: {
        name: 'git_publish',
        description: 'Publica uma release: faz commit, cria tag semver e push. Use após concluir uma feature.',
        parameters: {
            type: 'object',
            properties: { mensagem: { type: 'string', description: 'Mensagem do commit (opcional)' } },
            required: []
        }
    },
    git_status: {
        name: 'git_status',
        description: 'Mostra o status do git (arquivos modificados, staged, untracked).',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_diff: {
        name: 'git_diff',
        description: 'Mostra o diff das alterações atuais (unstaged).',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_log: {
        name: 'git_log',
        description: 'Mostra histórico de commits (últimos 10).',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_commit: {
        name: 'git_commit',
        description: 'Faz commit das alterações staged. Use git_status antes para ver o que será commitado.',
        parameters: {
            type: 'object',
            properties: { mensagem: { type: 'string', description: 'Mensagem descritiva do commit' } },
            required: ['mensagem']
        }
    },
    git_push: {
        name: 'git_push',
        description: 'Faz push dos commits para o remote.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_pull: {
        name: 'git_pull',
        description: 'Faz pull das alterações do remote.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_branch: {
        name: 'git_branch',
        description: 'Lista branches locais e remotas.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    git_stash: {
        name: 'git_stash',
        description: 'Salva ou restaura alterações não commitadas no stash.',
        parameters: {
            type: 'object',
            properties: { acao: { type: 'string', description: '"push" para salvar ou "pop" para restaurar' } },
            required: ['acao']
        }
    },
    snapshot_create: {
        name: 'snapshot_create',
        description: 'Cria um snapshot completo do estado atual do projeto para backup.',
        parameters: {
            type: 'object',
            properties: { rotulo: { type: 'string', description: 'Nome descritivo do snapshot (opcional)' } },
            required: []
        }
    },
    snapshot_list: {
        name: 'snapshot_list',
        description: 'Lista todos os snapshots salvos do projeto.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    snapshot_restore: {
        name: 'snapshot_restore',
        description: 'Restaura o projeto para um snapshot anterior. CUIDADO: desfaz todas as alterações posteriores.',
        parameters: {
            type: 'object',
            properties: { rotulo: { type: 'string', description: 'Nome do snapshot para restaurar' } },
            required: ['rotulo']
        }
    },
    debug_start: {
        name: 'debug_start',
        description: 'Inicia uma sessão de debug Node.js para um arquivo.',
        parameters: {
            type: 'object',
            properties: { arquivo: { type: 'string', description: 'Caminho do arquivo para debugar' } },
            required: ['arquivo']
        }
    },
    debug_stop: {
        name: 'debug_stop',
        description: 'Para a sessão de debug atual.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    debug_step: {
        name: 'debug_step',
        description: 'Avança um passo no debug (step over).',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    debug_resume: {
        name: 'debug_resume',
        description: 'Continua a execução até o próximo breakpoint.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    ssh_exec: {
        name: 'ssh_exec',
        description: 'Executa um comando no servidor remoto via SSH. Requer conexão SSH ativa.',
        parameters: {
            type: 'object',
            properties: { comando: { type: 'string', description: 'Comando a ser executado no servidor remoto' } },
            required: ['comando']
        }
    },
    ssh_status: {
        name: 'ssh_status',
        description: 'Verifica o status da conexão SSH com o servidor remoto.',
        parameters: { type: 'object', properties: {}, required: [] }
    },
    docker_run: {
        name: 'docker_run',
        description: 'Executa um container Docker com a imagem especificada. O comando deve começar com "docker".',
        parameters: {
            type: 'object',
            properties: { comando: { type: 'string', description: 'Comando docker completo' } },
            required: ['comando']
        }
    },
    task: {
        name: 'task',
        description: 'Delega uma subtarefa a um subagente isolado (somente leitura) que investiga o projeto e retorna um resumo. Use para buscas complexas, exploração de código ou análises paralelas sem poluir o contexto do agente principal.',
        parameters: {
            type: 'object',
            properties: { descricao: { type: 'string', description: 'Descrição detalhada da subtarefa a ser executada pelo subagente' } },
            required: ['descricao']
        }
    },
    question: {
        name: 'question',
        description: 'Faz uma pergunta ao usuário e aguarda a resposta. Use quando precisar de uma decisão, esclarecimento ou preferência do usuário durante a execução.',
        parameters: {
            type: 'object',
            properties: { pergunta: { type: 'string', description: 'A pergunta a ser feita ao usuário' } },
            required: ['pergunta']
        }
    },
    parallel_task: {
        name: 'parallel_task',
        description: 'Executa várias subtarefas de investigação EM PARALELO (somente leitura) e retorna um resumo de cada uma. Use para investigar áreas independentes do código de uma só vez, sem poluir o contexto do agente principal.',
        parameters: {
            type: 'object',
            properties: {
                tarefas: {
                    type: 'array',
                    description: 'Lista de descrições de subtarefas (máximo 3)',
                    items: { type: 'string' }
                }
            },
            required: ['tarefas']
        }
    },
    parallel_write: {
        name: 'parallel_write',
        description: 'Aplica alterações em VÁRIOS arquivos independentes EM PARALELO. Cada item indica o arquivo a modificar e o que fazer nele. Use apenas para mudanças em arquivos que NÃO dependem um do outro, para acelerar a escrita.',
        parameters: {
            type: 'object',
            properties: {
                tarefas: {
                    type: 'array',
                    description: 'Lista de { caminho, descricao } (máximo 3, arquivos distintos)',
                    items: { type: 'object', properties: { caminho: { type: 'string' }, descricao: { type: 'string' } } }
                }
            },
            required: ['tarefas']
        }
    },
    todo: {
        name: 'todo',
        description: 'Cria ou atualiza a lista de tarefas do plano atual. Use para expor um plano rastreável do trabalho em andamento.',
        parameters: {
            type: 'object',
            properties: {
                tarefas: {
                    type: 'array',
                    description: 'Lista de tarefas, cada uma como { "titulo": "...", "status": "pending|in_progress|completed" }',
                    items: { type: 'object', properties: { titulo: { type: 'string' }, status: { type: 'string' } } }
                }
            },
            required: ['tarefas']
        }
    }
};

const AGENT_TOOLS = Object.values(TOOL_SCHEMAS).map(t => ({
    name: t.name,
    description: t.description,
    parameters: Object.fromEntries(
        Object.entries(t.parameters.properties || {}).map(([k, v]) => [k, v.description || v.type || 'string'])
    )
}));

function stripBOM(text) {
    return typeof text === 'string' ? text.replace(/^\uFEFF+/, '') : text;
}

function normalizeLine(line) {
    return line.trim().replace(/\s+/g, ' ');
}

function replaceIgnoringIndent(content, pattern, replacement) {
    const pLines = pattern.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (!pLines.length) return content;
    const pNormalized = pLines.map(normalizeLine);
    const cLines = content.split('\n');
    for (let i = 0; i <= cLines.length - pLines.length; i++) {
        let ok = true;
        for (let j = 0; j < pLines.length; j++) {
            if (normalizeLine(cLines[i + j]) !== pNormalized[j]) { ok = false; break; }
        }
        if (ok) {
            const indent = (cLines[i].match(/^\s*/) || [''])[0];
            const rLines = replacement.split('\n').map((l, idx) => idx === 0 ? indent + l.trim() : l);
            cLines.splice(i, pLines.length, ...rLines);
            return cLines.join('\n');
        }
    }
    return content;
}

function replaceInContent(content, pattern, replacement) {
    if (content.includes(pattern)) {
        return { content: content.split(pattern).join(replacement), matched: true };
    }
    let matched = false;
    try {
        const regex = new RegExp(pattern, 'g');
        const replaced = content.replace(regex, replacement);
        if (replaced !== content) { content = replaced; matched = true; }
    } catch (e) {}
    if (!matched) {
        const normalized = replaceIgnoringIndent(content, pattern, replacement);
        if (normalized !== content) { content = normalized; matched = true; }
    }
    if (!matched) {
        const lines = content.split('\n');
        const pLines = pattern.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let found = false;
        for (let i = 0; i < lines.length && !found; i++) {
            const trimmed = lines[i].trim();
            if (!trimmed) continue;
            for (const p of pLines) {
                if (p && trimmed.includes(p)) {
                    lines[i] = lines[i].replace(p, replacement.trim());
                    found = true;
                    break;
                }
            }
        }
        if (found) { content = lines.join('\n'); matched = true; }
    }
    return { content, matched };
}

function getAllToolDeclarations(mcpManager) {
    const builtin = Object.values(TOOL_SCHEMAS);
    const mcpTools = (mcpManager ? mcpManager.getAllTools() : []).map(t => ({
        name: t.name,
        description: t.description,
        parameters: { type: 'object', properties: t.parameters || {}, required: Object.keys(t.parameters || {}) }
    }));
    return [...builtin, ...mcpTools];
}

// Ferramentas avançadas/raras, escondidas em tarefas simples: menos tokens no
// schema (custo) e menos chance de o agente escolher uma ferramenta inadequada.
const ADVANCED_TOOLS = new Set(['generate_tests', 'browser_navigate', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_evaluate', 'browser_console', 'browser_content', 'git_publish', 'git_push', 'git_pull', 'git_branch', 'git_log', 'git_stash', 'snapshot_create', 'snapshot_list', 'snapshot_restore', 'debug_start', 'debug_stop', 'debug_step', 'debug_resume', 'ssh_exec', 'ssh_status', 'docker_run', 'task', 'parallel_task', 'parallel_write']);

function getAgentToolsForMode(mode, mcpManager, isSimple) {
    const allTools = getAllToolDeclarations(mcpManager);
    if (mode === 'review' || mode === 'plan') {
        return allTools.filter(t => !['write_file', 'apply_patch', 'delete_file', 'search_replace', 'file_rename', 'exec_command', 'git_commit', 'git_push', 'git_publish', 'docker_run', 'ssh_exec', 'undo', 'redo', 'snapshot_restore', 'browser_navigate', 'browser_click', 'browser_type', 'task', 'parallel_task', 'parallel_write'].includes(t.name));
    }
    if (mode === 'write_subagent') {
        return allTools.filter(t => ['read_file', 'list_files', 'search_code', 'analyzer_symbols', 'analyzer_validate', 'apply_patch', 'write_file', 'search_replace'].includes(t.name));
    }
    if (isSimple) {
        return allTools.filter(t => !ADVANCED_TOOLS.has(t.name));
    }
    return allTools;
}

async function executeAgentTool(name, args) {
    const ctx = _ctx;
    if (!ctx) throw new Error('Contexto de ferramentas não inicializado');
    const resolveSafePath = ctx.resolveSafePath;
    const PROJECT_ROOT = ctx.projectRoot;
    const runQuickTest = ctx.runQuickTest;
    const listDirectory = ctx.listDirectory;
    const getAllFiles = ctx.getAllFiles;
    const validateAgentCommand = ctx.validateAgentCommand;
    const agentStreamCallback = ctx.agentStreamCallback;
    const registerChildProcess = ctx.registerChildProcess;
    const killChildTree = ctx.killChildTree;
    const getTestFilePath = ctx.getTestFilePath;
    const buildTestPrompt = ctx.buildTestPrompt;
    const callAI = ctx.callAI;
    const runGit = ctx.runGit;
    const nextVersion = ctx.nextVersion;
    const latestVersionTag = ctx.latestVersionTag;
    const BACKUP_DIR_NAME = ctx.BACKUP_DIR_NAME;
    const copyDirContents = ctx.copyDirContents;
    const restoreSnapshot = ctx.restoreSnapshot;
    const undoLastChange = ctx.undoLastChange;
    const redoLastChange = ctx.redoLastChange;
    const backupFromContent = ctx.backupFromContent;
    const invalidateProjectCache = ctx.invalidateProjectCache;
    const runAgentLoop = ctx.runAgentLoop;
    const requestUserInteraction = ctx.requestUserInteraction;
    const mcpManager = ctx.mcpManager;
    const _currentAgentProvider = ctx.currentAgentProvider;
    const _currentAgentSignal = ctx.currentAgentSignal;
    let _agentTodos = ctx.agentTodos;
    let _awaitingUserAnswer = ctx.awaitingUserAnswer;
    try {
        switch (name) {
            case 'read_file': {
                const full = resolveSafePath(args.caminho || '');
                if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
                const content = stripBOM(fs.readFileSync(full, 'utf-8')).slice(0, 50000);
                // Retorna o conteúdo limpo, como o opencode — sem o bloco de
                // diagnóstico que inflava o contexto e fazia o modelo ficar
                // "analisando" em vez de corrigir. A validação acontece no
                // write_file/analyzer_validate, não a cada leitura.
                return content;
            }
            case 'write_file': {
                const full = resolveSafePath(args.caminho || '');
                if (!full) return 'Erro: caminho inválido';
                const dir = path.dirname(full);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                const cleanContent = stripBOM(args.conteudo || '');
                fs.writeFileSync(full, cleanContent, 'utf-8');
                const ext = path.extname(args.caminho).toLowerCase();
                let result = `Arquivo ${args.caminho} salvo (${cleanContent.length} bytes)`;
                if (['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.c', '.cpp', '.h'].includes(ext)) {
                    try {
                        const validation = analyzer.validateCode(cleanContent, args.caminho, PROJECT_ROOT);
                        const errs = validation.errors.filter(e => e.severity === 'error');
                        const warns = validation.errors.filter(e => e.severity === 'warning');
                        if (errs.length > 0) result += `\n⚠️ ${errs.length} erro(s): ${errs.slice(0, 5).map(e => `Ln ${e.line}: ${e.message}`).join('; ')}`;
                        if (warns.length > 0) result += `\n💡 ${warns.length} aviso(s): ${warns.slice(0, 3).map(e => `Ln ${e.line}: ${e.message}`).join('; ')}`;
                        if (validation.errors.length === 0) result += ' ✅ Validação OK';
                    } catch (e) {}
                }
                try {
                    const testResult = runQuickTest(args.caminho);
                    if (testResult) result += '\n' + testResult;
                } catch (e) {}
                return result;
            }
            case 'delete_file': {
                const full = resolveSafePath(args.caminho || '');
                if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
                fs.unlinkSync(full);
                return `Arquivo ${args.caminho} removido`;
            }
            case 'list_files': {
                const dir = args.diretorio || '';
                const safeDir = resolveSafePath(dir);
                if (!safeDir) return 'Erro: diretório inválido (fora do projeto)';
                const items = listDirectory(safeDir);
                return items.map(i => `${i.isDirectory ? '📂' : '📄'} ${i.name}`).join('\n') || '(vazio)';
            }
            case 'search_code': {
                const dir = args.diretorio || '';
                const basePath = resolveSafePath(dir);
                if (!basePath) return 'Erro: diretório inválido';
                const pattern = args.padrao || '';
                if (!pattern) return 'Erro: padrão vazio';
                const results = [];
                try {
                    const allFiles = getAllFiles(basePath, { n: 0 });
                    // Padrão "gi" é stateful (flag g guarda lastIndex entre test()).
                    // Reinspeita a regex para cada linha, senão test() pula resultados
                    // e o search_code volta "Nenhum resultado" para padrões que existem.
                    const re = new RegExp(pattern, 'gi');
                    // Padrões com [\s\S] indicam busca multiline (trechos de código
                    // multi-linha). Esses precisam rodar contra o arquivo inteiro,
                    // não linha a linha.
                    const multiline = /\[\\s\\S\]/.test(pattern);
                    for (const file of allFiles.slice(0, 200)) {
                        try {
                            // getAllFiles devolve caminho relativo à raiz do projeto.
                            // Sem o join abaixo o readFileSync falha (path relativo ao
                            // cwd) e o search_code voltava "Nenhum resultado" sempre.
                            const abs = path.isAbsolute(file) ? file : path.join(PROJECT_ROOT, file);
                            const content = fs.readFileSync(abs, 'utf-8');
                            if (multiline) {
                                re.lastIndex = 0;
                                const m = re.exec(content);
                                if (m) {
                                    const ln = content.slice(0, m.index).split('\n').length;
                                    results.push(`${path.relative(PROJECT_ROOT, abs)}:${ln}: ${m[0].trim().slice(0, 200)}`);
                                    if (results.length >= 30) break;
                                }
                                continue;
                            }
                            const lines = content.split('\n');
                            for (let i = 0; i < lines.length; i++) {
                                re.lastIndex = 0;
                                if (re.test(lines[i])) {
                                    // Contexto de 2 linhas antes/depois (estilo rg -C 2):
                                    // sem isso o modelo via só a linha do match e perdia a
                                    // cadeia de chamadas (ex.: via "innerHTML" mas não o
                                    // "Seguranca.sanitizarHtml" na linha de cima).
                                    const ctxLines = [];
                                    const start = Math.max(0, i - 2);
                                    const end = Math.min(lines.length, i + 3);
                                    for (let j = start; j < end; j++) {
                                        const marker = j === i ? ' >>>' : '    ';
                                        ctxLines.push(String(j + 1).padStart(4) + marker + ' ' + lines[j].slice(0, 140));
                                    }
                                    results.push(`${path.relative(PROJECT_ROOT, abs)}:${i + 1}:\n${ctxLines.join('\n')}`);
                                    if (results.length >= 30) break;
                                }
                            }
                        } catch (e) {}
                        if (results.length >= 30) break;
                    }
                } catch (e) { return 'Erro ao buscar: ' + e.message; }
                return results.join('\n') || 'Nenhum resultado encontrado';
            }
            case 'exec_command': {
                const cmd = args.comando || '';
                const validationError = validateAgentCommand(cmd);
                if (validationError) return `Erro: ${validationError}`;
                try {
                    if (agentStreamCallback) {
                        agentStreamCallback('Sistema', `$ ${cmd}\n`);
                        const chunks = [];
                        const child = require('child_process').spawn(cmd, [], { cwd: PROJECT_ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
                        registerChildProcess(child);
                        const killTimer = setTimeout(() => killChildTree(child), 30000);
                        child.stdout.on('data', (d) => {
                            const text = d.toString();
                            chunks.push(text);
                            agentStreamCallback('Sistema', text);
                        });
                        child.stderr.on('data', (d) => {
                            const text = d.toString();
                            chunks.push(text);
                            agentStreamCallback('Sistema', text);
                        });
                        const code = await new Promise((resolve) => {
                            child.on('close', (c) => { clearTimeout(killTimer); resolve(c); });
                            child.on('error', () => { clearTimeout(killTimer); resolve(-1); });
                        });
                        const output = chunks.join('').slice(0, 10000);
                        return code === 0 ? (output || '(sem saída)') : `Erro (código ${code}): ${output.slice(0, 2000)}`;
                    } else {
                        const result = require('child_process').execSync(cmd, { cwd: PROJECT_ROOT, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
                        return result.slice(0, 10000) || '(sem saída)';
                    }
                } catch (e) {
                    return `Erro (código ${e.status}): ${(e.stderr || e.message || '').slice(0, 2000)}`;
                }
            }
            case 'generate_tests': {
                const full = resolveSafePath(args.caminho || '');
                if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
                const content = fs.readFileSync(full, 'utf-8');
                const ext = path.extname(args.caminho).toLowerCase();
                const testPath = getTestFilePath(args.caminho);
                if (fs.existsSync(path.join(PROJECT_ROOT, testPath))) return `Arquivo de teste já existe: ${testPath}`;
                const testPrompt = buildTestPrompt(args.caminho, content, ext);
                const provider = 'gemini';
                try {
                    const testCode = await callAI(provider, testPrompt, null, null);
                    const cleanCode = testCode.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
                    if (!cleanCode || cleanCode.length < 20) return 'Erro: IA não gerou código de teste';
                    const testFull = path.join(PROJECT_ROOT, testPath);
                    const testDir = path.dirname(testFull);
                    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
                    fs.writeFileSync(testFull, cleanCode, 'utf-8');
                    const testResult = runQuickTest(args.caminho);
                    return `✅ Teste criado: ${testPath}\n${testResult || 'Teste executado'}`;
                } catch (e) {
                    return `Erro ao gerar testes: ${e.message}`;
                }
            }
            case 'git_publish': {
                try {
                    const status = await runGit(['status', '--porcelain'], PROJECT_ROOT);
                    if (status.code !== 0) return 'Erro: git não encontrado ou projeto não é repositório';
                    const hasChanges = status.output.trim().length > 0;
                    const tag = nextVersion(await latestVersionTag());
                    const commitMsg = args.mensagem || `🔖 versão ${tag}`;
                    if (hasChanges) {
                        await runGit(['add', '-A'], PROJECT_ROOT);
                        await runGit(['commit', '-m', commitMsg], PROJECT_ROOT);
                    }
                    await runGit(['tag', '-a', tag, '-m', `Release ${tag}`], PROJECT_ROOT);
                    await runGit(['push', 'origin', 'HEAD', '--follow-tags'], PROJECT_ROOT);
                    return `✅ Release ${tag} publicada! ${hasChanges ? '(com alterações commitadas)' : '(sem novas alterações)'}`;
                } catch (e) {
                    return `Erro ao publicar: ${e.message}`;
                }
            }
            case 'git_status': {
                try { const r = await runGit(['status'], PROJECT_ROOT); return r.output.trim() || '(working tree limpa)'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'git_diff': {
                try { const r = await runGit(['diff'], PROJECT_ROOT); return r.output.slice(0, 5000).trim() || '(sem alterações)'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'git_log': {
                try { const r = await runGit(['log', '--oneline', '-10'], PROJECT_ROOT); return r.output.trim() || '(sem commits)'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'git_commit': {
                try { await runGit(['add', '-A'], PROJECT_ROOT); const r = await runGit(['commit', '-m', args.mensagem || 'commit'], PROJECT_ROOT); return r.output.trim(); } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'git_push': {
                try { const r = await runGit(['push'], PROJECT_ROOT); return r.output.trim(); } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'git_pull': {
                try { const r = await runGit(['pull'], PROJECT_ROOT); return r.output.trim(); } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'git_branch': {
                try { const r = await runGit(['branch', '-a'], PROJECT_ROOT); return r.output.trim(); } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'git_stash': {
                try { const r = await runGit(['stash', args.acao || 'push'], PROJECT_ROOT); return r.output.trim() || 'ok'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'file_rename': {
                const src = resolveSafePath(args.origem || '');
                const dst = resolveSafePath(args.destino || '');
                if (!src || !dst) return 'Erro: caminho inválido';
                if (!fs.existsSync(src)) return 'Erro: arquivo origem não encontrado';
                try { fs.renameSync(src, dst); return `Renomeado: ${args.origem} → ${args.destino}`; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'file_mkdir': {
                const dir = resolveSafePath(args.caminho || '');
                if (!dir) return 'Erro: caminho inválido';
                try { fs.mkdirSync(dir, { recursive: true }); return `Diretório criado: ${args.caminho}`; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'analyzer_validate': {
                const f = resolveSafePath(args.caminho || '');
                if (!f || !fs.existsSync(f)) return 'Erro: arquivo não encontrado';
                try { const content = fs.readFileSync(f, 'utf-8'); const v = analyzer.validateCode(content, args.caminho, PROJECT_ROOT); return v.errors.length ? v.errors.slice(0, 20).map(e => `Ln ${e.line}: [${e.severity}] ${e.message}`).join('\n') : '✅ Nenhum erro encontrado'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'analyzer_symbols': {
                const f = resolveSafePath(args.caminho || '');
                if (!f || !fs.existsSync(f)) return 'Erro: arquivo não encontrado';
                try { const content = fs.readFileSync(f, 'utf-8'); const ext = path.extname(args.caminho).toLowerCase(); let sym = []; if (['.js','.ts','.jsx','.tsx'].includes(ext)) sym = analyzer.getTSSymbols(args.caminho, PROJECT_ROOT); else if (ext === '.py') sym = analyzer.getPythonSymbols(args.caminho, PROJECT_ROOT); else if (ext === '.go') sym = analyzer.getGoSymbols(args.caminho, PROJECT_ROOT); return sym.map(s => `${s.kind} ${s.name} (ln ${s.line})`).join('\n') || '(nenhum símbolo)'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'test_run': {
                try { const result = runner.runCommandSync ? runner.runCommandSync('npm test', { cwd: PROJECT_ROOT, timeoutMs: 60000 }) : await runner.runCommand({ command: 'npm test', cwd: PROJECT_ROOT, timeoutMs: 60000 }); const r = result.stdout || result.output || ''; return r.slice(0, 5000).trim() || '(sem saída)'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'snapshot_create': {
                try { const label = args.rotulo || `snapshot-${Date.now()}`; const snapDir = path.join(PROJECT_ROOT, BACKUP_DIR_NAME, 'snapshots', label); if (fs.existsSync(snapDir)) return 'Erro: snapshot já existe com esse rótulo'; fs.mkdirSync(snapDir, { recursive: true }); copyDirContents(PROJECT_ROOT, snapDir, new Set(['node_modules', '.git', 'dist', 'build', BACKUP_DIR_NAME])); return `✅ Snapshot '${label}' criado`; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'snapshot_list': {
                try { const snapDir = path.join(PROJECT_ROOT, BACKUP_DIR_NAME, 'snapshots'); if (!fs.existsSync(snapDir)) return '(nenhum snapshot)'; return fs.readdirSync(snapDir).map(d => { const stat = fs.statSync(path.join(snapDir, d)); return `${d} (${stat.mtime.toISOString().slice(0, 10)})`; }).join('\n') || '(nenhum snapshot)'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'snapshot_restore': {
                try { const label = args.rotulo; if (!label) return 'Erro: informe o rótulo do snapshot'; const snapDir = path.join(PROJECT_ROOT, BACKUP_DIR_NAME, 'snapshots', label); if (!fs.existsSync(snapDir)) return 'Erro: snapshot não encontrado'; restoreSnapshot(label); return `✅ Projeto restaurado para snapshot '${label}'`; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'debug_start': {
                try { const f = resolveSafePath(args.arquivo || ''); if (!f || !fs.existsSync(f)) return 'Erro: arquivo não encontrado'; if (debuggerRunner.isRunning()) return 'Erro: já existe debug ativo'; await debuggerRunner.startDebug({ file: f, onEvent: () => {} }); return `✅ Debug iniciado: ${args.arquivo}`; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'debug_stop': {
                try { const r = debuggerRunner.stopDebug(); return r ? '✅ Debug parado' : 'Nenhum debug ativo'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'debug_step': {
                try { if (!debuggerRunner.isRunning()) return 'Erro: nenhum debug ativo'; const r = await debuggerRunner.stepOver(); return JSON.stringify(r); } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'debug_resume': {
                try { if (!debuggerRunner.isRunning()) return 'Erro: nenhum debug ativo'; const r = await debuggerRunner.resume(); return JSON.stringify(r); } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'ssh_exec': {
                try { if (!remote.isConnected()) return 'Erro: nenhuma conexão SSH ativa'; const r = await remote.execRemote(args.comando || ''); return r || '(sem saída)'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'ssh_status': {
                try { return JSON.stringify(remote.getStatus()); } catch (e) { return 'Desconectado'; }
            }
            case 'docker_run': {
                const fullCmd = `docker ${String(args.comando || 'ps').trim()}`;
                const validationError = validateAgentCommand(fullCmd);
                if (validationError) return `Erro: ${validationError}`;
                try { const r = await runner.runCommand({ command: fullCmd, cwd: PROJECT_ROOT, timeoutMs: 30000 }); return (r.stdout || r.output || '').slice(0, 3000).trim() || '(sem saída)'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'undo': {
                try { const r = await undoLastChange(); return r || 'Nada para desfazer'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'redo': {
                try { const r = await redoLastChange(); return r || 'Nada para refazer'; } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'search_replace': {
                try {
                    const base = resolveSafePath(args.caminho || '');
                    const pattern = stripBOM(args.padrao || '');
                    const replacement = args.substituto || '';
                    if (!pattern) return 'Erro: informe o padrão';
                    const files = base && fs.existsSync(base) ? (fs.statSync(base).isDirectory() ? getAllFiles(base, { n: 0 }).slice(0, 50) : [base]) : getAllFiles(PROJECT_ROOT, { n: 0 }).slice(0, 50);
                    let count = 0;
                    for (const f of files) {
                        if (!fs.statSync(f).isFile()) continue;
                        const content = stripBOM(fs.readFileSync(f, 'utf-8'));
                        const before = content;
                        const { content: newContent, matched } = replaceInContent(content, pattern, replacement);
                        if (matched && newContent !== before) {
                            backupFromContent(path.relative(PROJECT_ROOT, f), before);
                            fs.writeFileSync(f, newContent, 'utf-8');
                            count++;
                        }
                    }
                    return count > 0 ? `${count} arquivo(s) alterado(s)` : 'Nenhum arquivo alterado (padrão não encontrado em nenhum arquivo). Tente usar write_file para reescrever o arquivo inteiro.';
                } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'apply_patch': {
                try {
                    const full = resolveSafePath(args.file_path || args.caminho || '');
                    if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
                    const oldStr = stripBOM(args.old_string || '');
                    const newStr = args.new_string || '';
                    if (!oldStr) return 'Erro: informe old_string';
                    const content = stripBOM(fs.readFileSync(full, 'utf-8'));
                    const { content: newContent, matched } = replaceInContent(content, oldStr, newStr);
                    if (!matched || newContent === content) {
                        return 'Erro: old_string não encontrado no arquivo. Releia o trecho exato com read_file e tente novamente, ou use write_file para reescrever o arquivo inteiro.';
                    }
                    backupFromContent(path.relative(PROJECT_ROOT, full), content);
                    fs.writeFileSync(full, newContent, 'utf-8');
                    invalidateProjectCache();
                    return 'Patch aplicado com sucesso.';
                } catch (e) { return `Erro: ${e.message}`; }
            }
            case 'task': {
                const descricao = args.descricao || args.task || '';
                if (!descricao) return 'Erro: descrição da subtarefa vazia';
                const subProvider = _currentAgentProvider || 'gemini';
                const subSignal = _currentAgentSignal || null;
                const subPrompt = `Você é um subagente de investigação. Execute APENAS esta subtarefa e retorne um resumo conciso do resultado.\n\nSUBTAREFA: ${descricao}\n\nUse as ferramentas de leitura (read_file, search_code, list_files, analyzer_symbols) para investigar. NÃO modifique arquivos.`;
                try {
                    const summary = await runAgentLoop(subPrompt, null, subSignal, 'plan', [], subProvider);
                    return summary ? `Subagente concluído: ${summary.slice(0, 2000)}` : 'Subagente concluído sem resumo';
                } catch (e) {
                    return `Erro no subagente: ${e.message}`;
                }
            }
            case 'parallel_task': {
                const lista = Array.isArray(args.tarefas) ? args.tarefas : [];
                const subProvider = _currentAgentProvider || 'gemini';
                const subSignal = _currentAgentSignal || null;
                const tasks = lista.slice(0, 3).map(d => String(d || '').trim()).filter(Boolean);
                if (!tasks.length) return 'Erro: informe uma lista de subtarefas';
                const runOne = async (descricao) => {
                    const subPrompt = `Você é um subagente de investigação. Execute APENAS esta subtarefa e retorne um resumo conciso (máximo 150 palavras).\n\nSUBTAREFA: ${descricao}\n\nUse as ferramentas de leitura (read_file, search_code, list_files, analyzer_symbols) para investigar. NÃO modifique arquivos.`;
                    try {
                        const summary = await runAgentLoop(subPrompt, null, subSignal, 'plan', [], subProvider);
                        return `[${descricao.slice(0, 60)}] ${summary ? String(summary).slice(0, 1200) : 'sem resumo'}`;
                    } catch (e) {
                        return `[${descricao.slice(0, 60)}] Erro: ${e.message}`;
                    }
                };
                const results = await Promise.all(tasks.map(runOne));
                return `Subagentes paralelos concluídos (${results.length}):\n\n${results.join('\n\n')}`;
            }
            case 'parallel_write': {
                const lista = Array.isArray(args.tarefas) ? args.tarefas : [];
                const subProvider = _currentAgentProvider || 'gemini';
                const subSignal = _currentAgentSignal || null;
                const seenFiles = new Set();
                const tasks = [];
                for (const t of lista.slice(0, 3)) {
                    const caminho = String((t && t.caminho) || '').trim();
                    const descricao = String((t && t.descricao) || '').trim();
                    if (!caminho || !descricao || seenFiles.has(caminho)) continue;
                    seenFiles.add(caminho);
                    tasks.push({ caminho, descricao });
                }
                if (!tasks.length) return 'Erro: informe uma lista de { caminho, descricao } (arquivos distintos)';
                const runOne = async ({ caminho, descricao }) => {
                    const subPrompt = `Você é um subagente de edição. Modifique APENAS o arquivo "${caminho}" conforme a tarefa. Leia o arquivo (read_file) e aplique a mudança com apply_patch (edição cirúrgica) ou write_file (reescrita). NÃO altere NENHUM outro arquivo.\n\nTAREFA: ${descricao}\n\nAo final, responda em 1 linha o que foi alterado.`;
                    try {
                        const summary = await runAgentLoop(subPrompt, null, subSignal, 'write_subagent', [], subProvider);
                        return `[${caminho}] ${summary ? String(summary).slice(0, 800) : 'sem resumo'}`;
                    } catch (e) {
                        return `[${caminho}] Erro: ${e.message}`;
                    }
                };
                const results = await Promise.all(tasks.map(runOne));
                invalidateProjectCache();
                analyzer.invalidateIndex();
                return `Edição paralela concluída (${results.length}):\n\n${results.join('\n\n')}`;
            }
            case 'question': {
                const pergunta = args.pergunta || args.question || '';
                if (!pergunta) return 'Erro: pergunta vazia';
                const response = await requestUserInteraction('question', { pergunta }, _currentAgentSignal || null);
                if (!response || !response.resposta) {
                    // Sem resposta: pausa a tarefa em vez de o agente inventar uma
                    // direção e prosseguir. Aborta o sinal para encerrar o loop e
                    // sinaliza ao stream handler para mostrar "aguardando resposta".
                    _awaitingUserAnswer = true;
                    if (_currentAgentSignal) { try { _currentAgentSignal.abort(); } catch (e) {} }
                    throw new Error('Pergunta sem resposta — tarefa pausada aguardando o usuário.');
                }
                return `Resposta do usuário: ${response.resposta}`;
            }
            case 'todo': {
                const tarefas = Array.isArray(args.tarefas) ? args.tarefas : [];
                _agentTodos = tarefas.map((t, i) => {
                    const titulo = typeof t === 'string' ? t : (t.titulo || t.title || 'Tarefa ' + (i + 1));
                    const status = typeof t === 'string' ? 'pending' : (t.status || 'pending');
                    return { titulo, status };
                });
                const list = _agentTodos.map((t, i) => `${i + 1}. [${t.status}] ${t.titulo}`).join('\n');
                if (agentStreamCallback) agentStreamCallback('todo', JSON.stringify(_agentTodos));
                return `Plano de tarefas atualizado:\n${list || '(vazio)'}`;
            }
            default: {
                if (name === 'browser_content') {
                    try { return await executeBrowserTool(name, {}); } catch (e) { return `Erro Browser: ${e.message}`; }
                }
                if (name.startsWith('mcp_')) {
                    try { return await mcpManager.executeTool(name, args); }
                    catch (e) { return `Erro MCP: ${e.message}`; }
                }
                if (name.startsWith('browser_')) {
                    try { return await executeBrowserTool(name, args); }
                    catch (e) { return `Erro Browser: ${e.message}`; }
                }
                return 'Erro: ferramenta desconhecida';
            }
        }

    } finally {
        ctx.agentTodos = _agentTodos;
        ctx.awaitingUserAnswer = _awaitingUserAnswer;
    }
}

module.exports = {
    TOOL_SCHEMAS,
    AGENT_TOOLS,
    ADVANCED_TOOLS,
    stripBOM,
    normalizeLine,
    replaceIgnoringIndent,
    replaceInContent,
    getAllToolDeclarations,
    getAgentToolsForMode,
    setToolContext,
    executeAgentTool
};
