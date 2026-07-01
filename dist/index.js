#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import sql from 'mssql';
import { inspect } from 'node:util';
function requireEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
    }
    return value;
}
function parsePort(value) {
    const port = parseInt(value, 10);
    if (Number.isNaN(port)) {
        throw new Error(`Valor inválido para MSSQL_PORT: ${value}`);
    }
    return port;
}
function getAuthMode() {
    const rawMode = (process.env.MSSQL_AUTH_MODE ?? 'sql').toLowerCase();
    if (rawMode === 'sql' || rawMode === 'windows') {
        return rawMode;
    }
    throw new Error(`Valor inválido para MSSQL_AUTH_MODE: ${rawMode}. Valores aceitos: sql, windows`);
}
async function getSqlClient(authMode) {
    if (authMode === 'windows') {
        const module = (await import('mssql/msnodesqlv8.js'));
        return module.default ?? module;
    }
    return sql;
}
function createDbConfig(authMode) {
    const encrypt = process.env.MSSQL_ENCRYPT === 'true';
    const trustServerCertificate = process.env.MSSQL_TRUST_SERVER_CERTIFICATE !== 'false';
    const host = process.env.MSSQL_HOST ?? 'localhost';
    const port = parsePort(process.env.MSSQL_PORT ?? '1433');
    const database = requireEnv('MSSQL_DATABASE');
    const config = {
        server: host,
        port,
        database,
        options: {
            encrypt,
            trustServerCertificate,
        },
        pool: {
            max: 5,
            min: 0,
            idleTimeoutMillis: 30000,
        },
    };
    if (authMode === 'windows') {
        config.driver = 'msnodesqlv8';
        config.connectionString = `Driver={ODBC Driver 18 for SQL Server};Server=${host},${port};Database=${database};Trusted_Connection=yes;Encrypt=${encrypt ? 'yes' : 'no'};TrustServerCertificate=${trustServerCertificate ? 'yes' : 'no'};`;
    }
    else {
        config.user = requireEnv('MSSQL_USER');
        config.password = requireEnv('MSSQL_PASSWORD');
    }
    return config;
}
const authMode = getAuthMode();
let sqlClient = null;
const dbConfig = createDbConfig(authMode);
let pool = null;
function formatError(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error, null, 2);
    }
    catch {
        return inspect(error, { depth: 6, breakLength: 120 });
    }
}
async function getDbContext() {
    if (!sqlClient) {
        sqlClient = await getSqlClient(authMode);
    }
    if (!pool || !pool.connected) {
        pool = await new sqlClient.ConnectionPool(dbConfig).connect();
    }
    return { pool, client: sqlClient };
}
// ---------------------------------------------------------------------------
// Servidor MCP
// ---------------------------------------------------------------------------
const server = new Server({ name: 'mcp-mssqlserver', version: '1.0.0' }, { capabilities: { tools: {} } });
// ---------------------------------------------------------------------------
// Definição das ferramentas
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: 'execute_query',
            description: 'Executa uma query SQL no SQL Server e retorna os resultados. Use para SELECT, INSERT, UPDATE e DELETE.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'A query SQL a ser executada',
                    },
                },
                required: ['query'],
            },
        },
        {
            name: 'list_tables',
            description: 'Lista todas as tabelas do banco de dados atual, opcionalmente filtrando por schema.',
            inputSchema: {
                type: 'object',
                properties: {
                    schema: {
                        type: 'string',
                        description: 'Schema a filtrar (padrão: todos os schemas)',
                    },
                },
            },
        },
        {
            name: 'describe_table',
            description: 'Retorna a estrutura de uma tabela: colunas, tipos de dados, nulabilidade e valores padrão.',
            inputSchema: {
                type: 'object',
                properties: {
                    table: {
                        type: 'string',
                        description: 'Nome da tabela',
                    },
                    schema: {
                        type: 'string',
                        description: 'Schema da tabela (padrão: dbo)',
                    },
                },
                required: ['table'],
            },
        },
        {
            name: 'list_databases',
            description: 'Lista todos os bancos de dados disponíveis no servidor SQL Server.',
            inputSchema: {
                type: 'object',
                properties: {},
            },
        },
        {
            name: 'get_table_indexes',
            description: 'Lista os índices de uma tabela, incluindo colunas e tipo de índice.',
            inputSchema: {
                type: 'object',
                properties: {
                    table: {
                        type: 'string',
                        description: 'Nome da tabela',
                    },
                    schema: {
                        type: 'string',
                        description: 'Schema da tabela (padrão: dbo)',
                    },
                },
                required: ['table'],
            },
        },
        {
            name: 'get_foreign_keys',
            description: 'Lista as chaves estrangeiras de uma tabela e suas referências.',
            inputSchema: {
                type: 'object',
                properties: {
                    table: {
                        type: 'string',
                        description: 'Nome da tabela',
                    },
                    schema: {
                        type: 'string',
                        description: 'Schema da tabela (padrão: dbo)',
                    },
                },
                required: ['table'],
            },
        },
    ],
}));
// ---------------------------------------------------------------------------
// Implementação das ferramentas
// ---------------------------------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        const db = await getDbContext();
        const pool = db.pool;
        const client = db.client;
        switch (name) {
            case 'execute_query': {
                const query = args?.query;
                const result = await pool.request().query(query);
                const output = result.recordset?.length > 0
                    ? JSON.stringify(result.recordset, null, 2)
                    : `Consulta executada com sucesso. Linhas afetadas: ${result.rowsAffected?.[0] ?? 0}`;
                return { content: [{ type: 'text', text: output }] };
            }
            case 'list_tables': {
                const schema = args?.schema;
                const request = pool.request();
                let query = `
          SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
          FROM INFORMATION_SCHEMA.TABLES
        `;
                if (schema) {
                    request.input('schema', client.NVarChar, schema);
                    query += ' WHERE TABLE_SCHEMA = @schema';
                }
                query += ' ORDER BY TABLE_SCHEMA, TABLE_NAME';
                const result = await request.query(query);
                return { content: [{ type: 'text', text: JSON.stringify(result.recordset, null, 2) }] };
            }
            case 'describe_table': {
                const table = args?.table;
                const schema = args?.schema ?? 'dbo';
                const result = await pool
                    .request()
                    .input('schema', client.NVarChar, schema)
                    .input('table', client.NVarChar, table).query(`
            SELECT
              c.COLUMN_NAME,
              c.DATA_TYPE,
              c.CHARACTER_MAXIMUM_LENGTH,
              c.NUMERIC_PRECISION,
              c.NUMERIC_SCALE,
              c.IS_NULLABLE,
              c.COLUMN_DEFAULT,
              CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 'YES' ELSE 'NO' END AS IS_PRIMARY_KEY
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
              SELECT ku.COLUMN_NAME
              FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
              JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
              WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
                AND tc.TABLE_SCHEMA = @schema
                AND tc.TABLE_NAME = @table
            ) pk ON c.COLUMN_NAME = pk.COLUMN_NAME
            WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
            ORDER BY c.ORDINAL_POSITION
          `);
                return { content: [{ type: 'text', text: JSON.stringify(result.recordset, null, 2) }] };
            }
            case 'list_databases': {
                const result = await pool
                    .request()
                    .query('SELECT name, create_date, state_desc FROM sys.databases ORDER BY name');
                return { content: [{ type: 'text', text: JSON.stringify(result.recordset, null, 2) }] };
            }
            case 'get_table_indexes': {
                const table = args?.table;
                const schema = args?.schema ?? 'dbo';
                const result = await pool
                    .request()
                    .input('schema', client.NVarChar, schema)
                    .input('table', client.NVarChar, table).query(`
            SELECT
              i.name AS INDEX_NAME,
              i.type_desc AS INDEX_TYPE,
              i.is_unique AS IS_UNIQUE,
              i.is_primary_key AS IS_PRIMARY_KEY,
              STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS COLUMNS
            FROM sys.indexes i
            JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
            JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
            JOIN sys.tables t ON i.object_id = t.object_id
            JOIN sys.schemas s ON t.schema_id = s.schema_id
            WHERE s.name = @schema AND t.name = @table
            GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key
            ORDER BY i.is_primary_key DESC, i.name
          `);
                return { content: [{ type: 'text', text: JSON.stringify(result.recordset, null, 2) }] };
            }
            case 'get_foreign_keys': {
                const table = args?.table;
                const schema = args?.schema ?? 'dbo';
                const result = await pool
                    .request()
                    .input('schema', client.NVarChar, schema)
                    .input('table', client.NVarChar, table).query(`
            SELECT
              fk.name AS FK_NAME,
              COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS COLUMN_NAME,
              OBJECT_SCHEMA_NAME(fkc.referenced_object_id) AS REFERENCED_SCHEMA,
              OBJECT_NAME(fkc.referenced_object_id) AS REFERENCED_TABLE,
              COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS REFERENCED_COLUMN,
              fk.delete_referential_action_desc AS ON_DELETE,
              fk.update_referential_action_desc AS ON_UPDATE
            FROM sys.foreign_keys fk
            JOIN sys.foreign_key_columns fkc ON fk.object_id = fkc.constraint_object_id
            JOIN sys.tables t ON fk.parent_object_id = t.object_id
            JOIN sys.schemas s ON t.schema_id = s.schema_id
            WHERE s.name = @schema AND t.name = @table
            ORDER BY fk.name
          `);
                return { content: [{ type: 'text', text: JSON.stringify(result.recordset, null, 2) }] };
            }
            default:
                return {
                    content: [{ type: 'text', text: `Ferramenta desconhecida: ${name}` }],
                    isError: true,
                };
        }
    }
    catch (error) {
        console.error('Tool execution error:', inspect(error, { depth: 8, breakLength: 120 }));
        return {
            content: [{ type: 'text', text: `Erro: ${formatError(error)}` }],
            isError: true,
        };
    }
});
// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map