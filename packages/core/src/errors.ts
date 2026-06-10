export class MemharnessError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class NotFoundError extends MemharnessError {
  constructor(message: string) {
    super("NOT_FOUND", message);
  }
}

export class ValidationError extends MemharnessError {
  constructor(message: string) {
    super("INVALID_INPUT", message);
  }
}
