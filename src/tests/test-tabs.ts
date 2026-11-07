import { spawn } from 'node:child_process';

async function testAllTabs() {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const chrome = spawn(chromePath, [
    '--remote-debugging-port=9222',
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--user-data-dir=C:\\Users\\User\\.gemini\\antigravity\\scratch\\flight-hunter\\data\\chrome_test_prof3',
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

  ws.onmessage = (msg: any) => {
    const data = JSON.parse(msg.data.toString());
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
  await new Promise(r => setTimeout(r, 1000));

  // Test clicking every tab by dispatching real mouse click on the element
  for (const tab of ['offers', 'profiles', 'history', 'settings']) {
    console.log(`Clicking tab ${tab}...`);
    const clickRes: any = await send('Runtime.evaluate', {
      expression: `(() => {
        const btn = document.querySelector('button[data-tab="${tab}"]');
        if (!btn) return 'BUTTON NOT FOUND';
        btn.click();
        const tabContent = document.getElementById('tab-${tab}');
        return {
          btnActive: btn.classList.contains('active'),
          tabVisible: tabContent ? tabContent.style.display : 'NONE',
          allActiveBtns: Array.from(document.querySelectorAll('.tab-btn.active')).map(b => b.dataset.tab)
        };
      })()`,
      returnByValue: true
    });
    console.log(`Result for ${tab}:`, clickRes?.result?.value);
  }

  console.log('Exceptions during tab clicks:', exceptions);

  ws.close();
  chrome.kill();
}

testAllTabs().catch(console.error);
