/** Error with an HTTP status and a stable machine code. Messages are generic; codes are what the browser maps to text. */
export class CloudOperationError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
