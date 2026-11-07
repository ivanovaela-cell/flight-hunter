import { spawn } from 'node:child_process';

async function test() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome = spawn(chromePath, [
    '--remote-debugging-port=9222',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--user-data-dir=C:\\Users\\User\\.gemini\\antigravity\\scratch\\flight-hunter\\data\\chrome_test_prof2',
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
  console.log('Tabs:', tabs.map(t => ({ title: t.title, url: t.url, ws: t.webSocketDebuggerUrl })));
  const pageTab = tabs.find(t => t.url.includes('3000'));
  if (!pageTab) { chrome.kill(); return; }

  const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
  let id = 1;
  const pending = new Map();
  const consoleLogs: any[] = [];
  const exceptions: any[] = [];

  ws.onmessage = (msg: any) => {
    const data = JSON.parse(msg.data.toString());
    if (data.method === 'Runtime.consoleAPICalled') {
      consoleLogs.push({ type: data.params.type, args: data.params.args.map((a: any) => a.value) });
    }
    if (data.method === 'Runtime.exceptionThrown') {
      exceptions.push(data.params.exceptionDetails);
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
  await new Promise(r => setTimeout(r, 2000));

  console.log('=== EXCEPTIONS IN CHROME ===');
  console.log(JSON.stringify(exceptions, null, 2));

  console.log('=== CONSOLE API CALLS ===');
  console.log(JSON.stringify(consoleLogs, null, 2));

  const evalResult: any = await send('Runtime.evaluate', {
    expression: `(() => ({
      activeTab: document.querySelector('.tab-btn.active')?.textContent,
      offersRows: document.querySelectorAll('#offersTableBody tr').length,
      offersCount: typeof offers !== 'undefined' ? offers.length : 'undefined',
      firstRowText: document.querySelector('#offersTableBody tr')?.innerText?.substring(0, 100),
      firstBtnHtml: document.querySelector('.live-buy-btn')?.outerHTML
    }))()`,
    returnByValue: true
  });
  console.log('DOM Evaluation:', evalResult?.result?.value);

  // Now test clicking tabs
  console.log('--- Clicking tab profiles ---');
  await send('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('button[data-tab="profiles"]');
      btn.click();
    })()`
  });
  await new Promise(r => setTimeout(r, 500));

  const tabState: any = await send('Runtime.evaluate', {
    expression: `(() => ({
      activeTab: document.querySelector('.tab-btn.active')?.textContent,
      profilesDisplay: document.getElementById('tab-profiles')?.style.display,
      offersDisplay: document.getElementById('tab-offers')?.style.display,
      profilesCount: typeof profiles !== 'undefined' ? profiles.length : 'undefined',
      profilesTableRows: document.querySelectorAll('#profilesTableBody tr').length
    }))()`,
    returnByValue: true
  });
  console.log('Tab switch result:', tabState?.result?.value);

  // Now test clicking an offer button
  console.log('--- Checking first offer button click/href ---');
  const btnInfo: any = await send('Runtime.evaluate', {
    expression: `(() => {
      const btn = document.querySelector('.live-buy-btn');
      return btn ? { href: btn.href, text: btn.textContent, target: btn.target } : null;
    })()`,
    returnByValue: true
  });
  console.log('First offer button:', btnInfo?.result?.value);

  ws.close();
  chrome.kill();
}

test().catch(console.error);
