---
title: Images & Media Content
description: Native image and binary data support with automatic MIME detection, base64 encoding, and mixed content blocks.
---

# Images & Media Content

Many MCP tools produce visual or binary output—such as Playwright browser screenshots, dynamically generated charts, image processing filters, or PDF page renders. 

The Model Context Protocol specification supports sending raw base64-encoded images (`ImageContent`) directly to AI models like Claude Desktop and Cursor. **mcponce** makes handling images completely seamless by providing automatic Buffer normalization, magic byte MIME detection, and ergonomic helper functions.

---

## Quick Example: Screenshot Tool

With `mcponce`, you can return a raw Node.js `Buffer` directly from your tool handler—no manual base64 encoding or manual content array construction required:

```typescript
import { createMcpServer, image } from 'mcponce';
import fs from 'node:fs/promises';

const app = createMcpServer({ name: 'media-agent' });

// 1. Return a raw Buffer directly (MIME type is auto-detected from magic bytes!)
app.tool({
  name: 'get_app_logo',
  description: 'Returns the application brand logo image',
  handler: async () => {
    const pngBuffer = await fs.readFile('./assets/logo.png');
    return pngBuffer; // Automatically normalized to an MCP ImageContent block
  }
});

// 2. Return mixed text and image content
app.tool({
  name: 'generate_analytics_chart',
  description: 'Renders an analytics chart image with accompanying notes',
  handler: async () => {
    const chartPngBuffer = await renderChart();

    return [
      'Monthly Revenue Analytics (Q3):',
      image(chartPngBuffer), // image helper handles buffer or data-uri
      'Notice: Revenue increased by 24% in September.'
    ];
  }
});
```

---

## Automatic Buffer & MIME Detection

When your handler returns a `Buffer` or `Uint8Array`, `mcponce` inspects the initial magic bytes to determine the MIME type:

| Format | Magic Bytes | Inferred MIME Type |
| :--- | :--- | :--- |
| **PNG** | `89 50 4E 47` | `image/png` |
| **JPEG** | `FF D8 FF` | `image/jpeg` |
| **GIF** | `47 49 46 38` | `image/gif` |
| **WEBP** | `52 49 46 46 ... 57 45 42 50` | `image/webp` |
| **BMP** | `42 4D` | `image/bmp` |
| **SVG** | `<svg` or `<?xml` | `image/svg+xml` |

If magic bytes cannot be determined, it defaults to `image/png` (or `application/octet-stream`).

---

## Helper Functions

### `image(data, mimeType?)` / `imageContent(data, mimeType?)`

Constructs an `ImageContentHelper` that satisfies MCP's `ImageContent` interface:

:::tabs group="image-sources"
::tab From Node.js Buffer
```typescript
import { image } from 'mcponce';

const img = image(pngBuffer);
// { type: 'image', data: 'iVBORw0KGgo...', mimeType: 'image/png' }
```

::tab From Data URI
```typescript
// Automatically strips prefix and extracts MIME type
const img = image('data:image/jpeg;base64,/9j/4AAQSkZJRg==');
// mimeType: 'image/jpeg', data: '/9j/4AAQSkZJRg=='
```

::tab Explicit MIME Override
```typescript
const img = image(webpBuffer, 'image/webp');
```
:::

---

## Return Formats Supported by `mcponce`

The handler return value is automatically normalized into valid MCP `CallToolResult`:

### 1. Direct Helper or Buffer
```typescript
handler: () => image(buffer)
handler: () => buffer // Auto-detects and converts to image
```

### 2. Mixed Content Array
```typescript
handler: () => [
  'Here is your screenshot:',
  image(screenshotBuffer),
  'Status: Captured in 240ms'
]
```

### 3. Shorthand Object with Caption
```typescript
handler: () => ({
  image: chartBuffer,
  text: 'Quarterly Financial Summary'
})
```

### 4. Standard MCP Content Array
```typescript
handler: () => ({
  content: [
    { type: 'text', text: 'Document scan' },
    image(scannedPageBuffer).toJSON()
  ]
})
```

---

## Embedded Resources (`resource(...)`)

You can also embed resources into tool responses using `resourceContent` (or `resource`):

```typescript
import { resource } from 'mcponce';

app.tool({
  name: 'export_sales_report',
  handler: async () => {
    return [
      'Export completed successfully.',
      resource({
        uri: 'internal://reports/2026-q3.csv',
        text: 'Date,Amount,Region\n2026-09-01,15000,EMEA',
        mimeType: 'text/csv'
      })
    ];
  }
});
```
