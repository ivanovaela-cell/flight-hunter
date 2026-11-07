/**
 * FlightAPI.io Testing Script
 * Tests 3 routes:
 * 1. SVO -> PEK, 2027-01-13 (2 adults, Business, USD, direct only)
 * 2. SVO -> HAN, 2027-01-13 (2 adults, Business, USD, direct only)
 * 3. SVO -> BKK, 2027-01-13 (2 adults, Business, USD, direct only)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

interface RouteTest {
  origin: string;
  destination: string;
  date: string;
  adults: number;
  cabin: string;
  currency: string;
}

const ROUTES: RouteTest[] = [
  { origin: 'SVO', destination: 'PEK', date: '2027-01-13', adults: 2, cabin: 'Business', currency: 'USD' },
  { origin: 'SVO', destination: 'HAN', date: '2027-01-13', adults: 2, cabin: 'Business', currency: 'USD' },
  { origin: 'SVO', destination: 'BKK', date: '2027-01-13', adults: 2, cabin: 'Business', currency: 'USD' },
];

async function runFlightApiTest(apiKey: string) {
  if (!apiKey || apiKey.trim() === '') {
    console.error('ERROR: API Key is required. Provide it via FLIGHTAPI_KEY env var or CLI argument.');
    process.exit(1);
  }

  const outputDir = path.resolve(process.cwd(), 'data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log('================================================================');
  console.log('             FLIGHTAPI.IO LIVE TEST EXECUTION                   ');
  console.log('================================================================');
  console.log(`API Key: ${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`);
  console.log(`Routes to test: ${ROUTES.length}`);
  console.log(`Parameters: 2 Adults, Cabin: Business, Currency: USD, Direct Only\n`);

  for (let i = 0; i < ROUTES.length; i++) {
    const route = ROUTES[i];
    const url = `https://api.flightapi.io/onewaytrip/${apiKey}/${route.origin}/${route.destination}/${route.date}/${route.adults}/0/0/${route.cabin}/${route.currency}`;
    console.log(`----------------------------------------------------------------`);
    console.log(`[${i + 1}/${ROUTES.length}] Testing ${route.origin} -> ${route.destination} on ${route.date}...`);
    console.log(`Endpoint: ${url.replace(apiKey, 'HIDDEN_KEY')}`);

    try {
      const response = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'FlightHunter/1.0',
        },
      });

      console.log(`HTTP Status: ${response.status} ${response.statusText}`);

      // Check remaining credits in headers if any
      const rateLimitRemaining = response.headers.get('x-ratelimit-remaining') || response.headers.get('x-credits-remaining');
      if (rateLimitRemaining) {
        console.log(`Remaining credits (header): ${rateLimitRemaining}`);
      }

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Request failed (${response.status}): ${errText}`);
        continue;
      }

      const rawJson = await response.json();

      // Save raw JSON to disk for full inspection
      const rawFilePath = path.join(outputDir, `flightapi_raw_${route.origin}_${route.destination}_${route.date}.json`);
      fs.writeFileSync(rawFilePath, JSON.stringify(rawJson, null, 2), 'utf-8');
      console.log(`Saved raw JSON response to: ${rawFilePath}`);

      // Parse response
      parseAndDisplayRouteResults(rawJson, route);
    } catch (err: any) {
      console.error(`Error querying ${route.origin}->${route.destination}:`, err.message);
    }
  }
}

function parseAndDisplayRouteResults(data: any, route: RouteTest) {
  const itineraries = data.itineraries || [];
  const legs = data.legs || [];
  const segments = data.segments || [];
  const carriers = data.carriers || {};
  const agents = data.agents || {};
  const places = data.places || {};

  console.log(`\nFound total itineraries: ${itineraries.length}`);

  // Create lookup maps
  const legMap = new Map<string, any>();
  if (Array.isArray(legs)) {
    for (const leg of legs) legMap.set(leg.id, leg);
  }

  const carrierMap = new Map<any, any>();
  if (Array.isArray(carriers)) {
    for (const c of carriers) carrierMap.set(c.id, c);
  } else if (typeof carriers === 'object' && carriers !== null) {
    for (const [k, v] of Object.entries(carriers)) carrierMap.set(k, v);
  }

  const agentMap = new Map<any, any>();
  if (Array.isArray(agents)) {
    for (const a of agents) agentMap.set(a.id, a);
  } else if (typeof agents === 'object' && agents !== null) {
    for (const [k, v] of Object.entries(agents)) agentMap.set(k, v);
  }

  let directOfferCount = 0;

  for (const it of itineraries) {
    const legIds = it.leg_ids || [];
    const itLegs = legIds.map((id: string) => legMap.get(id)).filter(Boolean);

    // Filter direct flights: stop_count === 0
    const isDirect = itLegs.length === 1 && (itLegs[0].stop_count === 0 || itLegs[0].segments?.length === 1);
    if (!isDirect) {
      continue;
    }

    directOfferCount++;
    const leg = itLegs[0];
    const carrier = carrierMap.get(leg.operating_carrier_ids?.[0]) || carrierMap.get(leg.marketing_carrier_ids?.[0]) || {};
    const carrierName = carrier.name || carrier.code || 'Unknown Carrier';
    const departure = leg.departure;
    const arrival = leg.arrival;

    console.log(`\n============================================================`);
    console.log(`* DIRECT FLIGHT OPTION #${directOfferCount}`);
    console.log(`  Carrier: ${carrierName}`);
    console.log(`  Route: ${route.origin} -> ${route.destination}`);
    console.log(`  Departure: ${departure} | Arrival: ${arrival}`);
    console.log(`  Class: ${route.cabin} | Passengers: ${route.adults} adults`);
    console.log(`  Sellers / Pricing Options (${it.pricing_options?.length || 0}):`);

    const pricingOptions = it.pricing_options || [];
    for (const opt of pricingOptions) {
      const agentId = opt.agent_ids?.[0] || opt.agent_id;
      const agent = agentMap.get(agentId) || {};
      const agentName = agent.name || agentId || 'Direct / Unknown Agent';
      const priceAmount = opt.price?.amount || opt.price;
      const lastUpdated = opt.price?.last_updated || 'N/A';
      const quoteAge = opt.price?.quote_age !== undefined ? `${opt.price.quote_age} min` : 'N/A';
      const deepLink = opt.deepLink || opt.url || opt.link || 'N/A';

      console.log(`    - Seller: ${agentName}`);
      console.log(`      Total Price (2 adults): $${priceAmount} USD`);
      console.log(`      Quote Freshness: Updated ${lastUpdated} (age: ${quoteAge})`);
      console.log(`      Booking Link: ${deepLink}`);

      // Check Skyscanner indicators in link
      if (deepLink.includes('skyscanner') || deepLink.includes('api.flightapi.io/deeplink')) {
        console.log(`      [Link Analysis]: DeepLink uses redirect proxy (${deepLink.substring(0, 50)}...)`);
      }
    }
  }

  if (directOfferCount === 0) {
    console.log(`  (!) No direct flights found for ${route.origin} -> ${route.destination} on ${route.date} in Business class.`);
    console.log(`  (Note: Itineraries returned with transfers/layovers: ${itineraries.length})`);
  }
}

// Read API key from env or CLI arg
const apiKey = process.argv[2] || process.env.FLIGHTAPI_KEY || '';
runFlightApiTest(apiKey);
