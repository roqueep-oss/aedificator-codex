#!/usr/bin/env node
// MCP Server — expõe ferramentas do Aedificator para OpenCode CLI
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const readline = require('readline');

const PROJECT_ROOT = process.env.AED_PROJECT_ROOT || process.cwd();

function runGit(args) {
    try {
        const result = execSync(`git ${args.join(' ')}`, { cwd: PROJECT_ROOT, encoding: 'utf-8', timeout: 15000, windowsHide: true });
        return result.trim();
    } catch (e) {
        return e.stderr || e.stdout || e.message || 'erro';
    }
}

function resolveSafe(rel) {
    if (!rel) return null;
    const full = path.resolve(PROJECT_ROOT, rel);
    if (!full.startsWith(path.resolve(PROJECT_ROOT) + path.sep) && full !== path.resolve(PROJECT_ROOT)) return null;
    return full;
}

function listDir(dir) {
    const target = resolveSafe(dir || '') || PROJECT_ROOT;
    try {
        return fs.readdirSync(target, { withFileTypes: true }).map(d => ({ name: d.name, isDir: d.isDirectory() }));
    } catch (e) { return []; }
}

function getAllFiles(d, limit) {
    const files = [];
    const root = resolveSafe(d) || PROJECT_ROOT;
    function walk(dir) {
        if (files.length >= limit) return;
        try {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const fp = path.join(dir, e.name);
                if (e.isDirectory()) { if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(fp); }
                else files.push(fp);
            }
        } catch (_) {}
    }
    walk(root);
    return files;
}

function nextVersion(last) {
    const m = (last || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
    if (!m) return 'v1.0.0';
    return `v${m[1]}.${m[2]}.${parseInt(m[3]) + 1}`;
}

function latestVersionTag() {
    return runGit(['tag', '--sort=-v:refname']).split('\n')[0] || '';
}

function stripBOM(text) {
    return typeof text === 'string' ? text.replace(/^\uFEFF+/, '') : text;
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
        const pLines = pattern.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const cLines = content.split('\n');
        for (let i = 0; i <= cLines.length - pLines.length && !matched; i++) {
            let ok = true;
            for (let j = 0; j < pLines.length; j++) {
                if (cLines[i + j].trim() !== pLines[j]) { ok = false; break; }
            }
            if (ok) {
                const indent = (cLines[i].match(/^\s*/) || [''])[0];
                const rLines = replacement.split('\n').map((l, idx) => idx === 0 ? indent + l.trim() : l);
                cLines.splice(i, pLines.length, ...rLines);
                content = cLines.join('\n');
                matched = true;
            }
        }
    }
    return { content, matched };
}

const TOOLS = [
    { name: 'read_file', description: 'Lê conteúdo de um arquivo', inputSchema: { type: 'object', properties: { caminho: { type: 'string' } }, required: ['caminho'] } },
    { name: 'write_file', description: 'Cria ou sobrescreve um arquivo', inputSchema: { type: 'object', properties: { caminho: { type: 'string' }, conteudo: { type: 'string' } }, required: ['caminho', 'conteudo'] } },
    { name: 'delete_file', description: 'Remove um arquivo', inputSchema: { type: 'object', properties: { caminho: { type: 'string' } }, required: ['caminho'] } },
    { name: 'list_files', description: 'Lista arquivos e pastas', inputSchema: { type: 'object', properties: { diretorio: { type: 'string' } } } },
    { name: 'search_code', description: 'Busca regex nos arquivos', inputSchema: { type: 'object', properties: { padrao: { type: 'string' }, diretorio: { type: 'string' } }, required: ['padrao'] } },
    { name: 'exec_command', description: 'Executa comando shell', inputSchema: { type: 'object', properties: { comando: { type: 'string' } }, required: ['comando'] } },
    { name: 'git_status', description: 'Status do git', inputSchema: { type: 'object', properties: {} } },
    { name: 'git_diff', description: 'Diff das alterações', inputSchema: { type: 'object', properties: {} } },
    { name: 'git_log', description: 'Histórico de commits', inputSchema: { type: 'object', properties: {} } },
    { name: 'git_commit', description: 'Commit das alterações', inputSchema: { type: 'object', properties: { mensagem: { type: 'string' } }, required: ['mensagem'] } },
    { name: 'git_push', description: 'Push para remote', inputSchema: { type: 'object', properties: {} } },
    { name: 'git_pull', description: 'Pull do remote', inputSchema: { type: 'object', properties: {} } },
    { name: 'git_branch', description: 'Lista branches', inputSchema: { type: 'object', properties: {} } },
    { name: 'git_stash', description: 'Stash push/pop', inputSchema: { type: 'object', properties: { acao: { type: 'string' } }, required: ['acao'] } },
    { name: 'git_publish', description: 'Publica release (commit+tag+push)', inputSchema: { type: 'object', properties: { mensagem: { type: 'string' } } } },
    { name: 'file_rename', description: 'Renomeia/move arquivo', inputSchema: { type: 'object', properties: { origem: { type: 'string' }, destino: { type: 'string' } }, required: ['origem', 'destino'] } },
    { name: 'file_mkdir', description: 'Cria diretório', inputSchema: { type: 'object', properties: { caminho: { type: 'string' } }, required: ['caminho'] } },
    { name: 'test_run', description: 'Executa npm test', inputSchema: { type: 'object', properties: {} } },
    { name: 'search_replace', description: 'Busca e substitui texto em arquivos', inputSchema: { type: 'object', properties: { padrao: { type: 'string' }, substituto: { type: 'string' }, caminho: { type: 'string' } }, required: ['padrao', 'substituto'] } },
];

async function executeTool(name, args) {
    try {
        switch (name) {
            case 'read_file': {
                const f = resolveSafe(args.caminho);
                if (!f || !fs.existsSync(f)) return 'Erro: arquivo não encontrado';
                return fs.readFileSync(f, 'utf-8').replace(/^\uFEFF+/, '').slice(0, 50000);
            }
            case 'write_file': {
                const f = resolveSafe(args.caminho);
                if (!f) return 'Erro: caminho inválido';
                fs.mkdirSync(path.dirname(f), { recursive: true });
                const cleanContent = String(args.conteudo || '').replace(/^\uFEFF+/, '');
                fs.writeFileSync(f, cleanContent, 'utf-8');
                return `Arquivo ${args.caminho} salvo (${cleanContent.length} bytes)`;
            }
            case 'delete_file': {
                const f = resolveSafe(args.caminho);
                if (!f || !fs.existsSync(f)) return 'Erro: arquivo não encontrado';
                fs.unlinkSync(f);
                return `Arquivo ${args.caminho} removido`;
            }
            case 'list_files': {
                const items = listDir(args.diretorio || '');
                return items.map(i => `${i.isDir ? '📂' : '📄'} ${i.name}`).join('\n') || '(vazio)';
            }
            case 'search_code': {
                const base = resolveSafe(args.diretorio || '') || PROJECT_ROOT;
                const pattern = args.padrao;
                if (!pattern) return 'Erro: padrão vazio';
                const results = [];
                const regex = new RegExp(pattern, 'gi');
                for (const file of getAllFiles(base, 200)) {
                    try {
                        const content = fs.readFileSync(file, 'utf-8');
                        const lines = content.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            if (regex.test(lines[i])) {
                                results.push(`${path.relative(PROJECT_ROOT, file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                                if (results.length >= 30) break;
                            }
                        }
                    } catch (_) {}
                    if (results.length >= 30) break;
                }
                return results.join('\n') || 'Nenhum resultado';
            }
            case 'exec_command': {
                const cmd = args.comando;
                if (!cmd) return 'Erro: comando vazio';
                try {
                    const r = execSync(cmd, { cwd: PROJECT_ROOT, timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true });
                    return r.slice(0, 10000) || '(sem saída)';
                } catch (e) {
                    return `Erro (${e.status}): ${(e.stderr || e.message).slice(0, 2000)}`;
                }
            }
            case 'git_status': return runGit(['status']) || '(limpo)';
            case 'git_diff': return runGit(['diff']).slice(0, 5000) || '(sem alterações)';
            case 'git_log': return runGit(['log', '--oneline', '-10']) || '(sem commits)';
            case 'git_commit': runGit(['add', '-A']); return runGit(['commit', '-m', args.mensagem || 'commit']);
            case 'git_push': return runGit(['push']);
            case 'git_pull': return runGit(['pull']);
            case 'git_branch': return runGit(['branch', '-a']);
            case 'git_stash': return runGit(['stash', args.acao || 'push']) || 'ok';
            case 'git_publish': {
                const status = runGit(['status', '--porcelain']);
                const hasChanges = status.length > 0;
                const tag = nextVersion(latestVersionTag());
                const msg = args.mensagem || `🔖 ${tag}`;
                if (hasChanges) { runGit(['add', '-A']); runGit(['commit', '-m', msg]); }
                runGit(['tag', '-a', tag, '-m', `Release ${tag}`]);
                runGit(['push', 'origin', 'HEAD', '--follow-tags']);
                return `✅ Release ${tag} publicada!`;
            }
            case 'file_rename': {
                const src = resolveSafe(args.origem);
                const dst = resolveSafe(args.destino);
                if (!src || !dst) return 'Erro: caminho inválido';
                fs.renameSync(src, dst);
                return `Renomeado: ${args.origem} → ${args.destino}`;
            }
            case 'file_mkdir': {
                const d = resolveSafe(args.caminho);
                if (!d) return 'Erro: caminho inválido';
                fs.mkdirSync(d, { recursive: true });
                return `Diretório criado: ${args.caminho}`;
            }
            case 'test_run': {
                try {
                    const r = execSync('npm test', { cwd: PROJECT_ROOT, timeout: 60000, encoding: 'utf-8', maxBuffer: 1024 * 1024, windowsHide: true });
                    return r.slice(0, 5000) || '(sem saída)';
                } catch (e) { return `Testes falharam:\n${(e.stdout || e.stderr || e.message).slice(0, 3000)}`; }
            }
            case 'search_replace': {
                const base = resolveSafe(args.caminho || '');
                const files = base && fs.existsSync(base) ? (fs.statSync(base).isDirectory() ? getAllFiles(base, 50) : [base]) : getAllFiles(PROJECT_ROOT, 50);
                let count = 0;
                for (const f of files) {
                    try {
                        const content = stripBOM(fs.readFileSync(f, 'utf-8'));
                        const before = content;
                        const { content: newContent, matched } = replaceInContent(content, String(args.padrao || ''), String(args.substituto || ''));
                        if (matched && newContent !== before) { fs.writeFileSync(f, newContent, 'utf-8'); count++; }
                    } catch (_) {}
                }
                return count > 0 ? `${count} arquivo(s) alterado(s)` : 'Nenhum arquivo alterado';
            }
            default: return `Ferramenta: ${name}`;
        }
    } catch (e) {
        return `Erro: ${e.message}`;
    }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
    try {
        const msg = JSON.parse(line);
        const id = msg.id;
        if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'aedificator', version: '1.0.0' }, capabilities: { tools: {} } } }) + '\n');
        } else if (msg.method === 'tools/list') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: TOOLS } }) + '\n');
        } else if (msg.method === 'tools/call') {
            const { name, arguments: args } = msg.params || {};
            const result = await executeTool(name, args || {});
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(result).slice(0, 10000) }] } }) + '\n');
        }
    } catch (e) {}
});

process.stderr.write(`[mcp-aedificator] Pronto — ${PROJECT_ROOT}\n`);
