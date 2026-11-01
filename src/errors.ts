export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function required<T>(value: T | undefined, message = 'Resource not found'): T {
  if (value === undefined) throw new AppError(404, 'NOT_FOUND', message);
  return value;
}
