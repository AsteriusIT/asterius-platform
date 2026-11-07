import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { layoutGraph, RelationGraph } from '../src/components/RelationGraph';
import { renderUi } from './render';

afterEach(cleanup);

const nodes = [
  { id: 's/a', blueprint: 's', identifier: 'a', title: 'A', depth: 0 },
  { id: 's/b', blueprint: 's', identifier: 'b', title: 'B', depth: 1 },
  { id: 's/c', blueprint: 's', identifier: 'c', title: 'C', depth: 1 },
];

describe('RelationGraph', () => {
  it('lays nodes out in columns by depth', () => {
    const { placed } = layoutGraph(nodes);
    expect(placed[0].x).toBeLessThan(placed[1].x);
    expect(placed[1].x).toBe(placed[2].x);
    expect(placed[2].y).toBeGreaterThan(placed[1].y);
  });

  it('renders edges and linkable nodes', () => {
    renderUi(<RelationGraph graph={{ nodes, edges: [{ from: 's/a', to: 's/b', relation: 'dependsOn' }], truncated: false }} />);
    expect(screen.getByText('dependsOn')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open B' })).toBeTruthy();
  });

  it('says so when there is nothing related', () => {
    renderUi(<RelationGraph graph={{ nodes: [nodes[0]], edges: [], truncated: false }} />);
    expect(screen.getByText(/no relation yet/)).toBeTruthy();
  });
});
