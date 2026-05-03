import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
const JELLYSEERR_URL = process.env.JELLYSEERR_URL?.replace(/\/$/, "");
const JELLYSEERR_API_KEY = process.env.JELLYSEERR_API_KEY;
if (!JELLYSEERR_URL || !JELLYSEERR_API_KEY) {
    console.error("Missing required env vars: JELLYSEERR_URL, JELLYSEERR_API_KEY");
    process.exit(1);
}
async function jellyseerrFetch(path, options = {}) {
    const url = `${JELLYSEERR_URL}/api/v1${path}`;
    const res = await fetch(url, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "X-Api-Key": JELLYSEERR_API_KEY,
            ...options.headers,
        },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`Jellyseerr API error ${res.status}: ${text}`);
    }
    if (res.status === 204)
        return null;
    return res.json();
}
const server = new Server({ name: "jellyseerr-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "search_media",
            description: "Sucht nach Filmen oder Serien in Jellyseerr, um die Media-ID für eine Anfrage zu ermitteln.",
            inputSchema: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Suchtitel (Film- oder Serienname)",
                    },
                    type: {
                        type: "string",
                        enum: ["movie", "tv"],
                        description: "Medientyp: 'movie' oder 'tv'",
                    },
                },
                required: ["query"],
            },
        },
        {
            name: "create_request",
            description: "Sendet eine neue Anfrage für einen Film oder eine Serie.",
            inputSchema: {
                type: "object",
                properties: {
                    mediaType: {
                        type: "string",
                        enum: ["movie", "tv"],
                        description: "Medientyp: 'movie' oder 'tv'",
                    },
                    mediaId: {
                        type: "number",
                        description: "TMDB-ID des Films oder der Serie (aus search_media ermitteln)",
                    },
                    seasons: {
                        type: "array",
                        items: { type: "number" },
                        description: "Nur für Serien: Liste der Staffelnummern (leer = alle verfügbaren Staffeln)",
                    },
                },
                required: ["mediaType", "mediaId"],
            },
        },
        {
            name: "list_requests",
            description: "Listet die letzten Anfragen auf (eigene oder alle, je nach Berechtigung).",
            inputSchema: {
                type: "object",
                properties: {
                    filter: {
                        type: "string",
                        enum: ["all", "approved", "pending", "processing", "available", "unavailable", "failed"],
                        description: "Statusfilter (Standard: all)",
                    },
                    take: {
                        type: "number",
                        description: "Anzahl der Ergebnisse (Standard: 10, max 20)",
                    },
                },
            },
        },
        {
            name: "cancel_request",
            description: "Bricht eine bestehende Anfrage ab und löscht sie.",
            inputSchema: {
                type: "object",
                properties: {
                    requestId: {
                        type: "number",
                        description: "ID der Anfrage (aus list_requests ermitteln)",
                    },
                },
                required: ["requestId"],
            },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
        switch (name) {
            case "search_media": {
                const { query, type } = args;
                const params = new URLSearchParams({ query });
                const data = await jellyseerrFetch(`/search?${params}`);
                const results = (data.results ?? []).filter((r) => type ? r.mediaType === type : true);
                if (results.length === 0) {
                    return { content: [{ type: "text", text: "Keine Ergebnisse gefunden." }] };
                }
                const formatted = results.slice(0, 5).map((r) => {
                    const title = r.title ?? r.name ?? "Unbekannt";
                    const year = r.releaseDate?.slice(0, 4) ?? r.firstAirDate?.slice(0, 4) ?? "?";
                    const status = r.mediaInfo?.status
                        ? ` [Status: ${mapStatus(r.mediaInfo.status)}]`
                        : "";
                    return `- ${title} (${year}) | Typ: ${r.mediaType} | TMDB-ID: ${r.id}${status}`;
                });
                return {
                    content: [{ type: "text", text: `Suchergebnisse:\n${formatted.join("\n")}` }],
                };
            }
            case "create_request": {
                const { mediaType, mediaId, seasons } = args;
                let body = { mediaType, mediaId };
                if (mediaType === "tv") {
                    if (seasons && seasons.length > 0) {
                        body.seasons = seasons;
                    }
                    else {
                        // Alle verfügbaren Staffeln anfragen
                        const info = await jellyseerrFetch(`/tv/${mediaId}`);
                        const allSeasons = (info.seasons ?? [])
                            .filter((s) => s.seasonNumber > 0)
                            .map((s) => s.seasonNumber);
                        body.seasons = allSeasons;
                    }
                }
                const result = await jellyseerrFetch("/request", {
                    method: "POST",
                    body: JSON.stringify(body),
                });
                const title = result.media?.title ?? result.media?.name ?? `ID ${mediaId}`;
                return {
                    content: [
                        {
                            type: "text",
                            text: `Anfrage erfolgreich erstellt!\n- Titel: ${title}\n- Anfrage-ID: ${result.id}\n- Status: ${mapStatus(result.status)}`,
                        },
                    ],
                };
            }
            case "list_requests": {
                const { filter = "all", take = 10 } = args;
                const limit = Math.min(take, 20);
                const params = new URLSearchParams({
                    filter,
                    take: String(limit),
                    skip: "0",
                    sort: "added",
                });
                const data = await jellyseerrFetch(`/request?${params}`);
                const requests = data.results ?? [];
                if (requests.length === 0) {
                    return { content: [{ type: "text", text: "Keine Anfragen gefunden." }] };
                }
                const formatted = requests.map((r) => {
                    const title = r.media?.title ?? r.media?.name ?? "Unbekannt";
                    const year = r.media?.releaseDate?.slice(0, 4) ??
                        r.media?.firstAirDate?.slice(0, 4) ??
                        "?";
                    const type = r.type === "movie" ? "Film" : "Serie";
                    const date = r.createdAt ? new Date(r.createdAt).toLocaleDateString("de-DE") : "?";
                    const seasons = r.seasons?.length > 0
                        ? ` | Staffeln: ${r.seasons.map((s) => s.seasonNumber).join(", ")}`
                        : "";
                    return `- [ID: ${r.id}] ${title} (${year}) | ${type} | Status: ${mapStatus(r.status)} | Erstellt: ${date}${seasons}`;
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: `${requests.length} Anfrage(n) (Filter: ${filter}):\n${formatted.join("\n")}`,
                        },
                    ],
                };
            }
            case "cancel_request": {
                const { requestId } = args;
                await jellyseerrFetch(`/request/${requestId}`, { method: "DELETE" });
                return {
                    content: [{ type: "text", text: `Anfrage ${requestId} wurde erfolgreich abgebrochen und gelöscht.` }],
                };
            }
            default:
                throw new Error(`Unbekanntes Tool: ${name}`);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `Fehler: ${message}` }],
            isError: true,
        };
    }
});
function mapStatus(status) {
    const map = {
        1: "Unbekannt",
        2: "Ausstehend",
        3: "Verarbeitung",
        4: "Teilweise verfügbar",
        5: "Verfügbar",
    };
    return map[status] ?? `Status ${status}`;
}
const transport = new StdioServerTransport();
await server.connect(transport);
