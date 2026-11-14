import { open } from 'node:fs/promises';

export interface DocumentPage {
  text: string;
  totalBytes: number;
  truncated: boolean;
}

/** The TUI bounds memory use; the logs/diff CLI commands always stream the complete file. */
export async function readDocument(path: string, limit = 512 * 1024): Promise<DocumentPage> {
  const file = await open(path, 'r');
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - limit);
    const buffer = Buffer.alloc(Math.min(size, limit));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return { text, totalBytes: size, truncated: start > 0 };
  } finally {
    await file.close();
  }
}
