const access = new WeakMap<Request, number>();

// Only the gateway binds this after authentication. Client headers cannot
// create a WeakMap entry, and a direct/local handler read defaults to free.
export function bindCountryHistoryAccess(request: Request, days: number): void {
  access.set(request, days);
}

export function getCountryHistoryAccess(request: Request): number {
  return access.get(request) ?? 7;
}
