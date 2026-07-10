// ---------------------------------------------------------------------------
// Perfis de execução (MSSQL_PROFILE): guarda de comandos para execute_query
// ---------------------------------------------------------------------------
export function parseProfile(raw) {
    const value = (raw ?? '').toLowerCase() || 'reader';
    if (value === 'reader' || value === 'dml' || value === 'ddl') {
        return value;
    }
    throw new Error(`Valor inválido para MSSQL_PROFILE: ${raw}. Valores aceitos: reader, dml, ddl`);
}
// Instruções permitidas no início de uma instrução em qualquer perfil
const READER_STARTERS = new Set([
    'SELECT',
    'WITH',
    'DECLARE',
    'SET',
    'PRINT',
    'USE', // troca de contexto de banco; não concede permissões
    'IF',
    'ELSE',
    'WHILE',
    'BEGIN', // bloco BEGIN...END; BEGIN TRAN é capturado pelo token TRAN
    'END',
    'RETURN',
    'BREAK',
    'CONTINUE',
    'GOTO',
    'WAITFOR',
    'FETCH',
    'OPEN',
    'CLOSE',
    'DEALLOCATE',
    'THROW',
    'RAISERROR',
    'READTEXT',
]);
// Exigem perfil dml (transações incluídas: só fazem sentido com escrita)
const DML_KEYWORDS = new Set([
    'INSERT',
    'UPDATE',
    'DELETE',
    'MERGE',
    'UPDATETEXT',
    'WRITETEXT',
    'COMMIT',
    'ROLLBACK',
    'SAVE',
    'TRAN',
    'TRANSACTION',
]);
// Exigem perfil ddl (EXEC/dinâmico é inclassificável; administrativos idem)
const DDL_KEYWORDS = new Set([
    'CREATE',
    'ALTER',
    'DROP',
    'TRUNCATE',
    'GRANT',
    'REVOKE',
    'DENY',
    'EXEC',
    'EXECUTE',
    'BACKUP',
    'RESTORE',
    'DBCC',
    'BULK',
    'KILL',
    'SHUTDOWN',
    'RECONFIGURE',
    'CHECKPOINT',
    'SETUSER',
    'REVERT',
    'ENABLE',
    'DISABLE',
]);
// Funções de passagem com potencial de efeito colateral, bloqueadas abaixo de
// ddl em qualquer profundidade de parênteses
const DENY_ANY_DEPTH = new Set(['OPENROWSET', 'OPENQUERY', 'OPENDATASOURCE']);
/**
 * Remove comentários, literais de string e identificadores delimitados,
 * preservando o espaçamento para que tokens adjacentes não se fundam.
 * Identificadores delimitados viram o placeholder "x" para continuarem
 * contando como token (ex.: [dbo].[proc] no início de batch).
 * Trechos não terminados são removidos até o fim (o servidor rejeita o SQL
 * malformado de qualquer forma).
 */
export function stripSql(sql) {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const c = sql[i];
        const next = i + 1 < n ? sql[i + 1] : '';
        if (c === '-' && next === '-') {
            out += '  ';
            i += 2;
            while (i < n && sql[i] !== '\n') {
                out += ' ';
                i++;
            }
            continue;
        }
        if (c === '/' && next === '*') {
            // Comentários de bloco aninham em T-SQL
            let depth = 1;
            out += '  ';
            i += 2;
            while (i < n && depth > 0) {
                if (sql[i] === '/' && sql[i + 1] === '*') {
                    depth++;
                    out += '  ';
                    i += 2;
                }
                else if (sql[i] === '*' && sql[i + 1] === '/') {
                    depth--;
                    out += '  ';
                    i += 2;
                }
                else {
                    out += sql[i] === '\n' ? '\n' : ' ';
                    i++;
                }
            }
            continue;
        }
        if (c === "'") {
            out += ' ';
            i++;
            while (i < n) {
                if (sql[i] === "'" && sql[i + 1] === "'") {
                    out += '  ';
                    i += 2;
                }
                else if (sql[i] === "'") {
                    out += ' ';
                    i++;
                    break;
                }
                else {
                    out += sql[i] === '\n' ? '\n' : ' ';
                    i++;
                }
            }
            continue;
        }
        if (c === '[' || c === '"') {
            const closer = c === '[' ? ']' : '"';
            out += 'x';
            i++;
            while (i < n) {
                if (sql[i] === closer && sql[i + 1] === closer) {
                    out += '  ';
                    i += 2;
                }
                else if (sql[i] === closer) {
                    out += ' ';
                    i++;
                    break;
                }
                else {
                    out += sql[i] === '\n' ? '\n' : ' ';
                    i++;
                }
            }
            continue;
        }
        out += c;
        i++;
    }
    return out;
}
/**
 * Classificador em duas camadas sobre o SQL já limpo:
 * 1. allowlist estrita no início de cada instrução (nega desconhecidos);
 * 2. varredura de verbos de escrita/DDL em profundidade 0 de parênteses,
 *    pois T-SQL não exige ponto e vírgula entre instruções e CTEs podem
 *    terminar em DML (os corpos de CTE ficam em profundidade >= 1).
 */
export function findViolation(query, profile) {
    if (profile === 'ddl') {
        return null;
    }
    const stripped = stripSql(query);
    // @, # e $ fazem parte do token: @update, #delete e delete_flag não são
    // palavras-chave
    const tokenPattern = /[@#A-Za-z_][A-Za-z0-9_@#$]*|[();]/g;
    let depth = 0;
    let atStatementStart = true;
    let lastStarter = null;
    let match;
    while ((match = tokenPattern.exec(stripped)) !== null) {
        const token = match[0];
        if (token === '(') {
            depth++;
            continue;
        }
        if (token === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (token === ';') {
            if (depth === 0) {
                atStatementStart = true;
                lastStarter = null;
            }
            continue;
        }
        const upper = token.toUpperCase();
        if (DENY_ANY_DEPTH.has(upper)) {
            return { keyword: upper, requiredProfile: 'ddl' };
        }
        if (depth > 0) {
            continue;
        }
        if (DDL_KEYWORDS.has(upper)) {
            return { keyword: upper, requiredProfile: 'ddl' };
        }
        if (DML_KEYWORDS.has(upper)) {
            if (profile === 'reader') {
                return { keyword: upper, requiredProfile: 'dml' };
            }
            lastStarter = upper;
            atStatementStart = false;
            continue;
        }
        // SELECT ... INTO cria tabela (exige ddl); INSERT INTO / MERGE INTO /
        // FETCH ... INTO @var permanecem válidos pelo rastreio do último starter
        if (upper === 'INTO' && (lastStarter === 'SELECT' || lastStarter === 'WITH')) {
            return { keyword: 'SELECT ... INTO', requiredProfile: 'ddl' };
        }
        if (READER_STARTERS.has(upper)) {
            lastStarter = upper;
            atStatementStart = false;
            continue;
        }
        if (atStatementStart) {
            // Allowlist estrita: instrução desconhecida (ex.: chamada implícita de
            // procedure no início do batch) é negada abaixo de ddl
            return { keyword: upper, requiredProfile: null };
        }
        atStatementStart = false;
    }
    return null;
}
const PROFILE_SUMMARY = [
    'Perfis disponíveis (via variável de ambiente MSSQL_PROFILE):',
    '- reader (padrão): apenas leitura — SELECT, CTEs, DECLARE/SET e controle de fluxo.',
    '- dml: reader + INSERT, UPDATE, DELETE, MERGE e transações.',
    '- ddl: todos os comandos (CREATE/ALTER/DROP/TRUNCATE, EXEC, GRANT, etc.).',
].join('\n');
export function assertQueryAllowed(query, profile) {
    const violation = findViolation(query, profile);
    if (!violation) {
        return;
    }
    const reason = violation.requiredProfile === null
        ? `a instrução "${violation.keyword}" não é reconhecida pela lista de permissões. Use o perfil "ddl" para executar comandos arbitrários.`
        : `a instrução "${violation.keyword}" requer o perfil "${violation.requiredProfile}".`;
    throw new Error(`Comando bloqueado pelo perfil de execução "${profile}": ${reason}\n${PROFILE_SUMMARY}`);
}
export function describeExecuteQueryTool(profile) {
    switch (profile) {
        case 'reader':
            return ('Executa uma query SQL de leitura no SQL Server e retorna os resultados. ' +
                'Perfil ativo: "reader" — apenas SELECT e instruções de leitura são permitidos; ' +
                'INSERT/UPDATE/DELETE e DDL serão bloqueados.');
        case 'dml':
            return ('Executa uma query SQL no SQL Server e retorna os resultados. ' +
                'Perfil ativo: "dml" — SELECT, INSERT, UPDATE, DELETE e MERGE são permitidos; ' +
                'DDL (CREATE/ALTER/DROP/TRUNCATE) e EXEC serão bloqueados.');
        case 'ddl':
            return ('Executa uma query SQL no SQL Server e retorna os resultados. ' +
                'Use para SELECT, INSERT, UPDATE, DELETE e DDL. ' +
                'Perfil ativo: "ddl" — todos os comandos são permitidos.');
    }
}
//# sourceMappingURL=guard.js.map