import fs from 'fs';
import path from 'path';
import type { WAMessage } from '@whiskeysockets/baileys';

import { logger } from './logger.js';

const MAX_DIMENSION = 1024;
const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;

// Lazy-load sharp — it has no prebuilt binary for android-arm64 (Termux)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpFn: any;
let sharpLoaded = false;

async function getSharp(): Promise<((input: Buffer) => any) | null> {
  if (sharpLoaded) return sharpFn ?? null;
  sharpLoaded = true;
  try {
    const mod = await import('sharp');
    sharpFn = mod.default;
    return sharpFn;
  } catch {
    logger.warn('sharp not available — images will not be resized');
    sharpFn = null;
    return null;
  }
}

export interface ProcessedImage {
  content: string;
  relativePath: string;
}

export interface ImageAttachment {
  relativePath: string;
  mediaType: string;
}

export function isImageMessage(msg: WAMessage): boolean {
  return !!msg.message?.imageMessage;
}

export async function processImage(
  buffer: Buffer,
  groupDir: string,
  caption: string,
): Promise<ProcessedImage | null> {
  if (!buffer || buffer.length === 0) return null;

  const sharp = await getSharp();
  let output: Buffer;
  if (sharp) {
    output = await sharp(buffer)
      .resize(MAX_DIMENSION, MAX_DIMENSION, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 85 })
      .toBuffer();
  } else {
    output = buffer;
  }

  const attachDir = path.join(groupDir, 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });

  const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
  const filePath = path.join(attachDir, filename);
  fs.writeFileSync(filePath, output);

  const relativePath = `attachments/${filename}`;
  const content = caption
    ? `[Image: ${relativePath}] ${caption}`
    : `[Image: ${relativePath}]`;

  return { content, relativePath };
}

export function parseImageReferences(
  messages: Array<{ content: string }>,
): ImageAttachment[] {
  const refs: ImageAttachment[] = [];
  for (const msg of messages) {
    let match: RegExpExecArray | null;
    IMAGE_REF_PATTERN.lastIndex = 0;
    while ((match = IMAGE_REF_PATTERN.exec(msg.content)) !== null) {
      // Always JPEG — processImage() normalizes all images to .jpg
      refs.push({ relativePath: match[1], mediaType: 'image/jpeg' });
    }
  }
  return refs;
}
