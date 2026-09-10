import type { SidebarContext } from "../types.ts";

export interface DynamicSidebarPanel {
  id: string;
  order?: number; // lower numbers render earlier. Default: 20 (between session at 10 and mcp at 30)
  render: (ctx: SidebarContext, width: number) => string[];
}

export interface PiSidebarGlobalAPI {
  version: string;
  registerPanel: (panel: DynamicSidebarPanel) => () => void;
  unregisterPanel: (id: string) => void;
  getPanels: () => DynamicSidebarPanel[];
  isAvailable: () => boolean;
  requestRender: () => void;
}

const g = globalThis as unknown as {
  __PI_SIDEBAR_PANELS__?: Map<string, DynamicSidebarPanel>;
  __PI_SIDEBAR_REQUEST_RENDER__?: (() => void) | null;
  __PI_SIDEBAR_TUI__?: PiSidebarGlobalAPI;
};

if (!g.__PI_SIDEBAR_PANELS__) {
  g.__PI_SIDEBAR_PANELS__ = new Map<string, DynamicSidebarPanel>();
}
const panelMap: Map<string, DynamicSidebarPanel> = g.__PI_SIDEBAR_PANELS__;

let _requestRender: (() => void) | null = null;

export function setSidebarRenderCallback(cb: (() => void) | null): void {
  _requestRender = cb;
  g.__PI_SIDEBAR_REQUEST_RENDER__ = cb;
}

export function requestSidebarRender(): void {
  if (_requestRender) {
    _requestRender();
  } else if (typeof g.__PI_SIDEBAR_REQUEST_RENDER__ === "function") {
    g.__PI_SIDEBAR_REQUEST_RENDER__();
  }
}

export function registerSidebarPanel(panel: DynamicSidebarPanel): () => void {
  panelMap.set(panel.id, panel);
  requestSidebarRender();
  return () => {
    panelMap.delete(panel.id);
    requestSidebarRender();
  };
}

export function unregisterSidebarPanel(id: string): void {
  panelMap.delete(id);
  requestSidebarRender();
}

export function getRegisteredSidebarPanels(): DynamicSidebarPanel[] {
  return Array.from(panelMap.values()).sort((a, b) => (a.order ?? 20) - (b.order ?? 20));
}

export function clearRegisteredSidebarPanels(): void {
  panelMap.clear();
}

export function isSidebarAvailable(): boolean {
  return true;
}

// Expose on globalThis for zero-dependency cross-plugin interoperability
g.__PI_SIDEBAR_TUI__ = {
  version: "1.8.0",
  registerPanel: registerSidebarPanel,
  unregisterPanel: unregisterSidebarPanel,
  getPanels: getRegisteredSidebarPanels,
  isAvailable: isSidebarAvailable,
  requestRender: requestSidebarRender,
};
