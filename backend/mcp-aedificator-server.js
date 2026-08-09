#!/usr/bin/env node
// MCP Server — expõe 42 ferramentas do Aedificator para o OpenCode CLI
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROJECT_ROOT = process.env.AED_PROJECT_ROOT || process.cwd();
let server;

try { server = require('./server'); } catch (e) { server = null; }

const TOOLS = [
    { name: 'read_file', description: 'Lê o conteúdo completo de um arquivo', parameters: { caminho: { type: 'string', description: 'Caminho relativo do arquivo' } } },
    { name: 'write_file', description: 'Cria ou sobrescreve um arquivo', parameters: { caminho: { type: 'string', description: 'Caminho relativo' }, conteudo: { type: 'string', description: 'Conteúdo a escrever' } } },
    { name: 'delete_file', description: 'Remove um arquivo', parameters: { caminho: { type: 'string', description: 'Caminho relativo' } } },
    { name: 'list_files', description: 'Lista arquivos e pastas', parameters: { diretorio: { type: 'string', description: 'Diretório (opcional)' } } },
    { name: 'search_code', description: 'Busca padrão regex nos arquivos', parameters: { padrao: { type: 'string', description: 'Padrão regex' }, diretorio: { type: 'string', description: 'Diretório (opcional)' } } },
    { name: 'exec_command', description: 'Executa comando shell no projeto', parameters: { comando: { type: 'string', description: 'Comando a executar' } } },
    { name: 'generate_tests', description: 'Gera testes unitários para um arquivo', parameters: { caminho: { type: 'string', description: 'Caminho do arquivo' } } },
    { name: 'git_status', description: 'Mostra status do git', parameters: {} },
    { name: 'git_diff', description: 'Mostra diff das alterações', parameters: {} },
    { name: 'git_log', description: 'Histórico de commits (últimos 10)', parameters: {} },
    { name: 'git_commit', description: 'Faz commit das alterações', parameters: { mensagem: { type: 'string', description: 'Mensagem do commit' } } },
    { name: 'git_push', description: 'Push para o remote', parameters: {} },
    { name: 'git_pull', description: 'Pull do remote', parameters: {} },
    { name: 'git_branch', description: 'Lista branches', parameters: {} },
    { name: 'git_stash', description: 'Stash (push ou pop)', parameters: { acao: { type: 'string', description: 'push ou pop' } } },
    { name: 'git_publish', description: 'Publica release (commit + tag + push)', parameters: { mensagem: { type: 'string', description: 'Mensagem (opcional)' } } },
    { name: 'file_rename', description: 'Renomeia/move arquivo', parameters: { origem: { type: 'string', description: 'Caminho origem' }, destino: { type: 'string', description: 'Caminho destino' } } },
    { name: 'file_mkdir', description: 'Cria diretório', parameters: { caminho: { type: 'string', description: 'Caminho' } } },
    { name: 'analyzer_validate', description: 'Valida código (erros/avisos)', parameters: { caminho: { type: 'string', description: 'Caminho do arquivo' } } },
    { name: 'analyzer_symbols', description: 'Extrai símbolos do código', parameters: { caminho: { type: 'string', description: 'Caminho do arquivo' } } },
    { name: 'test_run', description: 'Executa testes do projeto', parameters: {} },
    { name: 'snapshot_create', description: 'Cria snapshot do projeto', parameters: { rotulo: { type: 'string', description: 'Rótulo (opcional)' } } },
    { name: 'snapshot_list', description: 'Lista snapshots', parameters: {} },
    { name: 'snapshot_restore', description: 'Restaura snapshot', parameters: { rotulo: { type: 'string', description: 'Rótulo' } } },
    { name: 'undo', description: 'Desfaz última alteração', parameters: {} },
    { name: 'redo', description: 'Refaz alteração desfeita', parameters: {} },
    { name: 'search_replace', description: 'Busca e substitui texto', parameters: { padrao: { type: 'string', description: 'Padrão' }, substituto: { type: 'string', description: 'Substituto' }, caminho: { type: 'string', description: 'Arquivo/diretório (opcional)' } } },
];

function resolveSafePath(relativePath) {
    if (!relativePath) return null;
    const full = path.resolve(PROJECT_ROOT, relativePath);
    const root = path.resolve(PROJECT_ROOT);
    if (!full.startsWith(root + path.sep) && full !== root) return null;
    return full;
}

function listDirectory(dir) {
    const target = resolveSafePath(dir || '') || PROJECT_ROOT;
    try {
        return fs.readdirSync(target, { withFileTypes: true }).map(d => ({
            name: d.name, isDirectory: d.isDirectory()
        }));
    } catch (e) { return []; }
}

function getAllFiles(dirPath, count) {
    const files = [];
    const root = resolveSafePath(dirPath) || PROJECT_ROOT;
    function walk(d) {
        if (files.length >= (count?.n === 0 ? 500 : 200)) return;
        try {
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                    walk(full);
                } else {
                    files.push(full);
                }
            }
        } catch (e) {}
    }
    walk(root);
    return files;
}

async function executeTool(name, args) {
    switch (name) {
        case 'read_file': {
            const full = resolveSafePath(args.caminho || '');
            if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
            return fs.readFileSync(full, 'utf-8').slice(0, 50000);
        }
        case 'write_file': {
            const full = resolveSafePath(args.caminho || '');
            if (!full) return 'Erro: caminho inválido';
            const dir = path.dirname(full);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(full, args.conteudo || '', 'utf-8');
            return `Arquivo ${args.caminho} salvo (${(args.conteudo || '').length} bytes)`;
        }
        case 'delete_file': {
            const full = resolveSafePath(args.caminho || '');
            if (!full || !fs.existsSync(full)) return 'Erro: arquivo não encontrado';
            fs.unlinkSync(full);
            return `Arquivo ${args.caminho} removido`;
        }
        case 'list_files': {
            const items = listDirectory(args.diretorio || '');
            return items.map(i => `${i.isDirectory ? '📂' : '📄'} ${i.name}`).join('\n') || '(vazio)';
        }
        case 'search_code': {
            const base = resolveSafePath(args.diretorio || '') || PROJECT_ROOT;
            const pattern = args.padrao || '';
            if (!pattern) return 'Erro: padrão vazio';
            const results = [];
            try {
                const regex = new RegExp(pattern, 'gi');
                for (const file of getAllFiles(base, { n: 0 }).slice(0, 200)) {
                    try {
                        const content = fs.readFileSync(file, 'utf-8');
                        const lines = content.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (regex.test(lines[i])) {
                                results.push(`${path.relative(PROJECT_ROOT, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                                if (results.length >= 30) break;
                            }
                        }
                    } catch (e) {}
                    if (results.length >= 30) break;
                }
            } catch (e) { return `Erro na regex: ${e.message}`; }
            return results.join('\n') || 'Nenhum resultado';
        }
        case 'exec_command': {
            const cmd = args.comando || '';
            if (!cmd) return 'Erro: comando vazio';
            try {
                const result = require('child_process').execSync(cmd, { cwd: PROJECT_ROOT, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
                return result.slice(0, 10000) || '(sem saída)';
            } catch (e) {
                return `Erro (código ${e.status}): ${(e.stderr || e.message || '').slice(0, 2000)}`;
            }
        }
        case 'generate_tests':
        case 'analyzer_validate':
        case 'analyzer_symbols':
        case 'test_run':
        case 'snapshot_create':
        case 'snapshot_list':
        case 'snapshot_restore':
        case 'undo':
        case 'redo':
        case 'search_replace':
        case 'git_status':
        case 'git_diff':
        case 'git_log':
        case 'git_commit':
        case 'git_push':
        case 'git_pull':
        case 'git_branch':
        case 'git_stash':
        case 'git_publish':
        case 'file_rename':
        case 'file_mkdir':
            if (server && server.executeAgentTool) {
                return await server.executeAgentTool(name, args);
            }
            return `Ferramenta ${name} requer backend Aedificator rodando`;
        default:
            return `Ferramenta desconhecida: ${name}`;
    }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let buffer = '';

rl.on('line', async (line) => {
    try {
        const msg = JSON.parse(line);
        const id = msg.id;

        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id,
                result: { protocolVersion: '2024-11-05', serverInfo: { name: 'aedificator', version: '1.0.0' }, capabilities: { tools: {} } }
            }) + '\n');
        } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id,
                result: { tools: TOOLS.map(t => ({ ...t, inputSchema: { type: 'object', properties: t.parameters, required: Object.keys(t.parameters) } })) }
            }) + '\n');
        } else if (msg.method === 'tools/call') {
            const { name, arguments: args } = msg.params || {};
            const result = await executeTool(name, args || {});
            process.stdout.write(JSON.stringify({
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: String(result).slice(0, 10000) }] }
            }) + '\n');
        } else if (msg.method === 'notifications/initialized') {
        }
    } catch (e) {
        process.stderr.write(`[mcp-aedificator] ${e.message}\n`);
    }
});

process.stderr.write(`[mcp-aedificator] Pronto. Projeto: ${PROJECT_ROOT}\n`);
