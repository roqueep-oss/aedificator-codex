// =============================================
//  ANALYZER — validação e indexação de código
//  para garantir exatidão nas alterações da IA
// =============================================
const fs = require('fs');
const path = require('path');

let projectIndex = null;
let projectIndexTs = Date.now();
const INDEX_TTL = 60000; // cache de 60s

let acorn = null;
let tsCompiler = null;

function getAcorn() {
    if (acorn) return acorn;
    try { acorn = require('acorn'); } catch (e) {}
    return acorn;
}

function getTypeScript() {
    if (tsCompiler) return tsCompiler;
    try { tsCompiler = require('typescript'); } catch (e) {}
    return tsCompiler;
}

// =============================================
//  INDEXADOR DE PROJETO
// =============================================
function indexProject(rootDir) {
    if (projectIndex && (Date.now() - projectIndexTs) < INDEX_TTL) {
        return projectIndex;
    }

    const idx = {
        files: {},
        exports: {},
        imports: {},
        functions: [],
        classes: [],
        types: [],
        variables: {},
        root: rootDir,
        timestamp: Date.now()
    };

    scanDir(rootDir, rootDir, idx);

    projectIndex = idx;
    projectIndexTs = Date.now();
    return idx;
}

function scanDir(dir, rootDir, idx) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch (e) { return; }
    for (const name of entries) {
        if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build') continue;
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch (e) { continue; }
        if (stat.isDirectory()) {
            scanDir(full, rootDir, idx);
        } else if (stat.isFile() && stat.size < 500000) {
            const ext = path.extname(name).toLowerCase();
            if (['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.pyw', '.go', '.java', '.cs', '.rb', '.php', '.kt', '.kts', '.swift', '.dart', '.scala', '.sc', '.lua', '.pl', '.pm', '.hs', '.lhs', '.ex', '.exs', '.r', '.R', '.sh', '.bash', '.zsh', '.sql', '.rs', '.c', '.h', '.cpp', '.cxx', '.cc', '.hpp', '.hh'].includes(ext)) {
                try {
                    const content = fs.readFileSync(full, 'utf-8');
                    const rel = path.relative(rootDir, full).replace(/\\/g, '/');
                    const parsed = parseFileExports(content, rel, ext);
                    idx.files[rel] = parsed;
                } catch (e) {}
            }
        }
    }
}

function parseFileExports(content, filePath, ext) {
    const result = {
        exports: [],
        imports: [],
        functions: [],
        classes: [],
        variables: [],
        filePath
    };

    // Imports
    const importRegex = /(?:import\s+(?:\{([^}]+)\}|(\w+)(?:\s*,\s*\{([^}]+)\})?|(\w+))\s+from\s+['"]([^'"]+)['"])|(?:const\s+(?:\{([^}]+)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
    let m;
    while ((m = importRegex.exec(content)) !== null) {
        const named = (m[1] || m[3] || m[6] || '').split(',').map(s => s.trim()).filter(Boolean);
        const defaultImp = m[2] || m[4] || m[7] || '';
        const from = m[5] || m[8] || '';
        if (defaultImp) named.push(defaultImp);
        for (const n of named) {
            const clean = n.replace(/\s+as\s+\w+/, '').split(' as ').pop().trim();
            result.imports.push({ name: clean, from });
        }
    }

    // Exports (named)
    const exportNamedRegex = /export\s+(?:const|let|var|function|class|type|interface)\s+(\w+)/g;
    while ((m = exportNamedRegex.exec(content)) !== null) {
        result.exports.push(m[1]);
    }

    // module.exports
    const moduleExportRegex = /module\.exports\s*=\s*\{([^}]*)\}/g;
    while ((m = moduleExportRegex.exec(content)) !== null) {
        const items = m[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
        result.exports.push(...items);
    }
    const moduleExportSingleRegex = /module\.exports\s*=\s*(\w+)/g;
    while ((m = moduleExportSingleRegex.exec(content)) !== null) {
        result.exports.push(m[1]);
    }

    // Functions
    const funcRegex = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
    while ((m = funcRegex.exec(content)) !== null) {
        result.functions.push({ name: m[1], params: parseParams(m[2]) });
    }

    // Arrow functions assigned to const/let/var
    const arrowRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/g;
    while ((m = arrowRegex.exec(content)) !== null) {
        result.functions.push({ name: m[1], params: parseParams(m[2]) });
    }

    // Classes
    const classRegex = /(?:export\s+)?class\s+(\w+)/g;
    while ((m = classRegex.exec(content)) !== null) {
        result.classes.push(m[1]);
    }

    // Declared variables (const, let, var at top level or exported)
    const varRegex = /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[=;]/g;
    while ((m = varRegex.exec(content)) !== null) {
        const name = m[1];
        if (!result.exports.includes(name) && name.length > 1) {
            result.variables.push(name);
        }
    }

    // TypeScript types/interfaces
    if (['.ts', '.tsx'].includes(ext)) {
        const typeRegex = /(?:export\s+)?(?:type|interface)\s+(\w+)/g;
        while ((m = typeRegex.exec(content)) !== null) {
            result.exports.push(m[1]);
        }
    }

    return result;
}

function parseParams(paramsStr) {
    return paramsStr.split(',').map(p => {
        const trimmed = p.trim();
        const name = trimmed.split(':')[0].split('=')[0].split('?')[0].trim();
        return name || '';
    }).filter(Boolean);
}

// =============================================
//  VALIDADOR DE CÓDIGO
// =============================================

function basicSyntaxCheck(code, langType) {
    const errors = [];
    const lines = code.split('\n');

    const pairs = { '(': ')', '[': ']', '{': '}' };
    for (const [open, close] of Object.entries(pairs)) {
        const stack = [];
        for (let i = 0; i < lines.length; i++) {
            for (let col = 0; col < lines[i].length; col++) {
                const ch = lines[i][col];
                if (ch === open) stack.push({ line: i + 1, col: col + 1 });
                else if (ch === close) {
                    if (stack.length === 0) {
                        errors.push({ type: langType, line: i + 1, column: col + 1, message: `"${close}" extra sem "${open}" correspondente`, severity: 'error' });
                    } else {
                        stack.pop();
                    }
                }
            }
        }
        for (const s of stack) {
            errors.push({ type: langType, line: s.line, column: s.col, message: `"${open}" sem fechamento`, severity: 'error' });
        }
    }

    let inSingle = false, inDouble = false, inBacktick = false;
    for (let i = 0; i < lines.length; i++) {
        for (let col = 0; col < lines[i].length; col++) {
            const ch = lines[i][col];
            if (ch === '\\') { col++; continue; }
            if (!inDouble && !inBacktick && ch === "'") inSingle = !inSingle;
            else if (!inSingle && !inBacktick && ch === '"') inDouble = !inDouble;
            else if (!inSingle && !inDouble && ch === '`') inBacktick = !inBacktick;
        }
    }
    if (inSingle) errors.push({ type: langType, line: lines.length, column: 1, message: 'String com aspas simples não fechada', severity: 'error' });
    if (inDouble) errors.push({ type: langType, line: lines.length, column: 1, message: 'String com aspas duplas não fechada', severity: 'error' });
    if (inBacktick) errors.push({ type: langType, line: lines.length, column: 1, message: 'Template string não fechada', severity: 'error' });

    return errors;
}

const COMPILER_INSTALL_HINTS = {
    java:     'https://adoptium.net (JDK) ou `winget install EclipseAdoptium.Temurin.21.JDK`',
    csharp:   '`winget install Microsoft.DotNet.SDK.8` ou https://dotnet.microsoft.com',
    ruby:     '`winget install RubyInstallerTeam.Ruby`',
    php:      '`winget install PHP.PHP`',
    kotlin:   '`winget install JetBrains.Kotlin`',
    swift:    'https://www.swift.org/download (Windows: `winget install Swift.Toolchain`)',
    dart:     '`winget install DartLang.DartSDK`',
    scala:    '`winget install Scala.Scala` ou https://www.scala-lang.org/download',
    lua:      '`winget install LuaLS.LuaLS` ou https://luabinaries.sourceforge.net',
    perl:     '`winget install StrawberryPerl.StrawberryPerl`',
    haskell:  '`winget install Haskell.HaskellPlatform` ou https://www.haskell.org/ghcup',
    elixir:   '`winget install Elixir.Elixir`',
    r:        '`winget install RProject.R`',
    shell:    'bash já incluso no Windows via Git Bash ou WSL',
};

function safeValidate(filePath, rootDir, langType, nativeValidator, requiredCmd) {
    const errors = [];
    const absPath = path.resolve(rootDir, filePath);
    if (!fs.existsSync(absPath)) return errors;

    let nativeRan = false;
    try {
        const nativeErrors = nativeValidator(filePath, rootDir);
        nativeRan = true;
        errors.push(...nativeErrors);
    } catch (e) {}

    if (!nativeRan) {
        const hint = COMPILER_INSTALL_HINTS[langType] || '';
        const hintMsg = hint ? `Instale: ${hint}` : '';
        if (hintMsg) {
            errors.push({ type: langType, line: 1, column: 1, message: `${requiredCmd || langType} não encontrado. ${hintMsg}. Usando validação básica.`, severity: 'info' });
        }
        try {
            const content = fs.readFileSync(absPath, 'utf-8');
            errors.push(...basicSyntaxCheck(content, langType));
        } catch (e) {}
    }

    return errors;
}

function validateCode(code, filePath, rootDir) {
    const errors = [];
    const idx = indexProject(rootDir);
    const ext = (path.extname(filePath) || '.js').toLowerCase();

    const IS_CSS = ['.css', '.scss', '.less'].includes(ext);
    const IS_HTML = ['.html', '.htm'].includes(ext);
    if (IS_CSS || IS_HTML) return { errors: [], valid: true, filePath, suggestionCount: 100 };

    function finish() {
        return { errors, valid: errors.length === 0, filePath, suggestionCount: calculateConfidence(errors) };
    }

    if (['.java'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'java', validateWithJavac, 'javac')); return finish(); }
    if (['.cs'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'csharp', validateWithCSharp, 'dotnet')); return finish(); }
    if (['.rb'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'ruby', validateWithRuby, 'ruby')); return finish(); }
    if (['.php'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'php', validateWithPHP, 'php')); return finish(); }
    if (['.kt', '.kts'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'kotlin', validateWithKotlin, 'kotlinc')); return finish(); }
    if (['.swift'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'swift', validateWithSwift, 'swiftc')); return finish(); }
    if (['.dart'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'dart', validateWithDart, 'dart')); return finish(); }
    if (['.scala', '.sc'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'scala', validateWithScala, 'scalac')); return finish(); }
    if (['.lua'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'lua', validateWithLua, 'luac')); return finish(); }
    if (['.pl', '.pm'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'perl', validateWithPerl, 'perl')); return finish(); }
    if (['.hs', '.lhs'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'haskell', validateWithHaskell, 'ghc')); return finish(); }
    if (['.ex', '.exs'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'elixir', validateWithElixir, 'elixirc')); return finish(); }
    if (['.r', '.R'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'r', validateWithR, 'Rscript')); return finish(); }
    if (['.sh', '.bash', '.zsh'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'shell', validateWithShell, 'bash')); return finish(); }
    if (['.sql'].includes(ext)) { errors.push(...basicSyntaxCheck(code, 'sql')); return finish(); }
    if (['.go'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'go', validateWithGoVet, 'go')); return finish(); }
    if (['.c', '.h', '.cpp', '.cxx', '.cc', '.hpp', '.hh'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'c/c++', validateWithGCC, 'gcc')); return finish(); }
    if (['.rs'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'rust', validateWithRustc, 'rustc')); return finish(); }
    if (['.py', '.pyw'].includes(ext)) { errors.push(...safeValidate(filePath, rootDir, 'python', validateWithPythonAST, 'python')); return finish(); }

    const isTS = ['.ts', '.tsx'].includes(ext);
    if (!['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'].includes(ext)) return finish();

    const syntaxErrors = isTS ? checkTSSyntax(code) : checkJSSyntax(code);
    errors.push(...syntaxErrors);

    const importErrors = checkImports(code, idx, filePath);
    errors.push(...importErrors);

    const varErrors = checkUndeclaredVars(code, idx, filePath);
    errors.push(...varErrors);

    const callErrors = checkCallSignatures(code, idx);
    errors.push(...callErrors);

    return finish();
}

function checkJSSyntax(code) {
    const errors = [];
    if (/(import\s+React|from\s+['"]react['"]|<[A-Z]\w*[\s/>]|@tailwind|@import\s+['"]|body\s*\{|\.\w+\s*\{)/.test(code)) {
        return errors;
    }
    const ac = getAcorn();
    if (!ac) return errors;

    try {
        ac.parse(code, { ecmaVersion: 2022, sourceType: 'module', locations: true, allowAwaitOutsideFunction: true });
    } catch (e) {
        errors.push({
            type: 'syntax',
            line: e.loc ? e.loc.line : 1,
            column: e.loc ? e.loc.column : 1,
            message: e.message,
            severity: 'error'
        });
    }
    return errors;
}

function checkTSSyntax(code) {
    const errors = [];
    const ts = getTypeScript();
    if (!ts) return errors;

    try {
        const source = ts.createSourceFile('temp.ts', code, ts.ScriptTarget.Latest, true);
        const diagnostics = [];
        const syntactic = source.parseDiagnostics || [];
        for (const d of syntactic) {
            const pos = source.getLineAndCharacterOfPosition(d.start || 0);
            diagnostics.push({
                type: 'syntax',
                line: pos.line + 1,
                column: pos.character + 1,
                message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
                severity: d.category === 0 ? 'warning' : d.category === 1 ? 'error' : 'info'
            });
        }
        errors.push(...diagnostics);
    } catch (e) {
        errors.push({ type: 'syntax', line: 1, column: 1, message: e.message, severity: 'error' });
    }
    return errors;
}

function checkImports(code, idx, filePath) {
    const errors = [];
    const importRegex = /(?:import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]|import\s+(\w+)\s+from\s+['"]([^'"]+)['"]|const\s+\{([^}]+)\}\s*=\s*require\s*\(\s*['"]([^'"]+)['"]|const\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"])/g;
    let m;
    const lines = code.split('\n');

    while ((m = importRegex.exec(code)) !== null) {
        const namedStr = m[1] || m[5] || '';
        const defaultImp = m[3] || m[7] || '';
        const from = m[2] || m[4] || m[6] || m[8] || '';
        const lineNum = code.substring(0, m.index).split('\n').length;

        if (from.startsWith('.') || from.startsWith('/')) continue;

        const importNames = namedStr.split(',').map(s => s.trim().split(' as ').pop().trim()).filter(Boolean);
        if (defaultImp) importNames.push(defaultImp);

        for (const name of importNames) {
            if (!name || name.length < 2) continue;
            let found = false;
            for (const [relPath, parsed] of Object.entries(idx.files)) {
                if (relPath.includes(name) || parsed.exports.includes(name)) {
                    found = true;
                    break;
                }
            }
            if (!found && !isGlobalOrBuiltin(name)) {
                errors.push({
                    type: 'import',
                    line: lineNum,
                    column: 1,
                    message: `Import "${name}" não encontrado nos exports do projeto`,
                    severity: 'warning'
                });
            }
        }
    }
    return errors;
}

function checkUndeclaredVars(code, idx, filePath) {
    const errors = [];
    if (/(import\s+React|<[A-Z]\w*[\s/>])/.test(code)) return errors;
    const currentFile = idx.files[filePath] || { exports: [], imports: [], functions: [], classes: [], variables: [] };

    const knownNames = new Set([
        ...currentFile.exports, ...currentFile.functions.map(f => f.name),
        ...currentFile.classes, ...currentFile.variables,
        ...currentFile.imports.map(i => i.name)
    ]);

    const lines = code.split('\n');
    const varRefRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]{2,})\b/g;
    const keywords = new Set(['const', 'let', 'var', 'function', 'class', 'return', 'if', 'else', 'for', 'while',
        'do', 'switch', 'case', 'break', 'continue', 'new', 'this', 'super', 'typeof', 'instanceof',
        'import', 'export', 'default', 'from', 'as', 'try', 'catch', 'finally', 'throw', 'async', 'await',
        'true', 'false', 'null', 'undefined', 'void', 'delete', 'in', 'of', 'yield', 'debugger',
        'console', 'process', 'module', 'exports', 'require', 'global', 'window', 'document',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Promise', 'Array', 'Object',
        'String', 'Number', 'Boolean', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'Date', 'RegExp',
        'Error', 'TypeError', 'JSON', 'Math', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
        'Buffer', '__dirname', '__filename', 'Intl', 'Proxy', 'Reflect', 'crypto', 'fs', 'path', 'os',
        'React', 'ReactDOM', 'react', 'react-dom', 'useState', 'useEffect', 'useRef', 'useMemo', 'useCallback', 'useContext',
        'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue', 'useId',
        'ReactDOM', 'Component', 'PureComponent', 'Fragment', 'StrictMode', 'Suspense',
        'props', 'state', 'children', 'key', 'ref', 'style', 'className', 'onClick', 'onChange',
        'onSubmit', 'onKeyDown', 'onKeyUp', 'onFocus', 'onBlur', 'onMouseEnter', 'onMouseLeave',
        'fetch', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
        'alert', 'confirm', 'prompt', 'encodeURIComponent', 'decodeURIComponent',
        'Blob', 'File', 'FileReader', 'FormData', 'URL', 'URLSearchParams',
        'State', 'Management', 'AppState', 'window']);

    lines.forEach((line, i) => {
        const cleanLine = line
            .replace(/"[^"]*"/g, '""')
            .replace(/'[^']*'/g, "''")
            .replace(/`[^`]*`/g, '``')
            .replace(/\/\/.*$/, '')
            .replace(/\/\*[\s\S]*?\*\//g, '');
        let m;
        while ((m = varRefRegex.exec(cleanLine)) !== null) {
            const name = m[1];
            if (keywords.has(name)) continue;
            if (knownNames.has(name)) continue;

            const isDecl = new RegExp(`\\b(const|let|var|function|class|import)\\s+${name}\\b`).test(line) ||
                          new RegExp(`["']\\s*${name}\\s*["']\\s*:`).test(line) ||
                          new RegExp(`{${name}\\}`).test(line) ||
                          line.includes(`.${name}`);

            if (!isDecl) {
                errors.push({
                    type: 'undefined-var',
                    line: i + 1,
                    column: m.index + 1,
                    message: `"${name}" pode não estar definido neste escopo`,
                    severity: 'warning'
                });
            }
        }
    });

    return errors.slice(0, 10);
}

function checkCallSignatures(code, idx) {
    const errors = [];
    const callRegex = /(\w+)\.(\w+)\s*\(([^)]*)\)/g;
    let m;

    while ((m = callRegex.exec(code)) !== null) {
        const obj = m[1];
        const method = m[2];
        const args = m[3].split(',').filter(a => a.trim());
        const lineNum = code.substring(0, m.index).split('\n').length;

        for (const [relPath, parsed] of Object.entries(idx.files)) {
            const cls = parsed.classes.find(c => c === obj);
            if (!cls) continue;
            const func = parsed.functions.find(f => f.name === method);
            if (func && func.params.length !== args.length) {
                errors.push({
                    type: 'signature',
                    line: lineNum,
                    column: 1,
                    message: `"${obj}.${method}" espera ${func.params.length} argumento(s), recebeu ${args.length}`,
                    severity: 'warning'
                });
            }
        }
    }
    return errors.slice(0, 5);
}

function isGlobalOrBuiltin(name) {
    const globals = new Set([
        'fs', 'path', 'os', 'crypto', 'http', 'https', 'url', 'querystring', 'stream',
        'child_process', 'events', 'util', 'assert', 'buffer', 'process', 'console',
        'express', 'cors', 'ws', 'dotenv', 'electron', 'React', 'react',
        'Component', 'useState', 'useEffect', 'useCallback', 'useMemo', 'useRef',
        'useContext', 'useReducer', 'axios', 'lodash', 'moment', 'zod',
        'jsonwebtoken', 'bcrypt', 'mongoose', 'sequelize', 'prisma',
        'jest', 'mocha', 'chai', 'sinon', 'supertest',
        'propTypes', 'PropTypes', 'classnames', 'styled'
    ]);
    return globals.has(name);
}

function calculateConfidence(errors) {
    const errCount = errors.filter(e => e.severity === 'error').length;
    const warnCount = errors.filter(e => e.severity === 'warning').length;
    if (errCount > 0) return 0;
    if (warnCount === 0) return 100;
    if (warnCount <= 2) return 90;
    if (warnCount <= 5) return 70;
    return 50;
}

// =============================================
//  AUTO-CORREÇÃO DE ERROS SIMPLES
// =============================================
function suggestFix(error, code) {
    const fixes = [];

    if (error.type === 'syntax') {
        if (error.message.includes('Unexpected token')) {
            fixes.push('Possível erro de sintaxe: verifique parênteses/chaves na linha ' + error.line);
        }
        if (error.message.includes('Unexpected end')) {
            fixes.push('Código incompleto: pode faltar fechamento de chave, parêntese ou aspa');
        }
    }

    if (error.type === 'import') {
        const nameMatch = error.message.match(/"([^"]+)"/);
        if (nameMatch) {
            fixes.push(`Considere importar "${nameMatch[1]}" ou verificar se o módulo existe`);
        }
    }

    if (error.type === 'undefined-var') {
        const nameMatch = error.message.match(/"([^"]+)"/);
        if (nameMatch) {
            fixes.push(`Declare "${nameMatch[1]}" com const/let/var ou verifique o escopo`);
        }
    }

    return fixes;
}

function autoFixCode(code, errors) {
    let fixed = code;
    let changes = 0;

    for (const e of errors) {
        if (e.type === 'syntax' && e.message.includes('Missing semicolon')) {
            const lines = fixed.split('\n');
            if (e.line <= lines.length) {
                lines[e.line - 1] = lines[e.line - 1].replace(/([^;{}\s])$/, '$1;');
                fixed = lines.join('\n');
                changes++;
            }
        }
    }

    return { code: fixed, changes, errors: errors.filter(e => e.type !== 'syntax' || !e.message.includes('Missing semicolon')) };
}

// =============================================
//  TYPE-CHECKING REAL (TypeScript createProgram)
// =============================================
function validateWithTSProgram(filePath, rootDir) {
    const errors = [];
    const ts = getTypeScript();
    if (!ts) return errors;

    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;

        const compilerOptions = {
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.CommonJS,
            strict: true,
            esModuleInterop: true,
            allowJs: true,
            checkJs: true,
            noEmit: true,
            lib: ['lib.es2022.d.ts'],
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            allowSyntheticDefaultImports: true,
            skipLibCheck: true
        };

        const host = ts.createCompilerHost(compilerOptions);
        host.getCurrentDirectory = () => rootDir;
        host.getDefaultLibFileName = () => 'lib.es2022.d.ts';

        const originalGetSourceFile = host.getSourceFile;
        host.getSourceFile = (fileName, languageVersion) => {
            if (fileName === absPath) {
                const content = fs.readFileSync(absPath, 'utf-8');
                return ts.createSourceFile(fileName, content, languageVersion, true);
            }
            return originalGetSourceFile(fileName, languageVersion);
        };

        const originalFileExists = host.fileExists;
        host.fileExists = (fileName) => {
            if (fileName === absPath) return true;
            return originalFileExists(fileName);
        };

        const originalReadFile = host.readFile;
        host.readFile = (fileName) => {
            if (fileName === absPath) {
                return fs.readFileSync(absPath, 'utf-8');
            }
            return originalReadFile(fileName);
        };

        const program = ts.createProgram([absPath], compilerOptions, host);
        const syntacticDiagnostics = program.getSyntacticDiagnostics(ts.createSourceFile(absPath, fs.readFileSync(absPath, 'utf-8'), ts.ScriptTarget.Latest, true));
        const semanticDiagnostics = program.getSemanticDiagnostics(ts.createSourceFile(absPath, fs.readFileSync(absPath, 'utf-8'), ts.ScriptTarget.Latest, true));

        for (const d of [...syntacticDiagnostics, ...semanticDiagnostics]) {
            const pos = d.file ? d.file.getLineAndCharacterOfPosition(d.start || 0) : { line: 0, character: 0 };
            errors.push({
                type: 'typescript',
                line: pos.line + 1,
                column: pos.character + 1,
                message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
                severity: d.category === 0 ? 'warning' : d.category === 1 ? 'error' : 'info',
                code: d.code
            });
        }
    } catch (e) {
        errors.push({ type: 'typescript', line: 1, column: 1, message: 'Type-check falhou: ' + e.message, severity: 'error' });
    }

    return errors;
}

function getTSSymbols(filePath, rootDir) {
    const symbols = [];
    const ts = getTypeScript();
    if (!ts) return symbols;

    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
        const program = ts.createProgram([absPath], {
            target: ts.ScriptTarget.Latest,
            module: ts.ModuleKind.CommonJS,
            strict: true,
            allowJs: true,
            checkJs: true,
            noEmit: true,
            lib: ['lib.es2022.d.ts']
        }, ts.createCompilerHost({}));
        const checker = program.getTypeChecker();

        const walk = (node) => {
            if (ts.isFunctionDeclaration(node) && node.name) {
                const type = checker.getTypeAtLocation(node);
                const sig = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
                const params = [];
                if (sig.length) {
                    for (const param of sig[0].getParameters()) {
                        const paramType = checker.typeToString(checker.getTypeOfSymbol(param));
                        params.push(param.getName() + ': ' + paramType);
                    }
                    const returnType = checker.typeToString(sig[0].getReturnType());
                    symbols.push({ name: node.name.text, kind: 'function', line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1, params, returnType });
                }
            }
            if (ts.isClassDeclaration(node) && node.name) {
                symbols.push({ name: node.name.text, kind: 'class', line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
            }
            if (ts.isVariableStatement(node)) {
                for (const decl of node.declarationList.declarations) {
                    if (ts.isIdentifier(decl.name)) {
                        const type = checker.getTypeAtLocation(decl);
                        symbols.push({ name: decl.name.text, kind: 'variable', line: sourceFile.getLineAndCharacterOfPosition(decl.getStart()).line + 1, type: checker.typeToString(type) });
                    }
                }
            }
            ts.forEachChild(node, walk);
        }
        walk(sourceFile);
    } catch (e) {}

    return symbols;
}

// =============================================
//  EXPORTS
// =============================================
// =============================================
//  LSP PYTHON (ast via subprocess)
// =============================================
function validateWithPythonAST(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const content = fs.readFileSync(absPath, 'utf-8');
        const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
        const result = require('child_process').spawnSync('python', ['-c', `
import ast, sys, traceback
try:
    tree = ast.parse("""${escaped}""")
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            pass
    print("OK")
except SyntaxError as e:
    print(f"SYNTAX:{e.lineno}:{e.offset}:{e.msg}")
except Exception as e:
    print(f"ERROR:0:0:{str(e).split(chr(10))[0]}")
`], { timeout: 10000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stdout || '').trim();
        if (out.startsWith('SYNTAX:') || out.startsWith('ERROR:')) {
            const parts = out.split(':');
            errors.push({
                type: 'python',
                line: parseInt(parts[1]) || 1,
                column: parseInt(parts[2]) || 1,
                message: parts.slice(3).join(':') || out,
                severity: 'error'
            });
        }
    } catch (e) {
        errors.push({ type: 'python', line: 1, column: 1, message: 'Python type-check falhou: ' + e.message, severity: 'error' });
    }
    return errors;
}

function getPythonSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
        const result = require('child_process').spawnSync('python', ['-c', `
import ast
try:
    tree = ast.parse("""${escaped}""")
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            args = [{'name': a.arg, 'annotation': (ast.unparse(a.annotation) if hasattr(ast, 'unparse') and a.annotation else 'any')} for a in node.args.args]
            print(f"FN|{node.lineno}|{node.name}|{len(args)}|{','.join(a['name']+':'+a['annotation'] for a in args)}|")
        elif isinstance(node, ast.ClassDef):
            print(f"CL|{node.lineno}|{node.name}|")
        elif isinstance(node, ast.Assign):
            for tgt in node.targets:
                if isinstance(tgt, ast.Name):
                    val = 'variable'
                    if isinstance(node.value, ast.Constant): val = repr(node.value)
                    elif isinstance(node.value, ast.Call) and hasattr(node.value.func, 'id'): val = node.value.func.id + '()'
                    print(f"VR|{node.lineno}|{tgt.id}|{val[:60]}|")
except Exception as e:
    print(f"ERR:{str(e).split(chr(10))[0]}")
`], { timeout: 10000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stdout || '').trim();
        for (const line of out.split('\n')) {
            const parts = line.split('|');
            if (parts[0] === 'FN') {
                const args = [];
                if (parts[3] !== '0') {
                    for (const a of (parts[4] || '').split(',')) {
                        const ap = a.split(':'); args.push({ name: ap[0], type: ap[1] || 'any' });
                    }
                }
                symbols.push({ name: parts[2], kind: 'function', line: parseInt(parts[1]), params: args });
            } else if (parts[0] === 'CL') {
                symbols.push({ name: parts[2], kind: 'class', line: parseInt(parts[1]) });
            } else if (parts[0] === 'VR') {
                symbols.push({ name: parts[2], kind: 'variable', line: parseInt(parts[1]), value: parts[3] });
            }
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP GO (go vet / gopls via subprocess)
// =============================================
function validateWithGoVet(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const cwd = path.dirname(absPath);
        const result = require('child_process').spawnSync('go', ['vet', absPath], { timeout: 15000, encoding: 'utf-8', windowsHide: true, cwd });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^(.+?):(\d+):(\d+):\s*(.+)/);
                if (m) {
                    errors.push({ type: 'go', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[4], severity: 'error' });
                } else if (line.trim()) {
                    errors.push({ type: 'go', line: 1, column: 1, message: line.trim(), severity: 'error' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getGoSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const fnRe = /func\s+(?:\([^)]*\s+\)\s+)?(\w+)\s*\(/g;
        const classRe = /type\s+(\w+)\s+struct/g;
        const varRe = /var\s+(\w+)\s+/g;
        const lines = content.split('\n');
        let m;
        while ((m = fnRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = varRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'variable', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  CODE SMELLS DETECTION
// =============================================
function detectCodeSmells(filePath, rootDir) {
    const smells = [];
    const fullPath = path.resolve(rootDir, filePath);
    if (!fs.existsSync(fullPath)) return smells;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    let fnStart = -1, fnName = '', braceDepth = 0, inFn = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        const isPyFn = line.match(/^def\s+(\w+)/);
        const isGoFn = line.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)/);
        const isJsFn = line.match(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:function|async\s+function|\([\w,\s]*\)\s*=>))/);
        const isRubyFn = line.match(/^\s*def\s+(?:self\.)?(\w+)/);
        const isElixirFn = line.match(/^\s*def(?:p)?\s+(\w+)/);
        const isLuaFn = line.match(/^\s*function\s+(\w[\w.:]*)/);
        const isShellFn = line.match(/^\s*(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/);
        const isKotlinFn = line.match(/^\s*(?:suspend\s+)?fun\s+(\w+)/);
        const isRustFn = line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);

        if (isPyFn) { fnName = isPyFn[1]; fnStart = i; inFn = true; braceDepth = 0; }
        else if (isGoFn) { fnName = isGoFn[1]; fnStart = i; inFn = true; braceDepth = 0; }
        else if (isJsFn) { fnName = isJsFn[1] || isJsFn[2]; fnStart = i; inFn = true; braceDepth = 0; }
        else if (isRubyFn) { fnName = isRubyFn[1]; fnStart = i; inFn = true; braceDepth = 0; }
        else if (isElixirFn) { fnName = isElixirFn[1]; fnStart = i; inFn = true; braceDepth = 0; }
        else if (isLuaFn) { fnName = isLuaFn[1]; fnStart = i; inFn = true; braceDepth = 0; }
        else if (isShellFn) { fnName = isShellFn[1]; fnStart = i; inFn = true; braceDepth = 0; }
        else if (isKotlinFn) { fnName = isKotlinFn[1]; fnStart = i; inFn = true; braceDepth = 0; }
        else if (isRustFn) { fnName = isRustFn[1]; fnStart = i; inFn = true; braceDepth = 0; }
        if (inFn) {
            const opens = (line.match(/\{/g) || []).length;
            const closes = (line.match(/\}/g) || []).length;
            braceDepth += opens - closes;
            const isPyDedent = (line.match(/^def\s/) || line.match(/^class\s/)) && i > fnStart;
            const isEndKeyword = line.match(/^end\b/) && inFn;
            if ((braceDepth <= 0 && fnStart >= 0 && opens === 0 && closes > 0) || isPyDedent || isEndKeyword) {
                const len = i - fnStart;
                if (len > 50) smells.push({ type: 'smell', line: fnStart + 1, message: 'Funcao "' + fnName + '" muito longa (' + len + ' linhas)', severity: 'warning' });
                inFn = false; fnStart = -1;
            }
            if (i === lines.length - 1 && inFn && (i - fnStart) > 50) {
                smells.push({ type: 'smell', line: fnStart + 1, message: 'Funcao "' + fnName + '" muito longa (' + (i - fnStart + 1) + ' linhas)', severity: 'warning' });
            }
        }
    }

    const varRegex = /(?:var|let|const)\s+(\w+)\s*=/g;
    const declaredVars = new Set();
    let vm;
    while ((vm = varRegex.exec(content)) !== null) {
        if (vm[1].length > 2) declaredVars.add(vm[1]);
    }
    for (const v of declaredVars) {
        const re = new RegExp('\\b' + v + '\\b', 'g');
        const matches = content.match(re);
        if (matches && matches.length <= 1) {
            const idx = content.indexOf(v);
            if (idx >= 0) {
                const lineNo = content.substring(0, idx).split('\n').length;
                smells.push({ type: 'smell', line: lineNo, message: 'Variavel "' + v + '" declarada mas nao usada', severity: 'warning' });
            }
        }
    }

    const importRegex = /(?:import\s.+|require\s*\(['"][^'"]+['"]\))/g;
    const imports = new Map();
    let im;
    while ((im = importRegex.exec(content)) !== null) {
        const imp = im[0].trim();
        imports.set(imp, (imports.get(imp) || 0) + 1);
    }
    for (const [imp, count] of imports) {
        if (count > 1) {
            const idx = content.lastIndexOf(imp);
            const lineNo = content.substring(0, idx).split('\n').length;
            smells.push({ type: 'smell', line: lineNo, message: 'Import duplicado: "' + imp + '"', severity: 'warning' });
        }
    }

    return smells;
}

// =============================================
//  LSP C/C++ (gcc -fsyntax-only)
// =============================================
function validateWithGCC(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const ext = path.extname(filePath).toLowerCase();
        if (!['.c', '.h', '.cpp', '.cxx', '.cc', '.hpp', '.hh'].includes(ext)) return errors;
        const result = require('child_process').spawnSync('gcc', ['-fsyntax-only', '-Wall', '-std=c17', absPath], { timeout: 15000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^(.+?):(\d+):(\d+):\s*(?:fatal error:|error:|warning:)\s*(.+)/);
                if (m) {
                    errors.push({ type: 'c/c++', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[4], severity: line.includes('warning:') ? 'warning' : 'error' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getCppSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const fnRe = /(?:\w+\s+)+(\w+)\s*\([^)]*\)\s*\{/g;
        const classRe = /(?:class|struct)\s+(\w+)/g;
        let m;
        while ((m = fnRe.exec(content)) !== null) {
            if (!['if', 'while', 'for', 'switch', 'return', 'sizeof', 'typeof'].includes(m[1])) {
                const before = content.substring(0, m.index);
                symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
            }
        }
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP RUST (rustc --check)
// =============================================
function validateWithRustc(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        if (!filePath.endsWith('.rs')) return errors;
        const result = require('child_process').spawnSync('rustc', ['--edition', '2021', '-Z', 'no-codegen', '--color', 'never', absPath], { timeout: 15000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^.+?:(\d+):(\d+):\s*\d+:\d+\s*(error|warning)(\[.+?\])?:\s*(.+)/);
                if (m) {
                    errors.push({ type: 'rust', line: parseInt(m[1]) || 1, column: parseInt(m[2]) || 1, message: (m[5] || line).trim(), severity: m[3] === 'error' ? 'error' : 'warning' });
                } else if (line.includes('error') || line.includes('warning')) {
                    errors.push({ type: 'rust', line: 1, column: 1, message: line.trim(), severity: 'warning' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getRustSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const fnRe = /(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g;
        const structRe = /(?:pub\s+)?struct\s+(\w+)/g;
        const traitRe = /(?:pub\s+)?trait\s+(\w+)/g;
        const implRe = /impl\s+(?:\w+\s+for\s+)?(\w+)/g;
        let m;
        while ((m = fnRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
        while ((m = structRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = traitRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'interface', line: before.split('\n').length });
        }
        while ((m = implRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP JAVA (javac)
// =============================================
function validateWithJavac(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('javac', ['-Xlint:all', absPath], { timeout: 20000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^(.+?):(\d+):\s*(error|warning):\s*(.+)/);
                if (m) {
                    const colMatch = m[1].includes(':') ? null : null;
                    errors.push({ type: 'java', line: parseInt(m[2]) || 1, column: 1, message: m[4], severity: m[3] === 'error' ? 'error' : 'warning' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getJavaSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const classRe = /(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/g;
        const ifaceRe = /(?:public\s+)?interface\s+(\w+)/g;
        const methodRe = /(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = ifaceRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'interface', line: before.split('\n').length });
        }
        while ((m = methodRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP C# (dotnet build / csc / mcs)
// =============================================
function validateWithCSharp(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const compilers = [
            { bin: 'dotnet', args: ['build', path.dirname(absPath), '--no-restore', '--verbosity', 'quiet'] },
            { bin: 'csc', args: ['/target:library', '/nologo', '/nowarn:CS0168,CS0219', absPath] },
            { bin: 'mcs', args: ['-target:library', '-nologo', absPath] }
        ];
        let result = null;
        for (const c of compilers) {
            try {
                result = require('child_process').spawnSync(c.bin, c.args, { timeout: 20000, encoding: 'utf-8', windowsHide: true });
                if (result.status !== null) break;
            } catch (e) {}
        }
        if (!result) return errors;
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)/);
                if (m) {
                    errors.push({ type: 'c#', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[6], severity: m[4] === 'error' ? 'error' : 'warning' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getCSharpSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const classRe = /(?:public\s+)?(?:static\s+)?(?:sealed\s+)?(?:abstract\s+)?class\s+(\w+)/g;
        const ifaceRe = /(?:public\s+)?interface\s+(\w+)/g;
        const methodRe = /(?:public|private|protected|internal)\s+(?:static\s+)?(?:virtual\s+)?(?:override\s+)?(?:async\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = ifaceRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'interface', line: before.split('\n').length });
        }
        while ((m = methodRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP RUBY (ruby -c)
// =============================================
function validateWithRuby(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('ruby', ['-c', absPath], { timeout: 10000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out && !out.includes('Syntax OK')) {
            for (const line of out.split('\n')) {
                const m = line.match(/^.+?:(\d+):\s*(.+)/);
                if (m) {
                    errors.push({ type: 'ruby', line: parseInt(m[1]) || 1, column: 1, message: m[2], severity: 'error' });
                } else if (line.trim()) {
                    errors.push({ type: 'ruby', line: 1, column: 1, message: line.trim(), severity: 'error' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getRubySymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const classRe = /class\s+(\w+)/g;
        const moduleRe = /module\s+(\w+)/g;
        const defRe = /def\s+(?:self\.)?(\w+)/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = moduleRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'module', line: before.split('\n').length });
        }
        while ((m = defRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP PHP (php -l)
// =============================================
function validateWithPHP(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('php', ['-l', '-d', 'display_errors=0', absPath], { timeout: 10000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out && !out.includes('No syntax errors')) {
            for (const line of out.split('\n')) {
                const m = line.match(/(?:Parse|Fatal)\s+error:\s*(.+?)\s+in\s+.+?\s+on\s+line\s+(\d+)/);
                if (m) {
                    errors.push({ type: 'php', line: parseInt(m[2]) || 1, column: 1, message: m[1], severity: 'error' });
                } else if (line.includes('error') || line.includes('Error')) {
                    errors.push({ type: 'php', line: 1, column: 1, message: line.trim(), severity: 'error' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getPHPSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const classRe = /class\s+(\w+)/g;
        const functionRe = /function\s+(\w+)\s*\(/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = functionRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP KOTLIN (kotlinc)
// =============================================
function validateWithKotlin(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('kotlinc', ['-no-stdlib', '-no-reflect', absPath], { timeout: 20000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)/);
                if (m) {
                    errors.push({ type: 'kotlin', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[5], severity: m[4] === 'error' ? 'error' : 'warning' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getKotlinSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const classRe = /(?:data\s+)?(?:sealed\s+)?(?:abstract\s+)?(?:open\s+)?class\s+(\w+)/g;
        const funRe = /(?:suspend\s+)?fun\s+(\w+)\s*\(/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            if (m[1] === 'for') continue;
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = funRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP SWIFT (swiftc -typecheck)
// =============================================
function validateWithSwift(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('swiftc', ['-typecheck', absPath], { timeout: 20000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^(.+?):(\d+):(\d+):\s*(error|warning):\s*(.+)/);
                if (m) {
                    errors.push({ type: 'swift', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[5], severity: m[4] === 'error' ? 'error' : 'warning' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getSwiftSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const classRe = /(?:public\s+)?(?:final\s+)?class\s+(\w+)/g;
        const structRe = /(?:public\s+)?struct\s+(\w+)/g;
        const funcRe = /func\s+(\w+)\s*\(/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = structRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = funcRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP DART (dart analyze)
// =============================================
function validateWithDart(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('dart', ['analyze', '--fatal-infos=false', absPath], { timeout: 20000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/(?:error|warning|info)\s*[-·]\s*(.+?)\s*[-·]\s*(.+?):(\d+):(\d+)\s*[-·]\s*(.+)/);
                if (m) {
                    const sev = m[1].toLowerCase().includes('error') ? 'error' : 'warning';
                    errors.push({ type: 'dart', line: parseInt(m[3]) || 1, column: parseInt(m[4]) || 1, message: m[5], severity: sev });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getDartSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const classRe = /(?:abstract\s+)?class\s+(\w+)/g;
        const funcRe = /(?:void|int|String|bool|double|num|dynamic|Future(?:<[^>]+>)?|Widget)\s+(\w+)\s*\(/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = funcRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP SCALA (scalac)
// =============================================
function validateWithScala(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('scalac', ['-Xlint', '-nowarn', absPath], { timeout: 20000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^(.+?):(\d+):\s*(error|warning):\s*(.+)/);
                if (m) {
                    errors.push({ type: 'scala', line: parseInt(m[2]) || 1, column: 1, message: m[4], severity: m[3] === 'error' ? 'error' : 'warning' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getScalaSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const classRe = /(?:case\s+)?class\s+(\w+)/g;
        const objectRe = /object\s+(\w+)/g;
        const traitRe = /trait\s+(\w+)/g;
        const defRe = /def\s+(\w+)\s*\(/g;
        let m;
        while ((m = classRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = objectRe.exec(content)) !== null) {
            if (m[1] === 'class') continue;
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'class', line: before.split('\n').length });
        }
        while ((m = traitRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'interface', line: before.split('\n').length });
        }
        while ((m = defRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP LUA (luac -p)
// =============================================
function validateWithLua(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('luac', ['-p', absPath], { timeout: 10000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/luac:.*?:(\d+):\s*(.+)/);
                if (m) {
                    errors.push({ type: 'lua', line: parseInt(m[1]) || 1, column: 1, message: m[2], severity: 'error' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getLuaSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const funcRe = /function\s+(\w[\w.:]*)\s*\(/g;
        let m;
        while ((m = funcRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP PERL (perl -c)
// =============================================
function validateWithPerl(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('perl', ['-c', '-I', rootDir, absPath], { timeout: 10000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out && !out.includes('syntax OK')) {
            for (const line of out.split('\n')) {
                const m = line.match(/at\s+.+?\s+line\s+(\d+)/);
                if (m) {
                    const msg = line.replace(/\s+at\s+.+$/, '').trim();
                    errors.push({ type: 'perl', line: parseInt(m[1]) || 1, column: 1, message: msg, severity: 'error' });
                } else if (line.trim()) {
                    errors.push({ type: 'perl', line: 1, column: 1, message: line.trim(), severity: 'error' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getPerlSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const subRe = /sub\s+(\w+)\s*\{/g;
        const pkgRe = /package\s+(\w[\w:]*)/g;
        let m;
        while ((m = subRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
        while ((m = pkgRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'module', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP HASKELL (ghc -fno-code)
// =============================================
function validateWithHaskell(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('ghc', ['-fno-code', '-Wall', absPath], { timeout: 20000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^(.+?):(\d+):(\d+):\s*(?:error|warning):\s*(.+)/);
                if (m) {
                    const sev = line.includes('error:') ? 'error' : 'warning';
                    errors.push({ type: 'haskell', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[4], severity: sev });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getHaskellSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const funcRe = /^(\w+)\s*::/gm;
        const dataRe = /^(?:newtype|data)\s+(\w+)/gm;
        let m;
        while ((m = funcRe.exec(content)) !== null) {
            symbols.push({ name: m[1], kind: 'function', line: content.substring(0, m.index).split('\n').length });
        }
        while ((m = dataRe.exec(content)) !== null) {
            symbols.push({ name: m[1], kind: 'class', line: content.substring(0, m.index).split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP ELIXIR (elixirc --no-compile)
// =============================================
function validateWithElixir(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const result = require('child_process').spawnSync('elixirc', ['--no-compile', '--warnings-as-errors=false', absPath], { timeout: 20000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/^\*\*\s+\((\w+)\)\s+(.+?):(\d+):\s*(.+)/);
                if (m) {
                    const sev = m[1].toLowerCase().includes('error') ? 'error' : 'warning';
                    errors.push({ type: 'elixir', line: parseInt(m[3]) || 1, column: 1, message: m[4], severity: sev });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getElixirSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const moduleRe = /defmodule\s+([\w.]+)/g;
        const funcRe = /def(?:p)?\s+(\w+)\s*\(/g;
        let m;
        while ((m = moduleRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'module', line: before.split('\n').length });
        }
        while ((m = funcRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP R (Rscript parse check)
// =============================================
function validateWithR(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const content = fs.readFileSync(absPath, 'utf-8');
        const escaped = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
        const result = require('child_process').spawnSync('Rscript', ['-e', `tryCatch({parse(text="${escaped}");cat("OK")},error=function(e)cat("ERROR:",e$message,"\\n"))`], { timeout: 10000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stdout || result.stderr || '').trim();
        if (out && out.startsWith('ERROR:')) {
            errors.push({ type: 'r', line: 1, column: 1, message: out.slice(6).trim(), severity: 'error' });
        } else if (out && !out.includes('OK')) {
            errors.push({ type: 'r', line: 1, column: 1, message: out, severity: 'error' });
        }
    } catch (e) {}
    return errors;
}

function getRSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const assignRe = /(\w[\w.]*)\s*<-\s*function\s*\(/g;
        let m;
        while ((m = assignRe.exec(content)) !== null) {
            symbols.push({ name: m[1], kind: 'function', line: content.substring(0, m.index).split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP SHELL (bash -n / shellcheck)
// =============================================
function validateWithShell(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const ext = path.extname(filePath).toLowerCase();
        const shell = ext === '.zsh' ? 'zsh' : 'bash';
        const result = require('child_process').spawnSync(shell, ['-n', absPath], { timeout: 10000, encoding: 'utf-8', windowsHide: true, shell: process.platform === 'win32' });
        const out = (result.stderr || result.stdout || '').trim();
        if (out) {
            for (const line of out.split('\n')) {
                const m = line.match(/line\s+(\d+):\s*(.+)/);
                if (m) {
                    errors.push({ type: 'shell', line: parseInt(m[1]) || 1, column: 1, message: m[2], severity: 'error' });
                }
            }
        }
    } catch (e) {}
    return errors;
}

function getShellSymbols(filePath, rootDir) {
    const symbols = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return symbols;
        const content = fs.readFileSync(absPath, 'utf-8');
        const funcRe = /^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm;
        let m;
        while ((m = funcRe.exec(content)) !== null) {
            const before = content.substring(0, m.index);
            symbols.push({ name: m[1], kind: 'function', line: before.split('\n').length });
        }
    } catch (e) {}
    return symbols;
}

// =============================================
//  LSP SQL (validação sintática básica)
// =============================================
function validateWithSQLSyntax(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const content = fs.readFileSync(absPath, 'utf-8');
        const lines = content.split('\n');
        let depth = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('--')) continue;
            const opens = (line.match(/\(/g) || []).length;
            const closes = (line.match(/\)/g) || []).length;
            depth += opens - closes;
            if (depth < 0) {
                errors.push({ type: 'sql', line: i + 1, column: 1, message: 'Parêntese de fechamento extra', severity: 'error' });
                depth = 0;
            }
        }
        if (depth > 0) {
            errors.push({ type: 'sql', line: lines.length, column: 1, message: `${depth} parêntese(s) não fechado(s)`, severity: 'error' });
        }
    } catch (e) {}
    return errors;
}

function getSQLSymbols(filePath, rootDir) {
    return [];
}


// =============================================
//  LINTER INTEGRATION (todas as linguagens)
// =============================================
const LINTERS = {
    '.js':  { cmd: 'eslint', args: ['--format=json', '--no-color'], parser: parseEslintOutput },
    '.mjs': { cmd: 'eslint', args: ['--format=json', '--no-color'], parser: parseEslintOutput },
    '.cjs': { cmd: 'eslint', args: ['--format=json', '--no-color'], parser: parseEslintOutput },
    '.jsx': { cmd: 'eslint', args: ['--format=json', '--no-color'], parser: parseEslintOutput },
    '.ts':  { cmd: 'eslint', args: ['--format=json', '--no-color'], parser: parseEslintOutput },
    '.tsx': { cmd: 'eslint', args: ['--format=json', '--no-color'], parser: parseEslintOutput },
    '.py':  { cmd: 'pylint', args: ['--output-format=text', '-sn'], parser: parsePylintOutput },
    '.pyw': { cmd: 'pylint', args: ['--output-format=text', '-sn'], parser: parsePylintOutput },
    '.rb':  { cmd: 'rubocop', args: ['--format=json', '--no-color'], parser: parseRubocopOutput },
    '.go':  { cmd: 'golangci-lint', args: ['run', '--out-format=line-number'], parser: parseGoLintOutput },
    '.java':{ cmd: 'checkstyle', args: ['-c', '/sun_checks.xml'], parser: parseCheckstyleOutput },
    '.cs':  { cmd: 'dotnet', args: ['format', '--verify-no-changes', '--verbosity', 'diagnostic'], parser: parseDotnetFormatOutput },
    '.php': { cmd: 'phpcs', args: ['--report=json', '-q'], parser: parsePhpcsOutput },
    '.kt':  { cmd: 'ktlint', args: ['--format=json', '--relative'], parser: parseKtlintOutput },
    '.kts': { cmd: 'ktlint', args: ['--format=json', '--relative'], parser: parseKtlintOutput },
    '.swift':{ cmd: 'swiftlint', args: ['lint', '--quiet', '--reporter', 'json'], parser: parseSwiftlintOutput },
    '.dart':{ cmd: 'dart', args: ['analyze', '--format=json'], parser: parseDartLintOutput },
    '.rs':  { cmd: 'clippy', args: [], parser: parseClippyOutput },
    '.scala':{ cmd: 'scalastyle', args: [], parser: parseScalastyleOutput },
    '.sc':  { cmd: 'scalastyle', args: [], parser: parseScalastyleOutput },
    '.sh':  { cmd: 'shellcheck', args: ['--format=json'], parser: parseShellcheckOutput },
    '.bash':{ cmd: 'shellcheck', args: ['--format=json'], parser: parseShellcheckOutput },
    '.zsh': { cmd: 'shellcheck', args: ['--format=json'], parser: parseShellcheckOutput },
    '.sql': { cmd: 'sqlfluff', args: ['lint', '--format=json'], parser: parseSqlfluffOutput },
    '.hs':  { cmd: 'hlint', args: ['--json'], parser: parseHlintOutput },
    '.lhs': { cmd: 'hlint', args: ['--json'], parser: parseHlintOutput },
};

function parseEslintOutput(out) {
    const errors = [];
    try {
        const results = JSON.parse(out);
        for (const file of results) {
            for (const msg of file.messages || []) {
                errors.push({ type: 'eslint', line: msg.line || 1, column: msg.column || 1, message: msg.message, severity: msg.severity === 2 ? 'error' : 'warning', rule: msg.ruleId });
            }
        }
    } catch (e) {}
    return errors;
}

function parsePylintOutput(out) {
    const errors = [];
    for (const line of out.split('\n')) {
        const m = line.match(/^.+?:(\d+):(\d+):\s*(\w+\d+):\s*(.+)/);
        if (m) errors.push({ type: 'pylint', line: parseInt(m[1]) || 1, column: parseInt(m[2]) || 1, message: m[4], severity: m[3].startsWith('E') || m[3].startsWith('F') ? 'error' : 'warning', rule: m[3] });
    }
    return errors;
}

function parseRubocopOutput(out) {
    const errors = [];
    try {
        const data = JSON.parse(out);
        for (const file of data.files || []) {
            for (const offense of file.offenses || []) {
                errors.push({ type: 'rubocop', line: offense.location.line, column: offense.location.column || 1, message: offense.message, severity: offense.severity === 'error' || offense.severity === 'fatal' ? 'error' : 'warning', rule: offense.cop_name });
            }
        }
    } catch (e) {}
    return errors;
}

function parseGoLintOutput(out) {
    const errors = [];
    for (const line of out.split('\n')) {
        const m = line.match(/^(.+?):(\d+):(\d+)?:?\s*(.+)/);
        if (m) errors.push({ type: 'golangci-lint', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[4], severity: 'warning' });
    }
    return errors;
}

function parseCheckstyleOutput(out) {
    const errors = [];
    for (const line of out.split('\n')) {
        const m = line.match(/\[(ERROR|WARN)\]\s+.+?:(\d+):(\d+)?:?\s*(.+)/);
        if (m) errors.push({ type: 'checkstyle', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[4], severity: m[1] === 'ERROR' ? 'error' : 'warning' });
    }
    return errors;
}

function parseDotnetFormatOutput(out) {
    const errors = [];
    for (const line of out.split('\n')) {
        const m = line.match(/(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+\w+:\s*(.+)/);
        if (m) errors.push({ type: 'dotnet-format', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[5], severity: m[4] === 'error' ? 'error' : 'warning' });
    }
    return errors;
}

function parsePhpcsOutput(out) {
    const errors = [];
    try {
        const data = JSON.parse(out);
        for (const [file, result] of Object.entries(data.files || {})) {
            for (const msg of result.messages || []) {
                errors.push({ type: 'phpcs', line: msg.line || 1, column: msg.column || 1, message: msg.message, severity: msg.type === 'ERROR' ? 'error' : 'warning', rule: msg.source });
            }
        }
    } catch (e) {}
    return errors;
}

function parseKtlintOutput(out) {
    const errors = [];
    for (const line of out.split('\n')) {
        try {
            const entry = JSON.parse(line);
            if (entry.file && entry.line) {
                errors.push({ type: 'ktlint', line: entry.line, column: entry.col || 1, message: entry.message || entry.detail, severity: 'warning', rule: entry.rule_id });
            }
        } catch (e) {}
    }
    return errors;
}

function parseSwiftlintOutput(out) {
    const errors = [];
    try {
        const results = JSON.parse(out);
        for (const r of results || []) {
            errors.push({ type: 'swiftlint', line: r.line || 1, column: r.character || 1, message: r.reason || r.rule_id, severity: r.severity === 'Error' ? 'error' : 'warning', rule: r.rule_id });
        }
    } catch (e) {}
    return errors;
}

function parseDartLintOutput(out) {
    const errors = [];
    for (const line of out.split('\n')) {
        const m = line.match(/(error|warning|info)\s*-\s*(.+?):(\d+):(\d+)\s*-\s*(.+)/);
        if (m) errors.push({ type: 'dart-lint', line: parseInt(m[3]) || 1, column: parseInt(m[4]) || 1, message: m[5], severity: m[1] === 'error' ? 'error' : 'warning' });
    }
    return errors;
}

function parseClippyOutput(out) {
    const errors = [];
    for (const line of out.split('\n')) {
        const m = line.match(/(?:error|warning)(?:\[(\w+)\])?:\s*(.+)/);
        if (m) {
            const sev = line.startsWith('error') ? 'error' : 'warning';
            errors.push({ type: 'clippy', line: 1, column: 1, message: m[2], severity: sev, rule: m[1] });
        }
    }
    return errors;
}

function parseScalastyleOutput(out) {
    const errors = [];
    for (const line of out.split('\n')) {
        const m = line.match(/(error|warning)\s+.+?line=(\d+)\s+(?:column=(\d+))?\s+(.+)/);
        if (m) errors.push({ type: 'scalastyle', line: parseInt(m[2]) || 1, column: parseInt(m[3]) || 1, message: m[4], severity: m[1] === 'error' ? 'error' : 'warning' });
    }
    return errors;
}

function parseShellcheckOutput(out) {
    const errors = [];
    try {
        const data = JSON.parse(out);
        for (const r of data || []) {
            errors.push({ type: 'shellcheck', line: r.line || 1, column: r.column || 1, message: r.message, severity: r.level === 'error' ? 'error' : 'warning', rule: 'SC' + r.code });
        }
    } catch (e) {}
    return errors;
}

function parseSqlfluffOutput(out) {
    const errors = [];
    try {
        const data = JSON.parse(out);
        for (const r of data || []) {
            errors.push({ type: 'sqlfluff', line: r.line_no || 1, column: r.line_pos || 1, message: r.description, severity: 'warning', rule: r.code });
        }
    } catch (e) {}
    return errors;
}

function parseHlintOutput(out) {
    const errors = [];
    try {
        const data = JSON.parse(out);
        for (const r of data || []) {
            errors.push({ type: 'hlint', line: r.startLine || 1, column: r.startColumn || 1, message: r.hint, severity: r.severity === 'Error' ? 'error' : 'warning', rule: r.name });
        }
    } catch (e) {}
    return errors;
}

function runLinter(filePath, rootDir) {
    const ext = path.extname(filePath).toLowerCase();
    const linter = LINTERS[ext];
    if (!linter) return [];

    const absPath = path.resolve(rootDir, filePath);
    if (!fs.existsSync(absPath)) return [];

    try {
        const args = [...linter.args, absPath];
        const result = require('child_process').spawnSync(linter.cmd, args, { timeout: 30000, encoding: 'utf-8', windowsHide: true });
        const out = (result.stdout || result.stderr || '').trim();
        if (!out) return [];
        return linter.parser(out);
    } catch (e) {
        return [{ type: 'linter', line: 1, column: 1, message: `${linter.cmd} não encontrado. Instale para análise de estilo.`, severity: 'info' }];
    }
}

// =============================================
//  SECURITY SCANNER
// =============================================
const SECRET_PATTERNS = [
    { name: 'API Key (generic)', pattern: /(?:api[_-]?key|apikey|api_secret|secret[_-]?key)\s*[:=]\s*['"][A-Za-z0-9_\-=]{20,}['"]/gi, severity: 'error' },
    { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g, severity: 'error' },
    { name: 'AWS Secret Key', pattern: /['"][A-Za-z0-9/+=]{40}['"]/g, severity: 'error' },
    { name: 'GitHub Token', pattern: /gh[pousr]_[A-Za-z0-9_]{36,}/g, severity: 'error' },
    { name: 'JWT Token', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, severity: 'warning' },
    { name: 'Private Key (PEM)', pattern: /-----BEGIN\s+(?:RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----/g, severity: 'error' },
    { name: 'Password assignment', pattern: /(?:password|passwd|pwd|senha)\s*[:=]\s*['"][^'"]{4,}['"]/gi, severity: 'warning' },
    { name: 'Database URL', pattern: /(?:mongodb|postgres|mysql|redis|sqlite):\/\/[^'"\s]+/gi, severity: 'warning' },
    { name: 'IP Address hardcoded', pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, severity: 'info' },
    { name: 'Token assignment', pattern: /(?:token|access_token|refresh_token|auth[_-]?token)\s*[:=]\s*['"][A-Za-z0-9_\-.]{10,}['"]/gi, severity: 'warning' },
];

const VULNERABLE_PATTERNS = [
    { name: 'eval() usage', pattern: /\beval\s*\(/g, severity: 'warning', message: 'eval() pode permitir code injection. Substitua por JSON.parse ou abordagem segura.' },
    { name: 'exec() usage', pattern: /\bexec\s*\(/g, severity: 'warning', message: 'exec() pode permitir code injection. Use APIs seguras.' },
    { name: 'innerHTML assignment', pattern: /\.innerHTML\s*=/g, severity: 'warning', message: 'innerHTML pode causar XSS. Use textContent ou sanitização.' },
    { name: 'document.write()', pattern: /document\.write\s*\(/g, severity: 'warning', message: 'document.write() bloqueia o parser e pode causar XSS.' },
    { name: 'SQL concatenation', pattern: /['"]\s*\+\s*\w+\s*\+\s*['"]/g, severity: 'warning', message: 'Concatenação SQL sugere SQL injection. Use parâmetros preparados.' },
    { name: 'os.system() Python', pattern: /\bos\.system\s*\(/g, severity: 'warning', message: 'os.system() pode permitir command injection. Use subprocess.run() com lista de args.' },
    { name: 'shell=True', pattern: /shell\s*=\s*True/gi, severity: 'warning', message: 'shell=True permite command injection em subprocess. Use lista de argumentos.' },
    { name: 'dangerouslySetInnerHTML', pattern: /dangerouslySetInnerHTML/g, severity: 'warning', message: 'dangerouslySetInnerHTML pode causar XSS em React.' },
    { name: 'http:// URL', pattern: /['"]http:\/\/[^'"]+['"]/g, severity: 'info', message: 'Use HTTPS em vez de HTTP para URLs externas.' },
];

function scanSecurity(filePath, rootDir) {
    const errors = [];
    try {
        const absPath = path.resolve(rootDir, filePath);
        if (!fs.existsSync(absPath)) return errors;
        const content = fs.readFileSync(absPath, 'utf-8');

        for (const rule of SECRET_PATTERNS) {
            let m;
            const seen = new Set();
            while ((m = rule.pattern.exec(content)) !== null) {
                const key = rule.name + ':' + m.index;
                if (seen.has(key)) continue;
                seen.add(key);
                const lineNo = content.substring(0, m.index).split('\n').length;
                const column = m.index - content.lastIndexOf('\n', m.index - 1);
                errors.push({
                    type: 'security',
                    line: lineNo,
                    column: column,
                    message: `[${rule.name}] Possível segredo exposto no código`,
                    severity: rule.severity
                });
            }
        }

        for (const rule of VULNERABLE_PATTERNS) {
            let m;
            const seen = new Set();
            while ((m = rule.pattern.exec(content)) !== null) {
                const key = rule.name + ':' + m.index;
                if (seen.has(key)) continue;
                seen.add(key);
                const lineNo = content.substring(0, m.index).split('\n').length;
                const column = m.index - content.lastIndexOf('\n', m.index - 1);
                errors.push({
                    type: 'security',
                    line: lineNo,
                    column: column,
                    message: rule.message,
                    severity: rule.severity
                });
            }
        }
    } catch (e) {}
    return errors;
}

// =============================================
//  FORMATTER INTEGRATION
// =============================================
const FORMATTERS = {
    '.js':  { cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.mjs': { cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.cjs': { cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.jsx': { cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.ts':  { cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.tsx': { cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.json':{ cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.css': { cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.html':{ cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.md':  { cmd: 'prettier', args: ['--write'], install: 'npm install -g prettier' },
    '.py':  { cmd: 'black', args: ['--quiet'], install: 'pip install black' },
    '.pyw': { cmd: 'black', args: ['--quiet'], install: 'pip install black' },
    '.go':  { cmd: 'gofmt', args: ['-w'], install: 'go install golang.org/x/tools/cmd/goimports@latest' },
    '.rs':  { cmd: 'rustfmt', args: ['--edition', '2021'], install: 'rustup component add rustfmt' },
    '.rb':  { cmd: 'rubocop', args: ['-A', '--format=quiet'], install: 'gem install rubocop' },
    '.php': { cmd: 'phpcbf', args: ['-q'], install: 'composer global require squizlabs/php_codesniffer' },
    '.java':{ cmd: 'google-java-format', args: ['-i'], install: 'Baixe de https://github.com/google/google-java-format' },
    '.kt':  { cmd: 'ktlint', args: ['-F'], install: 'Baixe de https://github.com/pinterest/ktlint' },
    '.kts': { cmd: 'ktlint', args: ['-F'], install: 'Baixe de https://github.com/pinterest/ktlint' },
    '.dart':{ cmd: 'dart', args: ['format'], install: 'Incluso no Dart SDK' },
    '.lua': { cmd: 'stylua', args: [], install: 'cargo install stylua' },
    '.sh':  { cmd: 'shfmt', args: ['-w', '-i', '2'], install: 'go install mvdan.cc/sh/v3/cmd/shfmt@latest' },
    '.bash':{ cmd: 'shfmt', args: ['-w', '-i', '2'], install: 'go install mvdan.cc/sh/v3/cmd/shfmt@latest' },
    '.sql': { cmd: 'sqlfluff', args: ['fix', '--force'], install: 'pip install sqlfluff' },
};

function formatCode(filePath, rootDir) {
    const ext = path.extname(filePath).toLowerCase();
    const formatter = FORMATTERS[ext];
    if (!formatter) return { success: false, message: `Sem formatador configurado para ${ext}` };

    const absPath = path.resolve(rootDir, filePath);
    if (!fs.existsSync(absPath)) return { success: false, message: 'Arquivo não encontrado' };

    try {
        const result = require('child_process').spawnSync(formatter.cmd, [...formatter.args, absPath], { timeout: 15000, encoding: 'utf-8', windowsHide: true });
        if (result.error && result.error.code === 'ENOENT') {
            return { success: false, message: `${formatter.cmd} não encontrado. Instale: ${formatter.install}` };
        }
        const newContent = fs.readFileSync(absPath, 'utf-8');
        return { success: true, message: `Formatado com ${formatter.cmd}`, content: newContent };
    } catch (e) {
        return { success: false, message: `Erro ao formatar: ${e.message}` };
    }
}

function formatProject(rootDir) {
    const results = [];
    const walk = (dir, rel) => {
        let items;
        try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const entry of items) {
            if (entry.isDirectory()) {
                if (['node_modules', '.git', 'dist', 'build', '.aedificator-codex-ide-backup'].includes(entry.name)) continue;
                walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
                continue;
            }
            const ext = path.extname(entry.name).toLowerCase();
            if (FORMATTERS[ext]) {
                const relPath = rel ? `${rel}/${entry.name}` : entry.name;
                const r = formatCode(relPath, rootDir);
                results.push({ file: relPath, ...r });
            }
        }
    };
    walk(rootDir, '');
    return results;
}

// =============================================
//  ENHANCED CODE SMELLS
// =============================================
function detectCodeSmellsEnhanced(filePath, rootDir) {
    const smells = [];
    const fullPath = path.resolve(rootDir, filePath);
    if (!fs.existsSync(fullPath)) return smells;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    smells.push(...detectCodeSmells(filePath, rootDir));
    smells.push(...detectCyclomaticComplexity(content, lines));
    smells.push(...detectGodClass(content, lines));
    smells.push(...detectDeadCode(content, lines));
    smells.push(...detectTooManyParams(content, lines));

    return smells;
}

function detectCyclomaticComplexity(content, lines) {
    const smells = [];
    const branches = ['if\\s*\\(', 'else\\s+if', 'case\\s+(?!.*:)', 'catch\\s*\\(', '\\&\\&', '\\|\\|', '\\?\\s*[^:]+:',
                      'for\\s*\\(', 'while\\s*\\(', 'unless\\s+', 'when\\s+', 'elif\\s+'];

    const fnStartPatterns = [
        /(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:function|async|\([\w,\s]*\)\s*=>))/,
        /^\s*def\s+(\w+)/,
        /^\s*func\s+(?:\([^)]*\)\s+)?(\w+)/,
        /(?:public|private|protected)\s+(?:static\s+)?(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*\(/,
        /^\s*fun\s+(\w+)\s*\(/,
        /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
    ];

    let fnName = '', fnStart = -1, branchCount = 0, inFn = false, braceDepth = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!inFn) {
            for (const pat of fnStartPatterns) {
                const m = line.match(pat);
                if (m) { fnName = m[1] || m[2]; fnStart = i; branchCount = 0; inFn = true; braceDepth = 0; break; }
            }
            continue;
        }
        for (const b of branches) {
            if (new RegExp(b, 'i').test(line)) branchCount++;
        }
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        braceDepth += opens - closes;
        const isEndKeyword = /^end\b/.test(line);
        const isPyDedent = /^(def|class)\s/.test(line) && i > fnStart;
        if ((braceDepth <= 0 && fnStart >= 0 && opens === 0 && closes > 0) || isEndKeyword || isPyDedent || i === lines.length - 1) {
            if (branchCount > 10) {
                smells.push({ type: 'complexity', line: fnStart + 1, message: `Funcao "${fnName}" tem complexidade ciclomática alta (~${branchCount} branches)`, severity: 'warning' });
            }
            inFn = false; fnStart = -1;
        }
    }
    return smells;
}

function detectGodClass(content, lines) {
    const smells = [];
    const classRe = /(?:^|\s)(?:class|struct|object|defmodule)\s+(\w+)/gm;
    let m;
    while ((m = classRe.exec(content)) !== null) {
        const className = m[1];
        const classStart = m.index;
        const afterClass = content.substring(classStart);

        const methodRe = /(?:def\s+|function\s+|func\s+|fn\s+|public\s|private\s|protected\s)/g;
        let methodCount = 0;
        let methodMatch;
        while ((methodMatch = methodRe.exec(afterClass)) !== null) methodCount++;

        let braceDepth = 0;
        let classEnd = classStart;
        let inRubyStyle = false;
        for (let i = classStart; i < content.length; i++) {
            if (content[i] === '{') braceDepth++;
            else if (content[i] === '}') { braceDepth--; if (braceDepth === 0 && i > classStart + 5) { classEnd = i; break; } }
            if (!inRubyStyle && /^end\b/.test(content.substring(i, i + 4)) && braceDepth === 0) {
                if (i > classStart + 10) { classEnd = i; break; }
            }
        }
        const classLines = content.substring(classStart, classEnd).split('\n').length;

        if (classLines > 300) {
            smells.push({ type: 'god-class', line: content.substring(0, classStart).split('\n').length, message: `Classe "${className}" muito grande (${classLines} linhas). Considere dividir em classes menores.`, severity: 'warning' });
        } else if (methodCount > 20) {
            smells.push({ type: 'god-class', line: content.substring(0, classStart).split('\n').length, message: `Classe "${className}" tem ${methodCount} métodos. Alta probabilidade de God Class.`, severity: 'warning' });
        }
    }
    return smells;
}

function detectDeadCode(content, lines) {
    const smells = [];
    const seen = new Set();

    const commentedCodeRe = /^\s*(?:\/\/|#|--)\s*(?:function|def|class|if|for|while|const|let|var|import|export|return|public|private|protected|static|fn|func)\b/gm;
    let m;
    while ((m = commentedCodeRe.exec(content)) !== null) {
        const key = content.substring(m.index, m.index + 30).trim();
        if (seen.has(key)) continue;
        seen.add(key);
        const lineNo = content.substring(0, m.index).split('\n').length;
        smells.push({ type: 'dead-code', line: lineNo, column: 1, message: 'Código comentado detectado. Remova ou justifique.', severity: 'info' });
    }

    const todoRe = /\b(TODO|FIXME|HACK|XXX|TEMP)\b[:\s-]*(.{0,60})/gi;
    while ((m = todoRe.exec(content)) !== null) {
        const tag = m[1].toUpperCase();
        const note = (m[2] || '').trim();
        const lineNo = content.substring(0, m.index).split('\n').length;
        const sev = tag === 'FIXME' ? 'warning' : 'info';
        smells.push({ type: 'dead-code', line: lineNo, column: 1, message: `[${tag}] ${note || 'Item pendente sem descrição'}`, severity: sev });
    }

    return smells;
}

function detectTooManyParams(content, lines) {
    const smells = [];
    const fnPatterns = [
        /function\s+(\w+)\s*\(([^)]*)\)/g,
        /=>\s*\(([^)]*)\)/g,
        /def\s+(\w+)\s*\(([^)]*)\)/g,
        /func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(([^)]*)\)/g,
        /fn\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)/g,
        /(?:public|private|protected)\s+(?:static\s+)?(?:\w+)\s+(\w+)\s*\(([^)]*)\)/g,
    ];

    for (const pat of fnPatterns) {
        let m;
        while ((m = pat.exec(content)) !== null) {
            const fnName = m[1] || '';
            const paramsStr = m[2] || '';
            const paramCount = paramsStr.split(',').filter(p => p.trim() && !/^\s*$/.test(p)).length;
            if (paramCount > 5) {
                const lineNo = content.substring(0, m.index).split('\n').length;
                smells.push({ type: 'too-many-params', line: lineNo, column: 1, message: `Funcao "${fnName || 'anônima'}" tem ${paramCount} parâmetros. Considere usar objeto/struct.`, severity: 'warning' });
            }
        }
    }
    return smells;
}

// =============================================
//  EXPORTS
// =============================================
module.exports = {
    indexProject,
    validateCode,
    suggestFix,
    autoFixCode,
    invalidateIndex: () => { projectIndex = null; projectIndexTs = 0; },
    basicSyntaxCheck,
    safeValidate,
    COMPILER_INSTALL_HINTS,
    runLinter,
    LINTERS,
    scanSecurity,
    SECRET_PATTERNS,
    VULNERABLE_PATTERNS,
    formatCode,
    formatProject,
    FORMATTERS,
    detectCodeSmells,
    detectCodeSmellsEnhanced,
    validateWithTSProgram,
    getTSSymbols,
    validateWithPythonAST,
    getPythonSymbols,
    validateWithGoVet,
    getGoSymbols,
    validateWithGCC,
    getCppSymbols,
    validateWithRustc,
    getRustSymbols,
    validateWithJavac,
    getJavaSymbols,
    validateWithCSharp,
    getCSharpSymbols,
    validateWithRuby,
    getRubySymbols,
    validateWithPHP,
    getPHPSymbols,
    validateWithKotlin,
    getKotlinSymbols,
    validateWithSwift,
    getSwiftSymbols,
    validateWithDart,
    getDartSymbols,
    validateWithScala,
    getScalaSymbols,
    validateWithLua,
    getLuaSymbols,
    validateWithPerl,
    getPerlSymbols,
    validateWithHaskell,
    getHaskellSymbols,
    validateWithElixir,
    getElixirSymbols,
    validateWithR,
    getRSymbols,
    validateWithShell,
    getShellSymbols,
    validateWithSQLSyntax,
    getSQLSymbols
};
