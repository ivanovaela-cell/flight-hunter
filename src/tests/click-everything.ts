import { spawn } from 'node:child_process';

async function clickEverything() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome = spawn(chromePath, [
    '--remote-debugging-port=9222',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--user-data-dir=C:\\Users\\User\\.gemini\\antigravity\\scratch\\flight-hunter\\data\\chrome_test_prof4',
    'http://localhost:3000'
  ]);

  let tabs: any[] = [];
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 300));
    try {
      const res = await fetch('http://127.0.0.1:9222/json');
      tabs = await res.json();
      if (tabs.length > 0) break;
    } catch (e) {}
  }
  const pageTab = tabs.find(t => t.url.includes('3000'));
  if (!pageTab) { chrome.kill(); return; }

  const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const exceptions: any[] = [];
  const consoleErrors: any[] = [];

  ws.onmessage = (msg: any) => {
    const data = JSON.parse(msg.data.toString());
    if (data.method === 'Runtime.exceptionThrown') {
      exceptions.push(data.params.exceptionDetails);
    }
    if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      consoleErrors.push(data.params.args.map((a: any) => a.value));
    }
    if (data.id && pending.has(data.id)) {
      const cb = pending.get(data.id);
      pending.delete(data.id);
      cb(data.result);
    }
  };

  await new Promise(r => ws.onopen = r as any);

  function send(method: string, params: any = {}) {
    return new Promise((resolve) => {
      const msgId = id++;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }

  await send('Runtime.enable');
  await send('Page.enable');
  await new Promise(r => setTimeout(r, 1500));

  // Check all links on page
  const linksInfo: any = await send('Runtime.evaluate', {
    expression: `(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.map(l => ({ text: l.textContent, href: l.href, target: l.target }));
    })()`,
    returnByValue: true
  });
  console.log('Total <a> links found on page:', linksInfo?.result?.value?.length);
  console.log('Sample links:', linksInfo?.result?.value?.slice(0, 5));

  // Check all badges on page
  const badgesInfo: any = await send('Runtime.evaluate', {
    expression: `(() => {
      const badges = Array.from(document.querySelectorAll('.badge'));
      return badges.map(b => ({ text: b.textContent, onclick: !!b.onclick, cursor: window.getComputedStyle(b).cursor }));
    })()`,
    returnByValue: true
  });
  console.log('Total .badge elements found:', badgesInfo?.result?.value?.length);
  console.log('Sample badges:', badgesInfo?.result?.value?.slice(0, 8));

  console.log('Any runtime exceptions:', exceptions);
  console.log('Any console errors:', consoleErrors);

  ws.close();
  chrome.kill();
}

clickEverything().catch(console.error);
