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

type ScreenNodeData = { node: GraphNode };
type ScreenFlowNode = Node<ScreenNodeData, "screen">;

const NODE_W = 210;
const COL_GAP = 56;
const ROW_GAP = 150;

/** Custom node: title + URL, with the thumbnail revealed on hover (CSS). */
function ScreenNodeView({ data }: NodeProps<ScreenFlowNode>) {
  const n = data.node;
  return (
    <div className="graph-node" title={n.url}>
      <Handle type="target" position={Position.Top} />
      <div className="graph-node__head">
        <span className="graph-node__title">{n.title || n.url}</span>
        <span className="graph-node__depth">d{n.depth}</span>
      </div>
      <div className="graph-node__url mono">{n.url}</div>
      {n.thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="graph-node__thumb" src={n.thumbUrl} alt="" />
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
  // Nodes are compact; fetch the full screen on click to open the viewer.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const screenQ = useScreen(selectedId ?? "");

  const { nodes, edges } = useMemo(() => {
    // Depth-based layout: each node sits in its depth row, columns left→right.
    const colByDepth = new Map<number, number>();
    const flowNodes: ScreenFlowNode[] = graph.nodes.map((node) => {
      const col = colByDepth.get(node.depth) ?? 0;
      colByDepth.set(node.depth, col + 1);
      return {
        id: node.id,
        type: "screen",
        position: { x: col * (NODE_W + COL_GAP), y: node.depth * ROW_GAP },
        data: { node },
      };
    });

    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    // Drop dead edges (no target) and any edge referencing a missing node.
    const flowEdges: Edge[] = graph.edges
      .filter((e) => e.from && e.to && nodeIds.has(e.from) && nodeIds.has(e.to))
      .map((e) => ({
        id: e.id,
        source: e.from as string,
        target: e.to as string,
        label: e.element?.text || undefined,
        animated: e.kind === "substate",
        style: { stroke: EDGE_COLOR[e.kind] ?? "var(--color-border-interactive)" },
      }));

    return { nodes: flowNodes, edges: flowEdges };
  }, [graph]);

  return (
    <div className="graph-canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => setSelectedId(node.id)}
        fitView
        minZoom={0.15}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>

      {selectedId && screenQ.isFetching && !screenQ.data ? (
        <div className="graph-loading">
          <Spinner /> Loading screenshot…
        </div>
      ) : null}

      {selectedId && screenQ.data ? (
        <ScreenViewer
          screens={[screenQ.data]}
          index={0}
          onClose={() => setSelectedId(null)}
          onNavigate={() => {}}
        />
      ) : null}
    </div>
  );
}
