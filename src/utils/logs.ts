import { createWriteStream, type WriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { errorMessage } from '../core/errors.js';

/** Raw subprocess output is streamed to disk, not buffered in the dashboard. */
export class LogWriter {
  private readonly stream: WriteStream;
  private error: string | null = null;
  constructor(path: string) {
    this.stream = createWriteStream(path, { flags: 'wx', mode: 0o600 });
    this.stream.on('error', (error: Error) => {
      this.error ??= errorMessage(error);
    });
  }
  write(chunk: Buffer | string): void {
    this.stream.write(chunk);
  }
  async close(): Promise<string | null> {
    this.stream.end();
    try {
      await finished(this.stream);
    } catch (error) {
      this.error ??= errorMessage(error);
    }
    return this.error;
  }
}
