# mcp-mssqlserver

Production-oriented MCP server for Microsoft SQL Server, exposing database operations to MCP clients (Claude Desktop, VS Code Copilot, Cursor, and compatible hosts).

## Features

- Query execution (`SELECT`, `INSERT`, `UPDATE`, `DELETE`)
- Database discovery and schema introspection
- Table metadata inspection (columns, types, nullability, defaults, PK)
- Index and foreign key discovery
- Estimated execution plan analysis (operators, costs, warnings, missing index suggestions) without executing the query
- Environment-driven configuration for secure deployment

## Available Tools

| Tool | Description |
|---|---|
| `execute_query` | Executes a SQL statement and returns recordsets or affected rows |
| `list_tables` | Lists tables from `INFORMATION_SCHEMA.TABLES` (optional schema filter) |
| `describe_table` | Returns table column metadata and primary key markers |
| `list_databases` | Lists all SQL Server databases |
| `get_table_indexes` | Lists table indexes, type, uniqueness, PK, and indexed columns |
| `get_foreign_keys` | Lists table foreign keys and referenced targets |
| `analyze_query_plan` | Returns the estimated execution plan analysis (operators, costs, warnings, missing indexes) without executing the query |

## Requirements

- Node.js 18+
- Access to a Microsoft SQL Server instance
- Network connectivity from MCP host to SQL Server (`host:port`)

## Configuration

Set connection settings using environment variables:

| Variable | Required | Default | Description |
|---|---|---|---|
| `MSSQL_HOST` | No | `localhost` | SQL Server host or IP |
| `MSSQL_PORT` | No | `1433` | SQL Server TCP port |
| `MSSQL_DATABASE` | Yes | — | Default database |
| `MSSQL_AUTH_MODE` | No | `sql` | Authentication mode: `sql` or `windows` |
| `MSSQL_USER` | Yes\* | — | SQL login user (required only in `sql`) |
| `MSSQL_PASSWORD` | Yes\* | — | SQL login password (required only in `sql`) |
| `MSSQL_ENCRYPT` | No | `false` | Enables encrypted connection |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | No | `true` | Trusts server certificate when encryption is enabled |

\* Required when `MSSQL_AUTH_MODE=sql`.

## Usage

### Run directly from GitHub

```bash
npx github:ferronicardoso/mcp-mssqlserver
```

### Claude Desktop configuration

`%APPDATA%\\Claude\\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mssqlserver": {
      "command": "npx",
      "args": ["github:ferronicardoso/mcp-mssqlserver"],
      "env": {
        "MSSQL_HOST": "localhost",
        "MSSQL_PORT": "1433",
        "MSSQL_DATABASE": "master",
        "MSSQL_AUTH_MODE": "sql",
        "MSSQL_USER": "sa",
        "MSSQL_PASSWORD": "your-password"
      }
    }
  }
}
```

### VS Code MCP configuration

`.vscode/mcp.json`:

```json
{
  "servers": {
    "mssqlserver": {
      "command": "npx",
      "args": ["github:ferronicardoso/mcp-mssqlserver"],
      "env": {
        "MSSQL_HOST": "localhost",
        "MSSQL_PORT": "1433",
        "MSSQL_DATABASE": "master",
        "MSSQL_AUTH_MODE": "sql",
        "MSSQL_USER": "sa",
        "MSSQL_PASSWORD": "your-password"
      }
    }
  }
}
```

## Local Development

```bash
git clone https://github.com/ferronicardoso/mcp-mssqlserver
cd mcp-mssqlserver
npm install
npm run build
```

Start the compiled server:

```bash
npm start
```

## Build and Commit Workflow

This repository intentionally tracks `dist/` to support `npx github:user/repo` usage.

The project uses a Husky `pre-commit` hook to:
1. build TypeScript (`npm run build`)
2. stage generated artifacts (`git add dist`)

Manual fallback:

```bash
npm run build
git add dist
```

## Security Notes

- Never commit real credentials or `.env` files.
- Prefer least-privilege SQL users for production use.
- For public or untrusted networks, enable encryption (`MSSQL_ENCRYPT=true`) and configure certificates appropriately.

## Windows Authentication (Integrated Security)

To use Windows Authentication with Integrated Security (process account), configure:

```bash
MSSQL_AUTH_MODE=windows
MSSQL_HOST=sqlserver.company.local
MSSQL_PORT=1433
MSSQL_DATABASE=master
```
