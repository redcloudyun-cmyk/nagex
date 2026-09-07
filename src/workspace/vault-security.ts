import path from 'node:path';
import { NagexError } from '../common/errors.js';
import type { CaptureType } from './workspace.types.js';

export const FILE_SIZE_LIMITS: Record<string, number> = {
  AUDIO: 50 * 1024 * 1024,      // 50 MB
  PDF: 100 * 1024 * 1024,      // 100 MB
  IMAGE: 25 * 1024 * 1024,      // 25 MB
  DOCUMENT: 10 * 1024 * 1024,   // 10 MB
  DEFAULT: 10 * 1024 * 1024,    // 10 MB
};

export interface MalwareScanResult {
  passed: boolean;
  threat?: string;
  scannedAt: string;
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename);
  const sanitized = base.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
  return sanitized || 'unnamed_file';
}

export function validateFileSize(sizeBytes: number, category: string): void {
  const limit = FILE_SIZE_LIMITS[category.toUpperCase()] ?? FILE_SIZE_LIMITS.DEFAULT;
  if (sizeBytes > limit) {
    throw new NagexError({
      code: 'MAX_SIZE_EXCEEDED',
      category: 'VALIDATION',
      message: `File size (${(sizeBytes / (1024 * 1024)).toFixed(2)} MB) exceeds allowed limit of ${(limit / (1024 * 1024)).toFixed(0)} MB for category ${category}.`,
      request_id: `req_sec_${Date.now()}`,
    });
  }
}

export function detectMimeFromMagicBytes(buffer: Buffer | Uint8Array): string | null {
  const buf = Buffer.from(buffer);
  if (buf.length < 4) return null;

  // PDF: %PDF- (0x25 0x50 0x44 0x46)
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) {
    return 'application/pdf';
  }

  // PNG: \x89PNG (0x89 0x50 0x4E 0x47)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }

  // JPEG: \xFF\xD8\xFF (0xFF 0xD8 0xFF)
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // GIF: GIF8 (0x47 0x49 0x46 0x38)
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }

  // WebM / EBML: 0x1A 0x45 0xDF 0xA3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'audio/webm';
  }

  // MP3 ID3 tag: ID3 (0x49 0x44 0x33)
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    return 'audio/mpeg';
  }

  // OGG: OggS (0x4F 0x67 0x67 0x53)
  if (buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
    return 'audio/ogg';
  }

  // RIFF (WAV or WEBP)
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    if (buf.length >= 12) {
      const type = buf.toString('ascii', 8, 12);
      if (type === 'WAVE') return 'audio/wav';
      if (type === 'WEBP') return 'image/webp';
    }
  }

  return null;
}

export function validateMimeAndExtension(filename: string, declaredMime: string, buffer?: Buffer | Uint8Array): void {
  const ext = path.extname(filename).toLowerCase();

  if (buffer && buffer.length >= 4) {
    const magicMime = detectMimeFromMagicBytes(buffer);
    if (magicMime) {
      if (ext === '.pdf' && magicMime.startsWith('image/')) {
        throw new NagexError({
          code: 'SECURITY_MIME_MISMATCH',
          category: 'VALIDATION',
          message: `Extension mismatch: file claims to be .pdf but binary content is ${magicMime}.`,
          request_id: `req_sec_${Date.now()}`,
        });
      }
      if ((ext === '.png' || ext === '.jpg' || ext === '.jpeg') && magicMime === 'application/pdf') {
        throw new NagexError({
          code: 'SECURITY_MIME_MISMATCH',
          category: 'VALIDATION',
          message: `Extension mismatch: file claims to be image but binary content is PDF.`,
          request_id: `req_sec_${Date.now()}`,
        });
      }
    }
  }
}


export function scanObjectForMalware(buffer: Buffer | Uint8Array): MalwareScanResult {
  // Production malware scanning integration point (e.g. ClamAV / VirusTotal)
  return {
    passed: true,
    scannedAt: new Date().toISOString(),
  };
}

export function generateCanonicalObjectKey(params: {
  tenantId: string;
  principalId: string;
  captureId: string;
  objectId: string;
}): string {
  const safeTenant = params.tenantId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const safePrincipal = params.principalId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const safeCapture = params.captureId.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const safeObject = sanitizeFilename(params.objectId);

  return `tenant/${safeTenant}/principal/${safePrincipal}/captures/${safeCapture}/${safeObject}`;
}
