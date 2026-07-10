# mcp-mssqlserver

Production-oriented MCP server for Microsoft SQL Server, exposing database operations to MCP clients (Claude Desktop, VS Code Copilot, Cursor, and compatible hosts).

## Features

- Query execution (`SELECT`, `INSERT`, `UPDATE`, `DELETE`), gated by execution profiles
- Database discovery and schema introspection
- Table metadata inspection (columns, types, nullability, defaults, PK)
- Index and foreign key discovery
- Environment-driven configuration for secure deployment

## Available Tools

| Tool | Description |
|---|---|
| `execute_query` | Executes a SQL statement and returns recordsets or affected rows (statements allowed depend on `MSSQL_PROFILE`) |
| `list_tables` | Lists tables from `INFORMATION_SCHEMA.TABLES` (optional schema filter) |
| `describe_table` | Returns table column metadata and primary key markers |
| `list_databases` | Lists all SQL Server databases |
| `get_table_indexes` | Lists table indexes, type, uniqueness, PK, and indexed columns |
| `get_foreign_keys` | Lists table foreign keys and referenced targets |

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
| `MSSQL_PROFILE` | No | `reader` | Execution guard profile: `reader` (read-only), `dml` (+ writes), `ddl` (everything) |
| `MSSQL_USER` | Yes\* | — | SQL login user (required only in `sql`) |
| `MSSQL_PASSWORD` | Yes\* | — | SQL login password (required only in `sql`) |
| `MSSQL_ENCRYPT` | No | `false` | Enables encrypted connection |
| `MSSQL_TRUST_SERVER_CERTIFICATE` | No | `true` | Trusts server certificate when encryption is enabled |

\* Required when `MSSQL_AUTH_MODE=sql`.

## Execution Profiles

The `MSSQL_PROFILE` environment variable controls which SQL statements `execute_query` may run. Profiles are cumulative:

| Profile | Allows |
|---|---|
| `reader` (default) | `SELECT`, CTEs, `DECLARE`/`SET`, flow control (`IF`, `WHILE`, `BEGIN...END`), cursors |
| `dml` | Everything in `reader`, plus `INSERT`, `UPDATE`, `DELETE`, `MERGE` and transactions (`BEGIN TRAN`, `COMMIT`, `ROLLBACK`) |
| `ddl` | Everything — `CREATE`/`ALTER`/`DROP`/`TRUNCATE`, `EXEC`, `GRANT`, and any other statement |

Enforcement uses a strict allowlist: statements the classifier does not recognize are **denied** below `ddl`, with an error naming the active profile and the blocked statement. Notable classifications:

- `SELECT ... INTO` requires `ddl` (it creates a table).
- `EXEC`/`sp_executesql` and `OPENROWSET`/`OPENQUERY`/`OPENDATASOURCE` require `ddl` — dynamic and pass-through SQL cannot be classified.
- Transactions require `dml`.
- Keywords inside strings, comments, or `[bracketed identifiers]` are ignored correctly.

The catalog tools (`list_tables`, `describe_table`, `list_databases`, `get_table_indexes`, `get_foreign_keys`) run fixed read-only queries and work in every profile. The `execute_query` tool description shown to the MCP client reflects the active profile.

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
        "MSSQL_PASSWORD": "your-password",
        "MSSQL_PROFILE": "reader"
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
        "MSSQL_PASSWORD": "your-password",
        "MSSQL_PROFILE": "reader"
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
- Keep `MSSQL_PROFILE=reader` unless writes are required. The profile guard is defense-in-depth, not a substitute for database-level permissions.
- For public or untrusted networks, enable encryption (`MSSQL_ENCRYPT=true`) and configure certificates appropriately.

## Windows Authentication (Integrated Security)

To use Windows Authentication with Integrated Security (process account), configure:

```bash
MSSQL_AUTH_MODE=windows
MSSQL_HOST=sqlserver.company.local
MSSQL_PORT=1433
MSSQL_DATABASE=master
```
