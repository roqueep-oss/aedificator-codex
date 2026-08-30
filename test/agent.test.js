const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'aedificator-agent-test-'));

process.env.PROJECT_ROOT = PROJECT_ROOT;

const {
    setProjectRoot,
    executeAgentTool
} = require('../backend/server');

setProjectRoot(PROJECT_ROOT);

test.after(() => {
    try { fs.rmSync(PROJECT_ROOT, { recursive: true, force: true }); } catch (_) {}
});

// ===== read_file =====
test('read_file: lê conteúdo de arquivo existente', async () => {
    const filePath = 'test-read.txt';
    fs.writeFileSync(path.join(PROJECT_ROOT, filePath), 'conteúdo de teste', 'utf-8');

    const result = await executeAgentTool('read_file', { caminho: filePath });
    assert.ok(result.includes('conteúdo de teste'), 'Deve conter o conteúdo do arquivo');
    assert.ok(!result.includes('Erro:'), 'Não deve conter erro');
});

test('read_file: retorna erro para arquivo inexistente', async () => {
    const result = await executeAgentTool('read_file', { caminho: 'nao-existe.txt' });
    assert.ok(result.includes('Erro:'), 'Deve retornar erro');
});

// ===== write_file =====
test('write_file: cria arquivo novo', async () => {
    const filePath = 'test-write-new.js';
    const result = await executeAgentTool('write_file', { caminho: filePath, conteudo: 'const x = 1;' });
    assert.ok(result.includes('salvo'), 'Deve confirmar salvamento');
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, filePath)), 'Arquivo deve existir');
    assert.equal(fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8'), 'const x = 1;');
});

test('write_file: sobrescreve arquivo existente', async () => {
    const filePath = 'test-overwrite.txt';
    fs.writeFileSync(path.join(PROJECT_ROOT, filePath), 'original', 'utf-8');

    const result = await executeAgentTool('write_file', { caminho: filePath, conteudo: 'modificado' });
    assert.ok(result.includes('salvo'), 'Deve confirmar salvamento');
    assert.equal(fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8'), 'modificado');
});

// ===== delete_file =====
test('delete_file: remove arquivo existente', async () => {
    const filePath = 'test-delete.txt';
    fs.writeFileSync(path.join(PROJECT_ROOT, filePath), 'para deletar', 'utf-8');
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, filePath)));

    const result = await executeAgentTool('delete_file', { caminho: filePath });
    assert.ok(result.includes('removido'), 'Deve confirmar remoção');
    assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, filePath)), 'Arquivo deve ser removido');
});

// ===== list_files =====
test('list_files: lista arquivos do diretório', async () => {
    const result = await executeAgentTool('list_files', { diretorio: '' });
    assert.ok(result.includes('test-write-new.js'), 'Deve listar arquivo criado');
    assert.ok(result.includes('test-read.txt'), 'Deve listar arquivo criado');
});

// ===== search_code =====
test('search_code: encontra padrões no código', async () => {
    const result = await executeAgentTool('search_code', { padrao: 'const x' });
    assert.ok(result.includes('test-write-new.js'), 'Deve encontrar o arquivo com o padrão');
    assert.ok(result.includes('const x = 1'), 'Deve mostrar a linha encontrada');
});

test('search_code: retorna vazio para padrão inexistente', async () => {
    const result = await executeAgentTool('search_code', { padrao: 'ZZZ_NAO_EXISTE_ZZZ' });
    assert.ok(!result.includes('test-write-new.js'), 'Não deve encontrar nada');
});

// ===== exec_command =====
test('exec_command: executa comando simples', async () => {
    const result = await executeAgentTool('exec_command', { comando: 'echo hello' });
    assert.ok(result.includes('hello'), 'Deve conter a saída do comando');
});

test('exec_command: retorna erro para comando inválido', async () => {
    const result = await executeAgentTool('exec_command', { comando: 'comando_que_nao_existe_12345' });
    assert.ok(result.includes('Erro') || result.includes('erro') || result.includes('não encontrado') || result.includes('not found') || result.includes('não é reconhecido'),
        'Deve reportar erro para comando inválido');
});

// ===== file_rename =====
test('file_rename: renomeia arquivo', async () => {
    const orig = 'test-rename-orig.txt';
    const dest = 'test-rename-dest.txt';
    fs.writeFileSync(path.join(PROJECT_ROOT, orig), 'renomear', 'utf-8');

    const result = await executeAgentTool('file_rename', { origem: orig, destino: dest });
    assert.ok(typeof result === 'string' && result.length > 0, 'Deve retornar resultado');
    assert.ok(!fs.existsSync(path.join(PROJECT_ROOT, orig)), 'Original não deve existir');
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, dest)), 'Destino deve existir');
});

// ===== file_mkdir =====
test('file_mkdir: cria diretório', async () => {
    const dirPath = 'test-dir/subdir';
    const result = await executeAgentTool('file_mkdir', { caminho: dirPath });
    assert.ok(result.includes('criado') || result.includes('sucesso'), 'Deve confirmar criação');
    assert.ok(fs.existsSync(path.join(PROJECT_ROOT, dirPath)), 'Diretório deve existir');
});

// ===== search_replace =====
test('search_replace: substitui texto em arquivo', async () => {
    const filePath = 'test-replace.txt';
    fs.writeFileSync(path.join(PROJECT_ROOT, filePath), 'conteúdo antigo aqui', 'utf-8');

    const result = await executeAgentTool('search_replace', { padrao: 'antigo', substituto: 'novo', caminho: filePath });
    assert.ok(result.includes('substituído') || result.includes('alterado') || result.includes('arquivo'), 'Deve confirmar substituição');
    const content = fs.readFileSync(path.join(PROJECT_ROOT, filePath), 'utf-8');
    assert.ok(content.includes('novo'), 'Conteúdo deve ter sido alterado');
    assert.ok(!content.includes('antigo'), 'Texto antigo não deve existir');
});

// ===== undo/redo =====
test('undo: retorna resposta sem crash', async () => {
    const result = await executeAgentTool('undo', {});
    assert.ok(typeof result === 'string' && result.length > 0, 'Deve retornar string não-vazia');
});

test('redo: retorna resposta sem crash', async () => {
    const result = await executeAgentTool('redo', {});
    assert.ok(typeof result === 'string' && result.length > 0, 'Deve retornar string não-vazia');
});

// ===== path traversal blocked =====
test('tools: bloqueia path traversal', async () => {
    const result = await executeAgentTool('read_file', { caminho: '../../../etc/passwd' });
    assert.ok(result.includes('Erro'), 'Deve bloquear path traversal');
});

// ===== exec_command segurança =====
test('exec_command: executa no diretório correto do projeto', async () => {
    const marker = 'MARKER_' + Date.now();
    const result = await executeAgentTool('exec_command', { comando: `echo ${marker}` });
    assert.ok(result.includes(marker), 'Deve executar e retornar a saída');
});

test('exec_command: bloqueia encadeamento de comandos', async () => {
    const result = await executeAgentTool('exec_command', { comando: 'echo a && whoami' });
    assert.ok(result.includes('Erro'), 'Deve bloquear encadeamento com &&');
});

test('exec_command: bloqueia separador de comandos', async () => {
    const result = await executeAgentTool('exec_command', { comando: 'echo a; whoami' });
    assert.ok(result.includes('Erro'), 'Deve bloquear separador ;');
});

test('exec_command: bloqueia redirecionamento', async () => {
    const result = await executeAgentTool('exec_command', { comando: 'echo a > out.txt' });
    assert.ok(result.includes('Erro'), 'Deve bloquear redirecionamento');
});

test('list_files: bloqueia caminho fora do projeto', async () => {
    const result = await executeAgentTool('list_files', { diretorio: '../../../etc/passwd' });
    assert.ok(result.includes('Erro'), 'Deve bloquear listagem fora do projeto');
});
