import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type GraphData,
  type NodeObject,
} from 'react-force-graph-2d';
import type { LineageEdge, LineageGraph, LineageNode } from '../../data/lineage';
import { accountColour } from '../../data/lineage';
import { networkRadius } from './layouts';

interface Props {
  graph: LineageGraph;
  accounts: string[];
  onSelect: (node: LineageNode | null) => void;
  selectedId: string | null;
}

type NetworkNode = NodeObject<LineageNode>;
type NetworkData = GraphData<LineageNode, LineageEdge>;

function colour(node: LineageNode, accounts: string[]): string {
  if (node.kind === 'account') return accountColour(accounts, node.id.split(':').pop() ?? '');
  if (node.kind === 'project') return '#3668e8';
  if (node.kind === 'vendor') return '#35a252';
  if (node.kind === 'invoice') return '#8042df';
  if (node.kind === 'check') return '#3668e8';
  return '#d18000';
}

function drawNode(
  node: NetworkNode,
  context: CanvasRenderingContext2D,
  globalScale: number,
  accounts: string[],
  hoveredId: string | null,
  selectedId: string | null,
): void {
  if (node.x === undefined || node.y === undefined) return;

  const radius = networkRadius(node);
  const fill = colour(node, accounts);
  const highlighted = node.id === hoveredId || node.id === selectedId;
  context.save();

  if (node.hub) {
    context.beginPath();
    context.arc(node.x, node.y, radius + 4, 0, Math.PI * 2);
    context.strokeStyle = `${fill}88`;
    context.lineWidth = 1.5 / globalScale;
    context.stroke();
  }

  context.beginPath();
  context.arc(node.x, node.y, radius, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  context.strokeStyle = highlighted ? '#263445' : '#ffffff';
  context.lineWidth = (highlighted ? 2.5 : 1.5) / globalScale;
  context.stroke();

  const alwaysLabelled = node.kind === 'project' || node.kind === 'account' || node.hub === true;
  if (alwaysLabelled || highlighted) {
    const rightSide = (node.x ?? 0) < 0;
    const labelX = node.x + (rightSide ? -(radius + 8) : radius + 8) / globalScale;
    const textAlign = rightSide ? 'right' : 'left';
    context.textAlign = textAlign;
    context.textBaseline = 'middle';
    context.font = `${highlighted ? 600 : 500} ${11 / globalScale}px sans-serif`;
    context.lineWidth = 3 / globalScale;
    context.strokeStyle = '#f7f9fc';
    context.fillStyle = '#283445';
    context.strokeText(node.label, labelX, node.y - 2 / globalScale);
    context.fillText(node.label, labelX, node.y - 2 / globalScale);
    if (highlighted && node.subtitle) {
      context.font = `${9 / globalScale}px sans-serif`;
      context.fillStyle = '#687586';
      context.strokeText(node.subtitle, labelX, node.y + 11 / globalScale);
      context.fillText(node.subtitle, labelX, node.y + 11 / globalScale);
    }
  }

  context.restore();
}

export default function LineageNetwork({ graph, accounts, onSelect, selectedId }: Props) {
  const graphRef = useRef<ForceGraphMethods<LineageNode, LineageEdge>>();
  const hostRef = useRef<HTMLDivElement>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const graphData = useMemo<NetworkData>(
    () => ({
      nodes: graph.nodes.map((node) => ({ ...node })),
      links: graph.edges.map((edge) => ({ ...edge })),
    }),
    [graph],
  );
  const maxAmount = Math.max(...graph.edges.map((edge) => edge.amount), 1);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const measure = () => {
      const next = { width: host.clientWidth, height: host.clientHeight };
      setSize((current) =>
        current.width === next.width && current.height === next.height ? current : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    measure();
    return () => observer.disconnect();
  }, []);

  return (
    <section className="lin__canvas lin__canvas--brain" aria-label="Project network">
      <div className="lin__canvasbar">
        <span className="lin__mode">Project network</span>
        <span className="lin__count">
          {graph.nodes.length} nodes · {graph.edges.length} connections
        </span>
        <select
          className="lin__node-select"
          aria-label="Select a project network node"
          value={selectedId ?? ''}
          onChange={(event) =>
            onSelect(graph.nodes.find((node) => node.id === event.target.value) ?? null)
          }
        >
          <option value="">Select a node…</option>
          {graph.nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.kind} · {node.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn--ghost btn--sm lin__fit"
          onClick={() => graphRef.current?.zoomToFit(350, 72)}
          title="Fit the whole project network"
        >
          Fit graph
        </button>
      </div>
      <div className="lin__forcegraph" ref={hostRef}>
        <ForceGraph2D<LineageNode, LineageEdge>
          ref={graphRef}
          width={size.width}
          height={size.height}
          graphData={graphData}
          nodeId="id"
          nodeVal={(node) => networkRadius(node) ** 2}
          nodeCanvasObjectMode={() => 'replace'}
          nodeCanvasObject={(node, context, scale) =>
            drawNode(node, context, scale, accounts, hoveredId, selectedId)
          }
          nodeLabel={(node) => `${node.label}\n${node.subtitle}`}
          linkColor={() => '#b9c3d0'}
          linkWidth={(link) => 0.5 + 1.5 * Math.sqrt(Math.max(link.amount, 0) / maxAmount)}
          onNodeClick={(node) => onSelect(node)}
          onNodeHover={(node) => setHoveredId(node?.id == null ? null : String(node.id))}
          onBackgroundClick={() => onSelect(null)}
          onEngineStop={() => graphRef.current?.zoomToFit(350, 72)}
          cooldownTicks={120}
          d3AlphaDecay={0.04}
          enableNodeDrag
          enablePanInteraction
          enableZoomInteraction
          showPointerCursor
        />
      </div>
    </section>
  );
}