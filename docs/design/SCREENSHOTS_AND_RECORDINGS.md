# Design: Screenshots & Media Upload

## Status

**Draft** | 2026-04-10

**Supersedes**: `docs/agent-browser-media-capture-design.md` (earlier draft with different video and
retention decisions). This document is the canonical design for media capture and upload.

## Problem

Open-Inspect sessions working on frontend features have no way to visually verify their work. The
agent can modify UI code but cannot prove the result looks correct. Users must manually open a
preview or clone the branch to check visual output.

Ramp's Inspect highlights this as a core differentiator: agents take before-and-after screenshots,
append them to PR descriptions, and let users see a streamed desktop view. We have the primitives
(`agent-browser` is already installed in every sandbox, and the `"screenshot"` artifact type is
declared in the schema) but no end-to-end pipeline to capture, store, and surface visual media.

## Goals

1. **Screenshots**: The agent can capture screenshots during execution and surface them to users in
   real time (web UI, Slack, GitHub PRs).
2. **Media upload pipeline**: Binary media (screenshots now, video later) can be uploaded from the
   sandbox, stored in R2, and served to clients via presigned URLs.
3. **Storage**: All media is stored in Cloudflare R2 with scoped access.
4. **agent-browser integration**: Leverage the `agent-browser` CLI already in the sandbox image,
   rather than building custom capture tooling.

### Deferred to Future Phase

- **Video recordings**: `agent-browser` v0.21.2 (our pinned version) does not expose a first-class
  `record` command — the upstream CLI documents `screenshot`, `diff`, `trace`, and `get cdp-url`,
  but not video recording. The sibling design doc (`agent-browser-media-capture-design.md`) proposes
  a CDP-attached recorder as a workaround. Video support will be added in a separate phase once the
  recording approach is validated against the pinned binary. The upload pipeline designed here is
  format-agnostic and will support video when ready.

## Non-Goals

- Live-streamed desktop/VNC view (Xvfb + x11vnc + websockify stack) -- separate initiative.
- Computer-use tool (agent autonomously clicking through the UI) -- orthogonal to capture.
- Chrome extension visual selection -- separate client.

---

## Current State

### What exists

| Component                    | State                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ArtifactType`               | `"screenshot"` is declared but unused (`shared/src/types/index.ts:28`)                                                                                                         |
| `artifacts` table            | Schema supports `type = 'screenshot'` (`session/schema.ts:84`)                                                                                                                 |
| `ArtifactEvent` (Python)     | Sandbox bridge can emit `{ type: "artifact", artifact_type, url, metadata }` (`sandbox_runtime/types.py:93`)                                                                   |
| `artifact_created` broadcast | DO broadcasts to all WS clients when artifacts are created (`durable-object.ts:459`)                                                                                           |
| `agent-browser`              | v0.21.2 installed globally in sandbox image with Chromium + all system deps (`images/base.py`)                                                                                 |
| Event processor              | `"artifact"` events from sandbox fall through to generic handler -- persisted in `events` table, broadcast, but **not** written to `artifacts` table (`sandbox-events.ts:179`) |

### What's missing

| Component                     | Gap                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------- |
| **R2 bucket**                 | No application R2 bucket exists. Only Terraform state backend uses R2.        |
| **R2 worker binding**         | `Env` interface has no `R2Bucket`. Terraform worker module has no R2 support. |
| **Upload route**              | No API endpoint accepts binary uploads or returns presigned URLs.             |
| **Download route**            | No API endpoint serves media from R2.                                         |
| **Sandbox upload path**       | Sandbox has no mechanism to push binary files to the control plane or R2.     |
| **Artifact event processing** | Artifact sandbox events are not routed to `repository.createArtifact()`.      |
| **Web UI rendering**          | Screenshot artifacts not rendered. `SafeMarkdown` strips `<img>`.             |
| **Slack image upload**        | Bot only sends text links, no file uploads via Slack `files.upload`.          |
| **GitHub PR images**          | Bot does not embed images in PR descriptions.                                 |
| **Presigned URL infra**       | No R2 S3 API access keys or bucket CORS for presigned download URLs.          |

---

## Architecture

```
Sandbox                     Control Plane                    R2                 Clients
  |                              |                           |                     |
  |  1. agent-browser screenshot |                           |                     |
  |  2. POST /sessions/:id/media |                           |                     |
  |  ---- multipart/form-data -->|                           |                     |
  |                              | 3. PUT /:key ----------->|                     |
  |                              | 4. createArtifact (SQLite)|                     |
  |                              | 5. broadcast -------------------------------------->|
  |                              |                           |                     |
  |                              | GET /media/:key           |                     |
  |                              |<--- serve or redirect ----|                     |
```

### Design decisions

**Upload via control plane, not direct R2.** The sandbox authenticates to the control plane with its
`SANDBOX_AUTH_TOKEN`. Direct R2 uploads would require distributing R2 credentials or generating
presigned URLs. Routing through the control plane keeps auth in one place and lets us enforce size
limits, content validation, and rate limiting at the edge. The tradeoff is bandwidth through the
Worker, but screenshots (typically <1 MB) are well within Workers limits (100 MB request body on
paid plans).

**R2 with public bucket disabled.** The R2 bucket itself is not publicly accessible. Media is served
via **presigned R2 URLs** generated by the control plane. This requires R2 S3 API access keys
(separate from the Worker R2 binding) and bucket CORS configuration to allow browser fetches from
the web app's origin. The web app requests presigned URLs through its existing server-side API proxy
(HMAC-authenticated), never directly from the browser to the control plane.

**Scoped R2 keys.** Objects are keyed as `sessions/{sessionId}/media/{artifactId}.{ext}` to enable
per-session lifecycle management and easy bulk deletion on session cleanup.

**Extend `ArtifactType`, don't create a new table.** Screenshots are artifacts like PRs and
previews. They use the same `artifacts` table and the same `artifact_created` broadcast path. The
`url` field stores the R2 object key (not a full URL) so we can generate fresh presigned URLs on
read.

**CLI + Skill, not custom OpenCode tools.** `agent-browser` (Vercel Labs) is a full-featured Rust
CLI with screenshot, visual diff, accessibility snapshot, batch execution, and more. Wrapping a
subset of its flags in custom OpenCode tools would lock the agent to a fraction of agent-browser's
capabilities while adding ~300 lines of tool code to maintain. Both Vercel and Microsoft
(Playwright) have converged on a **CLI + Skill** pattern for coding agents: a markdown instruction
file teaches the agent to invoke CLI commands via bash, and the tool schemas stay out of the model
context until needed. OpenCode discovers Skill files at `.opencode/skills/<name>/SKILL.md`
(confirmed — see [OpenCode Skills docs](https://opencode.ai/docs/skills/)). We follow this pattern
with a single Skill file and a thin `upload-media.js` helper for the only operation agent-browser
can't do natively (uploading to our control plane).

---

## Detailed Design

### 1. Storage Layer (R2)

#### 1.1 Terraform: R2 Bucket

New resource in `terraform/environments/production/`:

```hcl
# r2.tf
resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-media-${local.name_suffix}"
  location   = "ENAM"  # or match your region
}
```

#### 1.2 Terraform: Worker Module R2 Support

Add R2 binding support to `terraform/modules/cloudflare-worker/`:

```hcl
# variables.tf -- add:
variable "r2_buckets" {
  description = "List of R2 bucket bindings"
  type = list(object({
    binding_name = string
    bucket_name  = string
  }))
  default = []
}
```

```hcl
# main.tf -- add to local.bindings:
[for r2 in var.r2_buckets : {
  type        = "r2_bucket"
  name        = r2.binding_name
  bucket_name = r2.bucket_name
}],
```

#### 1.3 Terraform: Control Plane Worker Binding

```hcl
# workers-control-plane.tf -- add:
module "control_plane_worker" {
  # ... existing config ...

  r2_buckets = [
    {
      binding_name = "MEDIA_BUCKET"
      bucket_name  = cloudflare_r2_bucket.media.name
    }
  ]
}
```

#### 1.4 TypeScript: Env Binding

```typescript
// control-plane/src/types.ts
export interface Env {
  // ... existing bindings ...
  MEDIA_BUCKET: R2Bucket;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  R2_ACCOUNT_ID: string;
}
```

The Worker R2 binding (`MEDIA_BUCKET`) is used for uploads (`PUT`). Presigned download URLs require
S3-compatible credentials (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`), generated via the Cloudflare
dashboard or API and stored as Worker secrets.

#### 1.5 R2 Bucket CORS

The R2 bucket needs CORS rules so browsers can fetch presigned URLs from a different origin than the
R2 endpoint. Configure via Wrangler or the S3 API:

```json
[
  {
    "AllowedOrigins": ["https://your-app.vercel.app", "https://your-app.your-domain.com"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

#### 1.6 R2 Object Key Format

```
sessions/{sessionId}/media/{artifactId}.{ext}
```

Examples:

- `sessions/abc123/media/art_456.png`
- `sessions/abc123/media/art_789.webm`

This scoping enables:

- Per-session `list()` + `delete()` for cleanup
- Simple authorization: validate session access, then allow all media under that prefix

#### 1.7 Lifecycle Policy

**Deferred.** No retention policy in v1. Sessions themselves have no retention policy today (records
accumulate indefinitely), so expiring only the media would create stale artifact metadata and broken
session history. Media will be retained indefinitely until a session-level retention policy is
built, at which point R2
[object lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) can align
media retention with session retention (no custom code — R2 handles expiration natively via
`Expiration.Days` rules, configurable via Wrangler CLI or S3 API).

---

### 2. Shared Types

#### 2.1 `ArtifactType`

No change needed for v1. `"screenshot"` is already declared in the `ArtifactType` union. When video
support is added in a future phase, `"video"` will need to be added here **and** in the hard-coded
discriminators at `shared/src/completion/extractor.ts:toArtifactType()` and
`web/src/types/session.ts:Artifact`.

#### 2.2 Screenshot Artifact Metadata

```typescript
// shared/src/types/index.ts

/** Metadata stored on screenshot artifacts. */
export interface ScreenshotArtifactMetadata {
  /** R2 object key */
  objectKey: string;
  /** MIME type: image/png, image/jpeg, image/webp */
  mimeType: string;
  /** File size in bytes */
  sizeBytes: number;
  /** Viewport dimensions at capture time */
  viewport?: { width: number; height: number };
  /** URL that was screenshotted */
  sourceUrl?: string;
  /** Whether this is a full-page screenshot */
  fullPage?: boolean;
  /** Whether element annotations are overlaid */
  annotated?: boolean;
  /** Caption or description provided by the agent */
  caption?: string;
}
```

---

### 3. Control Plane API

#### 3.1 Upload Endpoint

```
POST /sessions/:id/media
Authorization: Bearer <sandbox_auth_token>
Content-Type: multipart/form-data

Fields:
  file: binary (required)
  artifactType: "screenshot" (required; "video" added in future phase)
  caption: string (optional)
  sourceUrl: string (optional)
  fullPage: "true" | "false" (optional)
  annotated: "true" | "false" (optional)
  viewport: JSON string (optional)
```

Response:

```json
{
  "artifactId": "art_abc123",
  "objectKey": "sessions/sess_xyz/media/art_abc123.png"
}
```

**Auth**: Sandbox auth (same as `/sessions/:id/pr` and `/sessions/:id/children`).

**Validation**:

- Max file size: 10 MB for screenshots
- Allowed MIME types: `image/png`, `image/jpeg`, `image/webp`
- Magic byte verification (don't trust the declared MIME type alone)
- Rate limit: 100 uploads per session (enforced by counting existing artifacts in the DO)

**Flow**:

1. Authenticate sandbox via `SessionDO.verifySandboxToken()`
2. Parse multipart form data
3. Validate file size and MIME type
4. Generate artifact ID
5. `PUT` to R2 with key `sessions/{sessionId}/media/{artifactId}.{ext}`
6. Forward to SessionDO to create artifact record and broadcast

#### 3.2 Media Retrieval (Presigned URLs)

Media is served via **presigned R2 URLs**, not through the control plane Worker. This offloads
bandwidth to R2 and avoids inventing a new browser-facing auth model.

**How it works**: The web app's existing server-side API proxy (HMAC-authenticated) calls the
control plane, which generates a presigned R2 URL using S3 API credentials and returns it. The
browser then fetches the image directly from R2.

```
Browser → Next.js /api/sessions/:id/media/:artifactId  (session cookie auth)
       → Control Plane GET /sessions/:id/media/:artifactId  (HMAC auth)
       ← { url: "https://<account>.r2.cloudflarestorage.com/...", expiresAt: ... }
Browser → R2 presigned URL  (no auth needed, CORS allows origin)
       ← image bytes
```

```
GET /sessions/:id/media/:artifactId
Authorization: HMAC (internal, same as all non-public routes)
```

Response:

```json
{
  "url": "https://<account>.r2.cloudflarestorage.com/sessions/.../art_123.png?X-Amz-...",
  "expiresAt": 1712345678
}
```

The presigned URL has a 15-minute TTL. The web client requests a fresh URL on each render (not
cached in the subscription payload), avoiding the problem of expired URLs in long-lived sessions.

**For external embedding** (Slack, GitHub), see Sections 7 and 8 for platform-specific strategies.

#### 3.3 Route Registration

```typescript
// router.ts -- add:
{ method: "POST", path: "/sessions/:id/media", handler: handleMediaUpload }   // sandbox auth
{ method: "GET",  path: "/sessions/:id/media/:artifactId", handler: handleMediaGet }  // HMAC auth
```

The POST route must be added to `SANDBOX_AUTH_ROUTES` in the router. The GET route uses standard
HMAC auth (same as all other non-public routes), called from the web app's server-side API proxy.

---

### 4. Session Durable Object Changes

#### 4.1 Fix Artifact Event Processing

The sandbox event processor currently falls through to the generic handler for `"artifact"` events,
persisting them only in the `events` table. It must also create an `artifacts` table record and
broadcast `artifact_created`.

```typescript
// sandbox-events.ts -- add before the generic fallthrough:

if (event.type === "artifact" && "artifactType" in event) {
  const artifactId = generateId();
  const artifactEvent = event as Extract<SandboxEvent, { type: "artifact" }>;

  this.deps.repository.createArtifact({
    id: artifactId,
    type: artifactEvent.artifactType as ArtifactType,
    url: artifactEvent.url,
    metadata: JSON.stringify(artifactEvent.metadata ?? {}),
    createdAt: now,
  });

  this.deps.broadcast({
    type: "artifact_created",
    artifact: {
      id: artifactId,
      type: artifactEvent.artifactType as ArtifactType,
      url: artifactEvent.url,
      metadata: artifactEvent.metadata ?? null,
      createdAt: now,
    },
  });

  // Also persist in events table for timeline replay
  this.deps.repository.createEvent({
    id: generateId(),
    type: event.type,
    data: JSON.stringify(event),
    messageId,
    createdAt: now,
  });

  return;
}
```

**Note**: This fixes a pre-existing bug where artifact events are never written to the `artifacts`
table. The fix benefits all artifact types, not just screenshots.

#### 4.2 Internal Media Upload Handler

**This is the canonical path for media artifacts.** The sandbox event fix in 4.1 handles non-media
artifact types (PRs, branches) that arrive as sandbox WebSocket events. Media artifacts use a
separate path because they carry binary payloads that must be uploaded to R2 at the Worker level
(the DO does not have an R2 binding).

The media upload POST arrives at the Worker router, which needs to:

1. Authenticate the sandbox token against the SessionDO
2. Upload bytes to R2 (at the Worker level, since R2 binding is on Env, not the DO)
3. Call the SessionDO to create the artifact record **and** an event record

New internal route on the SessionDO:

```typescript
// POST /internal/create-media-artifact
// Body: { artifactId, type, objectKey, metadata }
```

The DO handler must create **both** an artifact record (for the artifacts list) **and** an event
record (for the session timeline). This is necessary because `artifact_created` WebSocket messages
update the client's artifacts list (`setArtifacts`), but timeline rendering reads from the events
list. Without an event record, screenshots would appear in the sidebar gallery but not inline in the
session timeline.

The Worker-level handler orchestrates:

```
1. Verify sandbox token (call DO /internal/verify-sandbox-token)
2. Parse multipart, validate
3. R2 PUT (Worker has env.MEDIA_BUCKET)
4. Call DO /internal/create-media-artifact (creates artifact + event, broadcasts both)
5. Return { artifactId, objectKey }
```

**Orphan cleanup**: If the R2 PUT succeeds but the DO write fails, an orphaned R2 object is left
behind. This is acceptable for v1 — orphaned objects are inert and will be cleaned up when a
lifecycle policy is added. The reverse (DO write succeeds, R2 PUT fails) cannot happen since R2 PUT
runs first.

---

### 5. Sandbox: Agent-Browser Skill + Upload Helper

#### 5.1 Design Decision: Skill over Custom Tools

`agent-browser` (Vercel Labs, `vercel-labs/agent-browser`) is a Rust-based browser automation CLI
installed globally in every sandbox image. It provides a rich command set far beyond what custom
OpenCode tools would expose:

| Capability             | agent-browser command                   | Custom tool would cover? |
| ---------------------- | --------------------------------------- | ------------------------ |
| Screenshot             | `screenshot --full --annotate --json`   | Partial                  |
| Visual diff            | `diff screenshot --baseline before.png` | No                       |
| Structural diff        | `diff snapshot --baseline`              | No                       |
| Cross-URL diff         | `diff url <a> <b> --screenshot`         | No                       |
| Annotated refs         | `screenshot --annotate` → `@eN` refs    | No                       |
| Batch commands         | `batch` (multiple ops, one invocation)  | No                       |
| Accessibility snapshot | `snapshot -i -c`                        | No                       |
| Network interception   | `network`                               | No                       |

Both Vercel and Microsoft (Playwright CLI) recommend a **CLI + Skill** pattern for coding agents: a
markdown instruction file teaches the agent to invoke CLI commands via bash. This is more
token-efficient than loading tool schemas into context, gives the agent access to the full CLI
surface, and requires less code to maintain.

The only operation agent-browser cannot perform natively is uploading media to our control plane.
For that, we provide a single thin script (`upload-media.js`) that POSTs files using the existing
bridge client.

#### 5.2 Agent-Browser Skill File

A Skill file installed into the sandbox at `<repo>/.opencode/skills/agent-browser/SKILL.md`
(OpenCode discovers skills at `.opencode/skills/<name>/SKILL.md` — see
[OpenCode Skills docs](https://opencode.ai/docs/skills/)):

````markdown
---
name: agent-browser
description: >-
  Browser automation for visual verification of frontend changes. Use when you need to screenshot
  pages, run visual diffs, or inspect page accessibility structure.
---

# Browser Automation (agent-browser)

agent-browser is pre-installed in this sandbox with Chromium. Use it via bash to visually verify
frontend changes, capture before/after screenshots, and run visual diffs.

## Quick Reference

### Navigation

‍`bash agent-browser open <url>          # Navigate (auto-prepends https://) agent-browser back                # Go back agent-browser forward             # Go forward agent-browser reload              # Reload ‍`

### Screenshots

‍`bash agent-browser screenshot                    # Save to temp dir, returns path agent-browser screenshot page.png           # Save to specific path agent-browser screenshot --full             # Full scrollable page agent-browser screenshot --annotate         # Overlay numbered labels on elements agent-browser screenshot --json             # Machine-readable output (path in data.path) agent-browser screenshot --screenshot-format jpeg --screenshot-quality 80 ‍`

### Visual Diff (before/after comparison)

‍```bash

# Take baseline, make changes, then diff

agent-browser screenshot before.png

# ... make code changes, reload page ...

agent-browser diff screenshot --baseline before.png -o diff.png

# Uploads: before.png, current screenshot, and diff.png (changed pixels in red)

‍```

### Accessibility Snapshot

‍`bash agent-browser snapshot -i          # Interactive elements with @eN refs agent-browser snapshot -i -c       # Compact mode agent-browser snapshot -d 3        # Limit depth ‍`

### Batch Execution

‍`bash agent-browser batch \   "open http://localhost:3000" \   "screenshot --json" \   "snapshot -i -c" ‍`

## Upload to Session

After capturing a screenshot, upload it to the session so it appears in the timeline and can be
embedded in PRs and Slack messages:

‍```bash

# Upload a screenshot

node .opencode/tool/upload-media.js /tmp/screenshot.png screenshot "Dashboard after fix"

# Upload a visual diff

node .opencode/tool/upload-media.js /tmp/diff.png screenshot "Visual diff: before vs after" ‍```

## Recommended Workflows

### Verify a frontend change

1. `agent-browser open http://localhost:3000/page`
2. `agent-browser screenshot before.png`
3. Make code changes
4. `agent-browser reload`
5. `agent-browser screenshot after.png`
6. `agent-browser diff screenshot --baseline before.png -o diff.png`
7. Upload before, after, and diff images

### Inspect page structure (when visual info isn't enough)

1. `agent-browser snapshot -i` — get accessibility tree with element refs
2. Reason about structure from the text output
3. Screenshot only if you need visual confirmation

## Tips

- Use `--json` on screenshot commands for machine-readable output
- Use `--annotate` to see numbered labels on interactive elements
- Use `--full` for pages with scrollable content below the fold
- Prefer `snapshot -i` over screenshots when you need text/structural info
- Use `batch` to combine multiple sequential commands in one invocation
- The browser daemon persists between commands — no startup cost per call
````

#### 5.3 Upload Media Tool

A single thin OpenCode tool at `sandbox-runtime/tools/upload-media.js`. This is the only custom tool
needed — it bridges the gap between agent-browser's local file output and the control plane's media
upload endpoint.

```javascript
// upload-media.js — invoked as:
//   node .opencode/tool/upload-media.js <filepath> <type> [caption]
//
// This is a CLI script, not an OpenCode tool definition (no default export).
// The agent calls it via bash after using agent-browser to capture media.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { bridgeFetch } from "./_bridge-client.js";

const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const [filePath, artifactType, caption] = process.argv.slice(2);

if (!filePath || !artifactType) {
  console.error("Usage: node upload-media.js <filepath> screenshot [caption]");
  process.exit(1);
}

const ext = extname(filePath).toLowerCase();
const mimeType = MIME_TYPES[ext];
if (!mimeType) {
  console.error(`Unsupported file type: ${ext}. Supported: ${Object.keys(MIME_TYPES).join(", ")}`);
  process.exit(1);
}

const fileBytes = readFileSync(filePath);
const formData = new FormData();
formData.append("file", new Blob([fileBytes], { type: mimeType }), basename(filePath));
formData.append("artifactType", artifactType);
if (caption) formData.append("caption", caption);

// Important: pass an empty Content-Type header to override the bridge client's default
// "application/json". The runtime will auto-set it to "multipart/form-data" with the
// correct boundary when the body is FormData.
const response = await bridgeFetch("/media", {
  method: "POST",
  body: formData,
  headers: { "Content-Type": "" },
});
if (!response.ok) {
  const err = await response.text();
  console.error(`Upload failed (${response.status}): ${err}`);
  process.exit(1);
}

const result = await response.json();
console.log(`Uploaded ${artifactType}: ${result.artifactId} (${fileBytes.length} bytes)`);
```

**Note on bridge client compatibility**: The existing `_bridge-client.js` defaults
`Content-Type: application/json`, but caller-supplied headers override via object spread. Passing
`"Content-Type": ""` (empty string) clears the default so the runtime auto-sets
`multipart/form-data; boundary=...` from the FormData body. An alternative is to update the bridge
client to detect FormData and omit the default Content-Type, but the empty-string override is
simpler and doesn't require changing shared code.

#### 5.4 Skill + Tool Registration

The entrypoint (`entrypoint.py`) already copies `.js` files from `sandbox-runtime/tools/` to
`<repo>/.opencode/tool/`. Add `upload-media.js` to the tools directory (no code change to the copy
logic — the `for tool_file in tools_dir.iterdir()` loop picks it up automatically).

For the Skill file, extend `_install_tools()` (or add a parallel `_install_skills()`) to copy the
Skill markdown into the OpenCode skill directory:

```python
def _install_skills(self, workdir: Path) -> None:
    """Copy skill files into .opencode/skills/ for OpenCode to discover."""
    skills_src = Path("/app/sandbox_runtime/skills")
    skills_dest = workdir / ".opencode" / "skills"

    if not skills_src.exists():
        return

    for skill_dir in skills_src.iterdir():
        if skill_dir.is_dir() and (skill_dir / "SKILL.md").exists():
            dest = skills_dest / skill_dir.name
            dest.mkdir(parents=True, exist_ok=True)
            shutil.copy(skill_dir / "SKILL.md", dest / "SKILL.md")
```

File layout in `sandbox-runtime/`:

```
sandbox-runtime/
  src/sandbox_runtime/
    tools/
      _bridge-client.js          # existing
      spawn-task.js              # existing
      get-task-status.js         # existing
      cancel-task.js             # existing
      upload-media.js            # new — thin upload helper
    skills/
      agent-browser/
        SKILL.md                 # new — agent-browser instruction file
```

---

### 6. Web Client

#### 6.1 Rendering Model

**Important**: The `artifact_created` WebSocket message updates the client's **artifacts list**
(`setArtifacts` in `use-session-socket.ts:386`), not the timeline events. For screenshots to appear
in the session timeline, the DO's `create-media-artifact` handler (Section 4.2) must also create an
event record and broadcast it. The client then renders screenshots from **both** paths:

- **Timeline**: via `EventItem` handling `"artifact"` events (inline in the message stream)
- **Artifacts list**: via the existing artifacts panel (sidebar, action bar indicators)

#### 6.2 Timeline: Screenshot Event

Add a case to `EventItem` for `"artifact"` events with `artifactType === "screenshot"`:

```tsx
case "artifact": {
  const artifactData = event.data as {
    artifactType: string;
    metadata?: { caption?: string; objectKey?: string };
  };
  if (artifactData.artifactType === "screenshot") {
    return <ScreenshotCard event={event} sessionId={sessionId} />;
  }
  return null; // Other artifact types (pr, preview) handled elsewhere
}
```

#### 6.3 `ScreenshotCard` Component

```tsx
function ScreenshotCard({ event, sessionId }: { event: AgentEvent; sessionId: string }) {
  const metadata = event.data.metadata as ScreenshotArtifactMetadata;
  const [imageUrl, setImageUrl] = useState<string | null>(null);

  // Fetch presigned URL on mount via Next.js API proxy
  useEffect(() => {
    fetch(`/api/sessions/${sessionId}/media/${event.data.artifactId}`)
      .then((r) => r.json())
      .then(({ url }) => setImageUrl(url));
  }, [sessionId, event.data.artifactId]);

  return (
    <div className="screenshot-card">
      {metadata?.caption && <p className="caption">{metadata.caption}</p>}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={metadata?.caption || "Screenshot"}
          loading="lazy"
          onClick={() => openLightbox(imageUrl)}
        />
      ) : (
        <Skeleton />
      )}
      {metadata?.sourceUrl && <span className="source-url">{metadata.sourceUrl}</span>}
    </div>
  );
}
```

The presigned URL is fetched through the web app's `/api/` proxy (which adds HMAC auth), not
directly from the control plane. The URL has a 15-minute TTL — sufficient for viewing since the
component re-fetches on mount.

#### 6.4 Lightbox

A modal overlay for full-resolution image viewing with zoom/pan. Can use an existing library like
`yet-another-react-lightbox` or a minimal custom implementation.

#### 6.5 Sidebar: Media Gallery

Add a "Media" section to `SessionRightSidebar` that filters the artifacts list for
`type === "screenshot"` and renders thumbnails. Clicking opens the lightbox.

#### 6.6 Action Bar

Extend `ActionBar` to show a "Screenshots (N)" indicator when screenshot artifacts exist.

---

### 7. Slack Bot Integration

#### 7.1 Image Upload on Completion

When a session completes and has screenshot artifacts, upload the most relevant screenshots (e.g.,
the last 1-2) to Slack as native file uploads. This avoids expiring URL problems — once uploaded,
Slack hosts the file permanently.

```typescript
// slack-bot/src/completion/blocks.ts
async function uploadScreenshotToSlack(
  slackToken: string,
  channel: string,
  threadTs: string,
  presignedUrl: string,
  caption: string
) {
  // Fetch image bytes from R2 presigned URL
  const response = await fetch(presignedUrl);
  const buffer = await response.arrayBuffer();

  // Upload natively to Slack via files.uploadV2
  await slackClient.files.uploadV2({
    token: slackToken,
    channel_id: channel,
    thread_ts: threadTs,
    file: Buffer.from(buffer),
    filename: "screenshot.png",
    title: caption || "Session screenshot",
  });
}
```

This is preferable to using Slack `image` blocks with `image_url`, which require a
publicly-accessible URL and break if the signed URL expires before Slack's async fetch.

---

### 8. GitHub Bot Integration

#### 8.1 PR Description Screenshots

When a PR is created and the session has screenshot artifacts, embed them in the PR body:

```markdown
## Visual Changes

| Before                  | After                  |
| ----------------------- | ---------------------- |
| ![before](stable_url_1) | ![after](stable_url_2) |
```

The control plane's `PullRequestService.createPullRequest()` already constructs the PR body. Extend
it to query screenshot artifacts and generate **stable proxy URLs** for embedding.

**Stable proxy URL**: GitHub PR bodies are durable artifacts — short-lived presigned URLs are too
brittle (GitHub may not fetch the image immediately, and if the URL expires the image is permanently
broken). Instead, use a stable HMAC-authenticated URL:

```
/sessions/:id/media/:artifactId/public?token=<hmac>
```

The `token` is an HMAC-SHA256 signature over the session ID and artifact ID using
`INTERNAL_CALLBACK_SECRET`. This URL does not expire (the HMAC is deterministic), but only grants
access to the specific artifact. The control plane verifies the HMAC on each request and streams the
image from R2 (or returns a short-lived presigned redirect).

This same stable URL pattern can also be used as a fallback for Slack `image` blocks if native file
upload is not available.

---

### 9. Sandbox Image Changes

#### 9.1 Display Server

Not needed. `agent-browser` runs in **headless mode** by default, which is sufficient for
screenshots. No Xvfb changes required for v1.

#### 9.2 Skill + Tool Files in Image

The `upload-media.js` tool and `agent-browser/SKILL.md` skill file are bundled into the sandbox
image as part of the `sandbox_runtime` package (same `add_local_dir` in `images/base.py`). At boot,
`_install_tools()` copies `upload-media.js` to `<repo>/.opencode/tool/` and `_install_skills()`
copies the Skill file to `<repo>/.opencode/skills/agent-browser/SKILL.md`. No image changes needed
beyond adding the new files to the `sandbox-runtime` source tree.

---

## Data Flow: End-to-End Screenshot

```
1. Agent decides to verify a UI change (guided by agent-browser Skill)
2. Agent runs: agent-browser open http://localhost:3000/dashboard
3. Agent runs: agent-browser screenshot /tmp/screenshot.png --json
4. Agent runs: node .opencode/tool/upload-media.js /tmp/screenshot.png screenshot "Dashboard"
5. upload-media.js reads file, POSTs multipart to control plane: POST /sessions/:id/media
6. Worker authenticates sandbox token via SessionDO
7. Worker validates file (size, MIME, magic bytes)
8. Worker PUTs to R2: sessions/<sessionId>/media/<artifactId>.png
9. Worker calls SessionDO /internal/create-media-artifact
10. SessionDO inserts into `artifacts` table AND `events` table
11. SessionDO broadcasts { type: "artifact_created" } and event to all WS clients
12. Web client updates artifacts list (setArtifacts) and appends to timeline (events)
13. ScreenshotCard fetches presigned URL via Next.js /api/sessions/:id/media/:artifactId
14. Next.js proxy calls control plane (HMAC auth), receives presigned R2 URL
15. Browser fetches image directly from R2 presigned URL (CORS allows origin)
```

## Data Flow: End-to-End Visual Diff

```
1. Agent captures baseline: agent-browser screenshot before.png
2. Agent makes code changes, then: agent-browser reload
3. Agent runs visual diff: agent-browser diff screenshot --baseline before.png -o diff.png
4. Agent uploads all three images (before, after, diff) via upload-media.js
5-15. Same upload/store/broadcast/render flow as screenshots (×3 artifacts)
```

---

## Schema Changes

### DO SQLite (session/schema.ts)

No schema migration needed. The `artifacts` table already supports all needed fields:

- `type`: will store `"screenshot"` (already a declared value in `ArtifactType`)
- `url`: will store the R2 object key (not a full URL)
- `metadata`: will store JSON with `ScreenshotArtifactMetadata`

### D1 (global)

No D1 migration needed. Session-level media counts can be derived from the DO's artifacts table when
needed (e.g., for D1 session metrics, add `media_count` in a future migration).

---

## Security

### Upload Validation

- **Magic byte verification**: Check file headers match declared MIME type (PNG: `\x89PNG`, JPEG:
  `\xFF\xD8\xFF`, WebP: `RIFF....WEBP`). Don't trust `Content-Type` alone.
- **Size limits**: 10 MB per screenshot. Enforced at the Worker level before R2 PUT.
- **Rate limiting**: Per-session rate limit (100 media per session). Enforced by counting existing
  artifacts in the DO.
- **Sandbox-only upload**: Only the sandbox auth token can upload media. User WebSocket connections
  cannot.

### Access Control

- **Presigned URLs**: All media access goes through time-limited R2 presigned URLs (15 min TTL). No
  public bucket. URLs are generated server-side by the control plane using R2 S3 API credentials.
- **Session-scoped**: To view media, requests go through the web app's API proxy, which enforces
  session-level auth before forwarding to the control plane.
- **Stable HMAC URLs**: For external embedding (GitHub PRs), a non-expiring HMAC-authenticated URL
  verifies access per-artifact without requiring session auth.
- **Slack**: Screenshots are uploaded natively to Slack (no external URL needed after upload).
- **CORS**: The R2 bucket allows `GET` from the web app's origin(s) so browsers can fetch presigned
  URLs directly.

### Content Safety

- No server-side content scanning in v1. The agent generates all content, not users.
- If user-uploaded screenshots are added later, integrate content moderation.

---

## Implementation Plan

### Phase 1: Storage + Upload Pipeline

**Scope**: R2 bucket, Terraform, presigned URL infra, control plane upload/download routes.

1. Add `r2_buckets` variable to Terraform worker module
2. Create R2 bucket resource
3. Bind to control plane worker (`MEDIA_BUCKET: R2Bucket`)
4. Create R2 S3 API access keys, add as Worker secrets (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`)
5. Configure R2 bucket CORS (allow GET from web app origins)
6. Implement `POST /sessions/:id/media` (multipart, validation, R2 PUT) — sandbox auth
7. Implement `GET /sessions/:id/media/:artifactId` (presigned URL generation) — HMAC auth
8. Add `POST /sessions/:id/media` to `SANDBOX_AUTH_ROUTES` in router
9. Add `/internal/create-media-artifact` to SessionDO (creates artifact + event, broadcasts both)
10. Tests: upload validation, size limits, auth, presigned URL generation

### Phase 2: Artifact Event Processing Fix

**Scope**: Fix the existing bug where artifact events from the sandbox don't create artifact
records.

1. Add artifact event handler to `SessionSandboxEventProcessor`
2. Existing `ArtifactEvent` Python type already supports this
3. Tests: sandbox emits artifact event -> artifact appears in artifacts table and broadcast

### Phase 3: Sandbox Skill + Upload Helper

**Scope**: Agent-browser Skill file, `upload-media.js` helper, skill registration in entrypoint.

1. Write `agent-browser/SKILL.md` skill file (CLI reference + workflow patterns)
2. Implement `upload-media.js` (reads file, POSTs to `/sessions/:id/media` via bridge client)
3. Add `_install_skills()` to `entrypoint.py` to copy skill files into `.opencode/skills/`
4. Test: agent invokes `agent-browser screenshot` + `upload-media.js` -> artifact created

### Phase 4: Web UI

**Scope**: Timeline + artifacts list rendering, lightbox, sidebar gallery, Next.js API proxy.

1. Add Next.js `/api/sessions/:id/media/:artifactId` proxy route (session auth + HMAC to control
   plane)
2. Add `"artifact"` case to `EventItem` for screenshot events in timeline
3. Build `ScreenshotCard` component (fetches presigned URL via API proxy)
4. Add lightbox/modal for full-resolution viewing
5. Add "Media" section to right sidebar (reads from artifacts list)
6. Extend `ActionBar` with screenshot count indicator

### Phase 5: Bot Integrations

**Scope**: Slack native file uploads, GitHub PR stable URL embedding.

1. Slack: Upload screenshots natively via `files.uploadV2` on session completion
2. GitHub: Embed screenshots in PR descriptions using stable HMAC proxy URLs
3. Add `/sessions/:id/media/:artifactId/public?token=<hmac>` route for stable external access

### Future Phase: Video Recording

**Scope**: Validate `agent-browser record` or implement CDP-attached recorder, extend pipeline.

1. Validate recording capability with pinned `agent-browser` version (0.21.2)
2. If native `record` is unavailable, implement CDP-attached recorder per sibling design doc
3. Add `"video"` to `ArtifactType` and update discriminators (`toArtifactType()`, `Artifact`
   interface)
4. Add `VideoArtifactMetadata` type
5. Add `VideoCard` component to web UI
6. Extend upload validation for `video/webm` (50 MB limit)
7. Update Skill file with video recording workflow

---

## Alternatives Considered

### Direct R2 upload from sandbox (presigned URLs)

The control plane would generate a presigned R2 upload URL and return it to the sandbox, which
uploads directly. This reduces bandwidth through the Worker but adds complexity:

- Requires a new endpoint to generate presigned URLs
- Two round trips (get URL, then upload) instead of one
- R2 presigned URLs require a separate API token with specific permissions
- Harder to enforce content validation pre-upload

Rejected for v1. Can reconsider if video file sizes become a bottleneck.

### Store screenshots in DO SQLite as blobs

SQLite can store blobs, but:

- DO SQLite has a 256 MB storage limit per DO
- Binary data in SQLite is inefficient for large files
- No CDN/caching benefits
- Would bloat DO checkpoint size

Rejected.

### Dedicated media Worker (separate from control plane)

A purpose-built Worker just for media upload/download. This provides better separation of concerns
but adds deployment complexity for a feature that doesn't warrant it yet.

Deferred to when media volume justifies the split.

### KV for media storage

Cloudflare KV supports values up to 25 MB but is optimized for small, frequently-read values. R2 is
the correct choice for binary media (up to 5 TB per object, S3-compatible API, lifecycle rules).

Rejected.

### Custom OpenCode tools (`capture-screenshot`, `record-video`)

The initial design proposed dedicated OpenCode tool definitions that wrap `agent-browser` commands
and handle upload in a single tool call. This was rejected in favor of the CLI + Skill pattern for
several reasons:

- **Limited surface**: Custom tools would expose ~15% of agent-browser's capabilities (no visual
  diff, no accessibility snapshots, no batch execution, no network interception).
- **Token cost**: OpenCode tool schemas are always loaded into context. A Skill markdown file is
  only loaded when the agent's task matches the trigger condition.
- **Maintenance burden**: ~300 lines of tool code wrapping a CLI that already has `--json` output.
- **Ecosystem alignment**: Both Vercel (agent-browser) and Microsoft (Playwright CLI) recommend the
  CLI + Skill pattern for coding agents.

The tradeoff is less structured invocation (bash commands vs. typed parameters), but agent-browser's
`--json` flag and the Skill's workflow patterns provide sufficient guardrails. Server-side
validation on the upload endpoint catches the critical errors (wrong MIME type, oversized files).

### MCP server for browser automation

An MCP server (e.g., `@playwright/mcp`) would expose browser actions as structured MCP tools. This
provides richer type safety than the Skill approach but:

- Loads tool schemas into context on every turn (higher token cost)
- Requires running an MCP server process in the sandbox alongside the agent
- Playwright MCP's own README recommends CLI + Skills for coding agents, reserving MCP for
  "exploratory automation or long-running autonomous workflows"

Deferred. Could reconsider if we add computer-use capabilities (agent autonomously navigating
complex UIs) where structured tool calls become more valuable than CLI invocations.

---

## Open Questions

1. **Media in prompt attachments**: The `Attachment` type already supports `type: "image"`. Should
   users be able to attach screenshots from one session as context to a new prompt?

## Resolved Questions

- ~~**Screenshot diff tool**~~: `agent-browser diff screenshot` is exposed directly via the Skill.
- ~~**Automatic screenshots**~~: The Skill provides workflow patterns; the agent decides when to use
  them.
- ~~**OpenCode skill discovery**~~: Confirmed — OpenCode discovers
  `.opencode/skills/<name>/SKILL.md` (see [OpenCode Skills docs](https://opencode.ai/docs/skills/)).
- ~~**Video recording**~~: Deferred to future phase. Pinned `agent-browser` v0.21.2 does not expose
  a first-class `record` command. See "Future Phase: Video Recording" in the implementation plan.
