export interface DiagnosticError {
  at: string;
  context: string;
  name: string;
  message: string;
}

const MAX_ERRORS = 20;
const recentErrors: DiagnosticError[] = [];

export function recordDiagnosticError(
  error: unknown,
  context = "application",
): void {
  const value = error instanceof Error ? error : new Error(String(error));
  recentErrors.unshift({
    at: new Date().toISOString(),
    context: context.slice(0, 80),
    name: value.name.slice(0, 80),
    message: value.message.slice(0, 500),
  });
  recentErrors.splice(MAX_ERRORS);
}

export function getDiagnosticErrors(): readonly DiagnosticError[] {
  return recentErrors.map((error) => ({ ...error }));
}

export function resetDiagnosticErrorsForTesting(): void {
  recentErrors.length = 0;
}
