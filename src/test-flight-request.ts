/**
 * Flight Hunter - Technical Probe for Direct Business Class Flights
 * Route: Moscow (SVO) -> Hanoi (HAN) / Beijing (PEK)
 * Passengers: 2 Adults
 * Cabin: BUSINESS
 * Date: 2027-01-15
 * Stops: Strictly 0 (direct)
 */

interface QueryResult {
  provider: string;
  endpoint: string;
  method: string;
  requestPayload: any;
  status: number;
  statusText: string;
  responseBody: any;
  costUsd: number;
  executionTimeMs: number;
}

async function probeAmadeus(): Promise<QueryResult> {
  const url = new URL("https://api.amadeus.com/v2/shopping/flight-offers");
  url.searchParams.set("originLocationCode", "SVO");
  url.searchParams.set("destinationLocationCode", "HAN");
  url.searchParams.set("departureDate", "2027-01-15");
  url.searchParams.set("adults", "2");
  url.searchParams.set("travelClass", "BUSINESS");
  url.searchParams.set("nonStop", "true");
  url.searchParams.set("currencyCode", "USD");

  const token = process.env.AMADEUS_ACCESS_TOKEN || "";
  const headers: Record<string, string> = {
    "Accept": "application/json",
    "User-Agent": "FlightHunter/1.0"
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const startTime = Date.now();
  const res = await fetch(url.toString(), { method: "GET", headers });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    provider: "Amadeus GDS (Flight Offers Search v2)",
    endpoint: url.toString(),
    method: "GET",
    requestPayload: Object.fromEntries(url.searchParams.entries()),
    status: res.status,
    statusText: res.statusText,
    responseBody: body,
    costUsd: 0.00, // No charged fee for test / unauthorized probe
    executionTimeMs: Date.now() - startTime
  };
}

async function probeDuffel(): Promise<QueryResult> {
  const url = "https://api.duffel.com/air/offer_requests";
  const token = process.env.DUFFEL_TOKEN || "";
  const payload = {
    data: {
      slices: [
        {
          origin: "SVO",
          destination: "HAN",
          departure_date: "2027-01-15"
        }
      ],
      passengers: [
        { type: "adult" },
        { type: "adult" }
      ],
      cabin_class: "business"
    }
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Duffel-Version": "v2",
    "Accept": "application/json",
    "User-Agent": "FlightHunter/1.0"
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const startTime = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    provider: "Duffel NDC API (Offer Requests)",
    endpoint: url,
    method: "POST",
    requestPayload: payload,
    status: res.status,
    statusText: res.statusText,
    responseBody: body,
    costUsd: 0.00,
    executionTimeMs: Date.now() - startTime
  };
}

async function probeTravelpayouts(): Promise<QueryResult> {
  const url = new URL("https://api.travelpayouts.com/aviasales/v3/prices_for_dates");
  url.searchParams.set("origin", "SVO");
  url.searchParams.set("destination", "HAN");
  url.searchParams.set("departure_at", "2027-01-15");
  url.searchParams.set("direct", "true");
  url.searchParams.set("one_way", "true");
  url.searchParams.set("currency", "usd");

  const token = process.env.TRAVELPAYOUTS_TOKEN || "";
  if (token) {
    url.searchParams.set("token", token);
  }

  const startTime = Date.now();
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "FlightHunter/1.0"
    }
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  return {
    provider: "Travelpayouts / Aviasales Data API",
    endpoint: url.toString(),
    method: "GET",
    requestPayload: Object.fromEntries(url.searchParams.entries()),
    status: res.status,
    statusText: res.statusText,
    responseBody: body,
    costUsd: 0.00,
    executionTimeMs: Date.now() - startTime
  };
}

async function main() {
  console.log("================================================================================");
  console.log(" FLIGHT HUNTER - TECHNICAL API PROBE");
  console.log(" Route: SVO (Moscow) -> HAN (Hanoi Vietnam Airlines VN62)");
  console.log(" Cabin: BUSINESS | Passengers: 2 Adults | Date: 2027-01-15 | Stops: 0");
  console.log("================================================================================\n");

  const probes = [probeAmadeus, probeDuffel, probeTravelpayouts];

  for (const probe of probes) {
    try {
      const result = await probe();
      console.log(`[PROVIDER] ${result.provider}`);
      console.log(`URL: ${result.endpoint}`);
      console.log(`Method: ${result.method}`);
      console.log(`Payload/Params: ${JSON.stringify(result.requestPayload)}`);
      console.log(`HTTP Status: ${result.status} ${result.statusText} (${result.executionTimeMs} ms)`);
      console.log(`Query Execution Cost: $${result.costUsd.toFixed(2)} USD`);
      console.log(`Response Body:`);
      console.log(JSON.stringify(result.responseBody, null, 2));
      console.log("--------------------------------------------------------------------------------\n");
    } catch (err: any) {
      console.error(`Error executing probe: ${err.message}`);
    }
  }
}

main();
