import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Mock matchMedia for tests
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation(query => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(), // deprecated
    removeListener: vi.fn(), // deprecated
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
})

// Mock Tauri APIs for tests
vi.mock('@tauri-apps/api/core', () => ({
  // Asset URLs go through the webview's protocol handler, which does not exist
  // under jsdom — the path itself is enough to assert against.
  convertFileSrc: vi.fn((path: string) => `asset://${path}`),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {
    // Mock unlisten function
  }),
}))

// Opening a URL in the system browser (#32) — jsdom has no shell to hand it to.
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}))

// The webview handle reads window internals that jsdom has none of. Only its
// drag-drop listener is used (#27), and it hands back an unlisten like the
// real one so components can register and tear down as they normally would.
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: vi.fn(() => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {
      // Mock unlisten function
    }),
  })),
}))

// Mock typed Tauri bindings (tauri-specta generated)
vi.mock('@/lib/tauri-bindings', () => ({
  commands: {
    greet: vi.fn().mockResolvedValue('Hello, test!'),
    // A returning user by default (#32): `onboarding_version` above any step's
    // version means no test inherits a welcome modal it did not ask for. Tests
    // about onboarding set it to 0 — a first launch — themselves.
    loadPreferences: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        theme: 'system',
        onboarding_version: 1_000,
        // A folder already chosen (#31), for the same reason onboarding is
        // already done: a test about exporting should not have to pick one
        // first, and a test about picking one says so itself.
        export_directory: '/tmp/exports',
      },
    }),
    savePreferences: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    sendNativeNotification: vi
      .fn()
      .mockResolvedValue({ status: 'ok', data: null }),
    saveEmergencyData: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    loadEmergencyData: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    cleanupOldRecoveryFiles: vi
      .fn()
      .mockResolvedValue({ status: 'ok', data: 0 }),
    hasFalApiKey: vi.fn().mockResolvedValue({ status: 'ok', data: false }),
    saveFalApiKey: vi.fn().mockResolvedValue({
      status: 'ok',
      data: { outcome: 'valid', balance: null, status: null },
    }),
    checkFalApiKey: vi.fn().mockResolvedValue({
      status: 'ok',
      data: { outcome: 'missing', balance: null, status: null },
    }),
    clearFalApiKey: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    // Jobs (#24). Submitting resolves with a receipt, not an image: the result
    // arrives later, through the job store.
    generateImage: vi.fn().mockResolvedValue({
      status: 'ok',
      data: { requestId: 'test-request', generationId: 'test-generation' },
    }),
    activeJobs: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
    finishedJobs: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
    claimJob: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    cancelJob: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    // Projects (#23). An empty library by default: a test that wants one
    // says so, rather than every test inheriting a fixture it did not ask for.
    listProjects: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
    loadProject: vi
      .fn()
      .mockResolvedValue({ status: 'error', error: 'no such project' }),
    saveProject: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        id: 'test-project',
        name: 'Test',
        aspect: '16:9',
        createdAt: 0,
        updatedAt: 0,
        generationCount: 0,
        directory: '/tmp/projects/test-project',
      },
    }),
    deleteProject: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    projectUsage: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        totalBytes: 0,
        assetCount: 0,
        unusedBytes: 0,
        unusedCount: 0,
      },
    }),
    cleanupUnusedAssets: vi.fn().mockResolvedValue({
      status: 'ok',
      data: { removedCount: 0, freedBytes: 0 },
    }),
    importSourceImage: vi.fn().mockResolvedValue({
      status: 'ok',
      data: { assetName: 'imported.png', width: 1920, height: 1080 },
    }),
    // User presets (#28). Nobody's own library by default, for the same reason
    // the project list is empty: a test that wants one says so.
    userPresetsList: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
    userPresetSave: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    userPresetDelete: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    // Motion presets (#29) — the second library, empty by default for the same
    // reason the first one is.
    motionPresetsList: vi.fn().mockResolvedValue({ status: 'ok', data: [] }),
    motionPresetSave: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    motionPresetDelete: vi.fn().mockResolvedValue({ status: 'ok', data: null }),
    // Export (#31). ffmpeg present by default, because its absence is the
    // interesting case and the tests about it set it up themselves.
    ffmpegStatus: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        available: true,
        path: '/opt/homebrew/bin/ffmpeg',
        version: '8.0.1',
      },
    }),
    recheckFfmpeg: vi.fn().mockResolvedValue({
      status: 'ok',
      data: {
        available: true,
        path: '/opt/homebrew/bin/ffmpeg',
        version: '8.0.1',
      },
    }),
    exportGeneration: vi.fn().mockResolvedValue({
      status: 'ok',
      data: { files: ['hero.mp4', 'hero.webm', 'hero-poster.jpg'] },
    }),
  },
  unwrapResult: vi.fn((result: { status: string; data?: unknown }) => {
    if (result.status === 'ok') return result.data
    throw result
  }),
}))
