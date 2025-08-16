export const DEFAULT_LIMIT = 100;

export type Settings = {
  workers: number;
  fastDownload: boolean;
  fastDownloadQuality: 'source'|'md'|'ld';
  limit: number;
  dryRun: boolean;
  directDownload: boolean;
  directMaxTasks: number;
  directParallel: number;
  directZipManifest: boolean;
  directZipScript: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  workers: 8,
  fastDownload: false,
  fastDownloadQuality: 'source',
  limit: DEFAULT_LIMIT,
  dryRun: false,
  directDownload: false,
  directMaxTasks: 10,
  directParallel: 3,
  directZipManifest: true,
  directZipScript: true
};

export function clampInt(v: any, min: number, max: number, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

declare const chrome: any;

export async function loadSettings(): Promise<Settings> {
  return new Promise((resolve) => {
    chrome.storage.sync.get('soraDownloaderSettings', (data: any) => {
      try {
        const saved = data?.soraDownloaderSettings ? JSON.parse(data.soraDownloaderSettings) : {};
        if (saved.directMaxItems && !saved.directMaxTasks) saved.directMaxTasks = saved.directMaxItems;
        const s: Settings = { ...DEFAULT_SETTINGS, ...saved };
        s.limit          = clampInt(s.limit, 1, DEFAULT_LIMIT, DEFAULT_SETTINGS.limit);
        s.directMaxTasks = clampInt(s.directMaxTasks, 1, 100, DEFAULT_SETTINGS.directMaxTasks);
        s.directParallel = clampInt(s.directParallel, 1, 6, DEFAULT_SETTINGS.directParallel);
        resolve(s);
      } catch {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  });
}

export async function saveSettings(s: Settings): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ soraDownloaderSettings: JSON.stringify(s) }, resolve);
  });
}
