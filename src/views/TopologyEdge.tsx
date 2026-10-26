import { BaseEdge, EdgeLabelRenderer, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react';
import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

export type DiagramEdge = Edge<{ direction: 'RIGHT' | 'DOWN'; lane: number; bend?: { x: number; y: number } }, 'adjustable' | 'default' | 'straight'>;
type Axis = 'x' | 'y' | 'both';

/** Edit an orthogonal connection directly; its endpoints remain attached to the nodes. */
export function TopologyEdge({ id, sourceX, sourceY, targetX, targetY, data, label, markerEnd, style, selected }: EdgeProps<DiagramEdge>) {
  const { screenToFlowPosition, updateEdgeData, updateEdge } = useReactFlow();
  const drag = useRef<{ pointer: number; x: number; y: number; bend: { x: number; y: number }; axis: Axis } | null>(null);
  const direction = data?.direction ?? 'RIGHT';
  const lane = data?.lane ?? 0;
  const bend = data?.bend ?? { x: (sourceX + targetX) / 2 + (direction === 'DOWN' ? lane * 18 : lane * 12), y: (sourceY + targetY) / 2 + (direction === 'RIGHT' ? lane * 18 : lane * 12) };
  const points = direction === 'RIGHT'
    ? [{ x: sourceX, y: sourceY }, { x: sourceX + 20, y: sourceY }, { x: bend.x, y: sourceY }, bend, { x: targetX - 20, y: bend.y }, { x: targetX - 20, y: targetY }, { x: targetX, y: targetY }]
    : [{ x: sourceX, y: sourceY }, { x: sourceX, y: sourceY + 20 }, { x: sourceX, y: bend.y }, bend, { x: bend.x, y: targetY - 20 }, { x: targetX, y: targetY - 20 }, { x: targetX, y: targetY }];
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
  const reset = () => updateEdgeData(id, { bend: undefined });
  const handlers = (axis: Axis) => ({
    onPointerDown: (event: ReactPointerEvent<Element>) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
      updateEdge(id, { selected: true });
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      drag.current = { pointer: event.pointerId, ...point, bend, axis };
    },
    onPointerMove: (event: ReactPointerEvent<Element>) => {
      if (drag.current?.pointer !== event.pointerId) return;
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      updateEdgeData(id, { bend: {
        x: drag.current.bend.x + (drag.current.axis === 'y' ? 0 : point.x - drag.current.x),
        y: drag.current.bend.y + (drag.current.axis === 'x' ? 0 : point.y - drag.current.y),
      } });
    },
    onPointerUp: (event: ReactPointerEvent<Element>) => {
      if (drag.current?.pointer !== event.pointerId) return;
      drag.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    },
    onPointerCancel: () => { drag.current = null; },
  });
  const segments = [2, 3].map(index => {
    const from = points[index]; const to = points[index + 1];
    const horizontal = from.y === to.y;
    return { from, to, axis: (horizontal ? 'y' : 'x') as Axis, x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, length: Math.hypot(to.x - from.x, to.y - from.y) };
  });
  return <>
    <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ ...style, stroke: selected ? 'var(--accent)' : style?.stroke, strokeWidth: selected ? 2 : 1.4, strokeLinejoin: 'round' }} />
    {segments.map((segment, index) => <path key={index} data-route-segment={index} d={`M ${segment.from.x} ${segment.from.y} L ${segment.to.x} ${segment.to.y}`} fill="none" stroke="transparent" strokeWidth={18}
      className={`nodrag nopan topology-route-segment ${segment.axis === 'x' ? 'route-horizontal-drag' : 'route-vertical-drag'}`} {...handlers(segment.axis)} />)}
    <EdgeLabelRenderer>
      {label != null && <div className="topology-edge-control nodrag nopan" data-adjusted={!!data?.bend} style={{ transform: `translate(-50%, -100%) translate(${bend.x}px, ${bend.y - 8}px)`, zIndex: selected ? 1001 : 1 }}>
        <button className="topology-edge-label" aria-label={`Select ${label} connection`} title="Select connection to edit bends and segments" onClick={() => updateEdge(id, { selected: !selected })} onDoubleClick={reset}><span className="react-flow__edge-text">{label}</span></button>
      </div>}
      {selected && [{ x: bend.x, y: bend.y, axis: 'both' as Axis, name: 'bend' }, ...segments.filter(segment => segment.length > 40).map((segment, index) => ({ ...segment, name: `segment ${index + 1}` }))].map(handle => <button key={handle.name}
        className={`topology-route-handle nodrag nopan ${handle.axis === 'both' ? 'route-bend' : handle.axis === 'x' ? 'route-horizontal-drag' : 'route-vertical-drag'}`}
        aria-label={`Move connection ${handle.name}`} title={handle.axis === 'both' ? 'Drag bend · Double-click to reset' : 'Drag segment'}
        style={{ transform: `translate(-50%, -50%) translate(${handle.x}px, ${handle.y}px)` }} {...handlers(handle.axis)} onDoubleClick={reset}
        onKeyDown={event => {
          const step = event.shiftKey ? 30 : 10;
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'Escape'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === 'Home') reset(); else if (event.key === 'Escape') updateEdge(id, { selected: false });
          else updateEdgeData(id, { bend: {
            x: bend.x + (handle.axis === 'y' ? 0 : event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
            y: bend.y + (handle.axis === 'x' ? 0 : event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0),
          } });
        }} />)}
    </EdgeLabelRenderer>
  </>;
}

export const diagramEdgeTypes = { adjustable: TopologyEdge };
