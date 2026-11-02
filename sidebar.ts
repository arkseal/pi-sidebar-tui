import { truncateToWidth } from "@earendil-works/pi-tui";
import type { SidebarContext } from "./types.ts";
import { renderSessionPanel } from "./panels/session.ts";
import { renderTodosPanel } from "./panels/todos.ts";
import { renderWorkspacePanel } from "./panels/workspace.ts";
import { renderMcpPanel } from "./panels/mcp.ts";
import { getRegisteredSidebarPanels } from "./panels/registry.ts";

export interface RenderedPanelLineMeta {
  panel?: import("./panels/registry.ts").DynamicSidebarPanel;
  lineIndex?: number;
}

export function renderSidebarWithMeta(
  ctx: SidebarContext,
  width: number
): { lines: string[]; meta: RenderedPanelLineMeta[] } {
  const safeWidth = Math.max(1, width);

  const rawDynamicPanels = getRegisteredSidebarPanels();
  const dynamicPanels = ctx.showSubagents === false
    ? rawDynamicPanels.filter(p => p.id !== "subagents")
    : rawDynamicPanels;

  const renderDyn = (p: import("./panels/registry.ts").DynamicSidebarPanel) => ({
    lines: p.render(ctx, safeWidth),
    panel: p,
  });

  const earlyPanels = dynamicPanels.filter(p => (p.order ?? 20) < 30).map(renderDyn);
  const midPanels = dynamicPanels.filter(p => (p.order ?? 20) >= 30 && (p.order ?? 20) < 40).map(renderDyn);
  const postTodoPanels = dynamicPanels.filter(p => (p.order ?? 20) >= 40 && (p.order ?? 20) < 50).map(renderDyn);
  const latePanels = dynamicPanels.filter(p => (p.order ?? 20) >= 50).map(renderDyn);

  const allSections: Array<{ lines: string[]; panel?: import("./panels/registry.ts").DynamicSidebarPanel }> = [
    { lines: renderSessionPanel(ctx, safeWidth) },
    ...earlyPanels,
    { lines: renderMcpPanel(ctx, safeWidth) },
    ...midPanels,
    { lines: renderTodosPanel(ctx, safeWidth) },
    ...postTodoPanels,
    { lines: renderWorkspacePanel(ctx, safeWidth) },
    ...latePanels,
  ];
  // Skip empty panels (MCP panel returns [] when no servers)
  const sections = allSections.filter(s => s.lines.length > 0);

  const lines: string[] = [];
  const meta: RenderedPanelLineMeta[] = [];

  for (let i = 0; i < sections.length; i++) {
    if (i > 0) {
      lines.push("");
      meta.push({});
    }
    const sec = sections[i];
    for (let l = 0; l < sec.lines.length; l++) {
      lines.push(truncateToWidth(sec.lines[l], safeWidth, "", true));
      meta.push({ panel: sec.panel, lineIndex: l });
    }
  }

  return { lines, meta };
}

export function renderSidebar(ctx: SidebarContext, width: number): string[] {
  return renderSidebarWithMeta(ctx, width).lines;
}
