# Data Persistence

Patterns for saving and loading data to disk.

## Choosing a Storage Method

| Need               | Solution           | When to Use                                                           |
| ------------------ | ------------------ | --------------------------------------------------------------------- |
| App preferences    | Preferences System | Strongly-typed settings (theme, shortcuts)                            |
| Emergency recovery | Recovery System    | Crash recovery, backup before risky operations                        |
| Relational data    | SQLite             | User data requiring queries, relationships                            |
| External API data  | TanStack Query     | Remote data with caching (see [external-apis.md](./external-apis.md)) |

```
Need to persist data?
├─ App settings? → Preferences (Rust struct + TanStack Query)
├─ User data with queries/relationships? → SQLite (see below)
├─ Remote API data? → external-apis.md
└─ Emergency/crash recovery? → Recovery System
```

All data goes through Rust for type safety and security. Use TanStack Query on the frontend for loading states and cache invalidation.

## File Locations

```
~/Library/Application Support/com.myapp.app/  (macOS)
├── preferences.json                          # App preferences
├── index.sqlite                              # Project index (rebuildable)
├── projects/                                 # One folder per project
│   └── <project-id>/
│       ├── project.json                      # The manifest — source of truth
│       └── assets/                           # Generated files
└── recovery/                                 # Emergency data
    └── *.json
```

## Atomic Write Pattern (Critical)

All file writes use atomic operations to prevent corruption:

```rust
// Write to temp file first, then rename (atomic)
let temp_path = file_path.with_extension("tmp");
std::fs::write(&temp_path, content)?;
std::fs::rename(&temp_path, &file_path)?;
```

**Why**: If the app crashes during write, you either have the old file or the new file - never a corrupted partial file.

## Preferences System

### Rust Side

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct AppPreferences {
    pub theme: String,
    // Add new preferences here
}

impl Default for AppPreferences {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
        }
    }
}
```

### React Side

```typescript
// src/services/preferences.ts
export function usePreferences() {
  return useQuery({
    queryKey: ['preferences'],
    queryFn: async () => unwrapResult(await commands.loadPreferences()),
  })
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (preferences: AppPreferences) =>
      commands.savePreferences(preferences),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['preferences'] })
    },
  })
}
```

## Emergency Recovery System

For saving data before crashes or risky operations:

```typescript
// Save emergency data
await commands.saveEmergencyData({
  filename: 'unsaved-work',
  data: { content: userContent, timestamp: Date.now() },
})

// Load on startup
const recoveryData = await commands.loadEmergencyData({
  filename: 'unsaved-work',
})
if (recoveryData.status === 'ok' && recoveryData.data) {
  // Show recovery dialog
}
```

Recovery files are automatically cleaned up after 7 days via `cleanupOldRecoveryFiles`.

## Adding New Persistent Data

### 1. Define Rust struct

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct MyData {
    pub field: String,
}

impl Default for MyData {
    fn default() -> Self {
        Self { field: "default".to_string() }
    }
}
```

### 2. Add Tauri commands

Follow the pattern in `src-tauri/src/commands/preferences.rs`:

- `load_*` command with Default fallback
- `save_*` command with atomic write

### 3. Register commands

Add to `src-tauri/src/bindings.rs` and regenerate bindings:

```bash
npm run rust:bindings
```

### 4. Create React hooks

```typescript
export function useMyData() {
  return useQuery({
    queryKey: ['my-data'],
    queryFn: async () => unwrapResult(await commands.loadMyData()),
  })
}
```

## Security

### Filename Validation

Always validate filenames to prevent path traversal:

```rust
if filename.contains("..") || filename.contains("/") || filename.contains("\\") {
    return Err("Invalid filename".to_string());
}
```

### Directory Permissions

Use Tauri's `app_data_dir()` for safe storage locations - never write to arbitrary paths.

## Projects: disk authoritative, SQLite as index

Projects are the app's own data, and they follow a pattern the sections above do not
cover — worth reading before adding anything else that persists.

```
~/Library/Application Support/com.ideo.app/
├── index.sqlite              # rebuildable cache of the project list
└── projects/
    └── <project-id>/
        ├── project.json      # the manifest — the source of truth
        └── assets/
            └── <generation-id>.jpeg
```

**Disk is authoritative and the database is a cache.** `list_projects` reconciles the
index against the folders on every call, so deleting `index.sqlite` costs a rescan and
nothing else. This is asserted, not assumed — see
`deleting_the_database_file_costs_nothing_but_a_rescan` in
`src-tauri/src/projects/index.rs`.

**Rust owns the folder; TypeScript owns the schema.** The manifest crosses the boundary
as opaque JSON (`serde_json::Value`) and is written back byte-for-byte. Rust reads only
the handful of fields it needs to index and to clean up — id, name, aspect, timestamps,
asset names. Two consequences worth keeping:

- The recipe model lives in one place (`src/lib/recipe/manifest.ts`), which is where it
  is also validated. A manifest is untrusted input: it can be hand-edited, copied from
  another machine, or written by a newer build.
- Fields this build does not model survive a round trip, so an older build cannot
  silently downgrade a project it opens.

**Where each half of the state lives.** TanStack Query holds the project _list_ and the
on-disk facts about it; Zustand holds the _open_ project, because that is a live
document edited many times a second. `useProjectLibrary` in `src/services/projects.ts`
is the seam, and it debounces writes rather than saving per keystroke.

| Layer                 | Holds                                   | Module                    |
| --------------------- | --------------------------------------- | ------------------------- |
| `projects/store`      | folders, atomic writes, size, cleanup   | `src-tauri/src/projects/` |
| `projects/index`      | the SQLite cache and its reconciliation | `src-tauri/src/projects/` |
| `services/projects`   | queries, mutations, autosave            | `src/services/`           |
| `lib/recipe/manifest` | the on-disk shape, and validating it    | `src/lib/recipe/`         |

## SQLite Database

> Installed as `rusqlite` with the `bundled` feature, for the project index described
> above. `bundled` compiles SQLite from source, so there is no dependency on whatever
> version the host ships.

### When to Use SQLite

| Use Case                         | Recommendation     |
| -------------------------------- | ------------------ |
| Simple key-value settings        | Preferences System |
| User data with relationships     | SQLite             |
| Data requiring complex queries   | SQLite             |
| Large datasets (1000+ records)   | SQLite             |
| Data needing atomic transactions | SQLite             |

### Approach Options

| Approach   | Use When                                              |
| ---------- | ----------------------------------------------------- |
| `rusqlite` | Simpler setup, synchronous queries, smaller apps      |
| `sqlx`     | Async queries, compile-time SQL checking, larger apps |

Both integrate with Tauri commands and tauri-specta for type safety.

### Setup (rusqlite)

```bash
cd src-tauri && cargo add rusqlite --features bundled
```

### Architecture Pattern

Tauri commands wrap database operations, TanStack Query provides frontend caching.

```
React Component → TanStack Query → Tauri Command (rusqlite) → SQLite
```

```rust
use rusqlite::{Connection, params};
use std::sync::Mutex;
use tauri::State;

// Database connection managed as Tauri state
pub struct DbConnection(pub Mutex<Connection>);

#[tauri::command]
#[specta::specta]
pub fn get_items(db: State<DbConnection>) -> Result<Vec<Item>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, name, created_at FROM items ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;

    let items = stmt
        .query_map([], |row| {
            Ok(Item {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    Ok(items)
}
```

Initialize in `src-tauri/src/lib.rs`:

```rust
let db_path = app.path().app_data_dir()?.join("app.db");
let conn = Connection::open(&db_path)?;

// Run migrations
conn.execute(
    "CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )",
    [],
)?;

app.manage(DbConnection(Mutex::new(conn)));
```

```typescript
// Frontend: TanStack Query for caching and loading states
export function useItems() {
  return useQuery({
    queryKey: ['items'],
    queryFn: async () => unwrapResult(await commands.getItems()),
  })
}

export function useAddItem() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (item: CreateItem) => commands.addItem(item),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['items'] }),
  })
}
```

### Migration Rules

- Run migrations at app startup before managing database state
- Use `IF NOT EXISTS` / `IF EXISTS` for idempotent migrations
- For complex apps, consider a version table to track applied migrations
