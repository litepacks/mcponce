---
title: Defining Tools & Input Schemas
description: Complete guide to registering tools, shorthand schemas, Zod validation, return types, and execution contexts in mcponce.
---

# Defining Tools & Input Schemas

Tools are the core building blocks of an MCP server. They define callable actions that LLMs (or developers via the CLI) can invoke with structured arguments.

---

## 🛠️ Registering a Tool (`app.tool`)

Register tools using the fluent `app.tool(...)` method:

```ts
app.tool({
  name: 'send_email',
  description: 'Sends an email notification to a recipient',
  inputSchema: {
    to: 'string',
    subject: 'string',
    body: 'string',
    urgent: { type: 'boolean', default: false }
  },
  handler: async ({ to, subject, body, urgent }) => {
    // Perform email sending logic
    return {
      sent: true,
      recipient: to,
      messageId: 'msg_12345'
    };
  }
});
```

---

## 📐 Schema Definitions: Shorthand vs. Full Zod

`mcponce` supports both **intuitive shorthand definitions** and **raw Zod schemas**.

### 1. Shorthand Schema (Recommended)

Shorthand schemas reduce boilerplate while maintaining strict runtime validation:

```ts
app.tool({
  name: 'search_database',
  inputSchema: {
    // 1. Primitive string shorthand
    query: 'string',

    // 2. Config object with defaults and descriptions
    limit: {
      type: 'number',
      default: 20,
      description: 'Maximum number of records to return'
    },
    
    // 3. Optional fields
    category: {
      type: 'string',
      required: false,
      description: 'Optional category filter'
    },

    // 4. Arrays and objects
    tags: {
      type: 'array',
      default: []
    }
  },
  handler: ({ query, limit, category, tags }) => {
    return { results: [], count: 0 };
  }
});
```

Supported primitive types:
- `'string'`
- `'number'` / `'integer'`
- `'boolean'`
- `'array'`
- `'object'`

### 2. Full Zod Schemas

If you need advanced validation (regex patterns, min/max lengths, enums, unions), pass a standard Zod object:

```ts
import { z } from 'mcponce';

app.tool({
  name: 'create_user',
  inputSchema: {
    email: z.string().email(),
    age: z.number().int().min(18).max(120),
    role: z.enum(['admin', 'member', 'guest']).default('member'),
    website: z.string().url().optional()
  },
  handler: ({ email, age, role, website }) => {
    return { id: 1, email, age, role };
  }
});
```

---

## 🎁 Automatic Return Normalization

In raw MCP SDK, tools must return a strict object containing `{ content: [{ type: 'text', text: '...' }] }`.

In `mcponce`, you can return **any plain JavaScript value**:
- **Plain Objects / Records**: Automatically serialized to JSON.
- **Strings**: Rendered directly as text content.
- **Numbers / Booleans**: Formatted into readable text.
- **Buffers / Uint8Array**: Automatically converted to base64 `ImageContent` with auto-detected MIME type.
- **Image Helpers**: Use `image(buffer)` to construct typed `ImageContent` blocks with ease (see [Images & Media](/core-features/images-and-media)).
- **Mixed Content Arrays**: Return `['Chart:', image(buf)]` for rich multi-part responses.
- **Official CallToolResult**: Passed through unchanged for custom content.

```ts
import { image } from 'mcponce';

// All of these return formats are valid in mcponce:
app.tool({ name: 't1', handler: () => 'Simple text message' });
app.tool({ name: 't2', handler: () => 42 });
app.tool({ name: 't3', handler: () => ({ success: true, count: 10 }) });
app.tool({ name: 't4', handler: () => screenshotBuffer }); // Auto-converted to ImageContent
app.tool({ name: 't5', handler: () => ['Screenshot:', image(screenshotBuffer)] });
```

---

## 🎛️ Tool Execution Context

The second argument to your tool handler provides rich utilities:

```ts
app.tool({
  name: 'process_order',
  inputSchema: { orderId: 'string' },
  handler: async ({ orderId }, context) => {
    // 1. context.signal: AbortSignal triggered by timeouts or client cancellation
    if (context.signal?.aborted) {
      throw new Error('Aborted');
    }

    // 2. context.callTool: Invoke another tool directly
    const stock = await context.callTool('check_stock', { itemId: 'sku_1' });

    // 3. context.reportProgress: Stream real-time progress to client
    await context.reportProgress({ progress: 50, total: 100, message: 'Charging card...' });

    // 4. context.clearCache: Invalidate cached entries if needed
    context.clearCache('stock_cache');

    return { processed: true, stockLeft: stock.data };
  }
});
```

---

## Next Steps

- Learn how to **[Call Tools Within One Another](/core-features/inter-tool-calling)**.
- Read about **[Smart Input Coercion](/core-features/smart-input-coercion)**.
