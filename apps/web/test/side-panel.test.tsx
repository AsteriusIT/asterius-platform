import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { Badge, Button, Card } from '@mantine/core';
import type { RunLog } from '@asterius/shared';
import { LogViewer } from '../src/components/LogViewer';
import { Section } from '../src/components/Section';
import { SidePanel, SidePanelFooter } from '../src/components/SidePanel';
import { renderUi } from './render';

afterEach(cleanup);

const lines: RunLog[] = [{ at: '2026-01-01T10:00:00Z', stepId: 'build', level: 'info', message: 'compiling' }];

describe('SidePanel', () => {
  it('owns the chrome: one title, subtitle, actions and a close button', async () => {
    const onClose = vi.fn();
    renderUi(
      <SidePanel opened onClose={onClose} title="All logs" subtitle="12 lines" actions={<Badge>live</Badge>}>
        <p>content</p>
      </SidePanel>,
    );
    const panel = await screen.findByRole('dialog', { name: 'All logs' });
    expect(within(panel).getAllByRole('heading')).toHaveLength(1);
    const header = panel.querySelector('.side-panel-header') as HTMLElement;
    expect(within(header).getByText('12 lines')).toBeTruthy();
    expect(within(header).getByText('live')).toBeTruthy();
    expect(within(panel.querySelector('.side-panel-body') as HTMLElement).getByText('content')).toBeTruthy();
    fireEvent.click(within(header).getByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    renderUi(
      <SidePanel opened={false} onClose={() => {}} title="Hidden">
        <p>content</p>
      </SidePanel>,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('has a padded body by default and a flush one for full-bleed content', async () => {
    const view = renderUi(
      <SidePanel opened onClose={() => {}} title="Padded">
        <p>content</p>
      </SidePanel>,
    );
    expect((await screen.findByRole('dialog')).querySelector('.side-panel-body')?.hasAttribute('data-flush')).toBe(false);
    view.unmount();
    renderUi(
      <SidePanel opened onClose={() => {}} title="Flush" flush>
        <p>content</p>
      </SidePanel>,
    );
    expect((await screen.findByRole('dialog')).querySelector('.side-panel-body')?.hasAttribute('data-flush')).toBe(true);
  });

  it('keeps the page usable without an overlay', async () => {
    renderUi(
      <SidePanel opened onClose={() => {}} title="Step" overlay={false}>
        <p>content</p>
      </SidePanel>,
    );
    await screen.findByRole('dialog');
    expect(document.querySelector('.mantine-Drawer-overlay')).toBeNull();
    cleanup();
    renderUi(
      <SidePanel opened onClose={() => {}} title="Step">
        <p>content</p>
      </SidePanel>,
    );
    await screen.findByRole('dialog');
    expect(document.querySelector('.mantine-Drawer-overlay')).not.toBeNull();
  });

  it('pins the footer at the end of the body, from the prop or from the content', async () => {
    renderUi(
      <SidePanel opened onClose={() => {}} title="Edit" footer={<Button>Save</Button>}>
        <p>content</p>
      </SidePanel>,
    );
    const body = (await screen.findByRole('dialog')).querySelector('.side-panel-body') as HTMLElement;
    expect(body.lastElementChild?.classList.contains('side-panel-footer')).toBe(true);
    expect(within(body.lastElementChild as HTMLElement).getByRole('button', { name: 'Save' })).toBeTruthy();
    cleanup();
    renderUi(
      <SidePanel opened onClose={() => {}} title="Edit">
        <p>content</p>
        <SidePanelFooter>
          <Button>Create</Button>
        </SidePanelFooter>
      </SidePanel>,
    );
    const again = (await screen.findByRole('dialog')).querySelector('.side-panel-body') as HTMLElement;
    expect(within(again.lastElementChild as HTMLElement).getByRole('button', { name: 'Create' })).toBeTruthy();
  });
});

describe('Section', () => {
  it('is a flat, labelled region with its actions', () => {
    renderUi(
      <Section title="Logs" actions={<Badge>live</Badge>}>
        <p>lines</p>
      </Section>,
    );
    const section = screen.getByRole('region', { name: 'Logs' });
    expect(within(section).getByRole('heading', { name: 'Logs' })).toBeTruthy();
    expect(within(section).getByText('live')).toBeTruthy();
    expect(section.closest('.mantine-Card-root')).toBeNull();
    expect(section.querySelector('.mantine-Card-root, .mantine-Paper-root')).toBeNull();
  });

  it('has no header without a title', () => {
    renderUi(
      <Section>
        <p>bare</p>
      </Section>,
    );
    expect(screen.queryByRole('heading')).toBeNull();
    expect(screen.getByText('bare')).toBeTruthy();
  });
});

describe('content inside a panel', () => {
  it('the log viewer brings no title and no card: the panel gives the title', async () => {
    renderUi(
      <SidePanel opened onClose={() => {}} title="All logs" flush>
        <LogViewer fill lines={lines} />
      </SidePanel>,
    );
    const panel = await screen.findByRole('dialog', { name: 'All logs' });
    expect(within(panel).getAllByRole('heading')).toHaveLength(1);
    expect(within(panel).queryByText('Logs')).toBeNull();
    expect(panel.querySelector('.mantine-Card-root')).toBeNull();
    expect(within(panel).getByLabelText('Search logs')).toBeTruthy();
    expect(panel.querySelector('.log-viewer')?.hasAttribute('data-fill')).toBe(true);
  });

  it('the log viewer gets its title from a section when it sits among others', () => {
    renderUi(
      <Section title="Logs">
        <LogViewer lines={lines} />
      </Section>,
    );
    const section = screen.getByRole('region', { name: 'Logs' });
    expect(within(section).getByRole('log')).toBeTruthy();
    expect(section.querySelector('.log-viewer')?.hasAttribute('data-fill')).toBe(false);
  });

  it('a page that wants a card wraps the section itself', () => {
    renderUi(
      <Card>
        <Section title="Logs">
          <LogViewer lines={lines} />
        </Section>
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'Logs' }).closest('.mantine-Card-root')).not.toBeNull();
  });
});
