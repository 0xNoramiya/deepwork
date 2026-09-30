// All state-changing calls carry x-deepwork so the server can refuse cross-site requests.
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-deepwork': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const api = {
  get: <T,>(url: string) => call<T>('GET', url),
  post: <T,>(url: string, body: unknown = {}) => call<T>('POST', url, body),
  patch: <T,>(url: string, body: unknown) => call<T>('PATCH', url, body),
  put: <T,>(url: string, body: unknown) => call<T>('PUT', url, body),
  del: <T,>(url: string) => call<T>('DELETE', url),
};
