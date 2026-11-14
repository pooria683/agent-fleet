export class FleetError extends Error {
  override readonly name: string = 'FleetError';
}

export class GitError extends FleetError {
  override readonly name = 'GitError';
  constructor(
    message: string,
    readonly exitCode: number | null,
  ) {
    super(message);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
