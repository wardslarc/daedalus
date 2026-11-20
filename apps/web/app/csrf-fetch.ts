/** POST from the browser with the double-submit CSRF header the server requires. */
export function csrfToken(): string {
  const m = /(?:^|;\s*)dae_csrf=([0-9a-f]{64})/.exec(document.cookie);
  return m?.[1] ?? "";
}

export function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrfToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
}
