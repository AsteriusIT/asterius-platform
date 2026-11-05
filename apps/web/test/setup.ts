// jsdom lacks a few browser APIs Mantine uses.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub as never;
window.HTMLElement.prototype.scrollIntoView = () => {};
// Autosize textareas listen to font loading.
Object.defineProperty(document, 'fonts', { value: { addEventListener: () => {}, removeEventListener: () => {}, ready: Promise.resolve() } });
export {};
