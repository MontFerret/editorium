/** Incrementally decodes DAP's Content-Length framed UTF-8 JSON objects. */
export class DapFrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private length?: number;

  public push(chunk: Buffer, receive: (message: object) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      if (this.length === undefined) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = this.buffer.toString('ascii', 0, end).split('\r\n');
        const sizes = headers.filter(line => /^content-length:/i.test(line));
        const match = sizes.length === 1 && /^content-length:\s*(\d+)\s*$/i.exec(sizes[0]!);
        const size = match ? Number(match[1]) : NaN;
        if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid Ferret DAP Content-Length.');
        this.length = size;
        this.buffer = this.buffer.subarray(end + 4);
      }
      if (this.buffer.length < this.length) return;
      const message: unknown = JSON.parse(this.buffer.toString('utf8', 0, this.length));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid Ferret DAP message.');
      this.buffer = this.buffer.subarray(this.length);
      this.length = undefined;
      receive(message);
    }
  }
}
