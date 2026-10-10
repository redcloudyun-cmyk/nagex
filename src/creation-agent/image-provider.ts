import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { crc32 } from './simple-zip.js';
import type { ArtifactOutputPurpose, ArtifactVisualTheme } from './creation-agent.types.js';

export interface ImageProviderRequest {
  readonly prompt: string;
  readonly negativeConstraints?: readonly string[];
  readonly referenceImage?: string;
  readonly brandStyleId?: string;
  readonly aspectRatio: '16:9' | '4:3' | '1:1';
  readonly usageContext: string;
  readonly parentGoalId: string;
  readonly parentArtifactId?: string;
  readonly outputPurpose: ArtifactOutputPurpose;
  readonly outputPath: string;
  readonly theme: ArtifactVisualTheme;
}

export interface ImageProviderResult {
  readonly providerId: string;
  readonly file: string;
  readonly format: 'PNG';
  readonly width: number;
  readonly height: number;
  readonly generationMetadata: Record<string, string | number | boolean>;
}

export interface ImageProviderAdapter {
  readonly providerId: string;
  create(request: ImageProviderRequest): ImageProviderResult;
  edit(request: ImageProviderRequest & { readonly sourceImage: string; readonly revisionInstruction: string }): ImageProviderResult;
  variation(request: ImageProviderRequest & { readonly sourceImage: string }): ImageProviderResult;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  name.copy(header, 4);
  const footer = Buffer.alloc(4);
  footer.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([header, data, footer]);
}

function encodePng(width: number, height: number, palette: readonly string[], accentShift: number): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const colors = palette.map((hex) => {
    const clean = hex.replace('#', '').padEnd(6, '0').slice(0, 6);
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)] as const;
  });
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 4;
      const band = Math.floor((x / width) * colors.length + (accentShift % colors.length)) % colors.length;
      const [r, g, b] = colors[band];
      const center = Math.abs(x - width * 0.58) < width * 0.16 && Math.abs(y - height * 0.46) < height * 0.2;
      raw[i] = center ? Math.min(255, r + 40) : Math.max(0, r - Math.floor(y / height * 26));
      raw[i + 1] = center ? Math.min(255, g + 40) : Math.max(0, g - Math.floor(y / height * 18));
      raw[i + 2] = center ? Math.min(255, b + 40) : Math.max(0, b - Math.floor(y / height * 12));
      raw[i + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export class LocalRasterImageProvider implements ImageProviderAdapter {
  readonly providerId = 'local-raster-image-provider';

  create(request: ImageProviderRequest): ImageProviderResult {
    return this.write(request, 0, 'create');
  }

  edit(request: ImageProviderRequest & { readonly sourceImage: string; readonly revisionInstruction: string }): ImageProviderResult {
    return this.write(request, 1, 'edit');
  }

  variation(request: ImageProviderRequest & { readonly sourceImage: string }): ImageProviderResult {
    return this.write(request, 2, 'variation');
  }

  private write(request: ImageProviderRequest, shift: number, mode: string): ImageProviderResult {
    const [width, height] = request.aspectRatio === '1:1' ? [1024, 1024] : request.aspectRatio === '4:3' ? [1200, 900] : [1280, 720];
    fs.mkdirSync(path.dirname(request.outputPath), { recursive: true });
    fs.writeFileSync(request.outputPath, encodePng(width, height, request.theme.colorTokens, shift));
    return {
      providerId: this.providerId,
      file: request.outputPath,
      format: 'PNG',
      width,
      height,
      generationMetadata: {
        mode,
        promptHash: crc32(Buffer.from(request.prompt, 'utf8')),
        parentGoalId: request.parentGoalId,
        outputPurpose: request.outputPurpose,
        brandStyleId: request.brandStyleId ?? request.theme.brandStyleId,
      },
    };
  }
}
