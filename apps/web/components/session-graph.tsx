"use client";

// Interactive sitemap graph (FR-AP-050): react-flow node-link diagram with
// zoom/pan, a thumbnail on node hover, and click-to-open the full-size viewer.

import { useMemo, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { GraphNode, SessionGraph as SessionGraphData } from "@snapcrawl/shared";
import { ScreenViewer } from "@/components/screen-viewer";
import { Spinner } from "@/components/ui";
import { useScreen } from "@/lib/queries";

// `state` drives the click-path highlight (FR-AP-051): with a node selected, the
// nodes on the root→selection path read "on-path", the selection itself "selected",
// and everything else "dimmed" so the path stands out. With nothing selected every
// node is "normal" and the graph looks exactly as before.
type NodeHiState = "normal" | "on-path" | "selected" | "dimmed";
type ScreenNodeData = { node: GraphNode; state: NodeHiState };
type ScreenFlowNode = Node<ScreenNodeData, "screen">;

/**
 * The click path from a root to `selectedId` (FR-AP-051).
 *
 * The tree lives in the edges, not the nodes — a GraphNode carries no parent — so
 * we walk backwards from the selection along incoming edges until we reach a node
 * nothing points to (a root). Where a state was reached more than one way we take
 * the edge that descends by depth, i.e. the tree edge, so the "click path" is the
 * shortest sensible route rather than an incidental cross-link, and a `seen` guard
 * keeps a cyclic graph from looping forever.
 *
 * Returns the ids of the nodes and the edges on that path; both empty when nothing
 * is selected.
 */
function computePath(
  graph: SessionGraphData,
  selectedId: string | null,
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (!selectedId) return { nodeIds, edgeIds };

  const depthOf = new Map(graph.nodes.map((n) => [n.id, n.depth]));
  // to -> the incoming edge we treat as its parent link. Where a state was
  // reached more than one way, prefer the CLOSEST ancestor: the parent whose
  // depth is greatest while still shallower than the child. That reconstructs the
  // immediate-parent chain of the crawl (root→…→child, one level at a time)
  // rather than an incidental shortcut edge. When nothing is strictly shallower
  // (e.g. a same-depth substate transition), keep the first edge seen.
  const parentEdge = new Map<string, { from: string; edgeId: string; fromDepth: number }>();
  for (const e of graph.edges) {
    if (!e.from || !e.to) continue;
    if (!depthOf.has(e.from) || !depthOf.has(e.to)) continue;
    const fromDepth = depthOf.get(e.from) ?? 0;
    const toDepth = depthOf.get(e.to) ?? 0;
    if (fromDepth >= toDepth) continue; // not an ancestor link; skip same/backward edges
    const existing = parentEdge.get(e.to);
    if (!existing || fromDepth > existing.fromDepth) {
      parentEdge.set(e.to, { from: e.from, edgeId: e.id, fromDepth });
    }
  }
  // Fallback for nodes with no strictly-shallower parent (all incoming edges are
  // same-depth or backward): give them the first such edge so a substate still
  // links back to something rather than dangling.
  for (const e of graph.edges) {
    if (!e.from || !e.to) continue;
    if (!depthOf.has(e.from) || !depthOf.has(e.to)) continue;
    if (parentEdge.has(e.to) || e.from === e.to) continue;
    parentEdge.set(e.to, { from: e.from, edgeId: e.id, fromDepth: depthOf.get(e.from) ?? 0 });
  }

  let current: string | undefined = selectedId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    nodeIds.add(current);
    const parent = parentEdge.get(current);
    if (!parent || seen.has(parent.from)) break;
    edgeIds.add(parent.edgeId);
    current = parent.from;
  }
  return { nodeIds, edgeIds };
}

const NODE_W = 210;
const COL_GAP = 56;
const ROW_GAP = 150;
/**
 * Wrap each depth band after this many nodes.
 *
 * A crawl runs to maxScreens = 200 by default, and real trees are bottom-heavy —
 * the seeded 200-screen session puts 80 nodes at depth 3. One node per column
 * made that band 80 * 266 = ~21,000px wide, so fitView clamped at minZoom and
 * every node rendered 32x9px: measured, and completely unreadable. Wrapping keeps
 * the depth grouping (which is the point of the view) while bounding the width.
 */
const MAX_COLS = 10;

/**
 * Custom node: title + URL, with the thumbnail revealed on hover.
 *
 * The <img> is mounted on first hover rather than always. CSS alone can't do
 * this: `.graph-node__thumb` is `opacity: 0`, which hides the image but still
 * downloads it. A full session is maxScreens = 200 nodes, so always-mounting
 * meant opening the graph fetched 200 thumbnails / ~2.8 MB up front — measured —
 * for images the user very likely never hovers.
 *
 * Sticky once shown: re-hovering the same node is then instant, and only nodes
 * the user actually visited cost anything.
 */
function ScreenNodeView({ data }: NodeProps<ScreenFlowNode>) {
  const n = data.node;
  const [reveal, setReveal] = useState(false);
  const show = () => setReveal(true);

  const className =
    data.state === "normal" ? "graph-node" : `graph-node graph-node--${data.state}`;

  return (
    <div
      className={className}
      title={n.url}
      onMouseEnter={show}
      // Keyboard/AT users reach the node via focus, not a pointer (FR-AP-073).
      onFocus={show}
    >
      <Handle type="target" position={Position.Top} />
      <div className="graph-node__head">
        <span className="graph-node__title">{n.title || n.url}</span>
        <span className="graph-node__depth">d{n.depth}</span>
      </div>
      <div className="graph-node__url mono">{n.url}</div>
      {n.thumbUrl && reveal ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="graph-node__thumb" src={n.thumbUrl} alt="" loading="lazy" />
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { screen: ScreenNodeView };

const EDGE_COLOR: Record<string, string> = {
  navigation: "var(--color-primary)",
  substate: "var(--color-info, var(--color-primary))",
  dead: "var(--color-text-subtle)",
};

export function SessionGraph({ graph }: { graph: SessionGraphData }) {
  // Two distinct selections, because clicking a node does two things that must
  // outlive each other. `selectedId` drives the persistent click-path highlight
  // (FR-AP-051) and stays lit after the viewer closes; `viewerId` drives the
  // full-screen modal (FR-AP-050) and is cleared on close. A background click
  // clears both.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const screenQ = useScreen(viewerId ?? "");

  const path = useMemo(() => computePath(graph, selectedId), [graph, selectedId]);

  const { nodes, edges } = useMemo(() => {
    // Depth-based layout: each depth is a band, filled left→right and wrapped at
    // MAX_COLS so a wide band becomes several short rows instead of one endless
    // ribbon. Bands are stacked by their own height, so a 1-node depth doesn't
    // reserve the same space as an 80-node one.
    const perDepth = new Map<number, number>();
    for (const n of graph.nodes) perDepth.set(n.depth, (perDepth.get(n.depth) ?? 0) + 1);

    const bandY = new Map<number, number>();
    let y = 0;
    for (const depth of [...perDepth.keys()].sort((a, b) => a - b)) {
      bandY.set(depth, y);
      y += Math.ceil((perDepth.get(depth) ?? 1) / MAX_COLS) * ROW_GAP;
    }

    const hasSelection = selectedId !== null;
    const seenByDepth = new Map<number, number>();
    const flowNodes: ScreenFlowNode[] = graph.nodes.map((node) => {
      const i = seenByDepth.get(node.depth) ?? 0;
      seenByDepth.set(node.depth, i + 1);
      const state: NodeHiState = !hasSelection
        ? "normal"
        : node.id === selectedId
          ? "selected"
          : path.nodeIds.has(node.id)
            ? "on-path"
            : "dimmed";
      return {
        id: node.id,
        type: "screen",
        position: {
          x: (i % MAX_COLS) * (NODE_W + COL_GAP),
          y: (bandY.get(node.depth) ?? 0) + Math.floor(i / MAX_COLS) * ROW_GAP,
        },
        data: { node, state },
      };
    });

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    // Drop dead edges (no target) and any edge referencing a missing node.
    const flowEdges: Edge[] = graph.edges
      .filter((e) => e.from && e.to && nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e) => {
        const onPath = path.edgeIds.has(e.id);
        return {
          id: e.id,
          source: e.from as string,
          target: e.to as string,
          label: e.element?.text || undefined,
          // A path edge animates to draw the eye; others stop animating while a
          // selection is active so only the click path moves.
          animated: onPath || (!hasSelection && e.kind === "substate"),
          // Render path edges above the rest so the highlight is never hidden
          // under a crossing grey edge.
          zIndex: onPath ? 10 : 0,
          style: {
            stroke: onPath
              ? "var(--color-primary)"
              : EDGE_COLOR[e.kind] ?? "var(--color-border-interactive)",
            strokeWidth: onPath ? 3 : 1,
            // Fade the off-path edges so the lit path reads as foreground.
            opacity: hasSelection && !onPath ? 0.25 : 1,
          },
        };
      });

    return { nodes: flowNodes, edges: flowEdges };
  }, [graph, selectedId, path]);

  function selectNode(id: string) {
    setSelectedId(id); // highlight the click path (persists)
    setViewerId(id); // and open the full-size viewer
  }

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => selectNode(node.id)}
        // Clicking empty canvas clears the highlight (and any open viewer).
        onPaneClick={() => {
          setSelectedId(null);
          setViewerId(null);
        }}
        fitView
        // Low enough that fitView can actually frame a full 200-node session
        // rather than clamping and cropping it.
        minZoom={0.05}
        // 200 nodes each render a card; only paying for the ones on screen keeps
        // pan/zoom smooth at the default maxScreens.
        onlyRenderVisibleElements
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>

      {selectedId ? (
        <div className="graph-hint" role="status">
          Highlighting the path from the root. Click the canvas to clear.
        </div>
      ) : null}

      {viewerId && screenQ.isFetching && !screenQ.data ? (
        <div className="graph-loading">
          <Spinner /> Loading screenshot…
        </div>
      ) : null}

      {viewerId && screenQ.data ? (
        <ScreenViewer
          screens={[screenQ.data]}
          index={0}
          // Closing the viewer leaves the click-path highlight in place; only a
          // canvas click clears it.
          onClose={() => setViewerId(null)}
          onNavigate={() => {}}
        />
      ) : null}
    </div>
  );
}
