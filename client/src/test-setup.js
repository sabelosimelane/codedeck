// jsdom does not implement media queries; expose the browser contract to tests.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (media) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
  }),
});
