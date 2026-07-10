# mcp-mssqlserver

[![Docker Publish](https://github.com/ferronicardoso/mcp-mssqlserver/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/ferronicardoso/mcp-mssqlserver/actions/workflows/docker-publish.yml)
[![GHCR](https://img.shields.io/badge/ghcr.io-mcp--mssqlserver-2496ED?logo=docker&logoColor=white)](https://github.com/ferronicardoso/mcp-mssqlserver/pkgs/container/mcp-mssqlserver)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](package.json)

Production-oriented MCP server for Microsoft SQL Server, exposing database operations to MCP clients (Claude Desktop, VS Code Copilot, Cursor, and compatible hosts).

## Features

- Query execution (`SELECT`, `INSERT`, `UPDATE`, `DELETE`)
- Database discovery and schema introspection
- Table metadata inspection (columns, types, nullability, defaults, PK)
- Index and foreign key discovery
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

| `MCP_TRANSPORT` | No | `stdio` | Transport mode: `stdio` (default, for `npx`/Claude Desktop/VS Code) or `http` (Streamable HTTP, for Docker/remote clients such as n8n) |
| `MCP_HTTP_PORT` | No | `3001` | Port for the HTTP server (only used when `MCP_TRANSPORT=http`) |
| `MCP_HTTP_HOST` | No | `0.0.0.0` | Bind address for the HTTP server (only used when `MCP_TRANSPORT=http`) |

> Note: the published Docker image always runs in `http` mode and does not build the `msnodesqlv8` native driver (used only for `MSSQL_AUTH_MODE=windows`). Windows Authentication is only available when running the server directly on a Windows host via `npx`/`npm start`.

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

### Run with Docker (HTTP transport)

The published image runs in Streamable HTTP mode by default, for use as a remote MCP endpoint (e.g. from n8n's MCP Client Tool node or any Streamable HTTP-compatible client):

```bash
docker run -d --name mcp-mssqlserver \
  -p 3001:3001 \
  -e MSSQL_HOST=host.docker.internal \
  -e MSSQL_PORT=1433 \
  -e MSSQL_DATABASE=master \
  -e MSSQL_AUTH_MODE=sql \
  -e MSSQL_USER=sa \
  -e MSSQL_PASSWORD=your-password \
  ghcr.io/ferronicardoso/mcp-mssqlserver:latest
```

The MCP endpoint is then available at `http://localhost:3001/mcp`.

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
