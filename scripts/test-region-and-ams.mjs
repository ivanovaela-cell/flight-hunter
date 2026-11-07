import * as fs from 'node:fs';
import * as path from 'node:path';

// Read .env manually
const envPath = path.resolve(process.cwd(), '.env');
const envContent = fs.readFileSync(envPath, 'utf-8');
let apiKey = '';
for (const line of envContent.split('\n')) {
  if (line.startsWith('FLIGHTAPI_KEY=')) {
    apiKey = line.split('=')[1].trim();
  }
}

if (!apiKey) {
  console.error("No FLIGHTAPI_KEY found in .env");
  process.exit(1);
}

const tests = [
  {
    name: "Control Search (AMS -> BKK, International non-RU)",
    url: `https://api.flightapi.io/onewaytrip/${apiKey}/AMS/BKK/2027-01-13/2/0/0/Business/USD`,
    saveFile: "data/control_AMS_BKK.json"
  },
  {
    name: "SVO -> PEK with path region /DE",
    url: `https://api.flightapi.io/onewaytrip/${apiKey}/SVO/PEK/2027-01-13/2/0/0/Business/USD/DE`,
    saveFile: "data/test_SVO_PEK_region_path_DE.json"
  },
  {
    name: "SVO -> PEK with query ?region=KZ",
    url: `https://api.flightapi.io/onewaytrip/${apiKey}/SVO/PEK/2027-01-13/2/0/0/Business/USD?region=KZ`,
    saveFile: "data/test_SVO_PEK_region_query_KZ.json"
  }
];

async function run() {
  console.log("=== EXECUTING MAX 3 CALLS (6 CREDITS) ===");
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    console.log(`\n--- [${i + 1}/3] ${t.name} ---`);
    console.log(`URL: ${t.url.replace(apiKey, "HIDDEN_KEY")}`);

    try {
      const res = await fetch(t.url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'FlightHunter/1.0'
        }
      });

      console.log(`HTTP Status: ${res.status} ${res.statusText}`);
      const text = await res.text();
      
      let data;
      try {
        data = JSON.parse(text);
        fs.writeFileSync(t.saveFile, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`Saved response to ${t.saveFile}`);
      } catch {
        console.log(`Non-JSON response: ${text.slice(0, 200)}`);
        continue;
      }

      console.log(`Query Market: ${data.query?.market || 'N/A'}`);
      console.log(`Query Currency: ${data.query?.currency || 'N/A'}`);
      console.log(`Query Locale: ${data.query?.locale || 'N/A'}`);
      console.log(`Itineraries Count: ${data.itineraries?.length || 0}`);
      console.log(`Legs Count: ${data.legs?.length || 0}`);
      console.log(`Carriers Count: ${data.carriers?.length || 0}`);
      console.log(`Agents Count: ${data.agents?.length || 0}`);

      if (data.itineraries && data.itineraries.length > 0) {
        const first = data.itineraries[0];
        console.log(`First itinerary price: $${first.pricing_options?.[0]?.price?.amount || first.pricing_options?.[0]?.price}`);
        console.log(`First itinerary agent: ${first.pricing_options?.[0]?.agent_ids?.[0]}`);
      }
    } catch (e) {
      console.error(`Error: ${e.message}`);
    }
  }
}

run();
