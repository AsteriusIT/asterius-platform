import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Button, Group, Paper, Portal, Text, Title } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';

/**
 * Guided tour: a spotlight on one element at a time (`[data-tour="<target>"]`) with an explanation card.
 * Steps without a target, or whose target is not visible (e.g. collapsed navigation), are shown centered.
 * Keyboard: → / Enter next, ← back, Esc skip.
 */

export interface TourStep {
  /** Value of the `data-tour` attribute to highlight. */
  target?: string;
  title: string;
  body: ReactNode;
  placement?: 'right' | 'bottom' | 'left' | 'top';
  /** Label of the last step's button (default "Done"). */
  finishLabel?: string;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 6; // spotlight padding around the target
const GAP = 14; // distance between spotlight and card
const CARD_W = 340;
const MARGIN = 12; // keep the card inside the viewport

function findTarget(target?: string): HTMLElement | null {
  if (!target) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const visible = r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
  return visible ? el : null;
}

/** Card position next to the spotlight, flipped/clamped to stay on screen. */
export function cardPosition(rect: Rect | null, placement: TourStep['placement'], cardH: number, vw: number, vh: number) {
  if (!rect) return { top: Math.max(MARGIN, (vh - cardH) / 2), left: Math.max(MARGIN, (vw - CARD_W) / 2) };
  const fitsRight = rect.left + rect.width + PAD + GAP + CARD_W + MARGIN <= vw;
  const fitsBelow = rect.top + rect.height + PAD + GAP + cardH + MARGIN <= vh;
  let p = placement ?? 'right';
  if (p === 'right' && !fitsRight) p = fitsBelow ? 'bottom' : 'top';
  if (p === 'bottom' && !fitsBelow) p = 'top';
  let top: number;
  let left: number;
  if (p === 'right') {
    left = rect.left + rect.width + PAD + GAP;
    top = rect.top + rect.height / 2 - cardH / 2;
  } else if (p === 'left') {
    left = rect.left - PAD - GAP - CARD_W;
    top = rect.top + rect.height / 2 - cardH / 2;
  } else if (p === 'bottom') {
    top = rect.top + rect.height + PAD + GAP;
    left = rect.left + rect.width / 2 - CARD_W / 2;
  } else {
    top = rect.top - PAD - GAP - cardH;
    left = rect.left + rect.width / 2 - CARD_W / 2;
  }
  return {
    top: Math.min(Math.max(MARGIN, top), vh - cardH - MARGIN),
    left: Math.min(Math.max(MARGIN, left), vw - CARD_W - MARGIN),
  };
}

export function Tour({ steps, opened, onClose }: { steps: TourStep[]; opened: boolean; onClose: (completed: boolean) => void }) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardH, setCardH] = useState(200);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const cardRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const step = steps[Math.min(index, steps.length - 1)];
  const last = index >= steps.length - 1;

  useEffect(() => {
    if (opened) setIndex(0);
  }, [opened]);

  // Follow the target (layout changes, scrolling, resizing).
  const measure = useCallback(() => {
    setViewport({ w: window.innerWidth, h: window.innerHeight });
    const el = findTarget(step?.target);
    if (!el) return setRect(null);
    const r = el.getBoundingClientRect();
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [step?.target]);

  useLayoutEffect(() => {
    if (!opened) return;
    findTarget(step?.target)?.scrollIntoView({ block: 'nearest' });
    measure();
    const t = setTimeout(measure, 250); // after drawers/transitions settle
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [opened, step?.target, measure]);

  const centered = rect === null;
  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight);
    cardRef.current?.focus({ preventScroll: true });
  }, [index, opened, centered]);

  const next = useCallback(() => (last ? onClose(true) : setIndex((i) => i + 1)), [last, onClose]);
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  useEffect(() => {
    if (!opened) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opened, next, back, onClose]);

  if (!opened || !step) return null;
  const pos = cardPosition(rect, step.placement, cardH, viewport.w, viewport.h);
  const transition = reduceMotion ? 'none' : 'all 0.25s ease';

  return (
    <Portal>
      {/* Click shield: the page stays visible but inert during the tour. */}
      <Box pos="fixed" inset={0} style={{ zIndex: 1000, background: rect ? 'transparent' : 'rgba(0,0,0,0.45)' }} aria-hidden />
      {rect && (
        <Box
          aria-hidden
          pos="fixed"
          style={{
            zIndex: 1001,
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            borderRadius: 'var(--mantine-radius-md)',
            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.45)',
            outline: '2px solid var(--mantine-color-brand-6)',
            pointerEvents: 'none',
            transition,
          }}
        />
      )}
      <Paper
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        tabIndex={-1}
        shadow="lg"
        radius="xl"
        p="lg"
        w={CARD_W}
        pos="fixed"
        style={{ zIndex: 1002, top: pos.top, left: pos.left, maxWidth: `calc(100vw - ${MARGIN * 2}px)`, outline: 'none', transition }}
      >
        <Text fz="xs" c="dimmed" fw={500} mb="2xs">
          {index + 1} of {steps.length}
        </Text>
        <Title order={4} id="tour-title" mb="2xs">
          {step.title}
        </Title>
        <Text fz="sm" c="dimmed" component="div" lh="lg">
          {step.body}
        </Text>
        <Group gap="3xs" mt="md" aria-hidden>
          {steps.map((_, i) => (
            <Box
              key={i}
              h={6}
              w={i === index ? 18 : 6}
              bdrs="xl"
              bg={i === index ? 'var(--mantine-color-brand-6)' : 'var(--surface-3)'}
              style={{ transition }}
            />
          ))}
        </Group>
        <Group justify="space-between" mt="md">
          {last ? (
            <span />
          ) : (
            <Button variant="subtle" color="gray" size="xs" onClick={() => onClose(false)}>
              Skip tour
            </Button>
          )}
          <Group gap="xs">
            {index > 0 && (
              <Button variant="light" color="gray" size="xs" c="var(--mantine-color-text)" onClick={back}>
                Back
              </Button>
            )}
            <Button size="xs" onClick={next}>
              {last ? (step.finishLabel ?? 'Done') : index === 0 ? 'Show me around' : 'Next'}
            </Button>
          </Group>
        </Group>
      </Paper>
    </Portal>
  );
}
