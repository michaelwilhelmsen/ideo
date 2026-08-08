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
