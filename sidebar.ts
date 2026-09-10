import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SidebarContext } from "./types.ts";
import { renderSessionPanel } from "./panels/session.ts";
import { renderTodosPanel } from "./panels/todos.ts";
import { renderWorkspacePanel } from "./panels/workspace.ts";
import { renderMcpPanel } from "./panels/mcp.ts";
import { getRegisteredSidebarPanels } from "./panels/registry.ts";

export function renderSidebar(ctx: SidebarContext, width: number): string[] {
  const safeWidth = Math.max(1, width);

  const dynamicPanels = getRegisteredSidebarPanels();
  const earlyPanels = dynamicPanels.filter(p => (p.order ?? 20) < 30).map(p => p.render(ctx, safeWidth));
  const midPanels = dynamicPanels.filter(p => (p.order ?? 20) >= 30 && (p.order ?? 20) < 40).map(p => p.render(ctx, safeWidth));
  const postTodoPanels = dynamicPanels.filter(p => (p.order ?? 20) >= 40 && (p.order ?? 20) < 50).map(p => p.render(ctx, safeWidth));
  const latePanels = dynamicPanels.filter(p => (p.order ?? 20) >= 50).map(p => p.render(ctx, safeWidth));

  const allPanels = [
    renderSessionPanel(ctx, safeWidth),
    ...earlyPanels,
    renderMcpPanel(ctx, safeWidth),
    ...midPanels,
    renderTodosPanel(ctx, safeWidth),
    ...postTodoPanels,
    renderWorkspacePanel(ctx, safeWidth),
    ...latePanels,
  ];
  // Skip empty panels (MCP panel returns [] when no servers)
  const panels = allPanels.filter(p => p.length > 0);

  const result: string[] = [];
  for (let i = 0; i < panels.length; i++) {
    if (i > 0) result.push("");
    for (const line of panels[i]) {
      result.push(truncateToWidth(line, safeWidth, "", true));
    }
  }

  return result;
}
