export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, message, details);
export const forbidden = (message = 'You are not allowed to do this') => new HttpError(403, message);
export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const preconditionFailed = (message: string) => new HttpError(412, message);
export const conflict = (message: string) => new HttpError(409, message);

export const managedError = (kind: string, id: string) =>
  conflict(`${kind} "${id}" is managed by configuration (CONFIG_DIR); change it in the configuration repository`);

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
