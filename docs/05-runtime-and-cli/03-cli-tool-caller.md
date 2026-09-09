---
title: CLI Tool Caller
description: Test and debug MCP tools directly from the command line with parametric flags, progress bars, and JSON output.
---

# CLI Tool Caller

Testing tools by repeatedly prompting an LLM in Claude or Cursor is slow, unpredictable, and wastes token quota. 

**mcponce** features an interactive **CLI Tool Caller** that lets you execute, debug, and script any registered tool directly from your terminal.

---

## Basic Usage

Run any tool using `mcponce call <tool-name>`:

```bash
# Call a tool with named arguments
npx mcponce call get_weather --city Istanbul
```

Output:
```
✔ Execution completed in 14ms
{
  "city": "Istanbul",
  "temperature": 22,
  "condition": "Sunny"
}
```

---

## Passing Complex Arguments

The CLI automatically parses strings, numbers, booleans, and JSON objects:

:::tabs group="cli-args"
::tab Primitives
```bash
# Numbers and booleans
npx mcponce call fetch_users --limit 20 --active true
```

::tab JSON Objects and Arrays
```bash
# Pass structured JSON data directly
npx mcponce call create_record --data '{"name": "Alice", "role": "admin"}'
```

::tab Stdin Piping
```bash
# Pipe file or JSON directly into tool arguments
cat payload.json | npx mcponce call process_batch
```
:::

---

## CLI Flags & Modifiers

Fine-tune execution behavior with built-in flags:

| Flag | Description |
| :--- | :--- |
| `--json` | Outputs raw JSON data only (perfect for piping into `jq`). |
| `--no-cache` | Bypasses in-memory cache and forces fresh execution. |
| `--no-coerce` | Disables input type coercion. |
| `--timeout <ms>` | Sets a custom execution deadline in milliseconds. |
| `--help` | Inspects tool description, parameter types, and defaults. |

### Piping into `jq` with `--json`

```bash
npx mcponce call list_orders --status pending --json | jq '.[].id'
```

---

## Discovering Tools via `--help`

Don't remember the input schema of a tool? Inspect it with the CLI:

```bash
npx mcponce call query_database --help
```

Output:
```
Tool: query_database
Description: Executes a read-only SQL query against the database

Arguments:
  --query       <string> (required) SQL query string to run
  --maxRows     <number> (optional, default: 100) Max rows to return
  --timeoutMs   <number> (optional, default: 5000) Query timeout
```
