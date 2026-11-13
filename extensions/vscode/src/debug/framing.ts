const headerEnd = Buffer.from('\r\n\r\n');

/** Incrementally decodes DAP's Content-Length framed UTF-8 JSON objects. */
export class DapFrameReader {
  private parts: Buffer[] = [];
  private delimiterBytes = 0;
  private remaining?: number;

  public push(chunk: Buffer, receive: (message: object) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === undefined) {
        const start = offset;
        while (offset < chunk.length && this.delimiterBytes < headerEnd.length) {
          const byte = chunk[offset++];
          if (byte === headerEnd[this.delimiterBytes]) this.delimiterBytes++;
          else this.delimiterBytes = byte === headerEnd[0] ? 1 : 0;
        }
        this.parts.push(chunk.subarray(start, offset));
        if (this.delimiterBytes < headerEnd.length) return;
        this.delimiterBytes = 0;
        const headers = this.takeBytes().toString('ascii').split('\r\n');
        const sizes = headers.filter(line => /^content-length:/i.test(line));
        const match = sizes.length === 1 && /^content-length:\s*(\d+)\s*$/i.exec(sizes[0]!);
        const size = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid Ferret DAP Content-Length.');
        this.remaining = size;
      } else {
        const count = Math.min(this.remaining, chunk.length - offset);
        this.parts.push(chunk.subarray(offset, offset + count));
        offset += count;
        this.remaining -= count;
        if (this.remaining > 0) return;
        this.remaining = undefined;
        const message: unknown = JSON.parse(this.takeBytes().toString('utf8'));
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid Ferret DAP message.');
        receive(message);
      }
    }
  }

  private takeBytes(): Buffer {
    const bytes = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
    this.parts = [];
    return bytes;
  }
}
