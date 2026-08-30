'use strict';
// =============================================
//  LOOP DO AGENTE (unificado — provider + ferramentas)
//  Recebe as dependências do servidor via setLoopContext(). Os globais mutáveis
//  (_currentAgentProvider/_currentAgentSignal/_agentTodos) são acessados via ctx
//  para refletirem o estado compartilhado com tools.js e providers.js.
// =============================================

const { getAgentSystemPrompt, getDeepSeekAgentPrompt } = require('./prompts');
const { getAgentToolsForMode, getAllToolDeclarations, executeAgentTool } = require('./tools');
const { callAgentProviderWithFallback } = require('./providers');

let _ctx = null;
function setLoopContext(ctx) { _ctx = ctx; }

async function runAgentLoop(task, onChunk, signal, mode, history, provider) {
    const ctx = _ctx;
    if (!ctx) throw new Error('Contexto do loop não inicializado');
    const getFileTree = ctx.getFileTree;
    const getQualityRules = ctx.getQualityRules;
    const getMemoryContext = ctx.getMemoryContext;
    const PROJECT_ROOT = ctx.projectRoot;
    const _pendingImages = ctx.pendingImages;
    const _currentTaskComplexity = ctx.currentTaskComplexity;
    const snapshotProjectFiles = ctx.snapshotProjectFiles;
    const checkToolPermission = ctx.checkToolPermission;
    const buildToolLabel = ctx.buildToolLabel;
    const getToolIcon = ctx.getToolIcon;
    const truncateToolResult = ctx.truncateToolResult;
    const hasRealWriteErrors = ctx.hasRealWriteErrors;
    const diffSnapshots = ctx.diffSnapshots;
    const maybeCompactMessages = ctx.maybeCompactMessages;
    const validateChangedFiles = ctx.validateChangedFiles;
    const mcpManager = ctx.mcpManager;

    const promptDeps = { PROJECT_ROOT, getFileTree, getQualityRules, getMemoryContext, pendingImages: _pendingImages };
    const systemPrompt = provider === 'deepseek' ? getDeepSeekAgentPrompt(promptDeps, task) : getAgentSystemPrompt(promptDeps, task);
    let tools = getAgentToolsForMode(mode, mcpManager, _currentTaskComplexity === 'simple');
    // Teto adaptativo: tarefas simples convergem em poucos passos; tarefas complexas
    // (refatoração, múltiplos arquivos, arquitetura) precisam de mais. O agente também
    // encerra cedo via detecção de progresso (ver MAX_IDLE_ITERATIONS), então um teto
    // maior não significa necessariamente mais iterações — só mais espaço para tarefas grandes.
    const isComplexTask = _currentTaskComplexity === 'complex';
    const maxIterations = isComplexTask ? 40 : 12;

    const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content: task }];
    const prevProvider = ctx.currentAgentProvider;
    const prevSignal = ctx.currentAgentSignal;
    const prevTodos = ctx.agentTodos;
    ctx.currentAgentProvider = provider;
    ctx.currentAgentSignal = signal;
    ctx.agentTodos = [];

    const loopStartSnapshot = snapshotProjectFiles();
    const activeProvider = { value: provider };
    let noActionCount = 0;
    // Ferramentas que efetivamente alteram o projeto. Tool calls de leitura/
    // busca/browser/execução não contam como ação — se o agente fizer muitas
    // delas sem nunca escrever, entramos num loop de exploração infinito.
    const WRITE_TOOLS = new Set(['write_file', 'apply_patch', 'search_replace', 'delete_file', 'file_rename', 'file_mkdir', 'undo', 'redo', 'git_commit', 'git_push', 'git_publish', 'git_stash', 'snapshot_create', 'docker_run', 'ssh_exec']);
    const MAX_NO_WRITE_TOOLCALLS = 5;
    // Quando o agente fica relendo os mesmos arquivos (sinal claro de loop de
    // exploração), a escalada dispara mais cedo para não gastar iterações à toa.
    const MAX_NO_WRITE_TOOLCALLS_RELIDO = 3;
    let noWriteCount = 0;
    let forcedActions = 0;
    let stoppedEarly = false;
    // Rastreia quantas vezes cada arquivo foi lido: reler o mesmo arquivo várias
    // vezes é sinal de que a causa não está nele, mas no que ele chama.
    const arquivosLidos = new Map();
    // Detecção de progresso/estagnação: se o agente JÁ produziu alterações reais
    // no projeto e então fica várias iterações sem nova escrita (só lendo/
    // buscando/verificando), significa que o trabalho de escrita foi concluído e
    // as chamadas restantes são validação ociosa. Encerramos cedo em vez de
    // gastar iterações até o teto. Ao contrário do noWriteCount (que zera a cada
    // escrita), isto acompanha a ÚLTIMA escrita global: uma vez que algo foi
    // salvo, estagnação sem novas escritas dispara a conclusão.
    const MAX_IDLE_ITERATIONS = 5;
    let lastWriteIteration = 0;
    let wroteSomething = false;

    try {
        let iteration = 0;
        while (iteration < maxIterations) {
            if (signal && signal.aborted) {
                const err = new Error('Tarefa cancelada');
                err.name = 'AbortError';
                throw err;
            }
            iteration++;
            if (iteration >= maxIterations - 1 && onChunk) onChunk('Sistema', `⚠️ Iteração ${iteration}/${maxIterations} — finalize a tarefa.\n`);

            const thoughtStart = Date.now();
            const { text, toolCalls } = await callAgentProviderWithFallback(activeProvider.value, messages, tools, signal, onChunk, activeProvider);
            const elapsed = ((Date.now() - thoughtStart) / 1000).toFixed(1);

            if (text && onChunk) onChunk('Assistente', text);
            if (toolCalls.length === 0) {
                // O agente devolveu texto sem executar NENHUMA ferramenta. Isso é
                // legítimo para perguntas/consultas, mas se a tarefa pede uma
                // implementação e o texto parece indecisão/plano ("vou", "posso",
                // "preciso", "poderia", "sugiro"...), NÃO desistimos — forçamos a
                // execução por até 2 tentativas antes de concluir.
                const looksLikeActionTask = /(faça|crie|implemente|adicione|corrija|melhore|modifique|ajuste|refatore|escreva|altere|cria|implementar|melhorar|corrigir|adicionar)/i.test(task);
                const looksHesitant = /(^|\s)(vou|posso|poderia|preciso|devo|sugiro|planejo|vamos|pretendo|poderíamos|poderia|analisar|pensar|estudar)\b/i.test(text || '') || /(\?\s*$)|(escolha|prefere|qual opção|sugest[ãa]o)/i.test(text || '');
                if (looksLikeActionTask && looksHesitant && noActionCount < 2) {
                    noActionCount++;
                    messages.push({
                        role: 'user',
                        content: 'NÃO responda com plano ou pergunta. A tarefa é de IMPLEMENTAÇÃO: use as ferramentas write_file / search_replace / exec_command AGORA para fazer as alterações no código. Se precisar explorar, faça NO MÁXIMO 1 leitura e depois altere.'
                    });
                    continue;
                }
                return text || 'Agente concluído';
            }
            if (onChunk) onChunk('Sistema', `+ Thought: ${elapsed}s\n`);

            messages.push({ role: 'assistant', content: text, tool_calls: toolCalls });

            // Auto-correção NÃO pode ser inserida entre tool calls: a API OpenAI/DeepSeek
            // exige que mensagens "tool" sigam imediatamente um "assistant" com tool_calls.
            // A instrução é acumulada e enviada como "user" DEPOIS de todos os tool results.
            let autoCorrectPending = false;

            for (const tc of toolCalls) {
                if (onChunk) onChunk('Sistema', `🔧 ${tc.name}(${Object.values(tc.args).join(', ').slice(0, 60)})\n`);
                const decision = await checkToolPermission(tc.name, tc.args, signal);
                let result;
                let toolError = false;
                let resultStr = '';
                if (decision === 'deny') {
                    result = 'Permissão negada pelo usuário.';
                    toolError = true;
                    if (onChunk) onChunk('Sistema', '  ⛔ negado pelo usuário\n');
                } else {
                    if (onChunk) onChunk('activity', JSON.stringify({
                        ev: 'tool_start', id: tc.id, tool: tc.name,
                        label: buildToolLabel(tc.name, tc.args), icon: getToolIcon(tc.name),
                        file: tc.args.filePath || tc.args.path || tc.args.file || tc.args.caminho || '',
                        code: (tc.name === 'write_file' || tc.name === 'search_replace' || tc.name === 'apply_patch')
                            ? String(tc.args.content || tc.args.code || tc.args.newContent || tc.args.new_string || '').slice(0, 4000)
                            : ''
                    }));
                    const toolStart = Date.now();
                    try {
                        // Reler o mesmo arquivo várias vezes sem editar nada é loop
                        // de exploração. Em vez de devolver o conteúdo de novo
                        // (gastando tokens e iterações), avisa e força a convergência.
                        const releitura = (tc.name === 'read_file' && tc.args && tc.args.caminho)
                            ? (arquivosLidos.get(tc.args.caminho) || 0)
                            : 0;
                        if (tc.name === 'read_file' && releitura >= 2) {
                            result = `⚠️ Você já leu "${tc.args.caminho}" ${releitura} vezes sem editar nada. NÃO releia: se a causa não está aqui, use search_code para achar o arquivo que ele chama, ou APLIQUE a correção AGORA com apply_patch/write_file.`;
                        } else {
                            result = await executeAgentTool(tc.name, tc.args);
                        }
                    } catch (toolErr) {
                        result = `Erro: ${toolErr.message}`;
                        toolError = true;
                        if (onChunk) onChunk('Sistema', `  ⚠️ falhou: ${toolErr.message.slice(0, 80)}\n`);
                    }
                    const toolElapsed = ((Date.now() - toolStart) / 1000).toFixed(1);
                    resultStr = String(result);
                    if (!toolError) {
                        const preview = resultStr.length > 120 ? resultStr.slice(0, 120).replace(/\n/g, ' ') + '...' : resultStr.replace(/\n/g, ' ');
                        if (tc.name === 'read_file' || tc.name === 'list_files' || tc.name === 'search_code' || tc.name === 'exec_command') {
                            if (onChunk) onChunk('Sistema', `  → ${resultStr.length} bytes · ${toolElapsed}s\n`);
                        } else if (onChunk && resultStr.length) {
                            onChunk('Sistema', `  → ${preview} · ${toolElapsed}s\n`);
                        }
                    }
                    if (onChunk) onChunk('activity', JSON.stringify({ ev: 'tool_end', id: tc.id, isError: toolError, error: toolError ? (resultStr || 'Erro desconhecido').slice(0, 120) : undefined }));
                }
                messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: truncateToolResult(tc.name, result) });

                // Conta tool calls sem efeito de escrita. Ferramentas de leitura/
                // busca/browser/execução não alteram o projeto — se acumularem sem
                // nenhuma escrita, forçamos o agente a agir (ver check abaixo).
                if (WRITE_TOOLS.has(tc.name) && !toolError) {
                    noWriteCount = 0;
                    // Registra a iteração da ÚLTIMA escrita real (para detecção de
                    // estagnação). Mesmo que o agente volte a ler, enquanto não escrever
                    // de novo por MAX_IDLE_ITERATIONS, consideramos o trabalho concluído.
                    wroteSomething = true;
                    lastWriteIteration = iteration;
                    // Reset do rastreio de leitura do arquivo editado: permite
                    // reler após editar (verificação) sem disparar o aviso de releitura.
                    const p = tc.args && (tc.args.caminho || tc.args.file_path || tc.args.path || tc.args.file);
                    if (p) arquivosLidos.delete(p);
                } else if (tc.name !== 'question' && tc.name !== 'todo') {
                    noWriteCount++;
                }

                // Marca releitura do mesmo arquivo (sinal de causa em outro lugar).
                if (tc.name === 'read_file' && tc.args && tc.args.caminho) {
                    arquivosLidos.set(tc.args.caminho, (arquivosLidos.get(tc.args.caminho) || 0) + 1);
                }

                const toolResultStr = String(result);
                if ((tc.name === 'write_file' || tc.name === 'search_replace' || tc.name === 'apply_patch') && !toolError && hasRealWriteErrors(toolResultStr)) {
                    autoCorrectPending = true;
                    if (onChunk) onChunk('Sistema', '⚠️ Auto-correção: há erros reais no arquivo. Corrija antes de prosseguir.\n');
                }
            }

            // Quebra o loop de exploração: após N tool calls sem NENHUMA escrita,
            // injeta uma ordem clara para aplicar a correção agora. O agente
            // tende a ler/buscar sem nunca escrever — isso o força a convergir.
            // Escalada adaptativa: se o agente está relendo arquivos, dispara mais
            // cedo para não gastar iterações à toa em releitura.
            const temReleitura = Array.from(arquivosLidos.values()).some(n => n >= 2);
            const limiteEscalada = temReleitura ? MAX_NO_WRITE_TOOLCALLS_RELIDO : MAX_NO_WRITE_TOOLCALLS;
            if (noWriteCount >= limiteEscalada) {
                const feitas = noWriteCount;
                noWriteCount = 0;
                // Se o agente JÁ escreveu arquivos e agora só está verificando
                // (browser/lendo) sem novas escritas, não há mais o que forçar —
                // conclui em vez de ficar preso até a iteração 20.
                if (diffSnapshots(loopStartSnapshot, snapshotProjectFiles()).length > 0) {
                    stoppedEarly = true;
                    break;
                }
                forcedActions++;
                const relidos = Array.from(arquivosLidos.entries()).filter(([, n]) => n >= 2).map(([f]) => f);
                if (onChunk) onChunk('Sistema', `⚠️ ${feitas} chamadas de leitura/busca sem alterar arquivos. Forçando ação...\n`);
                const dicaReleitura = relidos.length
                    ? `Você já leu ${relidos.join(', ')} mais de uma vez. Se a causa não está aí, ela provavelmente está em um arquivo que esse código CHAMA (ex.: uma função de sanitização, validação ou filtro de HTML/dados). Siga a cadeia: leia UMA vez o arquivo da função chamada e aplique a correção nele.`
                    : '';

                if (forcedActions >= 3) {
                    // Terceira escalada: o modelo ainda não convergiu. Reduzimos ao
                    // mínimo absoluto e exigimos que a correção seja aplicada sem
                    // qualquer outra chamada de leitura — a falha deve ser corrigida
                    // direto com apply_patch no arquivo mais provável da tarefa.
                    tools = getAllToolDeclarations(mcpManager).filter(t =>
                        ['write_file', 'apply_patch', 'search_replace'].includes(t.name)
                    );
                    messages.push({
                        role: 'user',
                        content: `⚠️ [TERCEIRO AVISO — EXECUÇÃO OBRIGATÓRIA] Você fez ${feitas} chamadas de leitura/busca SEM alterar nenhum arquivo, pela terceira vez. As ferramentas de leitura/busca/execução foram REMOVIDAS. AGORA aplique a correção imediatamente:
1. Escolha o arquivo da tarefa que precisa ser alterado.
2. Use apply_patch (edição pontual) ou write_file (reescrita/novo).
3. Se não souber o conteúdo exato, leia mentalmente o que a tarefa pede e aplique a mudança mais direta que a atenda.
NÃO chame nenhuma outra ferramenta antes de escrever. Sua PRÓXIMA ação DEVE ser uma ferramenta de escrita.`
                    });
                } else if (forcedActions >= 2) {
                    // Segunda escalada: o modelo insistiu em explorar mesmo após o
                    // primeiro aviso. Removemos as ferramentas de exploração para
                    // que a única saída seja ler UMA linha e escrever a correção.
                    tools = getAllToolDeclarations(mcpManager).filter(t =>
                        ['read_file', 'write_file', 'apply_patch', 'search_replace', 'search_code', 'exec_command'].includes(t.name)
                    );
                    messages.push({
                        role: 'user',
                        content: `⚠️ [SEGUNDO AVISO — ÚLTIMA CHANCE] Você fez ${feitas} chamadas de leitura/busca SEM alterar nenhum arquivo, pela segunda vez. Isso não é mais exploração: é um loop. As ferramentas de exploração foram REMOVIDAS. Agora você só pode usar read_file (para confirmar UMA linha), write_file ou apply_patch. Identifique o arquivo e a linha exata da correção e aplique-a AGORA com apply_patch. NÃO responda com texto: chame a ferramenta de escrita na sua PRÓXIMA mensagem.`
                    });
                } else {
                    messages.push({
                        role: 'user',
                        content: `⚠️ [AÇÃO OBRIGATÓRIA] Você fez ${feitas} chamadas de leitura/busca sem alterar nenhum arquivo.
1. Se você JÁ identificou a causa raiz, aplique a correção AGORA com apply_patch (mudança pontual) ou write_file (arquivo novo/reescrita).
2. ${dicaReleitura ? dicaReleitura : 'Se ainda não tem certeza da causa, faça NO MÁXIMO 1 leitura adicional FOCADA no arquivo mais provável e aplique a correção imediatamente depois.'}
NÃO é permitido continuar lendo/buscando/reproduzindo no browser até você alterar ao menos um arquivo.`
                    });
                }
            }

            // Finalização por estagnação: já houve escrita real e o agente ficou
            // várias iterações sem novas escritas (só leitura/verificação). Isso
            // indica que o trabalho de escrita terminou e o resto é validação ociosa.
            // Encerramos cedo para não esgotar o teto de iterações à toa — a menos
            // que haja ERROS REAIS nos arquivos alterados, caso em que forçamos a
            // correção (como o opencode valida e repara o que escreveu).
            if (wroteSomething && (iteration - lastWriteIteration) >= MAX_IDLE_ITERATIONS) {
                const changes = diffSnapshots(loopStartSnapshot, snapshotProjectFiles());
                if (changes.length > 0) {
                    const changedFiles = changes.map(c => c.file);
                    const realErrors = (typeof validateChangedFiles === 'function') ? validateChangedFiles(changedFiles) : [];
                    if (realErrors.length > 0) {
                        // Reinicia o contador de estagnação: forçamos a correção dos erros.
                        lastWriteIteration = iteration;
                        const errList = realErrors.slice(0, 4).map(e => `${e.file}: ${e.detail}`).join('\n');
                        messages.push({
                            role: 'user',
                            content: `⚠️ [VALIDAÇÃO PÓS-ESCRITA] Os arquivos que você alterou têm erros REAIS de validação que precisam ser corrigidos antes de concluir:\n${errList}\n\nCorrija-os AGORA no mesmo arquivo (apply_patch ou write_file). Não avance nem conclua enquanto houver esses erros.`
                        });
                        if (onChunk) onChunk('Sistema', `⚠️ ${realErrors.length} arquivo(s) com erros reais. Corrigindo...\n`);
                    } else {
                        stoppedEarly = true;
                        break;
                    }
                }
            }

            if (autoCorrectPending) {
                messages.push({
                    role: 'user',
                    content: '⚠️ [Auto-correção] A validação do arquivo acima acusou erros REAIS (não avisos de escopo). Corrija-os AGORA no mesmo arquivo antes de prosseguir. IGNORE "pode não estar definido neste escopo" — são falsos positivos.'
                });
            }

            await maybeCompactMessages(provider, messages, signal);
        }
        const loopChanges = diffSnapshots(loopStartSnapshot, snapshotProjectFiles());
        if (loopChanges.length > 0) {
            const fileList = loopChanges.slice(0, 8).map(c => `${c.file} (${c.action})`).join(', ');
            return stoppedEarly
                ? `${loopChanges.length} arquivo(s) alterado(s): ${fileList}${loopChanges.length > 8 ? '...' : ''}`
                : `Limite de iterações atingido — ${loopChanges.length} arquivo(s) alterado(s): ${fileList}${loopChanges.length > 8 ? '...' : ''}`;
        }
        return stoppedEarly
            ? 'Concluído'
            : 'Limite de iterações atingido sem alterações de arquivos — o pedido pode ser amplo demais; separe em tarefas menores ou use o modo Direto.';
    } finally {
        ctx.currentAgentProvider = prevProvider;
        ctx.currentAgentSignal = prevSignal;
        ctx.agentTodos = prevTodos;
    }
}

module.exports = { runAgentLoop, setLoopContext };
