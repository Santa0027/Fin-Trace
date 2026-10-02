const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api/v1";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function apiClient(endpoint: string, options: RequestInit = {}) {
  const url = `${API_BASE}${endpoint}`;

  const config: RequestInit = {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  };

  if (config.method && ["POST", "PUT", "PATCH", "DELETE"].includes(config.method.toUpperCase())) {
    const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
    if (csrfMatch) {
      config.headers = {
        ...config.headers,
        "X-CSRFToken": csrfMatch[1]
      };
    }
  }

  const response = await fetch(url, config);

  if (response.status === 401) {
    // Session expired or unauthenticated
    window.dispatchEvent(new CustomEvent("auth:unauthorized"));
  }

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    const message =
      errorBody?.error?.message ||
      errorBody?.message ||
      errorBody?.detail ||
      `API Error: ${response.status}`;
    throw new ApiError(response.status, message, errorBody);
  }

  if (response.status === 204) return null;
  
  return response.json();
}
