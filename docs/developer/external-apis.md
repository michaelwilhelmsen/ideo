# External APIs

Patterns for calling external HTTP APIs from Tauri applications.

> **Note:** `reqwest` (HTTP) and `keyring` (OS keychain) are installed. The
> keychain backends are selected per platform in `src-tauri/Cargo.toml` so the
> cross-platform build doesn't pull the other platforms' native dependencies.
>
> Worked example: `src-tauri/src/commands/api_key.rs` — secret in the keychain,
> read only in Rust, with a pure classification function so the outcome mapping
> is testable without a network.

## Rust vs Frontend: When to Use Which

**Default recommendation: Use Rust backend (reqwest)**

| Approach         | Pros                                           | Cons                            |
| ---------------- | ---------------------------------------------- | ------------------------------- |
| Rust (reqwest)   | CORS bypass, secure token storage, type safety | More code per endpoint          |
| Frontend (fetch) | Less boilerplate, familiar API                 | CORS restrictions, exposed keys |

### Use Rust Backend For

- All authenticated API calls (keeps tokens out of WebView)
- APIs with CORS restrictions (desktop apps bypass CORS from Rust)
- Calls requiring response caching to local storage
- Production applications

### Use Frontend Fetch For

- Public APIs with no authentication
- Rapid prototyping before moving to Rust
- Third-party SDKs requiring browser context

## Setup

```bash
# Rust HTTP client
cd src-tauri && cargo add reqwest --features json,rustls-tls
```

For secure token storage, see the Authentication section below.

## Architecture Pattern

Follow the same pattern as local data: Tauri commands wrap API calls, TanStack Query provides caching.

```
React Component → TanStack Query → Tauri Command (reqwest) → External API
```

### Rust Command

```rust
use reqwest;
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct User {
    pub id: u32,
    pub name: String,
    pub email: String,
}

#[tauri::command]
#[specta::specta]
pub async fn fetch_user(user_id: u32) -> Result<User, String> {
    let client = reqwest::Client::new();

    let response = client
        .get(format!("https://api.example.com/users/{user_id}"))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("API error: {}", response.status()));
    }

    response.json::<User>()
        .await
        .map_err(|e| format!("Parse error: {e}"))
}
```

### React Service

```typescript
// src/services/users.ts
export const userQueryKeys = {
  all: ['users'] as const,
  user: (id: number) => [...userQueryKeys.all, id] as const,
}

export function useUser(userId: number) {
  return useQuery({
    queryKey: userQueryKeys.user(userId),
    queryFn: async () => unwrapResult(await commands.fetchUser(userId)),
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
  })
}

export function useUpdateUser() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      userId,
      data,
    }: {
      userId: number
      data: Partial<User>
    }) => {
      const result = await commands.updateUser(userId, data)
      if (result.status === 'error') throw new Error(result.error)
      return result.data
    },
    onSuccess: (_, { userId }) => {
      queryClient.invalidateQueries({ queryKey: userQueryKeys.user(userId) })
    },
  })
}
```

## Authentication

### Token Storage Options

| Option                    | Security            | Use When                          |
| ------------------------- | ------------------- | --------------------------------- |
| `keyring` crate           | High (OS keychain)  | API tokens, credentials           |
| `tauri-plugin-stronghold` | High (encrypted DB) | Multiple secrets, encryption keys |
| `tauri-plugin-store`      | Low (plain JSON)    | Non-sensitive data only           |

For OS keychain access, use the `keyring` crate directly:

```bash
cd src-tauri && cargo add keyring
```

```rust
use keyring::Entry;

#[tauri::command]
#[specta::specta]
pub fn save_auth_token(token: String) -> Result<(), String> {
    let entry = Entry::new("myapp", "auth_token")
        .map_err(|e| format!("Keyring error: {e}"))?;
    entry.set_password(&token)
        .map_err(|e| format!("Failed to save token: {e}"))
}

#[tauri::command]
#[specta::specta]
pub fn get_auth_token() -> Result<Option<String>, String> {
    let entry = Entry::new("myapp", "auth_token")
        .map_err(|e| format!("Keyring error: {e}"))?;
    match entry.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("Failed to get token: {e}")),
    }
}
```

### Authenticated Requests

```rust
#[tauri::command]
#[specta::specta]
pub async fn fetch_protected_data() -> Result<Data, String> {
    let entry = Entry::new("myapp", "auth_token")
        .map_err(|e| format!("Keyring error: {e}"))?;
    let token = entry.get_password()
        .map_err(|_| "Not authenticated")?;

    let client = reqwest::Client::new();
    client
        .get("https://api.example.com/protected")
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?
        .json::<Data>()
        .await
        .map_err(|e| format!("Parse error: {e}"))
}
```

## Error Handling

See [error-handling.md](./error-handling.md) for complete patterns. Key points for API calls:

```typescript
// Configure retry for network errors, not validation errors
const { data } = useQuery({
  queryKey: ['api-data'],
  queryFn: fetchData,
  retry: (failureCount, error) => {
    if (error.message.includes('validation')) return false
    return failureCount < 3
  },
})
```

## Offline Handling

For apps that need to work offline, cache API responses to SQLite:

```rust
#[tauri::command]
#[specta::specta]
pub async fn fetch_with_cache(app: tauri::AppHandle, id: u32) -> Result<Data, String> {
    // Try network first
    match fetch_from_api(id).await {
        Ok(data) => {
            cache_to_db(&app, &data)?;  // Cache for offline
            Ok(data)
        }
        Err(_) => {
            // Fallback to cache on network error
            load_from_cache(&app, id)
        }
    }
}
```

See [data-persistence.md](./data-persistence.md) for SQLite setup.

## Long-running jobs on a queue API

Some APIs do not answer the call that made them: you submit, get a request id back, and
poll until there is a result. fal.ai's image and video endpoints work this way, and the
worked example is `src-tauri/src/jobs/`.

The shape that matters is **the command does not return the result.**

```
generate_image → submit → record the request id → return a receipt
                                ↓ (background task, may outlive the window)
                          poll → fetch → save → mark collectable → emit `generation-settled`
```

Why not one long `await`, which is simpler to write and to call:

- **The charge lands at submit.** If the process is the only place the request id
  exists, quitting throws away something already paid for. Recording it first is what
  makes a relaunch able to pick the job back up.
- **Resume must not be a second code path.** `runner::start` and `runner::resume` differ
  only in where the queue URLs came from, and both call the same `watch`. A separate
  "restore" path would be exercised only after a crash, which is exactly when it must
  work.
- **A cap is needed somewhere.** A four-up batch is four concurrent charged calls. A
  `tokio::sync::Semaphore` around the job's whole life holds it to three, and a resumed
  batch queues behind the same cap.

Three practical points, each learned the expensive way:

- **Never construct queue URLs.** fal returns `status_url` / `response_url` /
  `cancel_url` on submit, and the versioned forms we would build ourselves return `405`.
- **An unrecognised status means keep waiting**, not fail. The user has already paid;
  a new state name is not evidence the job died.
- **Cancellation must not promise a refund.** Cancelling stops the polling and asks the
  API to stop working, but a job far enough along is charged anyway — so the copy beside
  the button says "may still charge", and no code path claims otherwise.

### Sending an input image

An image-to-image endpoint needs the input image _in the request body_. It travels as an
inline base64 data URI (`data:image/png;base64,…`), which `docs/research/models-gaps.md` §4
settled: it is the transfer confirmed to work on every image field surveyed, and the
two-step storage upload's wire protocol is still unverified. The ceiling is 10 MB raw,
refused locally rather than discovered as a 4xx.

The bytes never cross the IPC boundary. `StartRequest.imageInput` carries a **generation
id**, the field name and its shape; `jobs::image_input::prepare` resolves the id to a file
in the project's `assets` folder, sniffs its media type from the magic bytes, encodes it,
and writes it into the params under that name — a string for `image_url`, a one-element
array for `image_urls` — before `fal::submit` posts anything.

That module also holds a refusal worth copying: a `style` or `animate` submit with no
resolvable input fails there, before the key is fetched and before a concurrency slot is
taken. The reason is specific — the Nano Banana edit endpoints do not _require_ their image
field, so a missing source would have succeeded as a text-to-image and been charged for,
and an animate run with no start frame would have rendered the motion prompt as
text-to-video at up to $0.47 a second.

### Reading the result

Two payload shapes, because the two media are two shapes: an image endpoint answers with
`images: [{url}]` and a video endpoint with `video: {url}` — one object, not an array,
since one call produces one clip. `fal::extract_result` reads the video first, so a payload
carrying both files the clip that was paid for, and returns a `QueueResult { asset_url,
seed, kind }`.

`kind` is not cosmetic: it decides the extension when the URL has no usable one (a signed
or query-suffixed URL), and a clip filed as `.jpeg` is a file the app will not play and the
desktop will not preview. Beyond that nothing about the video path is special —
`projects::store::asset_path` finds a generation's file by its **stem**, so an `.mp4` is
found by the same lookup that finds a `.png`.

The wait ceiling _is_ per stage. A 30-second render routinely outlives the ten minutes a
still gets, so `runner::max_wait` gives `animate` thirty minutes and everything else ten —
raising it for all of them would let three stuck image jobs hold every concurrency slot.
And playing the result needs `media-src 'self' asset: http://asset.localhost` in the CSP;
without it the `<video>` element is blocked and shows nothing. `blob:` was in that list and
is not any more — every clip is played from the asset protocol off disk, nothing here ever
calls `createObjectURL`, and a source nothing loads from is a source only an injected
script can use.

Every one of those refusals crosses as a code, not a sentence: `GenerationError.inputImage`
is an `InputImageProblem` — `noneNamed`, `notOnDisk`, `unreadable`, `unsupportedFormat`,
`tooLarge { bytes, limit }`, `noField` — which `components/editor/errors.ts` maps to a key
in `locales/`. Unlike `detail`, which quotes what fal said, this failure is ours and there
is nobody to quote, so an English sentence built in Rust would be one no locale file could
ever reach (PRD §10.4). The path, the `io::Error` and the byte count are logged Rust-side
instead — see [error-handling.md](./error-handling.md).

Progress crosses as an emitted event rather than a return value, because the interesting
part happens while the command is still running — see
[tauri-commands.md](./tauri-commands.md) for registering an event payload type with
tauri-specta.

## Quick Reference

| Task            | Pattern                                           |
| --------------- | ------------------------------------------------- |
| Basic API call  | Rust command with reqwest                         |
| Queue/poll API  | Record the id, then watch — `src-tauri/src/jobs/` |
| Caching         | TanStack Query (frontend) or SQLite               |
| Token storage   | `keyring` crate (OS keychain)                     |
| Type safety     | tauri-specta (same as local commands)             |
| Error handling  | Result types, see error-handling.md               |
| Offline support | Cache to SQLite, fallback on network err          |
