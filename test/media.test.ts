import { describe, it, expect } from 'vitest';
import {
  createMcpServer,
  image,
  imageContent,
  text,
  textContent,
  resource,
  resourceContent,
  detectImageMimeType,
  toBase64,
  ImageContentHelper,
  isImageContent,
  isTextContent,
  isEmbeddedResource
} from '../src/index.js';
import { normalizeToolResult } from '../src/server/mcp.js';
import {
  normalizeResourceResult,
  normalizeContentItem
} from '../src/utils/media.js';

describe('Media & Image Content Helpers', () => {
  // Sample PNG 1x1 pixel buffer
  const samplePngBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52
  ]);

  // Sample JPEG SOI marker
  const sampleJpegBuffer = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46
  ]);

  // Sample GIF marker
  const sampleGifBuffer = Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61
  ]);

  // Sample WEBP marker
  const sampleWebpBuffer = Buffer.from([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50
  ]);

  describe('detectImageMimeType', () => {
    it('detects PNG from magic bytes', () => {
      expect(detectImageMimeType(samplePngBuffer)).toBe('image/png');
      expect(detectImageMimeType(new Uint8Array(samplePngBuffer))).toBe('image/png');
    });

    it('detects JPEG from magic bytes', () => {
      expect(detectImageMimeType(sampleJpegBuffer)).toBe('image/jpeg');
    });

    it('detects GIF from magic bytes', () => {
      expect(detectImageMimeType(sampleGifBuffer)).toBe('image/gif');
    });

    it('detects WEBP from magic bytes', () => {
      expect(detectImageMimeType(sampleWebpBuffer)).toBe('image/webp');
    });

    it('detects SVG from XML and SVG strings', () => {
      expect(detectImageMimeType('<svg viewBox="0 0 10 10"></svg>')).toBe('image/svg+xml');
      expect(detectImageMimeType('<?xml version="1.0"?><svg></svg>')).toBe('image/svg+xml');
    });

    it('detects mime type from data URI strings', () => {
      expect(detectImageMimeType('data:image/png;base64,iVBORw0KGgo=')).toBe('image/png');
      expect(detectImageMimeType('data:image/webp;base64,UklGRg==')).toBe('image/webp');
    });
  });

  describe('toBase64', () => {
    it('encodes Buffer to base64', () => {
      const buf = Buffer.from('hello world');
      expect(toBase64(buf)).toBe(buf.toString('base64'));
    });

    it('encodes Uint8Array to base64', () => {
      const arr = new Uint8Array([1, 2, 3, 4]);
      expect(toBase64(arr)).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
    });

    it('strips data URI prefix if present and handles plain string', () => {
      const dataUri = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=';
      expect(toBase64(dataUri)).toBe('iVBORw0KGgoAAAANSUhEUgAAAAE=');
      expect(toBase64('  iVBORw0KGgoAAAANSUhEUgAAAAE=  ')).toBe('iVBORw0KGgoAAAANSUhEUgAAAAE=');
    });
  });

  describe('ImageContentHelper and image(...)', () => {
    it('creates ImageContent from Buffer with auto-detected mime', () => {
      const img = image(samplePngBuffer);
      expect(img.type).toBe('image');
      expect(img.mimeType).toBe('image/png');
      expect(img.data).toBe(samplePngBuffer.toString('base64'));
      expect(isImageContent(img)).toBe(true);
    });

    it('creates ImageContent from Data URI', () => {
      const uri = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
      const img = imageContent(uri);
      expect(img.mimeType).toBe('image/jpeg');
      expect(img.data).toBe('/9j/4AAQSkZJRg==');
    });

    it('allows explicit MIME type override', () => {
      const img = image(Buffer.from('custom'), 'image/webp');
      expect(img.mimeType).toBe('image/webp');
    });

    it('serializes to valid MCP ImageContent via toJSON', () => {
      const img = image(samplePngBuffer);
      const json = img.toJSON();
      expect(json).toEqual({
        type: 'image',
        data: samplePngBuffer.toString('base64'),
        mimeType: 'image/png'
      });
    });
  });

  describe('normalizeToolResult with Media', () => {
    it('normalizes direct ImageContentHelper return', () => {
      const img = image(samplePngBuffer);
      const result = normalizeToolResult(img);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('image');
      expect((result.content[0] as any).mimeType).toBe('image/png');
      expect(result.text).toBe('[Image: image/png]');
    });

    it('normalizes raw Buffer return automatically to ImageContent', () => {
      const result = normalizeToolResult(sampleJpegBuffer);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('image');
      expect((result.content[0] as any).mimeType).toBe('image/jpeg');
      expect((result.content[0] as any).data).toBe(sampleJpegBuffer.toString('base64'));
      expect(result.text).toBe('[Image: image/jpeg]');
    });

    it('normalizes shorthand object with { image: buffer, text: "caption" }', () => {
      const result = normalizeToolResult({
        image: samplePngBuffer,
        text: 'Generated diagram'
      });
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Generated diagram' });
      expect(result.content[1].type).toBe('image');
      expect(result.text).toBe('Generated diagram');
    });

    it('normalizes mixed array with strings and image helpers', () => {
      const result = normalizeToolResult([
        'Here is the chart:',
        image(samplePngBuffer),
        'End of report'
      ]);
      expect(result.content).toHaveLength(3);
      expect(result.content[0]).toEqual({ type: 'text', text: 'Here is the chart:' });
      expect(result.content[1].type).toBe('image');
      expect(result.content[2]).toEqual({ type: 'text', text: 'End of report' });
      expect(result.text).toContain('Here is the chart:');
      expect(result.text).toContain('End of report');
    });

    it('normalizes embedded resources using resourceContent helper', () => {
      const res = resource({
        uri: 'file:///data.csv',
        text: 'a,b,c\n1,2,3',
        mimeType: 'text/csv'
      });
      expect(isEmbeddedResource(res)).toBe(true);

      const result = normalizeToolResult(res);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('resource');
    });
  });

  describe('Server Tool Integration with Image Returns', () => {
    it('executes a tool returning an image via app.callTool', async () => {
      const app = createMcpServer({
        name: 'test-media-server',
        registerInCentral: false
      });

      app.tool({
        name: 'generate_badge',
        handler: () => {
          return image(samplePngBuffer);
        }
      });

      const res = await app.callTool('generate_badge');
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe('image');
      expect((res.content[0] as any).mimeType).toBe('image/png');
      expect((res.content[0] as any).data).toBe(samplePngBuffer.toString('base64'));
    });

    it('executes a tool returning a raw Buffer directly', async () => {
      const app = createMcpServer({
        name: 'test-buffer-server',
        registerInCentral: false
      });

      app.tool({
        name: 'capture_screen',
        handler: () => {
          return samplePngBuffer; // Return raw Buffer directly
        }
      });

      const res = await app.callTool('capture_screen');
      expect(res.content).toHaveLength(1);
      expect(res.content[0].type).toBe('image');
      expect((res.content[0] as any).mimeType).toBe('image/png');
    });

    it('supports inter-tool calling with images', async () => {
      const app = createMcpServer({
        name: 'test-intertool-media',
        registerInCentral: false
      });

      app.tool({
        name: 'create_chart',
        handler: () => image(samplePngBuffer)
      });

      app.tool({
        name: 'build_dashboard',
        handler: async (_, { callTool }) => {
          const chartResult = await callTool('create_chart');
          return [
            'Dashboard Report Header',
            chartResult.content[0],
            'Footer Notes'
          ];
        }
      });

      const res = await app.callTool('build_dashboard');
      expect(res.content).toHaveLength(3);
      expect(res.content[0]).toEqual({ type: 'text', text: 'Dashboard Report Header' });
      expect(res.content[1].type).toBe('image');
      expect(res.content[2]).toEqual({ type: 'text', text: 'Footer Notes' });
    });
  });

  describe('Edge cases in detectImageMimeType & toBase64', () => {
    it('detects BMP from magic bytes', () => {
      const bmpBuffer = Buffer.from([0x42, 0x4d, 0x00, 0x00, 0x00, 0x00]);
      expect(detectImageMimeType(bmpBuffer)).toBe('image/bmp');
    });

    it('returns undefined for short or unrecognized byte arrays', () => {
      expect(detectImageMimeType(Buffer.from([0x00, 0x01]))).toBeUndefined();
      expect(detectImageMimeType(Buffer.from([0x12, 0x34, 0x56, 0x78]))).toBeUndefined();
      expect(detectImageMimeType('')).toBeUndefined();
      expect(detectImageMimeType('some random text')).toBeUndefined();
    });

    it('handles toBase64 with numbers, booleans or primitives', () => {
      expect(toBase64(12345 as any)).toBe(Buffer.from('12345').toString('base64'));
    });
  });

  describe('normalizeContentItem', () => {
    it('normalizes various content formats', () => {
      const imgHelper = image(samplePngBuffer);
      expect(normalizeContentItem(imgHelper)).toEqual(imgHelper.toJSON());

      const textBlock = text('hello');
      expect(normalizeContentItem(textBlock)).toEqual(textBlock);

      const strResult = normalizeContentItem('just a string');
      expect(strResult).toEqual({ type: 'text', text: 'just a string' });

      const bufResult = normalizeContentItem(samplePngBuffer);
      expect(bufResult.type).toBe('image');

      const objResource = normalizeContentItem({
        resource: { uri: 'custom://res', text: 'content' }
      });
      expect(objResource.type).toBe('resource');

      const objText = normalizeContentItem({ text: 'text inside object' });
      expect(objText).toEqual({ type: 'text', text: 'text inside object' });

      const genericObj = normalizeContentItem({ foo: 'bar', count: 42 });
      expect(genericObj.type).toBe('text');
      expect((genericObj as any).text).toBe(JSON.stringify({ foo: 'bar', count: 42 }));
    });
  });

  describe('normalizeResourceResult', () => {
    const defaultUri = 'test://resource/1';

    it('normalizes string content', () => {
      const res = normalizeResourceResult('plain text content', defaultUri);
      expect(res.contents).toHaveLength(1);
      expect(res.contents[0]).toEqual({
        uri: defaultUri,
        mimeType: 'text/plain',
        text: 'plain text content'
      });
    });

    it('normalizes raw Buffer/Uint8Array', () => {
      const res = normalizeResourceResult(samplePngBuffer, defaultUri);
      expect(res.contents[0].mimeType).toBe('image/png');
      expect((res.contents[0] as any).blob).toBe(samplePngBuffer.toString('base64'));
    });

    it('normalizes ImageContentHelper', () => {
      const helper = image(sampleJpegBuffer);
      const res = normalizeResourceResult(helper, defaultUri);
      expect(res.contents[0].mimeType).toBe('image/jpeg');
      expect((res.contents[0] as any).blob).toBe(sampleJpegBuffer.toString('base64'));
    });

    it('normalizes existing raw contents array with and without uri', () => {
      const raw = {
        contents: [
          { text: 'without uri' },
          { uri: 'custom://explicit', text: 'with uri' }
        ]
      };
      const res = normalizeResourceResult(raw, new URL(defaultUri));
      expect(res.contents[0].uri).toBe(defaultUri);
      expect(res.contents[1].uri).toBe('custom://explicit');
    });

    it('normalizes shorthand { blob, mimeType } and { text } objects', () => {
      const blobRes = normalizeResourceResult(
        { blob: 'aGVsbG8=', mimeType: 'audio/wav' },
        defaultUri
      );
      expect(blobRes.contents[0]).toEqual({
        uri: defaultUri,
        mimeType: 'audio/wav',
        blob: 'aGVsbG8='
      });

      const textRes = normalizeResourceResult(
        { text: 'explicit text', uri: 'custom://uri' },
        defaultUri
      );
      expect(textRes.contents[0]).toEqual({
        uri: 'custom://uri',
        mimeType: 'text/plain',
        text: 'explicit text'
      });
    });

    it('normalizes shorthand { image } objects', () => {
      const imgRes = normalizeResourceResult(
        { image: samplePngBuffer },
        defaultUri
      );
      expect(imgRes.contents[0].mimeType).toBe('image/png');
      expect((imgRes.contents[0] as any).blob).toBe(samplePngBuffer.toString('base64'));
    });

    it('normalizes generic objects and primitives to JSON/string', () => {
      const objRes = normalizeResourceResult({ users: [1, 2, 3] }, defaultUri);
      expect(objRes.contents[0].mimeType).toBe('application/json');
      expect(objRes.contents[0].text).toContain('"users"');

      const primRes = normalizeResourceResult(42, defaultUri);
      expect(primRes.contents[0].text).toBe('42');

      const nullRes = normalizeResourceResult(null, defaultUri);
      expect(nullRes.contents[0].text).toBe('');
    });
  });
});
