import { AviaSeekProvider } from "../providers/aviaseek.ts";

async function testCheck() {
  const provider = new AviaSeekProvider(true);

  console.log("=== ТЕСТ МЕТОДА checkBookingLink ===");

  // 1. Check an expired link
  const expiredRes = await provider.checkBookingLink("https://aviaseek.com/r/00000000-0000-0000-0000-000000000000/00%3A0");
  console.log("1. Проверка истекшей ссылки:", expiredRes);

  // 2. Perform live search to get a fresh link
  const search = await provider.searchFlights({
    origin: "SVO",
    destination: "PEK",
    departureDate: "2027-01-13",
    passengers: 2,
    cabinClass: "business",
    directOnly: true,
    currency: "USD"
  });

  const fresh = search.results.find(x => x.flightNumber === "910" || x.airline.includes("Air China"));
  if (fresh && fresh.deepLink) {
    console.log("2. Проверка свежей ссылки:", fresh.deepLink);
    const freshRes = await provider.checkBookingLink(fresh.deepLink);
    console.log("   Результат проверки свежей ссылки:", freshRes);
  }
}

testCheck().catch(console.error);
