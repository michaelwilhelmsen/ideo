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
    loadPreferences: vi
      .fn()
      .mockResolvedValue({ status: 'ok', data: { theme: 'system' } }),
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
  },
  unwrapResult: vi.fn((result: { status: string; data?: unknown }) => {
    if (result.status === 'ok') return result.data
    throw result
  }),
}))
