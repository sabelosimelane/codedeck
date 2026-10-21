// Run with Playwright's browser_run_code tool (filename), or invoke this function
// with a Playwright Page. Uses the running Vite server, never real PTY sessions.
async (page) => {
  const path = 'docs/todos/security-deposit-ledger-frontend.md';
  const origin = 'http://127.0.0.1:43000';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${origin}/__selection_test`, route => route.fulfill({ contentType: 'text/html', body: `
    <html><body style="margin:0;background:#111;color:white"><div id="root" style="width:1000px;height:650px"></div>
    <script type="module">
      import RefreshRuntime from '/@react-refresh';
      RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>type=>type; window.__vite_plugin_react_preamble_installed__=true;
      const {default: React} = await import('/node_modules/.vite/deps/react.js');
      const {default: {createRoot}} = await import('/node_modules/.vite/deps/react-dom_client.js');
      const source = await (await fetch('/src/components/Terminal.jsx')).text();
      const xtermUrl = source.match(/from "([^"]*@xterm_xterm[^"]*)"/)[1];
      const {default: {Terminal: XTerm}} = await import(xtermUrl);
      const originalOpen = XTerm.prototype.open;
      XTerm.prototype.open = function(el) { window.testTerm=this; return originalOpen.call(this,el); };
      window.sent = [];
      window.WebSocket = class {
        static OPEN=1; static CONNECTING=0; static CLOSING=2; static CLOSED=3;
        constructor() { window.testSocket=this; this.readyState=0; setTimeout(()=> { this.readyState=1; this.onopen?.(); this.emit({type:'session',sessionId:'copy-proof',existing:false}); },0); }
        send(data) {
          const message = JSON.parse(data);
          window.sent.push(message);
          if (message.type === 'resume') queueMicrotask(() => this.emit({type:'replay',chunks:[],overflow:false}));
        }
        close() { this.readyState=3; }
        emit(data) { this.onmessage?.({data:JSON.stringify(data)}); }
      };
      const {default: Terminal} = await import('/src/components/Terminal.jsx');
      const {ToastProvider} = await import('/src/components/ToastContext.jsx');
      window.seq=0;
      window.output=data=>window.testSocket.emit({type:'output',data,seq:++window.seq});
      createRoot(document.getElementById('root')).render(React.createElement(ToastProvider,null,React.createElement(Terminal,{sessionId:'copy-proof',cwd:'/tmp',isVisible:true})));
    </script></body></html>` }));
  await page.goto(`${origin}/__selection_test`);
  await page.waitForFunction(() => window.testTerm?.cols > 20 && window.testSocket?.readyState === 1);
  // Let font readiness and the initial viewport recovery settle deterministically.
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  const draw = async (mouseMode = true, text = path) => {
    await page.evaluate(({ mouseMode, text }) => {
      window.output('\x1b[?1003l\x1b[?1002l\x1b[2J\x1b[H' + text + '\r\nsecond line\r\nagent prompt' + (mouseMode ? '\x1b[?1002h\x1b[?1006h' : ''));
    }, { mouseMode, text });
    await page.waitForFunction(text => window.testTerm.buffer.active.getLine(0)?.translateToString(true) === text, text);
  };
  const point = async (col, row = 0) => page.evaluate(({ col, row }) => {
    const rect = document.querySelector('.xterm-screen').getBoundingClientRect();
    return { x: rect.x + (col + 0.1) * rect.width / window.testTerm.cols, y: rect.y + (row + 0.5) * rect.height / window.testTerm.rows };
  }, { col, row });
  const drag = async (from, to, releaseAltFirst = false) => {
    await page.keyboard.down('Alt'); await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 });
    if (releaseAltFirst) await page.keyboard.up('Alt');
    await page.mouse.up(); if (!releaseAltFirst) await page.keyboard.up('Alt');
  };
  const copy = async expected => {
    await page.keyboard.press('Meta+c');
    await page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, expected);
    assert(await page.evaluate(() => window.testTerm.hasSelection()), 'Copy cleared highlight');
  };
  await draw();
  await page.evaluate(() => { window.sent = []; return navigator.clipboard.writeText('sentinel'); });
  await drag(await point(0), await point(path.length), true);
  assert(await page.evaluate(() => window.testTerm.getSelection()) === path, 'Forward drag selected wrong text');
  assert(await page.evaluate(() => navigator.clipboard.readText()) === 'sentinel', 'Selection auto-copied');
  await page.evaluate(() => {
    window.redraw = setInterval(() => window.output('\x1b[?1002h\x1b[2J\x1b[HREDRAW'), 15);
    window.dispatchEvent(new Event('focus'));
  });
  await page.waitForFunction(() => window.seq >= 8);
  assert(await page.evaluate(() => window.testTerm.getSelection()) === path, 'Live redraw or focus erased selection');
  await copy(path);
  assert(!(await page.evaluate(() => window.sent)).some(message => message.type === 'input'), 'Selection sent input to the agent');
  await page.evaluate(() => clearInterval(window.redraw));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.testTerm.buffer.active.getLine(0)?.translateToString(true) === 'REDRAW');
  console.log('PASS: Option-drag + Cmd+C exact path, no auto-copy, redraw held, no PTY input, Escape catches up');

  await draw();
  await drag(await point(path.length), await point(0)); await copy(path);
  // New selection must reset the previous anchor.
  await drag(await point(5), await point(10)); await copy(path.slice(5,10));
  await page.keyboard.press('Escape');
  console.log('PASS: reverse drag and repeated selection use the actual pointer anchor');

  await draw(false);
  await drag(await point(0), await point(path.length)); await copy(path);
  await page.keyboard.press('Escape');
  await draw();
  await page.evaluate(() => { window.sent=[]; window.output('\x1b]52;c;b3ZlcndyaXRl\x07'); });
  await page.evaluate(() => new Promise(resolve => window.testTerm.write('', resolve)));
  assert(await page.evaluate(() => navigator.clipboard.readText()) === path, 'OSC 52 overwrote clipboard');
  await page.mouse.click((await point(4,2)).x, (await point(4,2)).y);
  assert((await page.evaluate(() => window.sent)).some(message => message.type === 'input' && message.data.includes('\x1b[<')), 'Ordinary approval clicks stopped reaching PTY');
  // A terminal write already queued at pointer-down must not destroy the drag.
  await draw();
  const from = await point(0); const to = await point(path.length);
  await page.evaluate(({from, to}) => {
    window.output('\x1b[?1002h');
    const target = document.querySelector('.xterm-screen');
    target.dispatchEvent(new MouseEvent('mousedown', {button:0, buttons:1, altKey:true, detail:1, clientX:from.x, clientY:from.y, bubbles:true}));
    document.dispatchEvent(new MouseEvent('mousemove', {buttons:1, altKey:true, clientX:to.x, clientY:to.y, bubbles:true}));
    document.dispatchEvent(new MouseEvent('mouseup', {button:0, clientX:to.x, clientY:to.y, bubbles:true}));
  }, {from, to});
  await page.waitForFunction(expected => window.testTerm.getSelection() === expected, path);
  await copy(path); await page.keyboard.press('Escape');
  console.log('PASS: queued mouse-mode write and mouseup before parser drain preserve the exact selection');

  // Native xterm joining of wrapped lines must copy no inserted newline.
  await page.evaluate(() => { document.getElementById('root').style.width='280px'; });
  await page.waitForFunction(() => window.testTerm.cols < 40);
  await page.evaluate(text => window.output('\x1b[2J\x1b[H' + text), path);
  await page.waitForFunction(() => window.testTerm.buffer.active.cursorY === 1);
  const cols = await page.evaluate(() => window.testTerm.cols);
  await drag(await point(0), await point(path.length % cols, Math.floor(path.length / cols)));
  await copy(path); await page.keyboard.press('Escape');
  console.log('PASS: wrapped path copies without inserted newline');

  // Select from real xterm scrollback, above the live viewport.
  await page.evaluate(text => {
    window.output('\x1b[2J\x1b[H' + Array.from({length:100}, (_,i)=>i===10?text:'history '+i).join('\r\n'));
  }, path);
  await page.waitForFunction(() => window.testTerm.buffer.active.baseY > 50);
  await page.evaluate(text => {
    const term=window.testTerm;
    for(let i=0;i<term.buffer.active.length;i++) {
      if(term.buffer.active.getLine(i)?.translateToString(true).startsWith(text.slice(0,term.cols))) {term.scrollToLine(i);break;}
    }
  }, path);
  await drag(await point(0), await point(path.length % cols, Math.floor(path.length / cols)), true);
  await copy(path);
  await page.keyboard.press('Escape');
  console.log('PASS: wrapped scrollback selection copies exactly');
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  console.log('PASS: mouse reporting off/on, OSC 52 blocked, ordinary approval click delivered');
  return 'Terminal selection browser acceptance passed';
}
