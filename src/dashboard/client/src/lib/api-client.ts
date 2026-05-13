const BASE_URL = "/api";

/** Error thrown by apiFetch when the server returns a non-OK status. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Fetch JSON from the dashboard API, throwing ApiError on non-OK responses. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "Unknown error");
    throw new ApiError(response.status, `${response.status}: ${body}`);
  }

  return response.json() as Promise<T>;
}
