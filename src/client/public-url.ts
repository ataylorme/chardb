/** Normalize the one public origin shared by auth, WebSockets, and file routes. */
export function normalizePublicWorkerUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new TypeError("CharDB public Worker URL must be an absolute URL");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("CharDB public Worker URL must use http or https");
    }
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new TypeError("CharDB public Worker URL must contain only an origin");
    }
    return url.origin;
}

export function publicWorkerWebSocketUrl(publicUrl: string): string {
    const endpoint = new URL("/ws", normalizePublicWorkerUrl(publicUrl));
    endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
    return endpoint.toString();
}
