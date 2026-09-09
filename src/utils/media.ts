import type {
  ImageContent,
  TextContent,
  EmbeddedResource,
  TextResourceContents,
  BlobResourceContents,
  ReadResourceResult
} from '@modelcontextprotocol/sdk/types.js';

export type AnyResourceContents = TextResourceContents | BlobResourceContents;

/**
 * Detects common image MIME types from raw buffer magic numbers.
 */
export function detectImageMimeType(
  bytes: Uint8Array | Buffer | string
): string | undefined {
  if (typeof bytes === 'string') {
    if (bytes.startsWith('data:')) {
      const match = bytes.match(/^data:([^;]+);/);
      if (match) return match[1];
    }
    const trimmed = bytes.trimStart();
    if (trimmed.startsWith('<svg') || (trimmed.startsWith('<?xml') && trimmed.includes('<svg'))) {
      return 'image/svg+xml';
    }
    return undefined;
  }

  if (!bytes || bytes.length < 4) {
    return undefined;
  }

  // PNG: 89 50 4E 47
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: GIF87a or GIF89a (47 49 46 38)
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }

  // WEBP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }

  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'image/bmp';
  }

  return undefined;
}

/**
 * Converts a Buffer, Uint8Array, or string to a clean base64 string.
 */
export function toBase64(data: Uint8Array | Buffer | string): string {
  if (typeof data === 'string') {
    // If it's a data URI, strip prefix
    const match = data.match(/^data:[^;]+;base64,(.+)$/s);
    if (match) {
      return match[1].trim();
    }
    return data.trim();
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('base64');
  }

  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
  }

  return Buffer.from(String(data)).toString('base64');
}

/**
 * Class representing an MCP ImageContent block with convenience methods.
 */
export class ImageContentHelper implements ImageContent {
  readonly type = 'image' as const;
  readonly data: string;
  readonly mimeType: string;

  constructor(
    data: Uint8Array | Buffer | string,
    mimeType?: string
  ) {
    let resolvedMime = mimeType;

    if (typeof data === 'string' && data.startsWith('data:')) {
      const match = data.match(/^data:([^;]+);base64,(.+)$/s);
      if (match) {
        resolvedMime = resolvedMime || match[1];
        this.data = match[2].trim();
        this.mimeType = resolvedMime || 'image/png';
        return;
      }
    }

    if (!resolvedMime) {
      resolvedMime = detectImageMimeType(data) || 'image/png';
    }

    this.mimeType = resolvedMime;
    this.data = toBase64(data);
  }

  toJSON(): ImageContent {
    return {
      type: 'image',
      data: this.data,
      mimeType: this.mimeType
    };
  }
}

/**
 * Constructs an MCP ImageContent object from a Buffer, Uint8Array, base64 string, or data URI.
 */
export function imageContent(
  data: Uint8Array | Buffer | string,
  mimeType?: string
): ImageContentHelper {
  return new ImageContentHelper(data, mimeType);
}

/**
 * Shorthand alias for `imageContent`.
 */
export const image = imageContent;

/**
 * Constructs an MCP TextContent block.
 */
export function textContent(text: string | number | boolean): TextContent {
  return {
    type: 'text',
    text: String(text)
  };
}

/**
 * Shorthand alias for `textContent`.
 */
export const text = textContent;

/**
 * Constructs an MCP EmbeddedResource block.
 */
export function resourceContent(resource: AnyResourceContents): EmbeddedResource {
  return {
    type: 'resource',
    resource
  };
}

/**
 * Shorthand alias for `resourceContent`.
 */
export const resource = resourceContent;

/**
 * Type guard for MCP ImageContent.
 */
export function isImageContent(val: any): val is ImageContent {
  return (
    val !== null &&
    typeof val === 'object' &&
    val.type === 'image' &&
    typeof val.data === 'string' &&
    typeof val.mimeType === 'string'
  );
}

/**
 * Type guard for MCP TextContent.
 */
export function isTextContent(val: any): val is TextContent {
  return (
    val !== null &&
    typeof val === 'object' &&
    val.type === 'text' &&
    typeof val.text === 'string'
  );
}

/**
 * Type guard for MCP EmbeddedResource.
 */
export function isEmbeddedResource(val: any): val is EmbeddedResource {
  return (
    val !== null &&
    typeof val === 'object' &&
    val.type === 'resource' &&
    val.resource !== null &&
    typeof val.resource === 'object'
  );
}

/**
 * Normalizes an arbitrary item into a valid MCP content block (TextContent, ImageContent, or EmbeddedResource).
 */
export function normalizeContentItem(item: any): TextContent | ImageContent | EmbeddedResource {
  if (item instanceof ImageContentHelper) {
    return item.toJSON();
  }

  if (isImageContent(item) || isTextContent(item) || isEmbeddedResource(item)) {
    return item;
  }

  if (typeof item === 'string') {
    return textContent(item);
  }

  if (Buffer.isBuffer(item) || item instanceof Uint8Array) {
    const mime = detectImageMimeType(item) || 'image/png';
    return imageContent(item, mime).toJSON();
  }

  if (item && typeof item === 'object') {
    // If it has { image: ... } shorthand
    if ('image' in item && item.image) {
      return imageContent(item.image, item.mimeType).toJSON();
    }
    // If it has { resource: ... } shorthand
    if ('resource' in item && item.resource) {
      return resourceContent(item.resource);
    }
    // If it has { text: ... } shorthand
    if ('text' in item && typeof item.text === 'string') {
      return textContent(item.text);
    }
  }

  return textContent(JSON.stringify(item));
}

/**
 * Normalizes an arbitrary resource return value into a compliant MCP ReadResourceResult.
 */
export function normalizeResourceResult(
  raw: any,
  uri: URL | string,
  defaultMimeType?: string
): ReadResourceResult {
  const uriString = typeof uri === 'string' ? uri : uri.href;

  if (raw && typeof raw === 'object' && Array.isArray(raw.contents)) {
    // Ensure each item in contents has a uri
    const contents = raw.contents.map((item: any) => {
      if (!item.uri) {
        return { ...item, uri: uriString };
      }
      return item;
    });
    return { contents };
  }

  if (typeof raw === 'string') {
    return {
      contents: [
        {
          uri: uriString,
          mimeType: defaultMimeType || 'text/plain',
          text: raw
        }
      ]
    };
  }

  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    const mime = defaultMimeType || detectImageMimeType(raw) || 'application/octet-stream';
    return {
      contents: [
        {
          uri: uriString,
          mimeType: mime,
          blob: toBase64(raw)
        }
      ]
    };
  }

  if (raw instanceof ImageContentHelper) {
    return {
      contents: [
        {
          uri: uriString,
          mimeType: raw.mimeType,
          blob: raw.data
        }
      ]
    };
  }

  if (raw && typeof raw === 'object') {
    if ('blob' in raw && typeof raw.blob === 'string') {
      return {
        contents: [
          {
            uri: raw.uri || uriString,
            mimeType: raw.mimeType || defaultMimeType || 'application/octet-stream',
            blob: raw.blob
          }
        ]
      };
    }
    if ('text' in raw && typeof raw.text === 'string') {
      return {
        contents: [
          {
            uri: raw.uri || uriString,
            mimeType: raw.mimeType || defaultMimeType || 'text/plain',
            text: raw.text
          }
        ]
      };
    }
    if ('image' in raw && raw.image) {
      const mime = raw.mimeType || detectImageMimeType(raw.image) || 'image/png';
      return {
        contents: [
          {
            uri: raw.uri || uriString,
            mimeType: mime,
            blob: toBase64(raw.image)
          }
        ]
      };
    }
    // Any other object or array: serialize to JSON
    return {
      contents: [
        {
          uri: uriString,
          mimeType: defaultMimeType || 'application/json',
          text: JSON.stringify(raw, null, 2)
        }
      ]
    };
  }

  return {
    contents: [
      {
        uri: uriString,
        mimeType: defaultMimeType || 'text/plain',
        text: String(raw ?? '')
      }
    ]
  };
}
