async function testRedirect() {
  const url = 'https://aviaseek.com/r/01a1b088-5833-8030-e309-4b37b5ffb2dd/70%3A1';
  console.log('Testing URL:', url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Body length:', text.length);
    console.log('Body preview:\n', text.substring(0, 800));
  } catch (e) {
    console.error('Fetch error:', e);
  }
}
testRedirect();
