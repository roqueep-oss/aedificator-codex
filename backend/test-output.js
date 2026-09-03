// Parser de saída de testes (node --test, Jest/Mocha/Vitest). Função pura
// extraída de server.js: converte texto de saída em estrutura { total, pass,
// fail, details, suites } para a UI e para decisões de rollback pós-agente.
function parseTestOutput(output) {
    const results = { total: 0, pass: 0, fail: 0, details: [], suites: [] };
    const lines = output.split('\n');
    const suiteStack = [{ name: 'root', tests: [] }];

    for (const line of lines) {
        const trimmed = line.trim();

        const suiteStart = trimmed.match(/^▶\s+(.+)$/);
        if (suiteStart) {
            const newSuite = { name: suiteStart[1].trim(), tests: [] };
            suiteStack[suiteStack.length - 1].tests.push(newSuite);
            suiteStack.push(newSuite);
            continue;
        }

        // Fim de suite: "✔ <nome> (ms)". Só é fim de suite se o nome corresponder
        // a uma suite realmente aberta — senão a linha é um teste passando (que
        // deve cair no passMatch abaixo, e não ser descartado/popado indevidamente).
        const suiteEnd = trimmed.match(/^✔\s+(.+?)\s+\(([\d.]+)ms\)$/);
        if (suiteEnd && suiteStack.length > 1) {
            const endName = suiteEnd[1].trim();
            if (suiteStack.some(s => s.name === endName)) {
                while (suiteStack.length > 1 && suiteStack[suiteStack.length - 1].name !== endName) suiteStack.pop();
                if (suiteStack.length > 1) suiteStack.pop();
                continue;
            }
        }

        const passMatch = trimmed.match(/^([✔✓])\s+(.+?)(?:\s+\(([\d.]+)ms\))?$/);
        if (passMatch) {
            results.pass++;
            results.total++;
            const name = passMatch[2] || '';
            const duration = passMatch[3] || '';
            const entry = { name, status: 'pass', duration };
            results.details.push(entry);
            if (suiteStack.length > 1) {
                suiteStack[suiteStack.length - 1].tests.push(entry);
            }
            continue;
        }

        const failMatch = trimmed.match(/^([✖✘✗✕])\s+(.+?)(?:\s+\(([\d.]+)ms\))?$/);
        if (failMatch) {
            results.fail++;
            results.total++;
            const name = failMatch[2] || '';
            const duration = failMatch[3] || '';
            const entry = { name, status: 'fail', duration, error: '' };
            results.details.push(entry);
            if (suiteStack.length > 1) {
                suiteStack[suiteStack.length - 1].tests.push(entry);
            }
            continue;
        }

        const failHeaderMatch = trimmed.match(/^[✖✘✗]\s+failing tests/);
        if (failHeaderMatch) continue;

        const failNameMatch = trimmed.match(/^test\s+at\s+(.+?):(\d+):\d+$/);
        if (failNameMatch) {
            const last = results.details[results.details.length - 1];
            if (last && last.status === 'fail') {
                last.file = failNameMatch[1];
                last.line = parseInt(failNameMatch[2]);
            }
            continue;
        }

        const errorMatch = trimmed.match(/^\s*\[(Error|TypeError|ReferenceError|SyntaxError|AssertionError)[:\]]/);
        if (errorMatch) {
            const last = results.details[results.details.length - 1];
            if (last && last.status === 'fail' && !last.error) {
                last.error = trimmed;
                last.errorType = errorMatch[1];
            }
            continue;
        }

        if (trimmed.startsWith('{') || trimmed.startsWith('error:')) {
            const last = results.details[results.details.length - 1];
            if (last && last.status === 'fail') {
                last.error = (last.error || '') + '\n' + trimmed;
            }
        }
    }

    // Fallback para formatos de resumo de frameworks comuns (Jest/Mocha/Vitest),
    // usados quando nenhum teste individual foi detectado pelas linhas ✔/✖.
    if (results.total === 0) {
        const jestLine = output.split('\n').find(l => /^\s*Tests:\s/i.test(l));
        if (jestLine) {
            const num = (re) => { const m = jestLine.match(re); return m ? (parseInt(m[1].replace(/,/g, ''), 10) || 0) : 0; };
            // "Tests: 32 passed, 32 total" | "Tests: 31 passed, 1 failed, 32 total"
            // "Tests: 1 failed, 31 passed, 32 total" | "Tests: 32 total"
            const passed = num(/([\d,]+)\s+passed/i);
            const failed = num(/([\d,]+)\s+failed/i);
            const total = num(/([\d,]+)\s+total/i);
            if (passed || failed) {
                results.pass = passed;
                results.fail = failed;
                results.total = total || (passed + failed);
            } else if (total) {
                // "Tests: 32 total" sem menção de falhas → assumimos que passaram.
                results.pass = total;
                results.total = total;
            }
        } else {
            const passM = output.match(/([\d,]+)\s+passing/);
            const failM = output.match(/([\d,]+)\s+failing/);
            if (passM || failM) {
                results.pass = passM ? (parseInt(passM[1].replace(/,/g, ''), 10) || 0) : 0;
                results.fail = failM ? (parseInt(failM[1].replace(/,/g, ''), 10) || 0) : 0;
                results.total = results.pass + results.fail;
            }
        }
    }

    results.suites = suiteStack[0].tests;
    return results;
}

module.exports = { parseTestOutput };
