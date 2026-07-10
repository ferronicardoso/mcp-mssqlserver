#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import sql from 'mssql';
import { XMLParser } from 'fast-xml-parser';
import { inspect } from 'node:util';

// ---------------------------------------------------------------------------
// Configuração via variáveis de ambiente
// ---------------------------------------------------------------------------
type AuthMode = 'sql' | 'windows';
type SqlClient = typeof sql;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variável de ambiente obrigatória não definida: ${name}`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = parseInt(value, 10);
  if (Number.isNaN(port)) {
    throw new Error(`Valor inválido para MSSQL_PORT: ${value}`);
  }
  return port;
}

function getAuthMode(): AuthMode {
  const rawMode = (process.env.MSSQL_AUTH_MODE ?? 'sql').toLowerCase();
  if (rawMode === 'sql' || rawMode === 'windows') {
    return rawMode;
  }
  throw new Error(
    `Valor inválido para MSSQL_AUTH_MODE: ${rawMode}. Valores aceitos: sql, windows`
  );
}

async function getSqlClient(authMode: AuthMode): Promise<SqlClient> {
  if (authMode === 'windows') {
    const module = (await import('mssql/msnodesqlv8.js')) as { default?: SqlClient };
    return module.default ?? (module as unknown as SqlClient);
  }
  return sql;
}

function createDbConfig(authMode: AuthMode): sql.config {
  const encrypt = process.env.MSSQL_ENCRYPT === 'true';
  const trustServerCertificate = process.env.MSSQL_TRUST_SERVER_CERTIFICATE !== 'false';
  const host = process.env.MSSQL_HOST ?? 'localhost';
  const port = parsePort(process.env.MSSQL_PORT ?? '1433');
  const database = requireEnv('MSSQL_DATABASE');

  const config: sql.config = {
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
    (config as sql.config & { connectionString?: string }).connectionString = `Driver={ODBC Driver 18 for SQL Server};Server=${host},${port};Database=${database};Trusted_Connection=yes;Encrypt=${
      encrypt ? 'yes' : 'no'
    };TrustServerCertificate=${trustServerCertificate ? 'yes' : 'no'};`;
  } else {
    config.user = requireEnv('MSSQL_USER');
    config.password = requireEnv('MSSQL_PASSWORD');
  }

  return config;
}

const authMode = getAuthMode();
let sqlClient: SqlClient | null = null;
const dbConfig: sql.config = createDbConfig(authMode);

let pool: sql.ConnectionPool | null = null;

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return inspect(error, { depth: 6, breakLength: 120 });
  }
}

async function getDbContext(): Promise<{ pool: sql.ConnectionPool; client: SqlClient }> {
  if (!sqlClient) {
    sqlClient = await getSqlClient(authMode);
  }

  if (!pool || !pool.connected) {
    pool = await new sqlClient.ConnectionPool(dbConfig).connect();
  }

  return { pool, client: sqlClient };
}

// ---------------------------------------------------------------------------
// Análise de plano de execução (SHOWPLAN_XML)
// ---------------------------------------------------------------------------
interface PlanOperator {
  physicalOp: string;
  logicalOp: string;
  estimatedRows?: number;
  estimatedSubtreeCost: number;
  object?: string;
  lookup?: boolean;
}

interface MissingIndexSuggestion {
  impact?: number;
  table?: string;
  equalityColumns: string[];
  inequalityColumns: string[];
  includeColumns: string[];
  suggestedCreateStatement?: string;
}

interface StatementAnalysis {
  statementText: string;
  estimatedRows?: number;
  estimatedCost?: number;
  operators: PlanOperator[];
  warnings: string[];
  issues: string[];
  missingIndexes: MissingIndexSuggestion[];
}

type XmlNode = Record<string, unknown>;

const showplanParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
});

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function attrString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function attrNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function attrBool(value: unknown): boolean {
  return value === true || value === 1 || value === 'true' || value === '1';
}

function walkXml(node: unknown, visit: (key: string, value: XmlNode) => void, key = ''): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkXml(item, visit, key);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    visit(key, node as XmlNode);
    for (const [childKey, childValue] of Object.entries(node)) {
      if (!childKey.startsWith('@_')) {
        walkXml(childValue, visit, childKey);
      }
    }
  }
}

function formatObjectName(object: XmlNode): string | undefined {
  const parts = [object['@_Database'], object['@_Schema'], object['@_Table'], object['@_Index']]
    .map(attrString)
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join('.') : undefined;
}

function extractOperator(relOp: XmlNode): PlanOperator {
  const operator: PlanOperator = {
    physicalOp: attrString(relOp['@_PhysicalOp']) ?? 'Unknown',
    logicalOp: attrString(relOp['@_LogicalOp']) ?? 'Unknown',
    estimatedRows: attrNumber(relOp['@_EstimateRows']),
    estimatedSubtreeCost: attrNumber(relOp['@_EstimatedTotalSubtreeCost']) ?? 0,
  };
  for (const [key, child] of Object.entries(relOp)) {
    if (key.startsWith('@_') || key === 'RelOp' || child === null || typeof child !== 'object') {
      continue;
    }
    const childNode = child as XmlNode;
    const objects = asArray(childNode.Object as XmlNode | XmlNode[] | undefined);
    if (objects.length > 0) {
      operator.object = formatObjectName(objects[0]);
      if (attrBool(childNode['@_Lookup'])) {
        operator.lookup = true;
      }
      break;
    }
  }
  return operator;
}

function extractWarnings(node: XmlNode): string[] {
  const warnings: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_')) {
      if (attrBool(value)) {
        warnings.push(key.slice(2));
      }
      continue;
    }
    if (key === '#text') {
      continue;
    }
    for (const child of asArray(value as XmlNode | XmlNode[])) {
      if (child === null || typeof child !== 'object') {
        warnings.push(key);
        continue;
      }
      const childNode = child as XmlNode;
      const detail = [attrString(childNode['@_ConvertIssue']), attrString(childNode['@_Expression'])]
        .filter(Boolean)
        .join(': ');
      warnings.push(detail ? `${key} (${detail})` : key);
    }
  }
  return warnings;
}

function stripBrackets(value: string): string {
  return value.replace(/[[\]]/g, '');
}

function extractMissingIndex(group: XmlNode): MissingIndexSuggestion {
  const suggestion: MissingIndexSuggestion = {
    impact: attrNumber(group['@_Impact']),
    equalityColumns: [],
    inequalityColumns: [],
    includeColumns: [],
  };
  const missingIndex = asArray(group.MissingIndex as XmlNode | XmlNode[] | undefined)[0];
  if (!missingIndex) {
    return suggestion;
  }

  const database = attrString(missingIndex['@_Database']);
  const schema = attrString(missingIndex['@_Schema']);
  const table = attrString(missingIndex['@_Table']);
  suggestion.table = [database, schema, table].filter(Boolean).join('.') || undefined;

  for (const columnGroup of asArray(missingIndex.ColumnGroup as XmlNode | XmlNode[] | undefined)) {
    const usage = attrString(columnGroup['@_Usage']);
    const columns = asArray(columnGroup.Column as XmlNode | XmlNode[] | undefined)
      .map((column) => attrString(column['@_Name']))
      .filter((name): name is string => Boolean(name));
    if (usage === 'EQUALITY') {
      suggestion.equalityColumns.push(...columns);
    } else if (usage === 'INEQUALITY') {
      suggestion.inequalityColumns.push(...columns);
    } else if (usage === 'INCLUDE') {
      suggestion.includeColumns.push(...columns);
    }
  }

  const keyColumns = [...suggestion.equalityColumns, ...suggestion.inequalityColumns];
  if (schema && table && keyColumns.length > 0) {
    const indexName = `IX_${stripBrackets(table)}_${keyColumns.map(stripBrackets).join('_')}`;
    let createStatement = `CREATE NONCLUSTERED INDEX [${indexName}] ON ${schema}.${table} (${keyColumns.join(', ')})`;
    if (suggestion.includeColumns.length > 0) {
      createStatement += ` INCLUDE (${suggestion.includeColumns.join(', ')})`;
    }
    suggestion.suggestedCreateStatement = createStatement;
  }
  return suggestion;
}

function detectIssues(operators: PlanOperator[], statementCost?: number): string[] {
  const issues = new Set<string>();
  for (const op of operators) {
    const target = op.object ? ` em ${op.object}` : '';
    if (op.lookup) {
      issues.add(`Key Lookup${target} — considere adicionar colunas INCLUDE ao índice usado`);
    } else if (op.physicalOp === 'RID Lookup') {
      issues.add(`RID Lookup${target} — tabela heap; considere um índice clustered ou covering index`);
    } else if (op.physicalOp === 'Table Scan') {
      issues.add(`Table Scan${target} — leitura completa de tabela sem índice`);
    } else if (op.physicalOp === 'Clustered Index Scan' || op.physicalOp === 'Index Scan') {
      issues.add(`${op.physicalOp}${target} — leitura completa do índice`);
    } else if (
      (op.physicalOp === 'Sort' || op.physicalOp === 'Hash Match') &&
      statementCost !== undefined &&
      statementCost > 0.05 &&
      op.estimatedSubtreeCost >= statementCost * 0.3
    ) {
      issues.add(`Operador custoso: ${op.physicalOp} (custo estimado ${op.estimatedSubtreeCost})`);
    }
  }
  return [...issues];
}

function analyzeStatement(stmt: XmlNode): StatementAnalysis {
  const estimatedCost = attrNumber(stmt['@_StatementSubTreeCost']);
  const operators: PlanOperator[] = [];
  const warnings = new Set<string>();
  const missingIndexes: MissingIndexSuggestion[] = [];

  walkXml(stmt, (key, node) => {
    if (key === 'RelOp') {
      operators.push(extractOperator(node));
    } else if (key === 'Warnings') {
      for (const warning of extractWarnings(node)) {
        warnings.add(warning);
      }
    } else if (key === 'MissingIndexGroup') {
      missingIndexes.push(extractMissingIndex(node));
    }
  });

  operators.sort((a, b) => b.estimatedSubtreeCost - a.estimatedSubtreeCost);
  const issues = detectIssues(operators, estimatedCost);

  return {
    statementText: attrString(stmt['@_StatementText']) ?? '',
    estimatedRows: attrNumber(stmt['@_StatementEstRows']),
    estimatedCost,
    operators: operators.slice(0, 20),
    warnings: [...warnings],
    issues,
    missingIndexes,
  };
}

export function parseShowplan(xml: string): StatementAnalysis[] {
  const doc = showplanParser.parse(xml) as XmlNode;
  const showPlan = doc.ShowPlanXML as XmlNode | undefined;
  const batchSequence = showPlan?.BatchSequence as XmlNode | undefined;
  const statements: StatementAnalysis[] = [];
  for (const batch of asArray(batchSequence?.Batch as XmlNode | XmlNode[] | undefined)) {
    for (const stmtContainer of asArray(batch.Statements as XmlNode | XmlNode[] | undefined)) {
      for (const [key, value] of Object.entries(stmtContainer)) {
        if (!key.startsWith('Stmt')) {
          continue;
        }
        for (const stmt of asArray(value as XmlNode | XmlNode[])) {
          statements.push(analyzeStatement(stmt));
        }
      }
    }
  }
  return statements;
}

async function getEstimatedPlanXml(query: string): Promise<string[]> {
  if (!sqlClient) {
    sqlClient = await getSqlClient(authMode);
  }
  const client = sqlClient;
  // Pool dedicado de conexão única: SET SHOWPLAN_XML é por sessão e não pode
  // vazar para as conexões compartilhadas das outras ferramentas.
  const planPool = await new client.ConnectionPool({
    ...dbConfig,
    pool: { max: 1, min: 0, idleTimeoutMillis: 30000 },
  }).connect();
  try {
    await planPool.request().batch('SET SHOWPLAN_XML ON');
    const result = await planPool.request().batch(query);
    const recordsets = asArray(result.recordsets as sql.IRecordSet<Record<string, unknown>>[]);
    const plans: string[] = [];
    for (const recordset of recordsets) {
      for (const row of recordset) {
        const value = Object.values(row)[0];
        if (typeof value === 'string' && value.includes('<ShowPlanXML')) {
          plans.push(value);
        }
      }
    }
    if (plans.length === 0) {
      throw new Error('O SQL Server não retornou um plano de execução para a query informada.');
    }
    return plans;
  } finally {
    await planPool.close();
  }
}

// ---------------------------------------------------------------------------
// Servidor MCP
// ---------------------------------------------------------------------------
const server = new Server(
  { name: 'mcp-mssqlserver', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ---------------------------------------------------------------------------
// Definição das ferramentas
// ---------------------------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'execute_query',
      description:
        'Executa uma query SQL no SQL Server e retorna os resultados. Use para SELECT, INSERT, UPDATE e DELETE.',
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
      description:
        'Retorna a estrutura de uma tabela: colunas, tipos de dados, nulabilidade e valores padrão.',
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
      name: 'analyze_query_plan',
      description:
        'Analisa o plano de execução estimado de uma query SQL sem executá-la. Retorna operadores, custos estimados, avisos (scans, lookups, conversões implícitas) e sugestões de índices ausentes.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A query SQL a ser analisada (batch único, sem GO)',
          },
          include_raw_plan: {
            type: 'boolean',
            description: 'Inclui o XML completo do plano (SHOWPLAN) na resposta (padrão: false)',
          },
        },
        required: ['query'],
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
        const query = args?.query as string;
        const result = await pool.request().query(query);
        const output =
          result.recordset?.length > 0
            ? JSON.stringify(result.recordset, null, 2)
            : `Consulta executada com sucesso. Linhas afetadas: ${result.rowsAffected?.[0] ?? 0}`;
        return { content: [{ type: 'text', text: output }] };
      }

      case 'list_tables': {
        const schema = args?.schema as string | undefined;
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
        const table = args?.table as string;
        const schema = (args?.schema as string) ?? 'dbo';
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
        const table = args?.table as string;
        const schema = (args?.schema as string) ?? 'dbo';
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
        const table = args?.table as string;
        const schema = (args?.schema as string) ?? 'dbo';
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

      case 'analyze_query_plan': {
        const query = args?.query as string;
        const includeRawPlan = (args?.include_raw_plan as boolean) ?? false;
        const plans = await getEstimatedPlanXml(query);
        const statements: StatementAnalysis[] = [];
        const parseErrors: string[] = [];
        for (const xml of plans) {
          try {
            statements.push(...parseShowplan(xml));
          } catch (parseError) {
            parseErrors.push(formatError(parseError));
          }
        }
        const output: Record<string, unknown> = { statements };
        if (parseErrors.length > 0) {
          output.parseErrors = parseErrors;
        }
        if (includeRawPlan || parseErrors.length > 0) {
          output.rawPlan = plans.join('\n');
        }
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Ferramenta desconhecida: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
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
