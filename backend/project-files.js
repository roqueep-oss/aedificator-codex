const fs = require('fs');
const path = require('path');

// Diretórios ignorados por padrão nas varreduras de arquivos do projeto.
const DEFAULT_IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache']);
const MAX_CONTEXT_FILES = 500;
const MAX_FILE_SIZE = 2 * 1024 * 1024;

// Varredura recursiva única de arquivos do projeto (DRY). Substitui as várias
// implementações de `const walk = (dir, rel) => {...}` duplicadas em server.js.
// `onFile` é chamado para cada arquivo (não-diretorio) com { relPath, name, full };
// a varredura ignora ignoredDirs e para ao atingir maxFiles (use Infinity para
// varrer sem limite, como no project/summary).
function walkProjectFiles(root, onFile, opts = {}) {
    const ignoredDirs = opts.ignoredDirs || DEFAULT_IGNORED_DIRS;
    const maxFiles = opts.maxFiles == null ? MAX_CONTEXT_FILES : opts.maxFiles;
    let visited = 0;
    const walk = (dir, rel) => {
        if (visited >= maxFiles) return;
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (visited >= maxFiles) return;
            if (entry.isDirectory()) {
                if (ignoredDirs.has(entry.name)) continue;
                walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
                continue;
            }
            visited++;
            onFile({
                relPath: rel ? `${rel}/${entry.name}` : entry.name,
                name: entry.name,
                full: path.join(dir, entry.name)
            });
        }
    };
    walk(root, '');
}

module.exports = { walkProjectFiles, DEFAULT_IGNORED_DIRS, MAX_CONTEXT_FILES, MAX_FILE_SIZE };
