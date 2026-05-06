# mcp-lexware-office

Docker Image Build Pipeline für den [Lexware Office MCP Server](https://github.com/JannikWempe/mcp-lexware-office).

Das Image wird aus dem upstream-Repo gebaut, mit [supergateway](https://github.com/supermaven-inc/supergateway) als SSE-Wrapper, und auf Docker Hub veröffentlicht: `berzdev/mcp-lexware-office:latest`

Der upstream-Server läuft nativ als stdio-Prozess. Supergateway macht daraus einen SSE-Server auf Port 8000 – kompatibel mit dem LibreChat-MCP-SSE-Pattern.

---

## LibreChat Integration

### Voraussetzungen

- LibreChat läuft via Docker Compose
- Lexware Office API Key (aus dem Lexware Office Portal unter Einstellungen → API)

### Schritt 1: `.env` ergänzen

```bash
LEXWARE_OFFICE_API_KEY=dein-lexware-office-api-key
```

### Schritt 2: `docker-compose.yml` ergänzen

Den `lexware-office-mcp` Service vor `volumes:` einfügen:

```yaml
  lexware-office-mcp:
    image: berzdev/mcp-lexware-office:latest
    container_name: lexware-office-mcp
    restart: unless-stopped
    env_file:
      - .env
```

Kein Port-Mapping nötig – der Container kommuniziert intern im Docker-Netzwerk mit LibreChat.

### Schritt 3: `librechat.yml` ergänzen

`mcpSettings.allowedAddresses` und `mcpServers` erweitern:

```yaml
mcpSettings:
  allowedAddresses:
    - "kimai-mcp"
    - "lexware-office-mcp"

mcpServers:
  lexware:
    type: sse
    url: http://lexware-office-mcp:8000/sse
    iconURL: "https://www.lexoffice.de/favicon.ico"
    allowedUsers:
      - "a.p@berz.dev"
```

### Schritt 4: Starten

```bash
# Image pullen und Service starten
docker compose pull lexware-office-mcp
docker compose up -d lexware-office-mcp

# LibreChat neu starten damit librechat.yaml neu geladen wird
docker compose restart api
```

### Logs prüfen

```bash
docker logs lexware-office-mcp -f
```

### Debug

```bash
# API Key im Container prüfen
docker exec lexware-office-mcp sh -lc 'env | grep LEXWARE'

# SSE-Endpoint aus LibreChat-Container testen
docker exec LibreChat sh -lc 'curl -s http://lexware-office-mcp:8000/sse'
```

---

## Image aktuell halten

Nach einem neuen upstream Release den Woodpecker Build manuell triggern:

1. Woodpecker UI öffnen → Repository `pb/mcp-lexware-office`
2. **Trigger manually** klicken
3. `docker compose pull lexware-office-mcp && docker compose up -d lexware-office-mcp` auf dem Server ausführen

---

## Architektur

```
LibreChat (api container)
        │
        │  SSE über Docker-internes Netzwerk
        ▼
  lexware-office-mcp:8000/sse
  (berzdev/mcp-lexware-office Image)
        │  supergateway → stdio
        │
  node /app/build/index.js
        │
        │  HTTPS REST API
        ▼
  api.lexoffice.io (Lexware Office Cloud)
```
